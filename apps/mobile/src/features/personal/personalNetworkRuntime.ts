import { AppState } from "react-native";

import { readPersonalNetworkHosts, refreshPersonalNetworkHosts } from "./personalNetwork";

/** Refreshes saved host status when the app returns to the foreground. */
export async function refreshPersonalNetworkHostsIfConfigured(): Promise<void> {
  if (readPersonalNetworkHosts().length === 0) return;
  await refreshPersonalNetworkHosts().catch(() => undefined);
}

export function installPersonalNetworkSync(): () => void {
  let current = AppState.currentState;
  const subscription = AppState.addEventListener("change", (next) => {
    const cameToForeground = current !== "active" && next === "active";
    current = next;
    if (cameToForeground) void refreshPersonalNetworkHostsIfConfigured();
  });
  void refreshPersonalNetworkHostsIfConfigured();
  return () => subscription.remove();
}
