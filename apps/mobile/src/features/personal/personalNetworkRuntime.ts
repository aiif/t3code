import {
  retryPersonalRelayRoutes,
  syncPersonalRelayRoutes,
} from "@t3tools/client-runtime/personal/portal";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AppState } from "react-native";

import { connectPairingUrl } from "../../connection/onboarding";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { personalGuestRoutes } from "../../state/personal";
import { buildPairingUrl } from "../connection/pairing";
import {
  personalNetworkStorage,
  readPersonalNetworkHosts,
  refreshPersonalNetworkHosts,
} from "./personalNetwork";

const SYNC_INTERVAL_MS = 60_000;

/** Refreshes saved host status when the app returns to the foreground. */
async function refreshPersonalNetworkHostsIfConfigured(): Promise<void> {
  if (readPersonalNetworkHosts().length === 0) return;
  await refreshPersonalNetworkHosts().catch(() => undefined);
}

const pairRelay = async (input: {
  readonly host: string;
  readonly pairingCode: string;
  readonly expectedEnvironmentId: EnvironmentId;
}) => {
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairingUrl,
    {
      pairingUrl: buildPairingUrl(input.host, input.pairingCode),
      expectedEnvironmentId: input.expectedEnvironmentId,
    },
    { reportFailure: false },
  );
  if (paired._tag === "Success") return { ok: true };
  const cause = squashAtomCommandFailure(paired);
  return {
    ok: false,
    error: cause instanceof Error ? cause.message : "The host refused the key.",
  };
};

async function syncEnvironmentRoutes(environmentId: EnvironmentId): Promise<void> {
  if (!readPersonalNetworkHosts().some((host) => host.environmentId === environmentId)) return;
  const result = await runAtomCommand(
    appAtomRegistry,
    personalGuestRoutes,
    { environmentId, input: {} },
    { reportFailure: false },
  );
  if (result._tag === "Failure") return;
  await syncPersonalRelayRoutes({
    environmentId,
    routes: result.value.routes,
    storage: personalNetworkStorage,
    fetchImpl: async (url, init) => fetch(url, init),
    pair: pairRelay,
  });
}

export function installPersonalNetworkSync(): () => void {
  let running = false;

  const syncAll = async () => {
    if (running) return;
    running = true;
    try {
      for (const environmentId of appAtomRegistry.get(connectedEnvironmentIdsAtom)) {
        await syncEnvironmentRoutes(environmentId);
      }
      await retryPersonalRelayRoutes({
        storage: personalNetworkStorage,
        fetchImpl: async (url, init) => fetch(url, init),
        pair: pairRelay,
      });
    } finally {
      running = false;
    }
  };
  const requestSync = () => {
    void syncAll().catch(() => undefined);
  };

  let current = AppState.currentState;
  const subscription = AppState.addEventListener("change", (next) => {
    const cameToForeground = current !== "active" && next === "active";
    current = next;
    if (cameToForeground) {
      void refreshPersonalNetworkHostsIfConfigured();
      requestSync();
    }
  });
  const unsubscribeRoutes = appAtomRegistry.subscribe(connectedEnvironmentIdsAtom, requestSync);
  const timer = setInterval(requestSync, SYNC_INTERVAL_MS);
  void refreshPersonalNetworkHostsIfConfigured();
  requestSync();
  return () => {
    subscription.remove();
    unsubscribeRoutes();
    clearInterval(timer);
  };
}
