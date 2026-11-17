import { errorResponse, handleApiRequest, type RegistryRequestContext } from "./api.ts";
import {
  resolveWorkerConfig,
  WorkerConfigError,
  type WorkerConfig,
  type WorkerEnv,
} from "./config.ts";
import { hostIdFromToken } from "./crypto.ts";
import { createTunnelProvisioner } from "./provisioner.ts";
import { createSqliteRegistryStore } from "./store.ts";
import type { RegistryStore } from "./store/types.ts";
import type { TunnelProvisioner } from "./tunnel/types.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const STALE_CLIENT_MS = 30 * DAY_MS;
/** A removed host keeps its tunnel this long so an admin restore is seamless. */
const REVOKED_HOST_GRACE_MS = DAY_MS;

export interface RegistrySweepResult {
  readonly prunedClients: number;
  readonly prunedRateLimits: number;
  readonly sweepFailed: boolean;
}

/** Daily cleanup: stale clients and rate-limit buckets, then orphaned tunnels. */
export async function runRegistrySweep(options: {
  readonly store: RegistryStore;
  readonly provisioner: TunnelProvisioner | null;
  readonly now: number;
}): Promise<RegistrySweepResult> {
  const { store, provisioner, now } = options;
  const prunedClients = store.pruneClients(now - STALE_CLIENT_MS);
  const prunedRateLimits = store.pruneRateLimits(now);
  if (provisioner === null) return { prunedClients, prunedRateLimits, sweepFailed: false };
  const activeHostIds = new Set(
    store
      .listHosts()
      .filter(
        (host) =>
          host.connectorMode === "named" &&
          (host.revokedAt === null || host.revokedAt >= now - REVOKED_HOST_GRACE_MS),
      )
      .map((host) => host.id),
  );
  try {
    await provisioner.sweep({ activeHostIds, now });
    return { prunedClients, prunedRateLimits, sweepFailed: false };
  } catch {
    return { prunedClients, prunedRateLimits, sweepFailed: true };
  }
}

/** One instance holds the registry; SQLite storage lives in this object. */
export class RegistryDurableObject implements DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: WorkerEnv;
  #config: WorkerConfig | null = null;
  #store: RegistryStore | null = null;
  #provisioner: TunnelProvisioner | null = null;
  #initialized = false;
  #alarmChecked = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: WorkerEnv) {
    this.#state = state;
    this.#env = env;
  }

  fetch(request: Request): Promise<Response> {
    return this.#serialize(async () => {
      const startedAt = Date.now();
      const pathname = new URL(request.url).pathname;
      let response: Response;
      try {
        const context = this.#context(request);
        await this.#ensureAlarm();
        response = await handleApiRequest(request, context);
      } catch (cause) {
        response =
          cause instanceof WorkerConfigError
            ? errorResponse(503, cause.message)
            : errorResponse(500, "Internal error.");
      }
      this.#log(request, pathname, response.status, startedAt);
      return response;
    });
  }

  alarm(): Promise<void> {
    return this.#serialize(async () => {
      const now = Date.now();
      try {
        const { store, provisioner } = this.#registry();
        const result = await runRegistrySweep({ store, provisioner, now });
        if (result.sweepFailed) this.#logEvent("sweep_failed");
      } catch (cause) {
        this.#logEvent(cause instanceof WorkerConfigError ? "sweep_config_error" : "sweep_failed");
      } finally {
        await this.#state.storage.setAlarm(now + DAY_MS);
      }
    });
  }

  #context(request: Request): RegistryRequestContext {
    const registry = this.#registry();
    return {
      env: this.#env,
      config: registry.config,
      store: registry.store,
      provisioner: registry.provisioner,
      now: () => Date.now(),
      clientIp: clientIp(request),
    };
  }

  #registry(): {
    readonly config: WorkerConfig;
    readonly store: RegistryStore;
    readonly provisioner: TunnelProvisioner | null;
  } {
    if (!this.#initialized) {
      const config = resolveWorkerConfig(this.#env);
      const store = createSqliteRegistryStore(this.#state.storage.sql, (callback) =>
        this.#state.storage.transactionSync(callback),
      );
      this.#config = config;
      this.#store = store;
      this.#provisioner = createTunnelProvisioner(config);
      this.#initialized = true;
    }
    if (this.#config === null || this.#store === null) {
      throw new Error("Registry storage is unavailable.");
    }
    return {
      config: this.#config,
      store: this.#store,
      provisioner: this.#provisioner,
    };
  }

  async #ensureAlarm(): Promise<void> {
    if (this.#alarmChecked) return;
    const existing = await this.#state.storage.getAlarm();
    if (existing === null) await this.#state.storage.setAlarm(Date.now() + DAY_MS);
    this.#alarmChecked = true;
  }

  /** Requests and the alarm share one queue so a registration cannot interleave. */
  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #log(request: Request, pathname: string, status: number, startedAt: number): void {
    this.#logEvent("request", {
      method: request.method,
      path: pathname,
      status,
      hostId: requestHostId(request, pathname),
      durationMs: Date.now() - startedAt,
    });
  }

  #logEvent(event: string, detail: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ event, ...detail }));
  }
}

function clientIp(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip !== null && ip.trim().length > 0) return ip.trim();
  return "unknown";
}

function requestHostId(request: Request, pathname: string): string | null {
  const admin = /^\/v1\/admin\/hosts\/([a-z0-9]{6,32})(?:\/|$)/u.exec(pathname);
  if (admin !== null) return admin[1]!;
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  return hostIdFromToken(header.slice(7).trim());
}
