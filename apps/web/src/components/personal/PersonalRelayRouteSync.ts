import {
  readPersonalHosts,
  retryPersonalRelayRoutes,
  syncPersonalRelayRoutes,
} from "@t3tools/client-runtime/personal/portal";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectPairing } from "../../connection/onboarding";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSummaries } from "../../state/presentation";
import { personalGuestRoutes } from "../../state/personal";

const SYNC_INTERVAL_MS = 60_000;

/**
 * Paired guests pull every relay route the host remembers, so a host switching
 * relays never asks a guest to paste a new key. Only a connected environment can
 * answer, so each route is retried while its relay is offline.
 */
export function startPersonalRelayRouteSync(): () => void {
  let running = false;

  const pairRelay = async (input: {
    readonly host: string;
    readonly pairingCode: string;
    readonly expectedEnvironmentId: EnvironmentId;
  }) => {
    const paired = await runAtomCommand(appAtomRegistry, connectPairing, input, {
      reportFailure: false,
    });
    if (paired._tag === "Success") return { ok: true };
    const cause = squashAtomCommandFailure(paired);
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "The host refused the key.",
    };
  };

  const syncAll = async () => {
    if (running) return;
    running = true;
    try {
      for (const environmentId of appAtomRegistry.get(
        environmentSummaries.connectedEnvironmentIdsAtom,
      )) {
        if (!readPersonalHosts().some((host) => host.environmentId === environmentId)) continue;
        const result = await runAtomCommand(
          appAtomRegistry,
          personalGuestRoutes,
          { environmentId, input: {} },
          { reportFailure: false },
        );
        if (result._tag === "Success") {
          await syncPersonalRelayRoutes({
            environmentId,
            routes: result.value.routes,
            pair: pairRelay,
          });
        }
      }
      await retryPersonalRelayRoutes({ pair: pairRelay });
    } finally {
      running = false;
    }
  };

  const requestSync = () => {
    void syncAll().catch(() => undefined);
  };

  const unsubscribe = appAtomRegistry.subscribe(
    environmentSummaries.connectedEnvironmentIdsAtom,
    requestSync,
  );
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") requestSync();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const timer = window.setInterval(requestSync, SYNC_INTERVAL_MS);
  requestSync();
  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.clearInterval(timer);
  };
}
