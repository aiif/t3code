import { describe, expect, it, vi } from "vite-plus/test";

import {
  PERSONAL_ADMIN_KEY_STORAGE,
  PERSONAL_ADMIN_RELAY_STORAGE,
  PERSONAL_HOSTS_STORAGE_KEY,
  detectAndConnectPersonalKey,
  forgetPersonalAdminConfig,
  getAdminHost,
  listAdminHosts,
  personalHostRecord,
  readPersonalAdminConfig,
  readPersonalHosts,
  refreshPersonalHosts,
  removeAdminHost,
  removePersonalHost,
  resolvePersonalHost,
  restoreAdminHost,
  rotateAdminHostKey,
  savePersonalAdminConfig,
  syncPersonalRelayRoutes,
  upsertPersonalHost,
  type PersonalStorage,
} from "./portal.js";

const ADMIN_KEY = "admin-key-for-tests-0123456789abcdef";
const HOST_KEY = "host-key-for-tests-0123456789abcdef";
const RELAY = "https://t3.example.test";

function memoryStorage(): PersonalStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const resolved = {
  hostId: "abcdef123456",
  environmentId: "env-home",
  label: "Home",
  publicUrl: "https://abcdef123456.t3.example.test",
  online: true,
  paused: false,
};

describe("admin storage", () => {
  it("keeps the admin key under its own key and forgets the whole console config", () => {
    const storage = memoryStorage();
    expect(readPersonalAdminConfig(storage)).toBeNull();
    savePersonalAdminConfig({ relayUrl: RELAY, adminKey: ADMIN_KEY }, storage);
    expect(storage.getItem(PERSONAL_ADMIN_KEY_STORAGE)).toBe(ADMIN_KEY);
    expect(readPersonalAdminConfig(storage)).toEqual({ relayUrl: RELAY, adminKey: ADMIN_KEY });
    forgetPersonalAdminConfig(storage);
    expect(readPersonalAdminConfig(storage)).toBeNull();
    expect(storage.getItem(PERSONAL_ADMIN_KEY_STORAGE)).toBeNull();
    expect(storage.getItem(PERSONAL_ADMIN_RELAY_STORAGE)).toBeNull();
  });
});

describe("admin api", () => {
  it("sends the admin key and decodes hosts", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const hosts = await listAdminHosts({
      config: { relayUrl: RELAY, adminKey: ADMIN_KEY },
      fetchImpl: async (url, init) => {
        calls.push({ url, authorization: new Headers(init.headers).get("authorization") });
        return jsonResponse({
          hosts: [
            {
              hostId: "abcdef123456",
              environmentId: "env-home",
              label: "Home",
              platform: "win32",
              online: true,
              paused: false,
              lastSeenAt: "2026-11-16T00:00:00.000Z",
              publicUrl: resolved.publicUrl,
              hostKey: HOST_KEY,
              clientsCount: 0,
              createdAt: "2026-11-15T00:00:00.000Z",
            },
          ],
        });
      },
    });
    expect(calls).toEqual([
      { url: `${RELAY}/v1/admin/hosts`, authorization: `Bearer ${ADMIN_KEY}` },
    ]);
    expect(hosts[0]?.hostKey).toBe(HOST_KEY);
  });

  it("reads clients, rotates, and removes through admin-only routes", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? "GET" });
      if (url.endsWith("/clients")) {
        return jsonResponse({
          host: {
            hostId: "abcdef123456",
            environmentId: "env-home",
            label: "Home",
            platform: "win32",
            online: true,
            paused: false,
            lastSeenAt: "2026-11-16T00:00:00.000Z",
            publicUrl: resolved.publicUrl,
            hostKey: HOST_KEY,
            clientsCount: 1,
            createdAt: "2026-11-15T00:00:00.000Z",
          },
          clients: [
            {
              sessionId: "session-1",
              clientLabel: "Phone",
              platform: "mobile",
              firstSeenAt: "2026-11-16T00:00:00.000Z",
              lastSeenAt: "2026-11-16T00:05:00.000Z",
              revokedAt: null,
            },
          ],
        });
      }
      if (url.endsWith("/rotate-key")) return jsonResponse({ hostKey: "rotated-host-key" });
      return jsonResponse({ removed: true });
    };

    const detail = await getAdminHost({
      config: { relayUrl: RELAY, adminKey: ADMIN_KEY },
      hostId: "abcdef123456",
      fetchImpl,
    });
    expect(detail.clients[0]?.clientLabel).toBe("Phone");
    expect(
      await rotateAdminHostKey({
        config: { relayUrl: RELAY, adminKey: ADMIN_KEY },
        hostId: "abcdef123456",
        fetchImpl,
      }),
    ).toBe("rotated-host-key");
    await removeAdminHost({
      config: { relayUrl: RELAY, adminKey: ADMIN_KEY },
      hostId: "abcdef123456",
      fetchImpl,
    });
    await restoreAdminHost({
      config: { relayUrl: RELAY, adminKey: ADMIN_KEY },
      hostId: "abcdef123456",
      fetchImpl,
    });
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "POST", "POST"]);
  });
});

describe("guest hosts", () => {
  it("resolves a host key and stores one record per host", async () => {
    const storage = memoryStorage();
    const host = await resolvePersonalHost({
      relayUrl: `${RELAY}/`,
      hostKey: HOST_KEY,
      fetchImpl: async () => jsonResponse(resolved),
    });
    expect(host).toEqual(resolved);
    const record = personalHostRecord({ relayUrl: RELAY, hostKey: HOST_KEY, resolved: host });
    upsertPersonalHost(record, storage);
    upsertPersonalHost(record, storage);
    expect(readPersonalHosts(storage)).toHaveLength(1);
    expect(readPersonalHosts(storage)[0]).toMatchObject({
      hostId: resolved.hostId,
      hostKey: HOST_KEY,
      online: true,
    });
  });

  it("rejects an invalid key and an unreachable relay distinctly", async () => {
    await expect(
      resolvePersonalHost({
        relayUrl: RELAY,
        hostKey: HOST_KEY,
        fetchImpl: async () => jsonResponse({}, 401),
      }),
    ).rejects.toMatchObject({ status: 401 });

    await expect(
      resolvePersonalHost({
        relayUrl: RELAY,
        hostKey: HOST_KEY,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toMatchObject({ _tag: "PersonalHostError" });
  });

  it("refreshes each host independently and keeps the last good state on failure", async () => {
    const storage = memoryStorage();
    const first = personalHostRecord({ relayUrl: RELAY, hostKey: HOST_KEY, resolved });
    const second = personalHostRecord({
      relayUrl: RELAY,
      hostKey: `${HOST_KEY}-b`,
      resolved: { ...resolved, hostId: "ffffffffffff", environmentId: "env-b" },
    });
    upsertPersonalHost(first, storage);
    upsertPersonalHost(second, storage);

    const refreshed = await refreshPersonalHosts({
      hosts: readPersonalHosts(storage),
      fetchImpl: async (url, init) => {
        const key = new Headers(init.headers).get("authorization");
        if (url.endsWith("/resolve") && key === `Bearer ${HOST_KEY}`) {
          return jsonResponse({ ...resolved, online: false, paused: true });
        }
        throw new Error("host unreachable");
      },
    });
    expect(refreshed.find((host) => host.hostId === resolved.hostId)).toMatchObject({
      online: false,
      paused: true,
      lastError: null,
    });
    expect(refreshed.find((host) => host.hostId === "ffffffffffff")).toMatchObject({
      online: false,
      lastError: "Could not reach the relay. Check the URL and your connection.",
    });
  });

  it("removes only the requested host", () => {
    const storage = memoryStorage();
    const first = personalHostRecord({ relayUrl: RELAY, hostKey: HOST_KEY, resolved });
    upsertPersonalHost(first, storage);
    upsertPersonalHost(
      personalHostRecord({
        relayUrl: RELAY,
        hostKey: `${HOST_KEY}-b`,
        resolved: { ...resolved, hostId: "ffffffffffff" },
      }),
      storage,
    );
    removePersonalHost({ hostId: first.hostId, relayUrl: RELAY }, storage);
    expect(readPersonalHosts(storage).map((host) => host.hostId)).toEqual(["ffffffffffff"]);
  });

  it("ignores a corrupt host list", () => {
    const storage = memoryStorage();
    storage.setItem(PERSONAL_HOSTS_STORAGE_KEY, "{not json");
    expect(readPersonalHosts(storage)).toEqual([]);
  });
});

describe("relay route sync", () => {
  const environmentId = resolved.environmentId as never;

  it("pairs a new route once and remembers it", async () => {
    const storage = memoryStorage();
    const pair = vi.fn(async () => ({ ok: true }));
    const fetchImpl = async () => jsonResponse(resolved);

    const hosts = await syncPersonalRelayRoutes({
      environmentId,
      routes: [{ relayUrl: RELAY, hostKey: HOST_KEY }],
      pair,
      storage,
      fetchImpl,
    });

    expect(pair).toHaveBeenCalledExactlyOnceWith({
      host: resolved.publicUrl,
      pairingCode: HOST_KEY,
      expectedEnvironmentId: environmentId,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ relayUrl: RELAY, hostKey: HOST_KEY });

    const again = await syncPersonalRelayRoutes({
      environmentId,
      routes: [{ relayUrl: RELAY, hostKey: HOST_KEY }],
      pair,
      storage,
      fetchImpl,
    });
    expect(pair).toHaveBeenCalledTimes(1);
    expect(again).toHaveLength(1);
  });

  it("retries a route while the relay reports the host offline", async () => {
    const storage = memoryStorage();
    const pair = vi.fn(async () => ({ ok: true }));
    const fetchImpl = async () => jsonResponse({ ...resolved, online: false });

    await syncPersonalRelayRoutes({
      environmentId,
      routes: [{ relayUrl: RELAY, hostKey: HOST_KEY }],
      pair,
      storage,
      fetchImpl,
    });
    expect(pair).not.toHaveBeenCalled();

    await syncPersonalRelayRoutes({
      environmentId,
      routes: [{ relayUrl: RELAY, hostKey: HOST_KEY }],
      pair,
      storage,
      fetchImpl: async () => jsonResponse(resolved),
    });
    expect(pair).toHaveBeenCalledOnce();
  });

  it("ignores a key that resolves to a different environment", async () => {
    const storage = memoryStorage();
    const pair = vi.fn(async () => ({ ok: true }));
    await syncPersonalRelayRoutes({
      environmentId,
      routes: [{ relayUrl: RELAY, hostKey: HOST_KEY }],
      pair,
      storage,
      fetchImpl: async () => jsonResponse({ ...resolved, environmentId: "env-other" }),
    });
    expect(pair).not.toHaveBeenCalled();
  });
});

describe("detectAndConnectPersonalKey", () => {
  it("resolves and pairs a valid host key first", async () => {
    const storage = memoryStorage();
    const pair = vi.fn(async () => ({ ok: true }));
    const outcome = await detectAndConnectPersonalKey({
      relayUrl: RELAY,
      key: HOST_KEY,
      storage,
      pairHost: pair,
      fetchImpl: async (url) => {
        if (url.endsWith("/hosts/resolve")) {
          return jsonResponse(resolved);
        }
        return jsonResponse({}, 401);
      },
    });

    expect(outcome.kind).toBe("host");
    if (outcome.kind === "host") {
      expect(outcome.host.hostId).toBe(resolved.hostId);
      expect(outcome.record.hostKey).toBe(HOST_KEY);
    }
    expect(pair).toHaveBeenCalledOnce();
    expect(readPersonalHosts(storage)).toHaveLength(1);
    expect(readPersonalAdminConfig(storage)).toBeNull();
  });

  it("falls back to admin key, saves admin config and pairs all active hosts", async () => {
    const storage = memoryStorage();
    const pair = vi.fn(async () => ({ ok: true }));
    const outcome = await detectAndConnectPersonalKey({
      relayUrl: RELAY,
      key: ADMIN_KEY,
      storage,
      pairHost: pair,
      fetchImpl: async (url) => {
        if (url.endsWith("/hosts/resolve")) {
          return jsonResponse({}, 401);
        }
        if (url.endsWith("/admin/hosts")) {
          return jsonResponse({
            hosts: [
              {
                hostId: "abcdef123456",
                environmentId: "env-home",
                label: "Home PC",
                platform: "win32",
                online: true,
                paused: false,
                lastSeenAt: "2026-11-16T00:00:00.000Z",
                publicUrl: "https://abcdef123456.t3.example.test",
                hostKey: "host-key-1",
                clientsCount: 0,
                createdAt: "2026-11-15T00:00:00.000Z",
                revokedAt: null,
              },
              {
                hostId: "offline-host",
                environmentId: "env-offline",
                label: "Office PC",
                platform: "linux",
                online: false,
                paused: false,
                lastSeenAt: "2026-11-16T00:00:00.000Z",
                publicUrl: "https://offline.t3.example.test",
                hostKey: "host-key-2",
                clientsCount: 0,
                createdAt: "2026-11-15T00:00:00.000Z",
                revokedAt: null,
              },
              {
                hostId: "revoked-host",
                environmentId: "env-revoked",
                label: "Revoked PC",
                platform: "linux",
                online: true,
                paused: false,
                lastSeenAt: "2026-11-16T00:00:00.000Z",
                publicUrl: "https://revoked.t3.example.test",
                hostKey: "host-key-3",
                clientsCount: 0,
                createdAt: "2026-11-15T00:00:00.000Z",
                revokedAt: "2026-11-16T12:00:00.000Z",
              },
            ],
          });
        }
        return jsonResponse({}, 404);
      },
    });

    expect(outcome.kind).toBe("admin");
    if (outcome.kind === "admin") {
      expect(outcome.records).toHaveLength(2); // Only non-revoked hosts
    }
    expect(pair).toHaveBeenCalledOnce(); // Only the 1 online non-revoked host is paired
    expect(readPersonalHosts(storage)).toHaveLength(2);
    expect(readPersonalAdminConfig(storage)).toEqual({
      relayUrl: RELAY,
      adminKey: ADMIN_KEY,
    });
  });

  it("throws when rejected by both host resolve and admin hosts", async () => {
    const storage = memoryStorage();
    const pair = vi.fn(async () => ({ ok: true }));
    await expect(
      detectAndConnectPersonalKey({
        relayUrl: RELAY,
        key: "invalid-key",
        storage,
        pairHost: pair,
        fetchImpl: async () => jsonResponse({}, 401),
      }),
    ).rejects.toThrow("Invalid key: rejected as both a host key and an admin key on this relay.");
    expect(pair).not.toHaveBeenCalled();
    expect(readPersonalHosts(storage)).toHaveLength(0);
    expect(readPersonalAdminConfig(storage)).toBeNull();
  });
});
