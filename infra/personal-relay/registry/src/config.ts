/**
 * Environment configuration for the personal-mode registry.
 *
 * The registry is a single-tenant service: one personal key owns one key space.
 * Everything deployment-specific comes from the environment so the same image
 * runs on any VPS.
 */

export interface RegistryConfig {
  /** Loopback address the HTTP server binds; OpenResty proxies to it. */
  readonly host: string;
  readonly port: number;
  /** Directory holding the SQLite database and generated VAPID keys. */
  readonly dataDir: string;
  /** Root credential. Anyone with it sees every host in this key space. */
  readonly personalKey: string;
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
}

const MIN_PERSONAL_KEY_LENGTH = 32;
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

export function resolveRegistryConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RegistryConfig {
  const personalKey = required(env, "T3CODE_PERSONAL_KEY");
  if (personalKey.length < MIN_PERSONAL_KEY_LENGTH) {
    throw new RegistryConfigError(
      `T3CODE_PERSONAL_KEY must contain at least ${MIN_PERSONAL_KEY_LENGTH} characters.`,
    );
  }
  const portalUrl = required(env, "T3CODE_PORTAL_URL").replace(/\/+$/, "");
  const frpServerAddr = required(env, "FRP_SERVER_ADDR");
  const frpAuthToken = required(env, "FRP_AUTH_TOKEN");

  return {
    host: env.REGISTRY_HOST?.trim() || "127.0.0.1",
    port: port(env, "REGISTRY_PORT", 8787),
    dataDir: env.REGISTRY_DATA_DIR?.trim() || "/data",
    personalKey,
    portalUrl,
    hostDomain: hostDomainOf(portalUrl),
    frpServerAddr,
    frpServerPort: port(env, "FRP_SERVER_PORT", 7001),
    frpAuthToken,
    vapidSubject: env.VAPID_SUBJECT?.trim() || portalUrl,
    heartbeatTtlMs: positiveInteger(env, "HEARTBEAT_TTL_MS", DEFAULT_HEARTBEAT_TTL_MS),
    notifyDedupeMs: positiveInteger(env, "NOTIFY_DEDUPE_MS", DEFAULT_NOTIFY_DEDUPE_MS),
  };
}
