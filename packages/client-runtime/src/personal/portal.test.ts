import { describe, expect, it } from "vite-plus/test";

import {
  PERSONAL_ADMIN_KEY_STORAGE,
  PERSONAL_HOSTS_STORAGE_KEY,
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
  rotateAdminHostKey,
  savePersonalAdminConfig,
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
  it("keeps the admin key under its own key and forgets it", () => {
    const storage = memoryStorage();
    expect(readPersonalAdminConfig(storage)).toBeNull();
    savePersonalAdminConfig({ relayUrl: RELAY, adminKey: ADMIN_KEY }, storage);
    expect(storage.getItem(PERSONAL_ADMIN_KEY_STORAGE)).toBe(ADMIN_KEY);
    expect(readPersonalAdminConfig(storage)).toEqual({ relayUrl: RELAY, adminKey: ADMIN_KEY });
    forgetPersonalAdminConfig(storage);
    expect(readPersonalAdminConfig(storage)).toBeNull();
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
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "POST"]);
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
