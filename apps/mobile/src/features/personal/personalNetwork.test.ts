import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const { secureStore } = vi.hoisted(() => ({
  secureStore: new Map<string, string>(),
}));

vi.mock("expo-secure-store", () => ({
  getItem: (key: string) => secureStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    secureStore.set(key, value);
  },
  deleteItem: (key: string) => {
    secureStore.delete(key);
  },
}));

import {
  forgetPersonalNetwork,
  readPersonalNetworkRecord,
  savePersonalNetworkConfig,
  syncPersonalNetwork,
} from "./personalNetwork";

const KEY = "personal-key-for-tests-0123456789abcdef";

const host = (overrides: Record<string, unknown> = {}) => ({
  hostId: "abcdef123456",
  environmentId: "env-home",
  label: "Home",
  publicUrl: "https://abcdef123456.t3.example.test",
  online: true,
  lastSeenAt: "2026-11-15T10:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  secureStore.clear();
  vi.unstubAllGlobals();
});

it("stores the key and paired hosts, then forgets them", () => {
  expect(readPersonalNetworkRecord()).toBeNull();

  savePersonalNetworkConfig({ relayUrl: "https://t3.example.test/", key: KEY });
  expect(readPersonalNetworkRecord()).toEqual({
    relayUrl: "https://t3.example.test",
    key: KEY,
    pairedEnvironmentIds: [],
  });

  forgetPersonalNetwork();
  expect(readPersonalNetworkRecord()).toBeNull();
});

it("discovers hosts and pairs only the ones this device has not paired", async () => {
  savePersonalNetworkConfig({ relayUrl: "https://t3.example.test", key: KEY });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hosts: [host()] }),
    })),
  );

  const paired: string[] = [];
  const result = await syncPersonalNetwork({
    pair: async ({ host: publicUrl, pairingCode, expectedEnvironmentId }) => {
      paired.push(`${expectedEnvironmentId}@${publicUrl}#${pairingCode}`);
      return EnvironmentId.make("env-home");
    },
  });

  expect(paired).toEqual([`env-home@https://abcdef123456.t3.example.test#${KEY}`]);
  expect(result?.paired).toEqual([EnvironmentId.make("env-home")]);
  expect(readPersonalNetworkRecord()?.pairedEnvironmentIds).toEqual(["env-home"]);

  const second = await syncPersonalNetwork({
    pair: async () => {
      throw new Error("should not pair an already paired host");
    },
  });
  expect(second?.skipped).toEqual(["env-home"]);
});
