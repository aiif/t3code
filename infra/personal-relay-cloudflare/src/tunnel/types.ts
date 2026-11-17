export interface TunnelEnsureInput {
  readonly hostId: string;
  readonly hostname: string;
  readonly originPort: number;
  readonly now: number;
}

export interface TunnelEnsureResult {
  readonly tunnelId: string;
  readonly tunnelToken: string;
  readonly hostname: string;
  readonly dnsRecordId: string;
}

export interface TunnelRemoveInput {
  readonly hostId: string;
  readonly tunnelId?: string | undefined;
  readonly dnsRecordId?: string | undefined;
  readonly hostname?: string | undefined;
}

export interface TunnelSweepInput {
  readonly activeHostIds: ReadonlySet<string>;
  readonly now: number;
}

/** One per host. Implementations must be idempotent and never log tokens. */
export interface TunnelProvisioner {
  ensure(input: TunnelEnsureInput): Promise<TunnelEnsureResult>;
  remove(input: TunnelRemoveInput): Promise<void>;
  sweep(input: TunnelSweepInput): Promise<void>;
}

export class TunnelProvisionError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly status?: number | null; readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "TunnelProvisionError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}
