import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import {
  retryPersonalRelayRoutes,
  syncPersonalRelayRoutes,
} from "@t3tools/client-runtime/personal/portal";
import { isPersonalHostAuthenticationBlocked } from "@t3tools/client-runtime/personal/session-repair";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react-native";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairingUrl } from "../../connection/onboarding";
import { m } from "../../i18n/messages";
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
    error: cause instanceof Error ? cause.message : m(msg("The host refused the key.")),
  };
};

const REPAIR_COOLDOWN_MS = 5 * 60_000;

/**
 * A saved host key can replace a rejected session. Pair again with it and
 * retry, instead of making the guest fetch a new pairing link by hand.
 */
async function repairRejectedPersonalHosts(repairedAt: Map<string, number>): Promise<void> {
  const now = Date.now();
  for (const host of readPersonalNetworkHosts()) {
    if (now - (repairedAt.get(host.environmentId) ?? 0) < REPAIR_COOLDOWN_MS) continue;
    const environmentId = host.environmentId as EnvironmentId;
    const entry = appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.get(environmentId);
    if (entry === undefined || !entry.enabled) continue;
    const state = AsyncResult.getOrElse(
      appAtomRegistry.get(environmentCatalog.stateAtom(environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (!isPersonalHostAuthenticationBlocked(state)) continue;
    repairedAt.set(host.environmentId, now);
    const paired = await pairRelay({
      host: host.publicUrl,
      pairingCode: host.hostKey,
      expectedEnvironmentId: environmentId,
    });
    if (!paired.ok) continue;
    await runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId, {
      reportFailure: false,
    });
  }
}

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
  const repairedAt = new Map<string, number>();

  const syncAll = async () => {
    if (running) return;
    running = true;
    try {
      await repairRejectedPersonalHosts(repairedAt);
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
  const rejectedHostsAtom = Atom.make((get) => {
    const rejected: Array<string> = [];
    const entries = get(environmentCatalog.catalogValueAtom).entries;
    for (const host of readPersonalNetworkHosts()) {
      const environmentId = host.environmentId as EnvironmentId;
      if (!entries.has(environmentId)) continue;
      const state = AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      );
      if (isPersonalHostAuthenticationBlocked(state)) rejected.push(host.environmentId);
    }
    return rejected.join("|");
  }).pipe(Atom.withLabel("mobile:personal-hosts-rejected"));

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
  const unsubscribeRejected = appAtomRegistry.subscribe(rejectedHostsAtom, (rejected) => {
    if (rejected !== "") requestSync();
  });
  const timer = setInterval(requestSync, SYNC_INTERVAL_MS);
  void refreshPersonalNetworkHostsIfConfigured();
  requestSync();
  return () => {
    subscription.remove();
    unsubscribeRoutes();
    unsubscribeRejected();
    clearInterval(timer);
  };
}
