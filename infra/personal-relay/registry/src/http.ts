import * as NodeHttp from "node:http";

import { RegistryRequestError, type RegistryService } from "./registry.ts";

const MAX_BODY_BYTES = 64 * 1024;

export interface RegistryHttpOptions {
  readonly service: RegistryService;
  readonly vapidPublicKey: string;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

class BodyTooLargeError extends Error {}

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

function sendJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

/** `/v1/...` in production; the bare path keeps local curl checks working. */
function routePath(url: string): string {
  const pathname = new URL(url, "http://registry.local").pathname.replace(/\/+$/, "");
  return pathname.startsWith("/v1/") || pathname === "/v1" ? pathname.slice(3) || "/" : pathname;
}

export function createRegistryServer(options: RegistryHttpOptions): NodeHttp.Server {
  const { service } = options;
  const log = options.log ?? (() => {});

  return NodeHttp.createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = routePath(request.url ?? "/");
    const startedAt = Date.now();

    const finish = (status: number) => {
      log("request", { method, path, status, durationMs: Date.now() - startedAt });
    };

    void (async () => {
      try {
        if (method === "GET" && path === "/health") {
          sendJson(response, 200, { ok: true, service: "t3-personal-registry" });
          finish(200);
          return;
        }

        if (method === "GET" && path === "/push/public-key") {
          sendJson(response, 200, { publicKey: options.vapidPublicKey });
          finish(200);
          return;
        }

        const token = bearerToken(request);
        if (token === null) {
          throw new RegistryRequestError(401, "Missing bearer credential.");
        }

        if (method === "POST" && path === "/hosts/register") {
          const spaceId = service.authenticatePersonalKey(token);
          const body = await readJsonBody(request);
          sendJson(response, 200, service.registerHost(spaceId, body));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/hosts/heartbeat") {
          const host = service.authenticateHostToken(token);
          const body = await readJsonBody(request);
          sendJson(response, 200, service.heartbeat(host, body));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/hosts/unregister") {
          const host = service.authenticateHostToken(token);
          sendJson(response, 200, service.unregister(host));
          finish(200);
          return;
        }

        if (method === "GET" && path === "/hosts") {
          const spaceId = service.authenticatePersonalKey(token);
          sendJson(response, 200, service.listHosts(spaceId));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/push/subscribe") {
          const spaceId = service.authenticatePersonalKey(token);
          const body = await readJsonBody(request);
          sendJson(response, 200, service.subscribe(spaceId, body));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/push/unsubscribe") {
          const spaceId = service.authenticatePersonalKey(token);
          const body = await readJsonBody(request);
          sendJson(response, 200, service.unsubscribe(spaceId, body));
          finish(200);
          return;
        }

        if (method === "POST" && path === "/notify") {
          const spaceId = service.authenticatePersonalKey(token);
          const body = await readJsonBody(request);
          sendJson(response, 200, await service.notify(spaceId, body));
          finish(200);
          return;
        }

        throw new RegistryRequestError(404, "Not found.");
      } catch (cause) {
        if (cause instanceof BodyTooLargeError) {
          sendJson(response, 413, { error: "Request body is too large." });
          finish(413);
          return;
        }
        if (cause instanceof RegistryRequestError) {
          sendJson(response, cause.status, { error: cause.message });
          finish(cause.status);
          return;
        }
        log("request failed", { method, path, cause });
        if (!response.headersSent) {
          sendJson(response, 500, { error: "Internal error." });
        }
        finish(500);
      }
    })();
  });
}
