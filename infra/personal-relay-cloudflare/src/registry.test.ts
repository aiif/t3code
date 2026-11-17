import { describe, expect, it } from "vite-plus/test";

import type { WorkerEnv } from "./config.ts";
import { RegistryDurableObject, runRegistrySweep } from "./registry.ts";
import { createSqliteRegistryStore } from "./store.ts";
import type { RegistryStore } from "./store/types.ts";
import { createFakeSqlStorage, type FakeSqlStorage } from "./testing/fakeSqlStorage.ts";
import { createFakeTunnelProvisioner } from "./tunnel/fake.ts";

const ADMIN_KEY = "admin-key-for-tests-0123456789abcdef";
const ENROLL_KEY = "enroll-key-for-tests-0123456789abcd";
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function workerEnv(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  return {
    T3CODE_ADMIN_KEY: ADMIN_KEY,
    T3CODE_SECRET_KEY: "07".repeat(32),
    T3CODE_ENROLL_KEY: ENROLL_KEY,
    ...overrides,
  } as unknown as WorkerEnv;
}

function makeStore(): { readonly store: RegistryStore; readonly fake: FakeSqlStorage } {
  const fake = createFakeSqlStorage();
  return { store: createSqliteRegistryStore(fake.sql), fake };
}

function createHost(
  store: RegistryStore,
  options: {
    readonly id: string;
    readonly environmentId: string;
    readonly connectorMode?: "named" | "quick";
    readonly hostKeyHash?: string;
    readonly hostTokenHash?: string;
    readonly now?: number;
  },
): void {
  store.createHost({
    id: options.id,
    environmentId: options.environmentId,
    label: options.id,
    platform: "linux",
    hostKeyHash: options.hostKeyHash ?? `key-${options.id}`,
    hostKeyCiphertext: "v1.nonce.tag.ciphertext",
    hostTokenHash: options.hostTokenHash ?? `token-${options.id}`,
    connectorMode: options.connectorMode ?? "named",
    hostname: options.connectorMode === "quick" ? null : `${options.id}.example.test`,
    originPort: 3773,
    publicUrl: options.connectorMode === "quick" ? "" : `https://${options.id}.example.test`,
    now: options.now ?? NOW - 10 * DAY_MS,
  });
}

interface FakeState {
  readonly state: DurableObjectState;
  readonly fake: FakeSqlStorage;
  readonly alarms: number[];
}

function makeState(): FakeState {
  const fake = createFakeSqlStorage();
  const alarms: number[] = [];
  let alarm: number | null = null;
  const state = {
    storage: {
      sql: fake.sql,
      getAlarm: () => Promise.resolve(alarm),
      setAlarm: (time: number | Date) => {
        alarm = typeof time === "number" ? time : time.getTime();
        alarms.push(alarm);
        return Promise.resolve();
      },
      transactionSync: <T>(callback: () => T): T => callback(),
    },
  } as unknown as DurableObjectState;
  return { state, fake, alarms };
}

function registerRequest(environmentId: string): Request {
  return new Request("https://relay.test/v1/hosts/register", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ENROLL_KEY}`,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
    },
    body: JSON.stringify({ environmentId, apiVersion: 2 }),
  });
}

describe("runRegistrySweep", () => {
  it("prunes stale clients and rate limits, then sweeps named hosts within the revocation grace", async () => {
    const { store } = makeStore();
    createHost(store, { id: "named0000000", environmentId: "env-named" });
    createHost(store, {
      id: "quick0000000",
      environmentId: "env-quick",
      connectorMode: "quick",
    });
    createHost(store, { id: "oldrevoked00", environmentId: "env-old" });
    store.revokeHost("oldrevoked00", NOW - 2 * DAY_MS);
    createHost(store, { id: "newrevoked00", environmentId: "env-new" });
    store.revokeHost("newrevoked00", NOW - 60 * 60 * 1_000);

    store.replaceClients(
      "named0000000",
      [
        {
          sessionId: "stale-session",
          clientLabel: null,
          platform: null,
          firstSeenAt: NOW - 40 * DAY_MS,
          lastSeenAt: NOW - 40 * DAY_MS,
        },
      ],
      NOW - 39 * DAY_MS,
    );
    store.revokeClient("named0000000", "stale-session", NOW - 39 * DAY_MS);
    store.consumeRateLimit({
      scope: "register",
      key: "203.0.113.7",
      limit: 10,
      windowMs: 60_000,
      now: NOW - 2 * DAY_MS,
    });

    const provisioner = createFakeTunnelProvisioner();
    const result = await runRegistrySweep({ store, provisioner, now: NOW });

    expect(result).toEqual({ prunedClients: 1, prunedRateLimits: 1, sweepFailed: false });
    expect(provisioner.state.swept).toHaveLength(1);
    expect(provisioner.state.swept[0]?.activeHostIds).toEqual(
      new Set(["named0000000", "newrevoked00"]),
    );
    expect(provisioner.state.swept[0]?.now).toBe(NOW);
  });

  it("still prunes without a provisioner", async () => {
    const { store } = makeStore();
    createHost(store, { id: "named0000000", environmentId: "env-named" });
    const result = await runRegistrySweep({ store, provisioner: null, now: NOW });
    expect(result).toEqual({ prunedClients: 0, prunedRateLimits: 0, sweepFailed: false });
  });
});

describe("RegistryDurableObject", () => {
  it("serves health from its own store", async () => {
    const { state } = makeState();
    const registry = new RegistryDurableObject(state, workerEnv());
    const response = await registry.fetch(new Request("https://relay.test/v1/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, version: 2, mode: "quick" });
  });

  it("returns 503 when the environment is not configured", async () => {
    const { state } = makeState();
    const registry = new RegistryDurableObject(state, workerEnv({ T3CODE_SECRET_KEY: undefined }));
    const response = await registry.fetch(new Request("https://relay.test/v1/health"));
    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toHaveProperty("error");
  });

  it("serializes concurrent registrations for one environment", async () => {
    const { state, fake } = makeState();
    const registry = new RegistryDurableObject(state, workerEnv());
    const [first, second] = await Promise.all([
      registry.fetch(registerRequest("env-a")),
      registry.fetch(registerRequest("env-a")),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(firstBody["hostId"]).toBe(secondBody["hostId"]);
    expect(fake.rows("SELECT COUNT(*) AS count FROM hosts")).toEqual([{ count: 1 }]);
  });

  it("reschedules its daily alarm even when the environment is invalid", async () => {
    const valid = makeState();
    const registry = new RegistryDurableObject(valid.state, workerEnv());
    await registry.alarm();
    expect(valid.alarms).toHaveLength(1);
    expect(valid.alarms[0]).toBeGreaterThan(0);

    const invalid = makeState();
    const unconfigured = new RegistryDurableObject(
      invalid.state,
      workerEnv({ T3CODE_ADMIN_KEY: undefined }),
    );
    await unconfigured.alarm();
    expect(invalid.alarms).toHaveLength(1);
  });
});
