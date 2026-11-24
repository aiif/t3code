import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import {
  readPersonalHosts,
  retryPersonalRelayRoutes,
  syncPersonalRelayRoutes,
} from "@t3tools/client-runtime/personal/portal";
import { isPersonalHostAuthenticationBlocked } from "@t3tools/client-runtime/personal/session-repair";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairing } from "../../connection/onboarding";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSummaries } from "../../state/presentation";
import { personalGuestRoutes } from "../../state/personal";

const SYNC_INTERVAL_MS = 60_000;
const REPAIR_COOLDOWN_MS = 5 * 60_000;

/**
 * Paired guests pull every relay route the host remembers, so a host switching
 * relays never asks a guest to paste a new key. Only a connected environment can
 * answer, so each route is retried while its relay is offline.
 */
export function startPersonalRelayRouteSync(): () => void {
  let running = false;
  const repairedAt = new Map<string, number>();

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
      error: cause instanceof Error ? cause.message : m(msg("The host refused the key.")),
    };
  };

  const repairRejectedPersonalHosts = async (attemptsAt: Map<string, number>) => {
    const now = Date.now();
    for (const host of readPersonalHosts()) {
      if (now - (attemptsAt.get(host.environmentId) ?? 0) < REPAIR_COOLDOWN_MS) continue;
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
      attemptsAt.set(host.environmentId, now);
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
  };

  const syncAll = async () => {
    if (running) return;
    running = true;
    try {
      await repairRejectedPersonalHosts(repairedAt);
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
  const rejectedHostsAtom = Atom.make((get) => {
    const rejected: Array<string> = [];
    const entries = get(environmentCatalog.catalogValueAtom).entries;
    for (const host of readPersonalHosts()) {
      const environmentId = host.environmentId as EnvironmentId;
      if (!entries.has(environmentId)) continue;
      const state = AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      );
      if (isPersonalHostAuthenticationBlocked(state)) rejected.push(host.environmentId);
    }
    return rejected.join("|");
  }).pipe(Atom.withLabel("web:personal-hosts-rejected"));

  const unsubscribe = appAtomRegistry.subscribe(
    environmentSummaries.connectedEnvironmentIdsAtom,
    requestSync,
  );
  const unsubscribeRejected = appAtomRegistry.subscribe(rejectedHostsAtom, (rejected) => {
    if (rejected !== "") requestSync();
  });
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") requestSync();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  const timer = window.setInterval(requestSync, SYNC_INTERVAL_MS);
  requestSync();
  return () => {
    unsubscribe();
    unsubscribeRejected();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.clearInterval(timer);
  };
}
