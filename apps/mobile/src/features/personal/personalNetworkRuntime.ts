import { AppState } from "react-native";

import { pairEnvironment } from "../../state/use-remote-environment-registry";
import { buildPairingUrl } from "../connection/pairing";
import { syncPersonalNetwork, type PairPersonalHost } from "./personalNetwork";

const pairHost: PairPersonalHost = async ({ host, pairingCode, expectedEnvironmentId }) => {
  const outcome = await pairEnvironment(buildPairingUrl(host, pairingCode), expectedEnvironmentId);
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "This host refused the key.");
  }
};

export function syncPersonalNetworkHosts() {
  return syncPersonalNetwork({ pair: pairHost });
}

let running = false;

function syncInBackground(): void {
  if (running) return;
  running = true;
  void syncPersonalNetworkHosts()
    .catch(() => undefined)
    .finally(() => {
      running = false;
    });
}

/**
 * The native counterpart to the portal's foreground refresh: hosts added to
 * the key space appear after the app becomes active again. A failure retries on
 * the next foreground and never blocks the app.
 */
export function installPersonalNetworkSync(): () => void {
  syncInBackground();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") syncInBackground();
  });
  return () => subscription.remove();
}
