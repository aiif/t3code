import type { SupervisorConnectionState } from "../connection/model.ts";

/**
 * A host key is the guest's own credential, so a rejected session on a saved
 * personal host heals by pairing again with that key.
 */
export function isPersonalHostAuthenticationBlocked(state: SupervisorConnectionState): boolean {
  return (
    state.phase === "blocked" &&
    state.lastFailure?._tag === "ConnectionBlockedError" &&
    state.lastFailure.reason === "authentication"
  );
}
