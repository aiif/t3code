import type { EnvironmentId } from "@t3tools/contracts";
import {
  personalHostRecord,
  readPersonalHosts,
  refreshPersonalHosts,
  removePersonalHost,
  resolvePersonalHost,
  upsertPersonalHost,
  type PersonalHostRecord,
  type PersonalStorage,
} from "@t3tools/client-runtime/personal/portal";
import * as SecureStore from "expo-secure-store";

/**
 * Host keys are guest credentials, so they live in the platform keystore
 * rather than app preferences. Each key is one independent host.
 */
export const personalNetworkStorage: PersonalStorage = {
  getItem: (key) => {
    try {
      return SecureStore.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      SecureStore.setItem(key, value);
    } catch {
      // A locked keystore reads as an unconfigured network; the next save retries.
    }
  },
  removeItem: (key) => {
    try {
      // SecureStore has no synchronous delete. An empty array reads back as unconfigured.
      SecureStore.setItem(key, "[]");
    } catch {
      // Removing an already absent record is the desired state.
    }
  },
};

export function readPersonalNetworkHosts(): ReadonlyArray<PersonalHostRecord> {
  return readPersonalHosts(personalNetworkStorage);
}

export type PairPersonalHost = (input: {
  readonly host: string;
  readonly pairingCode: string;
  readonly expectedEnvironmentId: EnvironmentId;
}) => Promise<{ readonly ok: boolean; readonly error: string | null }>;

/**
 * Resolves one host key through the relay, then pairs with that host URL. The
 * host key itself is retained so the record can be refreshed and re-paired.
 */
export async function addPersonalNetworkHost(input: {
  readonly relayUrl: string;
  readonly hostKey: string;
  readonly pair: PairPersonalHost;
}): Promise<PersonalHostRecord> {
  const resolved = await resolvePersonalHost({
    relayUrl: input.relayUrl,
    hostKey: input.hostKey,
  });
  const outcome = await input.pair({
    host: resolved.publicUrl,
    pairingCode: input.hostKey.trim(),
    expectedEnvironmentId: resolved.environmentId as EnvironmentId,
  });
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "This host refused the key.");
  }
  const record = personalHostRecord({
    relayUrl: input.relayUrl,
    hostKey: input.hostKey,
    resolved,
  });
  upsertPersonalHost(record, personalNetworkStorage);
  return record;
}

/** A live route outranks a paused one, which outranks a dead one; newer routes win ties. */
function routeRank(host: PersonalHostRecord): number {
  return host.online ? 2 : host.paused ? 1 : 0;
}

function betterRoute(
  candidate: PersonalHostRecord,
  current: PersonalHostRecord | null,
): PersonalHostRecord {
  return current === null || routeRank(candidate) >= routeRank(current) ? candidate : current;
}

/**
 * One row per computer: its best live route speaks for it, so a host that
 * switched relays never displays its dead route's relay or offline state.
 */
export function personalNetworkComputers(
  hosts: ReadonlyArray<PersonalHostRecord>,
): ReadonlyArray<PersonalHostRecord> {
  const byEnvironment = new Map<string, PersonalHostRecord>();
  for (const host of hosts) {
    const current = byEnvironment.get(host.environmentId) ?? null;
    byEnvironment.set(host.environmentId, betterRoute(host, current));
  }
  return [...byEnvironment.values()];
}

/** The relay an existing computer actually answers on, for the add-host form's default. */
export function currentPersonalNetworkRelayUrl(
  hosts: ReadonlyArray<PersonalHostRecord>,
): string | null {
  let best: PersonalHostRecord | null = null;
  for (const host of hosts) {
    best = betterRoute(host, best);
  }
  return best?.relayUrl ?? null;
}

/** Forgets every key that reaches one computer; a row removal must not resurrect a dead route. */
export function removePersonalNetworkComputer(
  environmentId: string,
): ReadonlyArray<PersonalHostRecord> {
  for (const record of readPersonalHosts(personalNetworkStorage)) {
    if (record.environmentId !== environmentId) continue;
    removePersonalHost(
      { hostId: record.hostId, relayUrl: record.relayUrl },
      personalNetworkStorage,
    );
  }
  return readPersonalHosts(personalNetworkStorage);
}

export function refreshPersonalNetworkHosts(): Promise<ReadonlyArray<PersonalHostRecord>> {
  return refreshPersonalHosts({
    hosts: readPersonalNetworkHosts(),
    storage: personalNetworkStorage,
    fetchImpl: async (url, init) => fetch(url, init),
  });
}
