import type { WorkerConfig } from "./config.ts";
import { createCloudflareTunnelProvisioner } from "./tunnel/index.ts";
import type { TunnelProvisioner } from "./tunnel/types.ts";

/** Quick tunnels are run by the host, so the relay only needs a provisioner when named. */
export function createTunnelProvisioner(
  config: WorkerConfig,
  fetchImpl?: typeof fetch,
): TunnelProvisioner | null {
  if (
    config.mode !== "named" ||
    config.accountId === null ||
    config.zoneId === null ||
    config.hostsSuffix === null ||
    config.cfApiToken === null
  ) {
    return null;
  }
  return createCloudflareTunnelProvisioner({
    accountId: config.accountId,
    zoneId: config.zoneId,
    hostsSuffix: config.hostsSuffix,
    tunnelPrefix: config.tunnelPrefix,
    apiToken: config.cfApiToken,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}
