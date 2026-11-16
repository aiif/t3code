import {
  forgetPersonalPortal,
  readPersonalPortalRecord,
  recordPairedEnvironments,
  savePersonalPortalConfig,
  syncPersonalPortal,
  type PersonalPortalConfig,
  type PersonalPortalRecord,
  type PersonalPortalStorage,
  type PersonalPortalSyncResult,
} from "@t3tools/client-runtime/personal/portal";
import type { EnvironmentId } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";

/**
 * The personal key is the root credential for every host, so it lives in the
 * platform keystore rather than app preferences. SecureStore's sync API keeps
 * the shared portal helpers usable from render.
 */
const personalNetworkStorage: PersonalPortalStorage = {
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
      // SecureStore has no synchronous delete. A JSON object without the
      // required fields reads back as unconfigured and is overwritten next save.
      SecureStore.setItem(key, "{}");
    } catch {
      // Removing an already absent record is the desired state.
    }
  },
};

export function readPersonalNetworkRecord(): PersonalPortalRecord | null {
  return readPersonalPortalRecord(personalNetworkStorage);
}

export function savePersonalNetworkConfig(config: PersonalPortalConfig): PersonalPortalRecord {
  return savePersonalPortalConfig(config, personalNetworkStorage);
}

export function forgetPersonalNetwork(): void {
  forgetPersonalPortal(personalNetworkStorage);
}

export type PairPersonalHost = (input: {
  readonly host: string;
  readonly pairingCode: string;
  readonly expectedEnvironmentId: EnvironmentId;
}) => Promise<unknown>;

/**
 * Discovers the hosts registered under the saved key and pairs the ones this
 * device has not paired yet. `pair` is injected so the UI and the background
 * sync can share the same discovery rules.
 */
export async function syncPersonalNetwork(input: {
  readonly pair: PairPersonalHost;
  readonly record?: PersonalPortalRecord | null;
}): Promise<PersonalPortalSyncResult | null> {
  const record = input.record ?? readPersonalNetworkRecord();
  if (record === null) return null;
  const result = await syncPersonalPortal({
    config: { relayUrl: record.relayUrl, key: record.key },
    record,
    pair: input.pair,
  });
  if (result.paired.length > 0) {
    const current = readPersonalNetworkRecord();
    // A forget or key rotation while discovery was in flight wins.
    if (current !== null && current.relayUrl === record.relayUrl && current.key === record.key) {
      recordPairedEnvironments(current, result.paired.map(String), personalNetworkStorage);
    }
  }
  return result;
}
