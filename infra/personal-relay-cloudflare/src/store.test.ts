import { describe, expect, it } from "vite-plus/test";

import { createSqliteRegistryStore } from "./store.ts";
import { SCHEMA_VERSION, type HostRow, type RegistryStore } from "./store/types.ts";
import { createFakeSqlStorage, type FakeSqlStorage } from "./testing/fakeSqlStorage.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = 1_700_000_000_000;

function makeStore(): { readonly store: RegistryStore; readonly fake: FakeSqlStorage } {
  const fake = createFakeSqlStorage();
  return { store: createSqliteRegistryStore(fake.sql), fake };
}

function createHost(
  store: RegistryStore,
  overrides: Partial<Parameters<RegistryStore["createHost"]>[0]> = {},
): HostRow {
  return store.createHost({
    id: "abc123def456",
    environmentId: "env-a",
    label: "Home PC",
    platform: "win32",
    hostKeyHash: "key-hash",
    hostKeyCiphertext: "v1.nonce.tag.ciphertext",
    hostTokenHash: "token-hash",
    connectorMode: "quick",
    hostname: null,
    originPort: null,
    publicUrl: "",
    now: NOW,
    ...overrides,
  });
}

describe("SQLite registry store: host records", () => {
  it("creates the schema and reports its version from the meta table", () => {
    const { store, fake } = makeStore();
    expect(store.getSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(store.getMeta("missing")).toBeNull();

    store.setMeta("note", "value");
    expect(store.getMeta("note")).toBe("value");

    createHost(store);
    const reopened = createSqliteRegistryStore(fake.sql);
    expect(reopened.getSchemaVersion()).toBe(SCHEMA_VERSION);
    expect(reopened.getHost("abc123def456")?.label).toBe("Home PC");
  });

  it("creates a host with defaults and finds it by environment, key and token", () => {
    const { store } = makeStore();
    const created = createHost(store);
    expect(created).toMatchObject({
      id: "abc123def456",
      environmentId: "env-a",
      label: "Home PC",
      platform: "win32",
      keyVersion: 1,
      online: 1,
      paused: 0,
      revokedAt: null,
      connectorMode: "quick",
      tunnelId: null,
      dnsRecordId: null,
      hostname: null,
      originPort: null,
      publicUrl: "",
      lastSeenAt: NOW,
      createdAt: NOW,
    });

    expect(store.findHostByEnvironment("env-a")?.id).toBe("abc123def456");
    expect(store.findHostByEnvironment("env-b")).toBeNull();
    expect(store.findHostByKeyHash("key-hash")?.id).toBe("abc123def456");
    expect(store.findHostByTokenHash("token-hash")?.id).toBe("abc123def456");
    expect(store.findHostByKeyHash("other")).toBeNull();
  });

  it("updates a registration without touching the host key or version", () => {
    const { store } = makeStore();
    createHost(store);
    const updated = store.updateRegistration({
      hostId: "abc123def456",
      label: "Renamed",
      platform: "darwin",
      hostTokenHash: "token-two",
      connectorMode: "named",
      hostname: "abc123def456.example.test",
      originPort: 3773,
      publicUrl: "https://abc123def456.example.test",
      now: NOW + 1_000,
    });
    expect(updated).toMatchObject({
      label: "Renamed",
      platform: "darwin",
      connectorMode: "named",
      hostname: "abc123def456.example.test",
      originPort: 3773,
      publicUrl: "https://abc123def456.example.test",
      hostTokenHash: "token-two",
      keyVersion: 1,
      online: 1,
      paused: 0,
      lastSeenAt: NOW + 1_000,
    });
    expect(store.findHostByTokenHash("token-two")?.id).toBe("abc123def456");
    expect(store.findHostByTokenHash("token-hash")).toBeNull();
    expect(store.findHostByKeyHash("key-hash")?.id).toBe("abc123def456");
  });

  it("stores tunnel identifiers through setConnector", () => {
    const { store } = makeStore();
    createHost(store);
    const updated = store.setConnector({
      hostId: "abc123def456",
      connectorMode: "named",
      tunnelId: "tunnel-1",
      dnsRecordId: "dns-1",
      hostname: "abc123def456.example.test",
      originPort: 3773,
      publicUrl: "https://abc123def456.example.test",
      now: NOW + 5_000,
    });
    expect(updated).toMatchObject({
      connectorMode: "named",
      tunnelId: "tunnel-1",
      dnsRecordId: "dns-1",
      hostname: "abc123def456.example.test",
      publicUrl: "https://abc123def456.example.test",
      lastSeenAt: NOW + 5_000,
    });
    expect(
      store.setConnector({
        hostId: "unknown000000",
        connectorMode: "quick",
        tunnelId: null,
        dnsRecordId: null,
        hostname: null,
        originPort: null,
        publicUrl: "",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("applies heartbeat labels, presence and quick public URLs", () => {
    const { store } = makeStore();
    createHost(store);

    expect(store.touchHeartbeat({ hostId: "abc123def456", now: NOW + 1_000 })).toMatchObject({
      label: "Home PC",
      online: 1,
      paused: 0,
      publicUrl: "",
      lastSeenAt: NOW + 1_000,
    });

    expect(
      store.touchHeartbeat({
        hostId: "abc123def456",
        label: null,
        online: false,
        publicUrl: "https://quick.trycloudflare.com",
        now: NOW + 2_000,
      }),
    ).toMatchObject({
      label: null,
      online: 0,
      paused: 1,
      publicUrl: "https://quick.trycloudflare.com",
    });

    expect(
      store.touchHeartbeat({
        hostId: "abc123def456",
        publicUrl: "",
        now: NOW + 3_000,
      }),
    ).toMatchObject({
      online: 1,
      paused: 0,
      publicUrl: "https://quick.trycloudflare.com",
      lastSeenAt: NOW + 3_000,
    });

    expect(store.touchHeartbeat({ hostId: "missing000000", now: NOW })).toBeNull();
  });

  it("rotates the host key and bumps the version", () => {
    const { store } = makeStore();
    createHost(store);
    expect(
      store.rotateHostKey({
        hostId: "abc123def456",
        hostKeyHash: "key-two",
        hostKeyCiphertext: "v1.nonce.tag.ciphertext2",
        now: NOW + 1_000,
      }),
    ).toBe(2);
    expect(store.findHostByKeyHash("key-hash")).toBeNull();
    const rotated = store.findHostByKeyHash("key-two");
    expect(rotated).toMatchObject({ keyVersion: 2, online: 1, paused: 0 });
    expect(rotated?.hostKeyCiphertext).toBe("v1.nonce.tag.ciphertext2");
  });

  it("deletes a host and its clients explicitly", () => {
    const { store, fake } = makeStore();
    createHost(store);
    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "session-a",
          clientLabel: null,
          platform: null,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ],
      NOW,
    );
    expect(store.deleteHost("abc123def456")).toBe(true);
    expect(store.getHost("abc123def456")).toBeNull();
    expect(store.listClients("abc123def456")).toHaveLength(0);
    expect(fake.rows("SELECT id FROM host_clients")).toHaveLength(0);
    expect(store.deleteHost("abc123def456")).toBe(false);
  });

  it("revokes and restores hosts without losing the environment binding", () => {
    const { store } = makeStore();
    createHost(store);
    expect(store.countActiveHosts()).toBe(1);

    expect(store.revokeHost("abc123def456", NOW + 1_000)).toBe(true);
    expect(store.revokeHost("abc123def456", NOW + 2_000)).toBe(false);
    expect(store.countActiveHosts()).toBe(0);
    expect(store.findHostByKeyHash("key-hash")).toBeNull();
    expect(store.findHostByTokenHash("token-hash")).toBeNull();
    expect(store.findHostByEnvironment("env-a")).toMatchObject({
      revokedAt: NOW + 1_000,
      online: 0,
      paused: 0,
    });
    expect(store.getHost("abc123def456")?.revokedAt).toBe(NOW + 1_000);
    expect(
      store.updateRegistration({
        hostId: "abc123def456",
        label: null,
        platform: null,
        hostTokenHash: "token-two",
        connectorMode: "quick",
        hostname: null,
        originPort: null,
        publicUrl: "",
        now: NOW,
      }),
    ).toBeNull();

    expect(store.restoreHost("abc123def456", NOW + 3_000)).toBe(true);
    expect(store.restoreHost("abc123def456", NOW + 4_000)).toBe(false);
    expect(store.getHost("abc123def456")).toMatchObject({
      revokedAt: null,
      online: 0,
      paused: 0,
      lastSeenAt: NOW + 3_000,
    });
    expect(store.countActiveHosts()).toBe(1);
  });

  it("lists hosts oldest first", () => {
    const { store } = makeStore();
    createHost(store);
    createHost(store, {
      id: "second000000",
      environmentId: "env-b",
      hostKeyHash: "key-hash-b",
      hostTokenHash: "token-hash-b",
      now: NOW + 1_000,
    });
    createHost(store, {
      id: "first0000000",
      environmentId: "env-c",
      hostKeyHash: "key-hash-c",
      hostTokenHash: "token-hash-c",
      now: NOW - 1_000,
    });
    expect(store.listHosts().map((host) => host.id)).toEqual([
      "first0000000",
      "abc123def456",
      "second000000",
    ]);
  });
});

describe("SQLite registry store: client snapshots", () => {
  it("keeps min firstSeen, max lastSeen and revokes sessions missing from a snapshot", () => {
    const { store } = makeStore();
    createHost(store);
    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "a",
          clientLabel: "Laptop",
          platform: "darwin",
          firstSeenAt: NOW + 5_000,
          lastSeenAt: NOW + 6_000,
        },
        {
          sessionId: "b",
          clientLabel: "Phone",
          platform: "android",
          firstSeenAt: NOW + 4_000,
          lastSeenAt: NOW + 4_500,
        },
      ],
      NOW,
    );

    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "a",
          clientLabel: "Work laptop",
          platform: "darwin",
          firstSeenAt: NOW + 3_000,
          lastSeenAt: NOW + 9_000,
        },
      ],
      NOW + 1_000,
    );

    const clients = store.listClients("abc123def456");
    expect(clients.map((client) => client.sessionId)).toEqual(["a", "b"]);
    expect(clients[0]).toMatchObject({
      clientLabel: "Work laptop",
      firstSeenAt: NOW + 3_000,
      lastSeenAt: NOW + 9_000,
      revokedAt: null,
    });
    expect(clients[1]).toMatchObject({ revokedAt: NOW + 1_000 });
    expect(store.countClients("abc123def456")).toBe(1);
    expect(store.revokedClients("abc123def456", NOW + 1_000)).toEqual(["b"]);
    expect(store.revokedClients("abc123def456", NOW + 1_000 + DAY_MS + 1)).toEqual([]);
  });

  it("revokes one client and reports it for 24 hours", () => {
    const { store } = makeStore();
    createHost(store);
    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "a",
          clientLabel: null,
          platform: null,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ],
      NOW,
    );
    expect(store.revokeClient("abc123def456", "a", NOW + 1_000)).toBe(true);
    expect(store.revokeClient("abc123def456", "a", NOW + 2_000)).toBe(false);
    expect(store.revokeClient("abc123def456", "missing", NOW)).toBe(false);
    expect(store.countClients("abc123def456")).toBe(0);
    expect(store.revokedClients("abc123def456", NOW + 1_000)).toEqual(["a"]);
    expect(store.revokedClients("abc123def456", NOW + 1_000 + DAY_MS + 1)).toEqual([]);
  });

  it("prunes revoked clients older than 30 days and keeps live ones", () => {
    const { store } = makeStore();
    createHost(store);
    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "stale",
          clientLabel: null,
          platform: null,
          firstSeenAt: NOW - 40 * DAY_MS,
          lastSeenAt: NOW - 40 * DAY_MS,
        },
        {
          sessionId: "fresh",
          clientLabel: null,
          platform: null,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ],
      NOW - 39 * DAY_MS,
    );
    store.revokeClient("abc123def456", "stale", NOW - 39 * DAY_MS);

    expect(store.listClients("abc123def456")).toHaveLength(2);
    expect(store.pruneClients(NOW - 30 * DAY_MS)).toBe(1);
    expect(store.listClients("abc123def456").map((client) => client.sessionId)).toEqual(["fresh"]);
  });

  it("revokes and prunes stale rows inside a replacement snapshot", () => {
    const { store } = makeStore();
    createHost(store);
    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "old",
          clientLabel: null,
          platform: null,
          firstSeenAt: NOW - 40 * DAY_MS,
          lastSeenAt: NOW - 40 * DAY_MS,
        },
      ],
      NOW - 39 * DAY_MS,
    );
    store.replaceClients("abc123def456", [], NOW);
    expect(store.listClients("abc123def456")).toHaveLength(0);
  });
});

describe("SQLite registry store: rate limits and audit", () => {
  it("allows a fixed number of requests per window and resets afterwards", () => {
    const { store } = makeStore();
    const input = {
      scope: "register",
      key: "203.0.113.7",
      limit: 2,
      windowMs: 60_000,
      now: NOW,
    };
    expect(store.consumeRateLimit(input)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    expect(store.consumeRateLimit(input).remaining).toBe(0);
    const blocked = store.consumeRateLimit(input);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(60_000);

    expect(store.consumeRateLimit({ ...input, key: "203.0.113.8" }).allowed).toBe(true);
    expect(store.consumeRateLimit({ ...input, scope: "resolve" }).allowed).toBe(true);
    expect(store.consumeRateLimit({ ...input, now: NOW + 60_000 }).allowed).toBe(true);
  });

  it("prunes expired rate-limit buckets", () => {
    const { store } = makeStore();
    store.consumeRateLimit({
      scope: "admin",
      key: "203.0.113.7",
      limit: 10,
      windowMs: 60_000,
      now: NOW,
    });
    expect(store.pruneRateLimits(NOW + 59_999)).toBe(0);
    expect(store.pruneRateLimits(NOW + 60_001)).toBe(1);
  });

  it("records admin audit rows", () => {
    const { store, fake } = makeStore();
    store.audit({ action: "rotate-key", hostId: "abc123def456", actor: "admin", now: NOW });
    store.audit({ action: "remove-host", hostId: null, actor: "admin", now: NOW + 1 });
    expect(
      fake.rows("SELECT action, host_id, actor, created_at FROM admin_audit ORDER BY id"),
    ).toEqual([
      { action: "rotate-key", host_id: "abc123def456", actor: "admin", created_at: NOW },
      { action: "remove-host", host_id: null, actor: "admin", created_at: NOW + 1 },
    ]);
  });
});
