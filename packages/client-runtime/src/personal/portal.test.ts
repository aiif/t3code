import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PERSONAL_PORTAL_STORAGE_KEY,
  discoverPersonalHosts,
  forgetPersonalPortal,
  readPersonalPortalRecord,
  recordPairedEnvironments,
  savePersonalPortalConfig,
  syncPersonalPortal,
  type PersonalPortalStorage,
} from "./portal.js";

const KEY = "personal-key-for-tests-0123456789abcdef";

function memoryStorage(): PersonalPortalStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const hostsResponse = (hosts: ReadonlyArray<Record<string, unknown>>) => ({
  ok: true,
  status: 200,
  json: async () => ({ hosts }),
});

const host = (overrides: Record<string, unknown> = {}) => ({
  hostId: "abcdef123456",
  environmentId: "env-home",
  label: "Home",
  publicUrl: "https://abcdef123456.t3.example.test",
  online: true,
  lastSeenAt: "2026-11-15T10:00:00.000Z",
  ...overrides,
});

describe("personal portal storage", () => {
  it("round-trips the key and forgets it", () => {
    const storage = memoryStorage();
    expect(readPersonalPortalRecord(storage)).toBeNull();

    savePersonalPortalConfig({ relayUrl: "https://t3.example.test/", key: KEY }, storage);
    expect(readPersonalPortalRecord(storage)).toEqual({
      relayUrl: "https://t3.example.test",
      key: KEY,
      pairedEnvironmentIds: [],
    });

    forgetPersonalPortal(storage);
    expect(readPersonalPortalRecord(storage)).toBeNull();
  });

  it("keeps paired environments only while the relay and key stay the same", () => {
    const storage = memoryStorage();
    const first = savePersonalPortalConfig(
      { relayUrl: "https://t3.example.test", key: KEY },
      storage,
    );
    recordPairedEnvironments(first, ["env-home"], storage);

    const same = savePersonalPortalConfig(
      { relayUrl: "https://t3.example.test", key: KEY },
      storage,
    );
    expect(same.pairedEnvironmentIds).toEqual(["env-home"]);

    const rotated = savePersonalPortalConfig(
      { relayUrl: "https://t3.example.test", key: "another-personal-key-0123456789abcdef" },
      storage,
    );
    expect(rotated.pairedEnvironmentIds).toEqual([]);
  });

  it("ignores a corrupt record", () => {
    const storage = memoryStorage();
    storage.setItem(PERSONAL_PORTAL_STORAGE_KEY, "{not json");
    expect(readPersonalPortalRecord(storage)).toBeNull();
  });
});

describe("host discovery", () => {
  it("lists hosts with the personal key", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const hosts = await discoverPersonalHosts({
      relayUrl: "https://t3.example.test/",
      key: KEY,
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          authorization: new Headers(init.headers).get("authorization"),
        });
        return hostsResponse([host()]) as unknown as Response;
      },
    });

    expect(calls).toEqual([
      {
        url: "https://t3.example.test/v1/hosts",
        authorization: `Bearer ${KEY}`,
      },
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ hostId: "abcdef123456", online: true });
  });

  it("reports a rejected key and an unreachable relay distinctly", async () => {
    await expect(
      discoverPersonalHosts({
        relayUrl: "https://t3.example.test",
        key: KEY,
        fetchImpl: async () =>
          ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response,
      }),
    ).rejects.toMatchObject({ status: 401 });

    await expect(
      discoverPersonalHosts({
        relayUrl: "https://t3.example.test",
        key: KEY,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toMatchObject({ _tag: "PersonalPortalError" });
  });
});

describe("portal sync", () => {
  const config = { relayUrl: "https://t3.example.test", key: KEY };

  it("pairs only hosts this device has not paired", async () => {
    const paired: string[] = [];
    const record = { ...config, pairedEnvironmentIds: ["env-known"] };
    const result = await syncPersonalPortal({
      config,
      record,
      fetchImpl: async () =>
        hostsResponse([
          host({ environmentId: "env-known", hostId: "aaaaaaaaaaaa" }),
          host({ environmentId: "env-home", hostId: "bbbbbbbbbbbb" }),
        ]) as unknown as Response,
      pair: async (input) => {
        paired.push(`${input.expectedEnvironmentId}@${input.host}`);
        return EnvironmentId.make("env-home");
      },
    });

    expect(paired).toEqual(["env-home@https://abcdef123456.t3.example.test"]);
    expect(result.paired).toEqual([EnvironmentId.make("env-home")]);
    expect(result.skipped).toEqual(["env-known"]);
    expect(result.failures).toEqual([]);
  });

  it("pairs an environment once even if the registry lists it twice", async () => {
    let calls = 0;
    const result = await syncPersonalPortal({
      config,
      record: { ...config, pairedEnvironmentIds: [] },
      fetchImpl: async () =>
        hostsResponse([host(), host({ hostId: "ffffffffffff" })]) as unknown as Response,
      pair: async () => {
        calls += 1;
        return EnvironmentId.make("env-home");
      },
    });

    expect(calls).toBe(1);
    expect(result.paired).toHaveLength(1);
  });

  it("keeps going when one host is offline", async () => {
    const result = await syncPersonalPortal({
      config,
      record: { ...config, pairedEnvironmentIds: [] },
      fetchImpl: async () =>
        hostsResponse([
          host({ environmentId: "env-offline", hostId: "aaaaaaaaaaaa", online: false }),
          host({ environmentId: "env-home", hostId: "bbbbbbbbbbbb" }),
        ]) as unknown as Response,
      pair: async (input) => {
        if (input.expectedEnvironmentId === EnvironmentId.make("env-offline")) {
          throw new Error("host unreachable");
        }
        return EnvironmentId.make("env-home");
      },
    });

    expect(result.paired).toEqual([EnvironmentId.make("env-home")]);
    expect(result.failures).toEqual([
      {
        hostId: "aaaaaaaaaaaa",
        environmentId: "env-offline",
        message: "host unreachable",
      },
    ]);
  });
});
