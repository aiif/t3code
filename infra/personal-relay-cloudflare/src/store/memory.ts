import type {
  AuditInput,
  ClientSnapshotInput,
  CreateHostInput,
  HostClientRow,
  HostRow,
  RateLimitInput,
  RateLimitResult,
  RegistryStore,
  RotateHostKeyInput,
  SetConnectorInput,
  TouchHeartbeatInput,
  UpdateRegistrationInput,
} from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";

const STALE_CLIENT_MS = 30 * 24 * 60 * 60 * 1_000;
const REVOKED_CLIENT_REPORT_MS = 24 * 60 * 60 * 1_000;

interface ClientRecord extends HostClientRow {
  readonly hostId: string;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const cloneHost = (host: HostRow): HostRow => ({ ...host });
const cloneClient = (client: HostClientRow): HostClientRow => ({ ...client });

/** Test adapter with the same semantics as the Durable Object SQLite store. */
export class InMemoryRegistryStore implements RegistryStore {
  readonly #hosts = new Map<string, HostRow>();
  readonly #clients = new Map<string, Map<string, ClientRecord>>();
  readonly #rateLimits = new Map<string, RateLimitBucket>();
  readonly #audit: Array<AuditInput> = [];
  readonly #meta = new Map<string, string>([["schema_version", String(SCHEMA_VERSION)]]);
  #nextClientId = 1;

  getSchemaVersion(): number {
    return Number(this.#meta.get("schema_version") ?? 0);
  }

  getMeta(key: string): string | null {
    return this.#meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#meta.set(key, value);
  }

  createHost(input: CreateHostInput): HostRow {
    const host: HostRow = {
      id: input.id,
      environmentId: input.environmentId,
      label: input.label,
      platform: input.platform,
      hostKeyHash: input.hostKeyHash,
      hostKeyCiphertext: input.hostKeyCiphertext,
      keyVersion: 1,
      hostTokenHash: input.hostTokenHash,
      online: 1,
      paused: 0,
      lastSeenAt: input.now,
      createdAt: input.now,
      revokedAt: null,
      connectorMode: input.connectorMode,
      tunnelId: null,
      dnsRecordId: null,
      hostname: input.hostname,
      originPort: input.originPort,
      publicUrl: input.publicUrl,
    };
    this.#hosts.set(host.id, host);
    this.#clients.set(host.id, new Map());
    return cloneHost(host);
  }

  getHost(hostId: string): HostRow | null {
    const host = this.#hosts.get(hostId);
    return host === undefined ? null : cloneHost(host);
  }

  findHostByEnvironment(environmentId: string): HostRow | null {
    for (const host of this.#hosts.values()) {
      if (host.environmentId === environmentId) return cloneHost(host);
    }
    return null;
  }

  findHostByKeyHash(hostKeyHash: string): HostRow | null {
    for (const host of this.#hosts.values()) {
      if (host.revokedAt === null && host.hostKeyHash === hostKeyHash) return cloneHost(host);
    }
    return null;
  }

  findHostByTokenHash(hostTokenHash: string): HostRow | null {
    for (const host of this.#hosts.values()) {
      if (host.revokedAt === null && host.hostTokenHash === hostTokenHash) return cloneHost(host);
    }
    return null;
  }

  updateRegistration(input: UpdateRegistrationInput): HostRow | null {
    const current = this.#hosts.get(input.hostId);
    if (current === undefined || current.revokedAt !== null) return null;
    const next: HostRow = {
      ...current,
      label: input.label,
      platform: input.platform,
      hostTokenHash: input.hostTokenHash,
      connectorMode: input.connectorMode,
      hostname: input.hostname,
      originPort: input.originPort,
      publicUrl: input.publicUrl,
      online: 1,
      paused: 0,
      lastSeenAt: input.now,
    };
    this.#hosts.set(next.id, next);
    return cloneHost(next);
  }

  setConnector(input: SetConnectorInput): HostRow | null {
    const current = this.#hosts.get(input.hostId);
    if (current === undefined || current.revokedAt !== null) return null;
    const next: HostRow = {
      ...current,
      connectorMode: input.connectorMode,
      tunnelId: input.tunnelId,
      dnsRecordId: input.dnsRecordId,
      hostname: input.hostname,
      originPort: input.originPort,
      publicUrl: input.publicUrl,
      lastSeenAt: input.now,
    };
    this.#hosts.set(next.id, next);
    return cloneHost(next);
  }

  touchHeartbeat(input: TouchHeartbeatInput): HostRow | null {
    const current = this.#hosts.get(input.hostId);
    if (current === undefined || current.revokedAt !== null) return null;
    const next: HostRow = {
      ...current,
      label: input.label === undefined ? current.label : input.label,
      lastSeenAt: input.now,
      online: input.online === false ? 0 : 1,
      paused: input.online === false ? 1 : 0,
      publicUrl:
        input.publicUrl === undefined || input.publicUrl.length === 0
          ? current.publicUrl
          : input.publicUrl,
    };
    this.#hosts.set(next.id, next);
    return cloneHost(next);
  }

  rotateHostKey(input: RotateHostKeyInput): number | null {
    const current = this.#hosts.get(input.hostId);
    if (current === undefined || current.revokedAt !== null) return null;
    const keyVersion = current.keyVersion + 1;
    const next: HostRow = {
      ...current,
      hostKeyHash: input.hostKeyHash,
      hostKeyCiphertext: input.hostKeyCiphertext,
      keyVersion,
      online: 1,
      paused: 0,
      lastSeenAt: input.now,
    };
    this.#hosts.set(next.id, next);
    return keyVersion;
  }

  deleteHost(hostId: string): boolean {
    this.#clients.delete(hostId);
    return this.#hosts.delete(hostId);
  }

  revokeHost(hostId: string, now: number): boolean {
    const current = this.#hosts.get(hostId);
    if (current === undefined || current.revokedAt !== null) return false;
    this.#hosts.set(hostId, {
      ...current,
      revokedAt: now,
      online: 0,
      paused: 0,
      lastSeenAt: now,
    });
    return true;
  }

  restoreHost(hostId: string, now: number): boolean {
    const current = this.#hosts.get(hostId);
    if (current === undefined || current.revokedAt === null) return false;
    this.#hosts.set(hostId, {
      ...current,
      revokedAt: null,
      online: 0,
      paused: 0,
      lastSeenAt: now,
    });
    return true;
  }

  listHosts(): ReadonlyArray<HostRow> {
    return [...this.#hosts.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(cloneHost);
  }

  countActiveHosts(): number {
    let count = 0;
    for (const host of this.#hosts.values()) {
      if (host.revokedAt === null) count += 1;
    }
    return count;
  }

  replaceClients(hostId: string, clients: ReadonlyArray<ClientSnapshotInput>, now: number): void {
    const existing = this.#clients.get(hostId) ?? new Map<string, ClientRecord>();
    this.#clients.set(hostId, existing);
    const reported = new Set<string>();

    for (const client of clients) {
      reported.add(client.sessionId);
      const current = existing.get(client.sessionId);
      existing.set(client.sessionId, {
        id: current?.id ?? this.#nextClientId++,
        hostId,
        sessionId: client.sessionId,
        clientLabel: client.clientLabel,
        platform: client.platform,
        firstSeenAt:
          current === undefined
            ? client.firstSeenAt
            : Math.min(current.firstSeenAt, client.firstSeenAt),
        lastSeenAt:
          current === undefined
            ? client.lastSeenAt
            : Math.max(current.lastSeenAt, client.lastSeenAt),
        revokedAt: client.revokedAt ?? current?.revokedAt ?? null,
      });
    }

    for (const [sessionId, client] of existing) {
      if (!reported.has(sessionId) && client.revokedAt === null) {
        existing.set(sessionId, { ...client, revokedAt: now });
      }
    }

    for (const [sessionId, client] of existing) {
      if (client.revokedAt !== null && client.lastSeenAt < now - STALE_CLIENT_MS) {
        existing.delete(sessionId);
      }
    }
  }

  listClients(hostId: string): ReadonlyArray<HostClientRow> {
    return [...(this.#clients.get(hostId)?.values() ?? [])]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map(cloneClient);
  }

  countClients(hostId: string): number {
    let count = 0;
    for (const client of this.#clients.get(hostId)?.values() ?? []) {
      if (client.revokedAt === null) count += 1;
    }
    return count;
  }

  revokeClient(hostId: string, sessionId: string, now: number): boolean {
    const client = this.#clients.get(hostId)?.get(sessionId);
    if (client === undefined || client.revokedAt !== null) return false;
    this.#clients.get(hostId)!.set(sessionId, { ...client, revokedAt: now });
    return true;
  }

  revokedClients(hostId: string, now: number): ReadonlyArray<string> {
    return [...(this.#clients.get(hostId)?.values() ?? [])]
      .filter(
        (client) => client.revokedAt !== null && client.revokedAt >= now - REVOKED_CLIENT_REPORT_MS,
      )
      .map((client) => client.sessionId);
  }

  pruneClients(before: number): number {
    let removed = 0;
    for (const clients of this.#clients.values()) {
      for (const [sessionId, client] of clients) {
        if (client.revokedAt !== null && client.lastSeenAt < before) {
          clients.delete(sessionId);
          removed += 1;
        }
      }
    }
    return removed;
  }

  consumeRateLimit(input: RateLimitInput): RateLimitResult {
    const key = `${input.scope}:${input.key}`;
    const existing = this.#rateLimits.get(key);
    const bucket =
      existing === undefined || existing.resetAt <= input.now
        ? { count: 0, resetAt: input.now + input.windowMs }
        : existing;
    bucket.count += 1;
    this.#rateLimits.set(key, bucket);
    const allowed = bucket.count <= input.limit;
    return {
      allowed,
      remaining: Math.max(0, input.limit - bucket.count),
      retryAfterMs: allowed ? 0 : Math.max(0, bucket.resetAt - input.now),
    };
  }

  pruneRateLimits(before: number): number {
    let removed = 0;
    for (const [key, bucket] of this.#rateLimits) {
      if (bucket.resetAt < before) {
        this.#rateLimits.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  audit(input: AuditInput): void {
    this.#audit.push({ ...input });
  }
}

export function createInMemoryRegistryStore(): InMemoryRegistryStore {
  return new InMemoryRegistryStore();
}
