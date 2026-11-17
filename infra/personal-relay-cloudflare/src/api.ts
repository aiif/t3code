import type { WorkerConfig, WorkerEnv } from "./config.ts";
import { WorkerConfigError } from "./config.ts";
import {
  decryptHostKey,
  encryptHostKey,
  hashHostKey,
  hashToken,
  hostIdFromToken,
  newHostId,
  newHostKey,
  newHostToken,
  safeEqualText,
} from "./crypto.ts";
import type { ClientSnapshotInput, HostRow, RegistryStore } from "./store/types.ts";
import type { TunnelEnsureResult, TunnelProvisioner } from "./tunnel/types.ts";
import { TunnelProvisionError } from "./tunnel/types.ts";

export interface RegistryRequestContext {
  readonly env: WorkerEnv;
  readonly config: WorkerConfig;
  readonly store: RegistryStore;
  readonly provisioner: TunnelProvisioner | null;
  readonly now: () => number;
  readonly clientIp: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_ID_LENGTH = 200;
const MAX_LABEL_LENGTH = 80;
const MAX_PLATFORM_LENGTH = 40;
const MAX_PUBLIC_URL_LENGTH = 2048;
const MAX_SESSION_ID_LENGTH = 200;
const MAX_CLIENTS_PER_REPORT = 500;

const REGISTER_LIMIT = { limit: 10, windowMs: 60_000 } as const;
const RESOLVE_LIMIT = { limit: 120, windowMs: 60_000 } as const;
const ADMIN_LIMIT = { limit: 300, windowMs: 60_000 } as const;

const HOST_ID = "([a-z0-9]{6,32})";
const ADMIN_HOST_PATTERN = new RegExp(`^/admin/hosts/${HOST_ID}$`, "u");
const ADMIN_HOST_CLIENTS_PATTERN = new RegExp(`^/admin/hosts/${HOST_ID}/clients$`, "u");
const ADMIN_HOST_ACTION_PATTERN = new RegExp(
  `^/admin/hosts/${HOST_ID}/(rotate-key|remove|restore|revoke-client)$`,
  "u",
);

class ApiRequestError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.headers = headers;
  }
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: message }, status, headers);
}

/**
 * CORS is same-origin plus the configured origins; a wildcard is never emitted.
 * The relay root serves the admin console, so same-origin is the common case.
 */
export function corsHeadersFor(
  request: Request,
  allowedOrigins: ReadonlyArray<string>,
): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin === null || origin.length === 0) return {};
  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin && !allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function preflightResponse(
  request: Request,
  allowedOrigins: ReadonlyArray<string>,
): Response {
  return new Response(null, { status: 204, headers: corsHeadersFor(request, allowedOrigins) });
}

function withCors(response: Response, request: Request, config: WorkerConfig): Response {
  const headers = corsHeadersFor(request, config.allowedOrigins);
  if (Object.keys(headers).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

export function healthBody(config: WorkerConfig): {
  readonly ok: true;
  readonly service: "t3-personal-registry";
  readonly version: 2;
  readonly mode: WorkerConfig["mode"];
} {
  return { ok: true, service: "t3-personal-registry", version: 2, mode: config.mode };
}

interface ApiRoute {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly handle: (
    request: Request,
    context: RegistryRequestContext,
    match: RegExpExecArray,
  ) => Promise<Response>;
}

const ROUTES: ReadonlyArray<ApiRoute> = [
  { method: "GET", pattern: /^\/health$/u, handle: healthRoute },
  { method: "POST", pattern: /^\/hosts\/register$/u, handle: registerRoute },
  { method: "POST", pattern: /^\/hosts\/heartbeat$/u, handle: heartbeatRoute },
  { method: "POST", pattern: /^\/hosts\/unregister$/u, handle: unregisterRoute },
  { method: "POST", pattern: /^\/hosts\/clients$/u, handle: clientsRoute },
  { method: "POST", pattern: /^\/hosts\/rotate-key$/u, handle: rotateHostKeyRoute },
  { method: "POST", pattern: /^\/hosts\/resolve$/u, handle: resolveRoute },
  { method: "GET", pattern: /^\/admin\/hosts$/u, handle: adminHostsRoute },
  { method: "GET", pattern: ADMIN_HOST_PATTERN, handle: adminHostRoute },
  { method: "GET", pattern: ADMIN_HOST_CLIENTS_PATTERN, handle: adminHostClientsRoute },
  { method: "POST", pattern: ADMIN_HOST_ACTION_PATTERN, handle: adminHostActionRoute },
  { method: "GET", pattern: /^\/push\/public-key$/u, handle: pushPublicKeyRoute },
  { method: "POST", pattern: /^\/push\/subscribe$/u, handle: pushSubscribeRoute },
  { method: "POST", pattern: /^\/push\/unsubscribe$/u, handle: pushUnsubscribeRoute },
  { method: "POST", pattern: /^\/notify$/u, handle: notifyRoute },
];

/** `/v1/...` in production; bare paths keep `wrangler dev` curl checks working. */
function routePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, "");
  if (trimmed === "/v1") return "/";
  if (trimmed.startsWith("/v1/")) return trimmed.slice(3);
  return trimmed.length === 0 ? "/" : trimmed;
}

export async function handleApiRequest(
  request: Request,
  context: RegistryRequestContext,
): Promise<Response> {
  const path = routePath(new URL(request.url).pathname);
  let response: Response;
  try {
    const route = ROUTES.find(
      (candidate) => candidate.method === request.method && candidate.pattern.test(path),
    );
    if (route === undefined) throw new ApiRequestError(404, "Not found.");
    const match = route.pattern.exec(path);
    if (match === null) throw new ApiRequestError(404, "Not found.");
    response = await route.handle(request, context, match);
  } catch (cause) {
    response = errorToResponse(cause);
  }
  return withCors(response, request, context.config);
}

function errorToResponse(cause: unknown): Response {
  if (cause instanceof ApiRequestError) {
    return errorResponse(cause.status, cause.message, { ...cause.headers });
  }
  if (cause instanceof WorkerConfigError) {
    return errorResponse(503, cause.message);
  }
  return errorResponse(500, "Internal error.");
}

async function healthRoute(_request: Request, context: RegistryRequestContext): Promise<Response> {
  return jsonResponse(healthBody(context.config));
}

async function registerRoute(request: Request, context: RegistryRequestContext): Promise<Response> {
  enforceRateLimit(context, "register", REGISTER_LIMIT);
  requireEnrollmentKey(request, context.config);
  const body = await readJsonBody(request);
  const input = parseRegisterBody(body, context.config.mode);
  const now = context.now();
  const mode = context.config.mode;
  const existing = context.store.findHostByEnvironment(input.environmentId);
  if (existing !== null) return reRegister(existing, context, input, now);

  if (context.store.countActiveHosts() >= context.config.maxHosts) {
    throw new ApiRequestError(409, `This relay allows at most ${context.config.maxHosts} hosts.`);
  }

  const hostId = newHostId();
  const hostKey = newHostKey();
  const hostToken = newHostToken(hostId);
  const tunnel =
    mode === "named" ? await ensureTunnel(context, hostId, namedOriginPort(input), now) : null;
  const hostname = tunnel === null ? null : tunnel.hostname;
  const publicUrl = tunnel === null ? "" : `https://${tunnel.hostname}`;

  const host = context.store.createHost({
    id: hostId,
    environmentId: input.environmentId,
    label: input.label,
    platform: input.platform,
    hostKeyHash: await hashHostKey(hostKey),
    hostKeyCiphertext: await encryptHostKey(context.config.secretKey, hostKey),
    hostTokenHash: await hashToken(hostToken),
    connectorMode: mode,
    hostname,
    originPort: input.originPort,
    publicUrl,
    now,
  });
  if (tunnel !== null) {
    context.store.setConnector({
      hostId,
      connectorMode: "named",
      tunnelId: tunnel.tunnelId,
      dnsRecordId: tunnel.dnsRecordId,
      hostname: tunnel.hostname,
      originPort: input.originPort,
      publicUrl,
      now,
    });
  }
  return jsonResponse(
    registrationBody(host, hostKey, hostToken, tunnel, context.config.heartbeatIntervalMs),
  );
}

async function reRegister(
  existing: HostRow,
  context: RegistryRequestContext,
  input: ParsedRegister,
  now: number,
): Promise<Response> {
  if (existing.revokedAt !== null) {
    throw new ApiRequestError(410, "This host was removed.");
  }
  const mode = context.config.mode;
  if (mode === "quick" && existing.connectorMode === "named") {
    await removeTunnel(context, existing);
  }
  const tunnel =
    mode === "named" ? await ensureTunnel(context, existing.id, namedOriginPort(input), now) : null;
  const hostToken = newHostToken(existing.id);
  const hostKey = await decryptHostKeyOrNull(context.config.secretKey, existing);
  const publicUrl = tunnel === null ? "" : `https://${tunnel.hostname}`;
  const updated = context.store.updateRegistration({
    hostId: existing.id,
    label: input.label,
    platform: input.platform,
    hostTokenHash: await hashToken(hostToken),
    connectorMode: mode,
    hostname: tunnel === null ? null : tunnel.hostname,
    originPort: input.originPort,
    publicUrl,
    now,
  });
  if (updated === null) throw new ApiRequestError(410, "This host was removed.");
  context.store.setConnector({
    hostId: existing.id,
    connectorMode: mode,
    tunnelId: tunnel === null ? null : tunnel.tunnelId,
    dnsRecordId: tunnel === null ? null : tunnel.dnsRecordId,
    hostname: tunnel === null ? null : tunnel.hostname,
    originPort: input.originPort,
    publicUrl,
    now,
  });

  if (hostKey !== null) {
    return jsonResponse(
      registrationBody(updated, hostKey, hostToken, tunnel, context.config.heartbeatIntervalMs),
    );
  }
  const rotatedKey = newHostKey();
  const keyVersion = context.store.rotateHostKey({
    hostId: existing.id,
    hostKeyHash: await hashHostKey(rotatedKey),
    hostKeyCiphertext: await encryptHostKey(context.config.secretKey, rotatedKey),
    now,
  });
  if (keyVersion === null) throw new ApiRequestError(410, "This host was removed.");
  const rotated = context.store.getHost(existing.id) ?? updated;
  return jsonResponse(
    registrationBody(rotated, rotatedKey, hostToken, tunnel, context.config.heartbeatIntervalMs),
  );
}

function registrationBody(
  host: HostRow,
  hostKey: string,
  hostToken: string,
  tunnel: TunnelEnsureResult | null,
  heartbeatIntervalMs: number,
): {
  readonly hostId: string;
  readonly hostKey: string;
  readonly hostKeyVersion: number;
  readonly hostToken: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly publicUrl: string;
  readonly connector:
    | {
        readonly kind: "cloudflare-tunnel";
        readonly mode: "named";
        readonly tunnelToken: string;
        readonly hostname: string;
      }
    | { readonly kind: "cloudflare-tunnel"; readonly mode: "quick" };
  readonly heartbeatIntervalMs: number;
} {
  return {
    hostId: host.id,
    hostKey,
    hostKeyVersion: host.keyVersion,
    hostToken,
    environmentId: host.environmentId,
    label: host.label,
    publicUrl: host.publicUrl,
    connector:
      tunnel === null
        ? { kind: "cloudflare-tunnel", mode: "quick" }
        : {
            kind: "cloudflare-tunnel",
            mode: "named",
            tunnelToken: tunnel.tunnelToken,
            hostname: tunnel.hostname,
          },
    heartbeatIntervalMs,
  };
}

async function heartbeatRoute(
  request: Request,
  context: RegistryRequestContext,
): Promise<Response> {
  const host = await authenticateHostToken(request, context);
  const body = await readJsonBody(request);
  const now = context.now();
  if (body["environmentId"] !== undefined) {
    const environmentId = requireText(
      body["environmentId"],
      "environmentId",
      MAX_ENVIRONMENT_ID_LENGTH,
    );
    if (environmentId !== host.environmentId) {
      throw new ApiRequestError(403, "Host token does not match this environment.");
    }
  }
  const label =
    body["label"] === undefined
      ? undefined
      : optionalText(body["label"], "label", MAX_LABEL_LENGTH);
  const online = body["online"] === undefined ? true : body["online"] === true;
  const hostKeyVersion = typeof body["hostKeyVersion"] === "number" ? body["hostKeyVersion"] : 0;
  const publicUrl =
    host.connectorMode === "quick" && body["publicUrl"] !== undefined
      ? parsePublicUrl(body["publicUrl"])
      : undefined;
  const updated = context.store.touchHeartbeat({
    hostId: host.id,
    label,
    online,
    publicUrl,
    now,
  });
  if (updated === null) throw new ApiRequestError(410, "This host was removed.");
  const rotation =
    hostKeyVersion < updated.keyVersion
      ? await rotationBody(context.config.secretKey, updated)
      : {};
  return jsonResponse({
    hostId: updated.id,
    ...rotation,
    revokedSessionIds: context.store.revokedClients(updated.id, now),
    heartbeatIntervalMs: context.config.heartbeatIntervalMs,
  });
}

async function rotationBody(
  secretKey: Uint8Array,
  host: HostRow,
): Promise<{ readonly hostKey?: string; readonly hostKeyVersion?: number }> {
  try {
    return {
      hostKey: await decryptHostKey(secretKey, host.hostKeyCiphertext),
      hostKeyVersion: host.keyVersion,
    };
  } catch {
    return {};
  }
}

async function unregisterRoute(
  request: Request,
  context: RegistryRequestContext,
): Promise<Response> {
  const host = await authenticateHostToken(request, context);
  const removed = context.store.deleteHost(host.id);
  await removeTunnel(context, host);
  return jsonResponse({ removed });
}

async function clientsRoute(request: Request, context: RegistryRequestContext): Promise<Response> {
  const host = await authenticateHostToken(request, context);
  const body = await readJsonBody(request);
  const now = context.now();
  const clients = parseClientSnapshot(body, now);
  context.store.replaceClients(host.id, clients, now);
  return jsonResponse({ recorded: clients.length });
}

async function rotateHostKeyRoute(
  request: Request,
  context: RegistryRequestContext,
): Promise<Response> {
  const host = await authenticateHostToken(request, context);
  const now = context.now();
  const hostKey = newHostKey();
  const hostKeyVersion = context.store.rotateHostKey({
    hostId: host.id,
    hostKeyHash: await hashHostKey(hostKey),
    hostKeyCiphertext: await encryptHostKey(context.config.secretKey, hostKey),
    now,
  });
  if (hostKeyVersion === null) throw new ApiRequestError(410, "This host was removed.");
  context.store.audit({ action: "rotate-key", hostId: host.id, actor: "host", now });
  return jsonResponse({ hostKey, hostKeyVersion });
}

async function resolveRoute(request: Request, context: RegistryRequestContext): Promise<Response> {
  enforceRateLimit(context, "resolve", RESOLVE_LIMIT);
  const token = requireBearer(request);
  rejectAdminKey(token, context.config);
  const host = context.store.findHostByKeyHash(await hashHostKey(token.trim()));
  if (host === null) throw new ApiRequestError(401, "Invalid host key.");
  return jsonResponse({
    hostId: host.id,
    environmentId: host.environmentId,
    label: host.label,
    publicUrl: host.publicUrl,
    online: isOnline(host, context.now(), context.config.heartbeatTtlMs),
    paused: host.paused === 1,
  });
}

async function adminHostsRoute(
  request: Request,
  context: RegistryRequestContext,
): Promise<Response> {
  enforceAdmin(request, context);
  const hosts = await Promise.all(
    context.store.listHosts().map((host) => adminHostBody(context, host)),
  );
  return jsonResponse({ hosts });
}

async function adminHostRoute(
  request: Request,
  context: RegistryRequestContext,
  match: RegExpExecArray,
): Promise<Response> {
  enforceAdmin(request, context);
  const host = requireAdminHost(context, match[1]!);
  return jsonResponse({ host: await adminHostBody(context, host) });
}

async function adminHostClientsRoute(
  request: Request,
  context: RegistryRequestContext,
  match: RegExpExecArray,
): Promise<Response> {
  enforceAdmin(request, context);
  const host = requireAdminHost(context, match[1]!);
  return jsonResponse({
    host: await adminHostBody(context, host),
    clients: context.store.listClients(host.id).map((client) => ({
      sessionId: client.sessionId,
      clientLabel: client.clientLabel,
      platform: client.platform,
      firstSeenAt: new Date(client.firstSeenAt).toISOString(),
      lastSeenAt: new Date(client.lastSeenAt).toISOString(),
      revokedAt: client.revokedAt === null ? null : new Date(client.revokedAt).toISOString(),
    })),
  });
}

async function adminHostActionRoute(
  request: Request,
  context: RegistryRequestContext,
  match: RegExpExecArray,
): Promise<Response> {
  enforceAdmin(request, context);
  const hostId = match[1]!;
  const action = match[2]!;
  const now = context.now();
  if (action === "rotate-key") {
    requireAdminHost(context, hostId);
    const hostKey = newHostKey();
    const hostKeyVersion = context.store.rotateHostKey({
      hostId,
      hostKeyHash: await hashHostKey(hostKey),
      hostKeyCiphertext: await encryptHostKey(context.config.secretKey, hostKey),
      now,
    });
    if (hostKeyVersion === null) throw new ApiRequestError(404, "Unknown host.");
    context.store.audit({ action: "rotate-key", hostId, actor: "admin", now });
    return jsonResponse({ hostKey, hostKeyVersion });
  }
  if (action === "remove") {
    const removed = context.store.revokeHost(hostId, now);
    if (!removed) throw new ApiRequestError(404, "Unknown host.");
    context.store.audit({ action: "remove-host", hostId, actor: "admin", now });
    return jsonResponse({ removed });
  }
  if (action === "restore") {
    const restored = context.store.restoreHost(hostId, now);
    if (!restored) throw new ApiRequestError(404, "Unknown host.");
    context.store.audit({ action: "restore-host", hostId, actor: "admin", now });
    return jsonResponse({ restored });
  }
  const body = await readJsonBody(request);
  const sessionId = requireText(body["sessionId"], "sessionId", MAX_SESSION_ID_LENGTH);
  const revoked = context.store.revokeClient(hostId, sessionId, now);
  context.store.audit({ action: "revoke-client", hostId, actor: "admin", now });
  return jsonResponse({ revoked });
}

async function pushPublicKeyRoute(): Promise<Response> {
  return jsonResponse({ publicKey: "" });
}

async function pushSubscribeRoute(
  request: Request,
  context: RegistryRequestContext,
): Promise<Response> {
  await authenticateAnyKey(request, context);
  return jsonResponse({ subscribed: true });
}

async function pushUnsubscribeRoute(
  request: Request,
  context: RegistryRequestContext,
): Promise<Response> {
  await authenticateAnyKey(request, context);
  return jsonResponse({ removed: false });
}

async function notifyRoute(request: Request, context: RegistryRequestContext): Promise<Response> {
  await authenticateHostToken(request, context);
  return jsonResponse({ delivered: 0, removed: 0, skipped: "no-subscriptions" });
}

interface ParsedRegister {
  readonly environmentId: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly originPort: number | null;
}

function namedOriginPort(input: ParsedRegister): number {
  if (input.originPort === null) {
    throw new ApiRequestError(400, "origin is required in named mode.");
  }
  return input.originPort;
}

function parseRegisterBody(
  body: Record<string, unknown>,
  mode: WorkerConfig["mode"],
): ParsedRegister {
  if (body["apiVersion"] !== 2) {
    throw new ApiRequestError(
      400,
      "apiVersion 2 is required. Update the host to the current version.",
    );
  }
  const environmentId = requireText(
    body["environmentId"],
    "environmentId",
    MAX_ENVIRONMENT_ID_LENGTH,
  );
  const label = optionalText(body["label"], "label", MAX_LABEL_LENGTH);
  const platform = optionalText(body["platform"], "platform", MAX_PLATFORM_LENGTH);
  const originPort = parseOrigin(body["origin"], mode === "named");
  return { environmentId, label, platform, originPort };
}

function parseOrigin(value: unknown, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) throw new ApiRequestError(400, "origin is required in named mode.");
    return null;
  }
  const origin = parseRecord(value);
  const host = requireText(origin["host"], "origin.host", 200);
  if (host !== "127.0.0.1") {
    throw new ApiRequestError(400, "origin.host must be 127.0.0.1.");
  }
  const port = origin["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ApiRequestError(400, "origin.port must be an integer between 1 and 65535.");
  }
  return port;
}

function parseClientSnapshot(
  body: Record<string, unknown>,
  now: number,
): ReadonlyArray<ClientSnapshotInput> {
  const raw = body["clients"];
  if (!Array.isArray(raw)) throw new ApiRequestError(400, "clients must be an array.");
  if (raw.length > MAX_CLIENTS_PER_REPORT) {
    throw new ApiRequestError(400, "clients is too long.");
  }
  return raw.map((entry) => {
    const client = parseRecord(entry);
    return {
      sessionId: requireText(client["sessionId"], "clients[].sessionId", MAX_SESSION_ID_LENGTH),
      clientLabel: optionalText(client["clientLabel"], "clients[].clientLabel", MAX_LABEL_LENGTH),
      platform: optionalText(client["platform"], "clients[].platform", MAX_PLATFORM_LENGTH),
      firstSeenAt: parseTimestamp(client["firstSeenAt"], "clients[].firstSeenAt", now),
      lastSeenAt: parseTimestamp(client["lastSeenAt"], "clients[].lastSeenAt", now),
      revokedAt:
        client["revokedAt"] === undefined || client["revokedAt"] === null
          ? null
          : parseTimestamp(client["revokedAt"], "clients[].revokedAt", now),
    };
  });
}

function parseTimestamp(value: unknown, what: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ApiRequestError(400, `${what} must be an ISO timestamp or epoch milliseconds.`);
}

function parsePublicUrl(value: unknown): string {
  if (typeof value !== "string") throw new ApiRequestError(400, "publicUrl must be a string.");
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length > MAX_PUBLIC_URL_LENGTH) {
    throw new ApiRequestError(400, "publicUrl is too long.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiRequestError(400, "publicUrl must be a URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new ApiRequestError(400, "publicUrl must use https.");
  }
  return trimmed;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiRequestError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== "string") throw new ApiRequestError(400, `${what} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ApiRequestError(400, `${what} is required.`);
  if (trimmed.length > maxLength) throw new ApiRequestError(400, `${what} is too long.`);
  return trimmed;
}

function optionalText(value: unknown, what: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiRequestError(400, `${what} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) throw new ApiRequestError(400, `${what} is too long.`);
  return trimmed;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ApiRequestError(413, "Request body is too large.");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) {
    throw new ApiRequestError(413, "Request body is too large.");
  }
  if (buffer.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new ApiRequestError(400, "Request body must be valid JSON.");
  }
  return parseRecord(parsed);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length === 0 ? null : token;
}

function requireBearer(request: Request): string {
  const token = bearerToken(request);
  if (token === null) throw new ApiRequestError(401, "Missing bearer credential.");
  return token;
}

function requireEnrollmentKey(request: Request, config: WorkerConfig): void {
  const token = requireBearer(request);
  rejectAdminKey(token, config);
  if (!safeEqualText(token, config.enrollKey)) {
    throw new ApiRequestError(401, "Invalid enrollment key.");
  }
}

function rejectAdminKey(token: string, config: WorkerConfig): void {
  if (safeEqualText(token, config.adminKey)) {
    throw new ApiRequestError(403, "The admin key cannot be used here.");
  }
}

async function authenticateHostToken(
  request: Request,
  context: RegistryRequestContext,
): Promise<HostRow> {
  const token = requireBearer(request);
  rejectAdminKey(token, context.config);
  const hostId = hostIdFromToken(token);
  if (hostId === null) throw new ApiRequestError(401, "Invalid host token.");
  const host = context.store.findHostByTokenHash(await hashToken(token));
  if (host === null || host.id !== hostId) {
    throw new ApiRequestError(401, "Invalid host token.");
  }
  return host;
}

async function authenticateAnyKey(
  request: Request,
  context: RegistryRequestContext,
): Promise<void> {
  const token = requireBearer(request);
  if (safeEqualText(token, context.config.adminKey)) return;
  const host = context.store.findHostByKeyHash(await hashHostKey(token.trim()));
  if (host === null) throw new ApiRequestError(401, "Invalid key.");
}

function enforceAdmin(request: Request, context: RegistryRequestContext): void {
  enforceRateLimit(context, "admin", ADMIN_LIMIT);
  const token = requireBearer(request);
  if (!safeEqualText(token, context.config.adminKey)) {
    throw new ApiRequestError(401, "Invalid admin key.");
  }
}

function enforceRateLimit(
  context: RegistryRequestContext,
  scope: string,
  rule: { readonly limit: number; readonly windowMs: number },
): void {
  const result = context.store.consumeRateLimit({
    scope,
    key: context.clientIp.trim().length === 0 ? "unknown" : context.clientIp.trim(),
    limit: rule.limit,
    windowMs: rule.windowMs,
    now: context.now(),
  });
  if (result.allowed) return;
  throw new ApiRequestError(429, "Too many requests. Try again later.", {
    "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))),
  });
}

function requireAdminHost(context: RegistryRequestContext, hostId: string): HostRow {
  const host = context.store.getHost(hostId);
  if (host === null || host.revokedAt !== null) {
    throw new ApiRequestError(404, "Unknown host.");
  }
  return host;
}

async function adminHostBody(
  context: RegistryRequestContext,
  host: HostRow,
): Promise<Record<string, unknown>> {
  return {
    hostId: host.id,
    environmentId: host.environmentId,
    label: host.label,
    platform: host.platform,
    online: isOnline(host, context.now(), context.config.heartbeatTtlMs),
    paused: host.paused === 1,
    lastSeenAt: new Date(host.lastSeenAt).toISOString(),
    publicUrl: host.publicUrl,
    hostKey:
      (await decryptHostKeyOrNull(context.config.secretKey, host)) ??
      "(unavailable: secret key changed)",
    clientsCount: context.store.countClients(host.id),
    createdAt: new Date(host.createdAt).toISOString(),
    revokedAt: host.revokedAt === null ? null : new Date(host.revokedAt).toISOString(),
    connectorMode: host.connectorMode,
    hostname: host.hostname,
  };
}

async function decryptHostKeyOrNull(secretKey: Uint8Array, host: HostRow): Promise<string | null> {
  try {
    return await decryptHostKey(secretKey, host.hostKeyCiphertext);
  } catch {
    return null;
  }
}

function isOnline(host: HostRow, now: number, heartbeatTtlMs: number): boolean {
  if (host.revokedAt !== null || host.online !== 1 || host.paused !== 0) return false;
  if (host.connectorMode === "quick" && host.publicUrl.length === 0) return false;
  return now - host.lastSeenAt <= heartbeatTtlMs;
}

async function ensureTunnel(
  context: RegistryRequestContext,
  hostId: string,
  originPort: number,
  now: number,
): Promise<TunnelEnsureResult> {
  const provisioner = context.provisioner;
  const suffix = context.config.hostsSuffix;
  if (provisioner === null || suffix === null) {
    throw new ApiRequestError(503, "Tunnel provisioning is not configured.");
  }
  try {
    return await provisioner.ensure({
      hostId,
      hostname: `${hostId}.${suffix}`,
      originPort,
      now,
    });
  } catch (cause) {
    if (cause instanceof TunnelProvisionError && cause.status === 409) {
      throw new ApiRequestError(409, "The hostname is already in use.");
    }
    throw new ApiRequestError(502, "Tunnel provisioning failed. Try again later.");
  }
}

async function removeTunnel(context: RegistryRequestContext, host: HostRow): Promise<void> {
  const provisioner = context.provisioner;
  if (provisioner === null) return;
  try {
    await provisioner.remove({
      hostId: host.id,
      tunnelId: host.tunnelId ?? undefined,
      dnsRecordId: host.dnsRecordId ?? undefined,
      hostname: host.hostname ?? undefined,
    });
  } catch {
    // Cleanup is best effort; the daily sweep retries orphaned tunnels.
  }
}
