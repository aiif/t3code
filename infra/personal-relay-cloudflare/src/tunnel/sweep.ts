import type { TunnelProvisioner } from "./types.ts";

export interface TunnelSweepOptions {
  readonly provisioner: TunnelProvisioner;
  readonly activeHostIds: ReadonlySet<string>;
  readonly now: number;
}

export async function sweepTunnels(options: TunnelSweepOptions): Promise<void> {
  await options.provisioner.sweep({
    activeHostIds: options.activeHostIds,
    now: options.now,
  });
}
