import type { TunnelProvisioner } from "./types.ts";

export { CloudflareApiError } from "./cloudflare.ts";

export interface CloudflareTunnelProvisionerOptions {
  readonly accountId: string;
  readonly zoneId: string;
  readonly hostsSuffix: string;
  readonly tunnelPrefix: string;
  readonly apiToken: string;
  /** Injectable for tests; defaults to the platform fetch. */
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

/** Lane P replaces this with the real Cloudflare API implementation. */
export function createCloudflareTunnelProvisioner(
  _options: CloudflareTunnelProvisionerOptions,
): TunnelProvisioner {
  throw new Error("Cloudflare tunnel provisioning is not implemented yet.");
}
