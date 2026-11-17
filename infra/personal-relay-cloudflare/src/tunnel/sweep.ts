import type { TunnelProvisioner } from "./types.ts";

export interface TunnelSweepOptions {
  readonly provisioner: TunnelProvisioner;
  readonly activeHostIds: ReadonlySet<string>;
  readonly now: number;
}

/** Lane P fills in orphan cleanup details; the interface above is frozen. */
export async function sweepTunnels(options: TunnelSweepOptions): Promise<void> {
  await options.provisioner.sweep({
    activeHostIds: options.activeHostIds,
    now: options.now,
  });
}
