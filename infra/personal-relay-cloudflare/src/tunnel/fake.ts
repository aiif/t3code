import { TunnelProvisionError } from "./types.ts";
import type {
  TunnelEnsureInput,
  TunnelEnsureResult,
  TunnelProvisioner,
  TunnelRemoveInput,
  TunnelSweepInput,
} from "./types.ts";

export interface FakeTunnelProvisionerState {
  readonly ensured: Array<TunnelEnsureInput>;
  readonly removed: Array<TunnelRemoveInput>;
  readonly swept: Array<TunnelSweepInput>;
  readonly failures: Array<TunnelProvisionError>;
}

export class FakeTunnelProvisioner implements TunnelProvisioner {
  readonly state: FakeTunnelProvisionerState = {
    ensured: [],
    removed: [],
    swept: [],
    failures: [],
  };
  readonly #tunnels = new Map<string, TunnelEnsureResult>();
  readonly #failures: Array<TunnelProvisionError> = [];

  failNext(error: TunnelProvisionError = new TunnelProvisionError("Fake tunnel failure.")): void {
    this.#failures.push(error);
  }

  ensure(input: TunnelEnsureInput): Promise<TunnelEnsureResult> {
    this.state.ensured.push(input);
    const failure = this.#failures.shift();
    if (failure !== undefined) {
      this.state.failures.push(failure);
      return Promise.reject(failure);
    }
    const existing = this.#tunnels.get(input.hostId);
    if (existing !== undefined) return Promise.resolve(existing);
    const result: TunnelEnsureResult = {
      tunnelId: `tunnel-${input.hostId}`,
      tunnelToken: `token-${input.hostId}`,
      hostname: input.hostname,
      dnsRecordId: `dns-${input.hostId}`,
    };
    this.#tunnels.set(input.hostId, result);
    return Promise.resolve(result);
  }

  remove(input: TunnelRemoveInput): Promise<void> {
    this.state.removed.push(input);
    this.#tunnels.delete(input.hostId);
    return Promise.resolve();
  }

  sweep(input: TunnelSweepInput): Promise<void> {
    this.state.swept.push(input);
    for (const hostId of this.#tunnels.keys()) {
      if (!input.activeHostIds.has(hostId)) this.#tunnels.delete(hostId);
    }
    return Promise.resolve();
  }

  resultFor(hostId: string): TunnelEnsureResult | null {
    return this.#tunnels.get(hostId) ?? null;
  }
}

export function createFakeTunnelProvisioner(): FakeTunnelProvisioner {
  return new FakeTunnelProvisioner();
}
