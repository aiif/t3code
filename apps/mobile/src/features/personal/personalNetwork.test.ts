import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
});

import {
  upsertPersonalHost,
  type PersonalHostRecord,
} from "@t3tools/client-runtime/personal/portal";
import {
  addPersonalNetworkHost,
  currentPersonalNetworkRelayUrl,
  personalNetworkComputers,
  personalNetworkStorage,
  readPersonalNetworkHosts,
  refreshPersonalNetworkHosts,
  removePersonalNetworkComputer,
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

  expect(removePersonalNetworkComputer(host.environmentId)).toEqual([]);
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

describe("a computer that switched relays", () => {
  const OLD_RELAY = "https://old.example.test";
  const NEW_RELAY = "https://new.example.test";

  const hostRecord = (input: {
    readonly relayUrl: string;
    readonly hostKey: string;
    readonly environmentId?: string;
    readonly online?: boolean;
    readonly paused?: boolean;
  }): PersonalHostRecord => ({
    relayUrl: input.relayUrl,
    hostKey: input.hostKey,
    hostId: "abcdef123456",
    environmentId: input.environmentId ?? "env-home",
    label: "Home",
    publicUrl: "https://abcdef123456.example.test",
    online: input.online ?? true,
    paused: input.paused ?? false,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  // What refreshPersonalHosts leaves behind once the host no longer shares through the old relay.
  const deadOld = {
    ...hostRecord({ relayUrl: OLD_RELAY, hostKey: `${HOST_KEY}-old`, online: false }),
    lastError: "Could not reach the relay. Check the URL and your connection.",
  };
  const liveNew = hostRecord({ relayUrl: NEW_RELAY, hostKey: `${HOST_KEY}-new` });

  it("shows one row through the live route, not the dead old relay", () => {
    const computers = personalNetworkComputers([deadOld, liveNew]);
    expect(computers).toHaveLength(1);
    expect(computers[0]).toMatchObject({ relayUrl: NEW_RELAY, online: true, lastError: null });
    expect(currentPersonalNetworkRelayUrl([deadOld, liveNew])).toBe(NEW_RELAY);
  });

  it("keeps other computers in their own rows", () => {
    const other = hostRecord({
      relayUrl: NEW_RELAY,
      hostKey: `${HOST_KEY}-work`,
      environmentId: "env-work",
    });
    expect(
      personalNetworkComputers([deadOld, liveNew, other]).map((host) => host.environmentId),
    ).toEqual(["env-home", "env-work"]);
  });

  it("speaks through the newest route when every relay is dead", () => {
    const deadNew = { ...liveNew, online: false, lastError: "Could not reach the relay." };
    expect(personalNetworkComputers([deadOld, deadNew])).toMatchObject([
      { relayUrl: NEW_RELAY, online: false },
    ]);
  });

  it("prefers a paused route over a dead one", () => {
    const pausedNew = { ...liveNew, online: false, paused: true };
    expect(personalNetworkComputers([deadOld, pausedNew])).toMatchObject([
      { relayUrl: NEW_RELAY, paused: true },
    ]);
  });

  it("forgetting a computer drops all its relay routes", () => {
    upsertPersonalHost(deadOld, personalNetworkStorage);
    upsertPersonalHost(liveNew, personalNetworkStorage);
    upsertPersonalHost(
      hostRecord({ relayUrl: NEW_RELAY, hostKey: `${HOST_KEY}-work`, environmentId: "env-work" }),
      personalNetworkStorage,
    );

    const remaining = removePersonalNetworkComputer("env-home");
    expect(remaining.map((host) => host.environmentId)).toEqual(["env-work"]);
    expect(readPersonalNetworkHosts().map((host) => host.environmentId)).toEqual(["env-work"]);
    removePersonalNetworkComputer("env-work");
  });
});
