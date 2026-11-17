export type TunnelMode = "auto" | "named" | "quick";
export type ResolvedTunnelMode = "named" | "quick";

export interface WorkerEnv {
  readonly REGISTRY: DurableObjectNamespace;
  readonly ASSETS: Fetcher;
  readonly T3CODE_ADMIN_KEY?: string;
  readonly T3CODE_SECRET_KEY?: string;
  readonly T3CODE_ENROLL_KEY?: string;
  readonly T3CODE_CF_API_TOKEN?: string;
  readonly T3CODE_TUNNEL_MODE?: string;
  readonly T3CODE_CF_ACCOUNT_ID?: string;
  readonly T3CODE_CF_ZONE_ID?: string;
  readonly T3CODE_HOSTS_SUFFIX?: string;
  readonly TUNNEL_PREFIX?: string;
  readonly T3CODE_MAX_HOSTS?: string;
  readonly T3CODE_HEARTBEAT_INTERVAL_MS?: string;
  readonly T3CODE_HEARTBEAT_TTL_MS?: string;
  readonly T3CODE_ALLOWED_ORIGINS?: string;
}

export interface WorkerConfig {
  readonly adminKey: string;
  readonly enrollKey: string;
  readonly secretKey: Uint8Array;
  readonly cfApiToken: string | null;
  readonly accountId: string | null;
  readonly zoneId: string | null;
  readonly hostsSuffix: string | null;
  readonly tunnelPrefix: string;
  readonly maxHosts: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTtlMs: number;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly configuredMode: TunnelMode;
  readonly mode: ResolvedTunnelMode;
}

const MIN_KEY_LENGTH = 32;
const DEFAULT_TUNNEL_PREFIX = "t3cf";
const DEFAULT_MAX_HOSTS = 20;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_HEARTBEAT_TTL_MS = 180_000;

export class WorkerConfigError extends Error {
  override name = "WorkerConfigError";
}

function optional(env: WorkerEnv, name: keyof WorkerEnv): string | null {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredKey(env: WorkerEnv, name: keyof WorkerEnv, label: string): string {
  const value = optional(env, name);
  if (value === null) throw new WorkerConfigError(`${label} is required.`);
  if (value.length < MIN_KEY_LENGTH) {
    throw new WorkerConfigError(`${label} must contain at least ${MIN_KEY_LENGTH} characters.`);
  }
  return value;
}

function positiveInteger(value: string | null, name: string, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WorkerConfigError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function tunnelMode(value: string | null): TunnelMode {
  if (value === null) return "auto";
  if (value === "auto" || value === "named" || value === "quick") return value;
  throw new WorkerConfigError("T3CODE_TUNNEL_MODE must be auto, named or quick.");
}

function normalizeSuffix(value: string | null): string | null {
  if (value === null) return null;
  const suffix = value.toLowerCase().replace(/^\.+/u, "").replace(/\.+$/u, "");
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(suffix)) {
    throw new WorkerConfigError("T3CODE_HOSTS_SUFFIX must be a DNS zone or sub-zone.");
  }
  return suffix;
}

function tunnelPrefix(value: string | null): string {
  const prefix = (value ?? DEFAULT_TUNNEL_PREFIX).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(prefix)) {
    throw new WorkerConfigError("TUNNEL_PREFIX must be a lowercase DNS label.");
  }
  return prefix;
}

function allowedOrigins(value: string | null): ReadonlyArray<string> {
  if (value === null) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          if (entry === "*") {
            throw new WorkerConfigError("T3CODE_ALLOWED_ORIGINS cannot contain *.");
          }
          try {
            return new URL(entry).origin;
          } catch {
            throw new WorkerConfigError(`T3CODE_ALLOWED_ORIGINS entry is not an origin: ${entry}`);
          }
        }),
    ),
  ];
}

/**
 * Reads and validates every Worker setting. `auto` chooses named only when the
 * account, zone, suffix and runtime API token are all present; otherwise quick.
 */
export function resolveWorkerConfig(env: WorkerEnv): WorkerConfig {
  const adminKey = requiredKey(env, "T3CODE_ADMIN_KEY", "T3CODE_ADMIN_KEY");
  const enrollKey = requiredKey(env, "T3CODE_ENROLL_KEY", "T3CODE_ENROLL_KEY");
  if (adminKey === enrollKey) {
    throw new WorkerConfigError("The enrollment key must differ from the admin key.");
  }
  const secretKey = decodeSecretKey(optional(env, "T3CODE_SECRET_KEY"));
  const cfApiToken = optional(env, "T3CODE_CF_API_TOKEN");
  const accountId = optional(env, "T3CODE_CF_ACCOUNT_ID");
  const zoneId = optional(env, "T3CODE_CF_ZONE_ID");
  const hostsSuffix = normalizeSuffix(optional(env, "T3CODE_HOSTS_SUFFIX"));
  const configuredMode = tunnelMode(optional(env, "T3CODE_TUNNEL_MODE"));

  const namedReady =
    cfApiToken !== null && accountId !== null && zoneId !== null && hostsSuffix !== null;
  if (configuredMode === "named" && !namedReady) {
    throw new WorkerConfigError(
      "Named mode needs T3CODE_CF_API_TOKEN, T3CODE_CF_ACCOUNT_ID, T3CODE_CF_ZONE_ID and T3CODE_HOSTS_SUFFIX.",
    );
  }

  return {
    adminKey,
    enrollKey,
    secretKey,
    cfApiToken,
    accountId,
    zoneId,
    hostsSuffix,
    tunnelPrefix: tunnelPrefix(optional(env, "TUNNEL_PREFIX")),
    maxHosts: positiveInteger(
      optional(env, "T3CODE_MAX_HOSTS"),
      "T3CODE_MAX_HOSTS",
      DEFAULT_MAX_HOSTS,
    ),
    heartbeatIntervalMs: positiveInteger(
      optional(env, "T3CODE_HEARTBEAT_INTERVAL_MS"),
      "T3CODE_HEARTBEAT_INTERVAL_MS",
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
    heartbeatTtlMs: positiveInteger(
      optional(env, "T3CODE_HEARTBEAT_TTL_MS"),
      "T3CODE_HEARTBEAT_TTL_MS",
      DEFAULT_HEARTBEAT_TTL_MS,
    ),
    allowedOrigins: allowedOrigins(optional(env, "T3CODE_ALLOWED_ORIGINS")),
    configuredMode,
    mode: configuredMode === "quick" || !namedReady ? "quick" : "named",
  };
}

export function decodeSecretKey(raw: string | null): Uint8Array<ArrayBuffer> {
  if (raw === null) throw new WorkerConfigError("T3CODE_SECRET_KEY is required.");
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(value)) {
    const bytes = new Uint8Array(new ArrayBuffer(32));
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/u.test(value)) {
    return base64UrlDecode(value);
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length !== 32) {
    throw new WorkerConfigError("T3CODE_SECRET_KEY must decode to exactly 32 bytes.");
  }
  return copyBytes(bytes);
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/").replace(/=+$/u, "");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.length !== 32) {
    throw new WorkerConfigError("T3CODE_SECRET_KEY must decode to exactly 32 bytes.");
  }
  return bytes;
}
