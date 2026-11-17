export type HostConnectorMode = "named" | "quick";

export const SCHEMA_VERSION = 1;

export interface HostRow {
  readonly id: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly hostKeyHash: string;
  readonly hostKeyCiphertext: string;
  readonly keyVersion: number;
  readonly hostTokenHash: string;
  readonly online: number;
  readonly paused: number;
  readonly lastSeenAt: number;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly connectorMode: HostConnectorMode;
  readonly tunnelId: string | null;
  readonly dnsRecordId: string | null;
  readonly hostname: string | null;
  readonly originPort: number | null;
  readonly publicUrl: string;
}

export interface HostClientRow {
  readonly id: number;
  readonly hostId: string;
  readonly sessionId: string;
  readonly clientLabel: string | null;
  readonly platform: string | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt: number | null;
}

export interface CreateHostInput {
  readonly id: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly hostKeyHash: string;
  readonly hostKeyCiphertext: string;
  readonly hostTokenHash: string;
  readonly connectorMode: HostConnectorMode;
  readonly hostname: string | null;
  readonly originPort: number | null;
  readonly publicUrl: string;
  readonly now: number;
}

export interface UpdateRegistrationInput {
  readonly hostId: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly hostTokenHash: string;
  readonly connectorMode: HostConnectorMode;
  readonly hostname: string | null;
  readonly originPort: number | null;
  readonly publicUrl: string;
  readonly now: number;
}

export interface SetConnectorInput {
  readonly hostId: string;
  readonly connectorMode: HostConnectorMode;
  readonly tunnelId: string | null;
  readonly dnsRecordId: string | null;
  readonly hostname: string | null;
  readonly originPort: number | null;
  readonly publicUrl: string;
  readonly now: number;
}

export interface TouchHeartbeatInput {
  readonly hostId: string;
  readonly label?: string | null | undefined;
  readonly online?: boolean | undefined;
  readonly publicUrl?: string | undefined;
  readonly now: number;
}

export interface RotateHostKeyInput {
  readonly hostId: string;
  readonly hostKeyHash: string;
  readonly hostKeyCiphertext: string;
  readonly now: number;
}

export interface ClientSnapshotInput {
  readonly sessionId: string;
  readonly clientLabel: string | null;
  readonly platform: string | null;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt?: number | null | undefined;
}

export interface RateLimitInput {
  readonly scope: string;
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly now: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export interface AuditInput {
  readonly action: string;
  readonly hostId: string | null;
  readonly actor: string;
  readonly now: number;
}

/**
 * Persistence for the single registry Durable Object. Kept synchronous: DO
 * SQLite is synchronous, and crypto/Cloudflare calls happen in the service.
 */
export interface RegistryStore {
  getSchemaVersion(): number;

  createHost(input: CreateHostInput): HostRow;
  getHost(hostId: string): HostRow | null;
  findHostByEnvironment(environmentId: string): HostRow | null;
  /** Excludes revoked hosts so a removed key cannot resolve. */
  findHostByKeyHash(hostKeyHash: string): HostRow | null;
  /** Excludes revoked hosts so a removed host cannot heartbeat. */
  findHostByTokenHash(hostTokenHash: string): HostRow | null;

  updateRegistration(input: UpdateRegistrationInput): HostRow | null;
  setConnector(input: SetConnectorInput): HostRow | null;
  touchHeartbeat(input: TouchHeartbeatInput): HostRow | null;
  rotateHostKey(input: RotateHostKeyInput): number | null;

  deleteHost(hostId: string): boolean;
  revokeHost(hostId: string, now: number): boolean;
  restoreHost(hostId: string, now: number): boolean;
  listHosts(): ReadonlyArray<HostRow>;
  countActiveHosts(): number;

  replaceClients(hostId: string, clients: ReadonlyArray<ClientSnapshotInput>, now: number): void;
  listClients(hostId: string): ReadonlyArray<HostClientRow>;
  countClients(hostId: string): number;
  revokeClient(hostId: string, sessionId: string, now: number): boolean;
  revokedClients(hostId: string, now: number): ReadonlyArray<string>;
  pruneClients(before: number): number;

  consumeRateLimit(input: RateLimitInput): RateLimitResult;
  pruneRateLimits(before: number): number;

  audit(input: AuditInput): void;

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
