import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
});

import {
  addPersonalNetworkHost,
  readPersonalNetworkHosts,
  refreshPersonalNetworkHosts,
  removePersonalNetworkHost,
} from "./personalNetwork";

const RELAY = "https://t3.example.test";
const HOST_KEY = "host-key-for-tests-0123456789abcdef";

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

it("adds, refreshes, and removes one host per key", async () => {
  vi.stubGlobal("fetch", async () => jsonResponse(resolved));
  const pair = vi.fn(async () => ({ ok: true, error: null }));

  const host = await addPersonalNetworkHost({ relayUrl: RELAY, hostKey: HOST_KEY, pair });
  expect(pair).toHaveBeenCalledWith({
    host: resolved.publicUrl,
    pairingCode: HOST_KEY,
    expectedEnvironmentId: resolved.environmentId,
  });
  expect(readPersonalNetworkHosts()).toEqual([
    expect.objectContaining({ hostId: resolved.hostId, environmentId: resolved.environmentId }),
  ]);

  const refreshed = await refreshPersonalNetworkHosts();
  expect(refreshed[0]).toMatchObject({ online: true, paused: false, lastError: null });

  expect(removePersonalNetworkHost(host)).toEqual([]);
  vi.unstubAllGlobals();
});

it("reports a rejected key without storing it", async () => {
  vi.stubGlobal("fetch", async () => jsonResponse({}, 401));
  await expect(
    addPersonalNetworkHost({
      relayUrl: RELAY,
      hostKey: HOST_KEY,
      pair: async () => ({ ok: true, error: null }),
    }),
  ).rejects.toMatchObject({ status: 401 });
  expect(readPersonalNetworkHosts()).toEqual([]);
  vi.unstubAllGlobals();
});

it("stops adding when the host refuses the key", async () => {
  vi.stubGlobal("fetch", async () => jsonResponse(resolved));
  await expect(
    addPersonalNetworkHost({
      relayUrl: RELAY,
      hostKey: HOST_KEY,
      pair: async () => ({ ok: false, error: "refused" }),
    }),
  ).rejects.toThrow("refused");
  expect(readPersonalNetworkHosts()).toEqual([]);
  vi.unstubAllGlobals();
});
