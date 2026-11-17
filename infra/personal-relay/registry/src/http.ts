import * as NodeHttp from "node:http";

import { RegistryRequestError, type RegistryService } from "./registry.ts";

const MAX_BODY_BYTES = 64 * 1024;
const ADMIN_HOST_PATH =
  /^\/admin\/hosts\/([a-z0-9]{6,32})(?:\/(clients|rotate-key|remove|restore|revoke-client))?$/;

export interface RegistryHttpOptions {
  readonly service: RegistryService;
  readonly vapidPublicKey: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

class BodyTooLargeError extends Error {}

interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

const REGISTER_LIMIT: RateLimit = { limit: 20, windowMs: 60_000 };
const RESOLVE_LIMIT: RateLimit = { limit: 120, windowMs: 60_000 };
const ADMIN_LIMIT: RateLimit = { limit: 300, windowMs: 60_000 };

async function readJsonBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RegistryRequestError(400, "Request body must be valid JSON.");
  }
}

function bearerToken(request: NodeHttp.IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length === 0 ? null : token;
}

/** `/v1/...` in production; the bare path keeps local curl checks working. */
function routePath(url: string): string {
  const pathname = new URL(url, "http://registry.local").pathname.replace(/\/+$/, "");
  return pathname.startsWith("/v1/") || pathname === "/v1" ? pathname.slice(3) || "/" : pathname;
}

function requestIp(request: NodeHttp.IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function createRegistryServer(options: RegistryHttpOptions): NodeHttp.Server {
  const { service } = options;
  const log = options.log ?? (() => {});
  const allowedOrigins = new Set(options.allowedOrigins);
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const corsHeaders = (request: NodeHttp.IncomingMessage) => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !allowedOrigins.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  };

  const sendJson = (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    status: number,
    body: unknown,
  ): void => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      ...corsHeaders(request),
    });
    response.end(payload);
  };

  const limit = (request: NodeHttp.IncomingMessage, scope: string, rule: RateLimit): void => {
    const key = `${scope}:${requestIp(request)}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count > rule.limit) {
      throw new RegistryRequestError(429, "Too many requests. Try again later.");
    }
  };

  return NodeHttp.createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = routePath(request.url ?? "/");
    const startedAt = Date.now();

    const finish = (status: number) => {
      log("request", { method, path, status, durationMs: Date.now() - startedAt });
    };

    if (method === "OPTIONS") {
      response.writeHead(204, {
        ...corsHeaders(request),
      });
      response.end();
      return;
    }

    void (async () => {
      try {
        if (method === "GET" && path === "/health") {
          sendJson(request, response, 200, {
            ok: true,
            service: "t3-personal-registry",
            version: 2,
          });
          finish(200);
          return;
        }

        if (method === "GET" && path === "/push/public-key") {
          sendJson(request, response, 200, { publicKey: options.vapidPublicKey });
          finish(200);
          return;
        }

        if (method === "POST" && path === "/hosts/register") {
          limit(request, "register", REGISTER_LIMIT);
          const body = await readJsonBody(request);
          sendJson(request, response, 200, service.registerHost(body));
          finish(200);
          return;
        }

        const token = bearerToken(request);
        if (token === null) {
          throw new RegistryRequestError(401, "Missing bearer credential.");
        }

        if (method === "POST" && path === "/hosts/resolve") {
          limit(request, "resolve", RESOLVE_LIMIT);
          sendJson(request, response, 200, service.resolveHostKey(token));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/push/subscribe") {
          const scope = service.authenticateAnyKey(token);
          const body = await readJsonBody(request);
          sendJson(request, response, 200, service.subscribe(scope, body));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/push/unsubscribe") {
          const scope = service.authenticateAnyKey(token);
          const body = await readJsonBody(request);
          sendJson(request, response, 200, service.unsubscribe(scope, body));
          finish(200);
          return;
        }

        if (path.startsWith("/admin/")) {
          limit(request, "admin", ADMIN_LIMIT);
          service.authenticateAdminKey(token);
          const match = ADMIN_HOST_PATH.exec(path);
          if (match === null) {
            if (method === "GET" && path === "/admin/hosts") {
              sendJson(request, response, 200, service.listAdminHosts());
              finish(200);
              return;
            }
            throw new RegistryRequestError(404, "Not found.");
          }
          const hostId = match[1]!;
          const action = match[2] ?? null;
          if (method === "GET" && action === null) {
            sendJson(request, response, 200, service.getAdminHost(hostId));
            finish(200);
            return;
          }
          if (method === "GET" && action === "clients") {
            sendJson(request, response, 200, service.listAdminClients(hostId));
            finish(200);
            return;
          }
          if (method === "POST" && action === "rotate-key") {
            sendJson(request, response, 200, service.rotateHostKey(hostId, "admin"));
            finish(200);
            return;
          }
          if (method === "POST" && action === "remove") {
            sendJson(request, response, 200, service.removeHost(hostId, "admin"));
            finish(200);
            return;
          }
          if (method === "POST" && action === "restore") {
            sendJson(request, response, 200, service.restoreHost(hostId, "admin"));
            finish(200);
            return;
          }
          if (method === "POST" && action === "revoke-client") {
            const body = await readJsonBody(request);
            sendJson(request, response, 200, service.revokeClient(hostId, body, "admin"));
            finish(200);
            return;
          }
          throw new RegistryRequestError(404, "Not found.");
        }

        const host = service.authenticateHostToken(token);

        if (method === "POST" && path === "/hosts/heartbeat") {
          const body = await readJsonBody(request);
          sendJson(request, response, 200, service.heartbeat(host, body));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/hosts/unregister") {
          sendJson(request, response, 200, service.unregister(host));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/hosts/clients") {
          const body = await readJsonBody(request);
          sendJson(request, response, 200, service.reportClients(host, body));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/hosts/rotate-key") {
          sendJson(request, response, 200, service.rotateHostKey(host.id, "host"));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/notify") {
          const body = await readJsonBody(request);
          sendJson(request, response, 200, await service.notify(host, body));
          finish(200);
          return;
        }

        throw new RegistryRequestError(404, "Not found.");
      } catch (cause) {
        if (cause instanceof BodyTooLargeError) {
          sendJson(request, response, 413, { error: "Request body is too large." });
          finish(413);
          return;
        }
        if (cause instanceof RegistryRequestError) {
          sendJson(request, response, cause.status, { error: cause.message });
          finish(cause.status);
          return;
        }
        log("request failed", {
          method,
          path,
          error: cause instanceof Error ? cause.name : "unknown",
        });
        if (!response.headersSent) {
          sendJson(request, response, 500, { error: "Internal error." });
        }
        finish(500);
      }
    })();
  });
}
