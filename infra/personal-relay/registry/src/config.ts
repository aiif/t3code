/**
 * Environment configuration for the personal-network registry.
 *
 * The relay is a single-tenant service: one admin key manages every host, while
 * each host has its own host key. Everything deployment-specific comes from the
 * environment so the same image runs on any VPS.
 */

export interface RegistryConfig {
  /** Loopback address the HTTP server binds; OpenResty proxies to it. */
  readonly host: string;
  readonly port: number;
  /** Directory holding the SQLite database and generated VAPID keys. */
  readonly dataDir: string;
  /** Relay root credential. Only `/v1/admin/*` accepts it. */
  readonly adminKey: string;
  /** 32-byte key used to encrypt host keys at rest. */
  readonly secretKey: Buffer;
  /** Portal origin, used for display URLs and VAPID subject. */
  readonly portalUrl: string;
  /** Domain the portal and host wildcard live under, e.g. `t3.example.com`. */
  readonly hostDomain: string;
  /** Public address hosts connect to for frp; must be reachable from the internet. */
  readonly frpServerAddr: string;
  readonly frpServerPort: number;
  /** Shared secret configured in frps.toml; handed to registered hosts. */
  readonly frpAuthToken: string;
  readonly vapidSubject: string;
  /** A host without a heartbeat for this long is reported offline. */
  readonly heartbeatTtlMs: number;
  /** Notifications for the same host, thread and phase inside this window collapse. */
  readonly notifyDedupeMs: number;
  /** Browser origins allowed to call the API, in addition to the portal origin. */
  readonly allowedOrigins: ReadonlyArray<string>;
}

const MIN_ADMIN_KEY_LENGTH = 32;
const DEFAULT_HEARTBEAT_TTL_MS = 90_000;
const DEFAULT_NOTIFY_DEDUPE_MS = 30_000;

export class RegistryConfigError extends Error {
  override name = "RegistryConfigError";
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new RegistryConfigError(`${name} is required.`);
  }
  return value;
}

function port(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new RegistryConfigError(`${name} must be a positive integer port.`);
  }
  return value;
}

function positiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RegistryConfigError(`${name} must be a positive integer.`);
  }
  return value;
}

/** `T3CODE_SECRET_KEY` is 32 raw bytes, or its base64/hex encoding. */
export function decodeSecretKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) {
    throw new RegistryConfigError("T3CODE_SECRET_KEY is required.");
  }
  const fromHex = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : null;
  const fromBase64 = /^[A-Za-z0-9+/_=-]{43,44}$/.test(value)
    ? Buffer.from(value, value.includes("-") || value.includes("_") ? "base64url" : "base64")
    : null;
  const bytes = fromHex ?? fromBase64 ?? Buffer.from(value, "utf8");
  if (bytes.length !== 32) {
    throw new RegistryConfigError("T3CODE_SECRET_KEY must decode to exactly 32 bytes.");
  }
  return bytes;
}

/** The bare hostname for `portalUrl`, so one setting can derive both origins. */
function hostDomainOf(portalUrl: string): string {
  let url: URL;
  try {
    url = new URL(portalUrl);
  } catch {
    throw new RegistryConfigError("T3CODE_PORTAL_URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RegistryConfigError("T3CODE_PORTAL_URL must use http or https.");
  }
  return url.hostname;
}

function allowedOrigins(env: Readonly<Record<string, string | undefined>>, portalUrl: string) {
  const configured = (env.T3CODE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return [...new Set([new URL(portalUrl).origin, ...configured])];
}

export function resolveRegistryConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RegistryConfig {
  // The old personal key becomes the admin key; T3CODE_ADMIN_KEY wins when both exist.
  const adminKey = (env.T3CODE_ADMIN_KEY ?? env.T3CODE_PERSONAL_KEY)?.trim() ?? "";
  if (adminKey.length < MIN_ADMIN_KEY_LENGTH) {
    throw new RegistryConfigError(
      `T3CODE_ADMIN_KEY must contain at least ${MIN_ADMIN_KEY_LENGTH} characters.`,
    );
  }
  const portalUrl = required(env, "T3CODE_PORTAL_URL").replace(/\/+$/, "");
  const frpServerAddr = required(env, "FRP_SERVER_ADDR");
  const frpAuthToken = required(env, "FRP_AUTH_TOKEN");

  return {
    host: env.REGISTRY_HOST?.trim() || "127.0.0.1",
    port: port(env, "REGISTRY_PORT", 8787),
    dataDir: env.REGISTRY_DATA_DIR?.trim() || "/data",
    adminKey,
    secretKey: decodeSecretKey(required(env, "T3CODE_SECRET_KEY")),
    portalUrl,
    hostDomain: hostDomainOf(portalUrl),
    frpServerAddr,
    frpServerPort: port(env, "FRP_SERVER_PORT", 7001),
    frpAuthToken,
    vapidSubject: env.VAPID_SUBJECT?.trim() || portalUrl,
    heartbeatTtlMs: positiveInteger(env, "HEARTBEAT_TTL_MS", DEFAULT_HEARTBEAT_TTL_MS),
    notifyDedupeMs: positiveInteger(env, "NOTIFY_DEDUPE_MS", DEFAULT_NOTIFY_DEDUPE_MS),
    allowedOrigins: allowedOrigins(env, portalUrl),
  };
}
