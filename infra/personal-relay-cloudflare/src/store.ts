import type {
  AuditInput,
  ClientSnapshotInput,
  CreateHostInput,
  HostClientRow,
  HostConnectorMode,
  HostRow,
  RateLimitInput,
  RateLimitResult,
  RegistryStore,
  RotateHostKeyInput,
  SetConnectorInput,
  TouchHeartbeatInput,
  UpdateRegistrationInput,
} from "./store/types.ts";
import { SCHEMA_VERSION } from "./store/types.ts";

export type RegistrySql = DurableObjectStorage["sql"];
/** Cloudflare forbids BEGIN/COMMIT through `sql.exec`; the DO injects `transactionSync`. */
export type RegistryTransaction = <T>(callback: () => T) => T;

const STALE_CLIENT_MS = 30 * 24 * 60 * 60 * 1_000;
const REVOKED_CLIENT_REPORT_MS = 24 * 60 * 60 * 1_000;

type SqlValue = string | number | null;

const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS hosts (
     id TEXT PRIMARY KEY,
     environment_id TEXT NOT NULL UNIQUE,
     label TEXT,
     platform TEXT,
     host_key_hash TEXT NOT NULL UNIQUE,
     host_key_ciphertext TEXT NOT NULL,
     key_version INTEGER NOT NULL DEFAULT 1,
     host_token_hash TEXT NOT NULL UNIQUE,
     online INTEGER NOT NULL DEFAULT 1,
     paused INTEGER NOT NULL DEFAULT 0,
     last_seen_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER,
     connector_mode TEXT NOT NULL,
     tunnel_id TEXT,
     dns_record_id TEXT,
     hostname TEXT,
     origin_port INTEGER,
     public_url TEXT NOT NULL DEFAULT ''
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS host_clients (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     host_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     client_label TEXT,
     platform TEXT,
     first_seen_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     revoked_at INTEGER,
     UNIQUE (host_id, session_id)
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS host_clients_host_idx ON host_clients (host_id, last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     scope TEXT NOT NULL,
     key TEXT NOT NULL,
     count INTEGER NOT NULL,
     reset_at INTEGER NOT NULL,
     PRIMARY KEY (scope, key)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS admin_audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     action TEXT NOT NULL,
     host_id TEXT,
     actor TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT`,
];

type HostDbRow = {
  readonly id: string;
  readonly environment_id: string;
  readonly label: string | null;
  readonly platform: string | null;
  readonly host_key_hash: string;
  readonly host_key_ciphertext: string;
  readonly key_version: number;
  readonly host_token_hash: string;
  readonly online: number;
  readonly paused: number;
  readonly last_seen_at: number;
  readonly created_at: number;
  readonly revoked_at: number | null;
  readonly connector_mode: string;
  readonly tunnel_id: string | null;
  readonly dns_record_id: string | null;
  readonly hostname: string | null;
  readonly origin_port: number | null;
  readonly public_url: string;
};

type HostClientDbRow = {
  readonly id: number;
  readonly host_id: string;
  readonly session_id: string;
  readonly client_label: string | null;
  readonly platform: string | null;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly revoked_at: number | null;
};

function toHost(row: HostDbRow): HostRow {
  return {
    id: row.id,
    environmentId: row.environment_id,
    label: row.label,
    platform: row.platform,
    hostKeyHash: row.host_key_hash,
    hostKeyCiphertext: row.host_key_ciphertext,
    keyVersion: row.key_version,
    hostTokenHash: row.host_token_hash,
    online: row.online,
    paused: row.paused,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    connectorMode: row.connector_mode as HostConnectorMode,
    tunnelId: row.tunnel_id,
    dnsRecordId: row.dns_record_id,
    hostname: row.hostname,
    originPort: row.origin_port,
    publicUrl: row.public_url,
  };
}

function toHostClient(row: HostClientDbRow): HostClientRow {
  return {
    id: row.id,
    hostId: row.host_id,
    sessionId: row.session_id,
    clientLabel: row.client_label,
    platform: row.platform,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

/** SQLite persistence for the single registry Durable Object. Synchronous by design. */
class SqliteRegistryStore implements RegistryStore {
  readonly #sql: RegistrySql;
  readonly #transaction: RegistryTransaction;

  constructor(sql: RegistrySql, transaction: RegistryTransaction) {
    this.#sql = sql;
    this.#transaction = transaction;
    this.#migrate();
  }

  #migrate(): void {
    this.#transaction(() => {
      for (const statement of SCHEMA_STATEMENTS) this.#sql.exec(statement);
      const stored = this.getMeta("schema_version");
      if (stored === null) {
        this.setMeta("schema_version", String(SCHEMA_VERSION));
        return;
      }
      const version = Number(stored);
      if (!Number.isInteger(version) || version < 1) {
        throw new Error("Registry schema version is invalid.");
      }
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `Registry schema version ${version} is newer than this Worker (${SCHEMA_VERSION}).`,
        );
      }
    });
  }

  #rows<T>(query: string, ...bindings: ReadonlyArray<SqlValue>): T[] {
    return this.#sql.exec(query, ...bindings).toArray() as unknown as T[];
  }

  #run(query: string, ...bindings: ReadonlyArray<SqlValue>): void {
    this.#sql.exec(query, ...bindings).toArray();
  }

  getSchemaVersion(): number {
    return Number(this.getMeta("schema_version") ?? 0);
  }

  getMeta(key: string): string | null {
    const row = this.#rows<{ readonly value: string }>(
      "SELECT value FROM meta WHERE key = ?",
      key,
    )[0];
    return row === undefined ? null : row.value;
  }

  setMeta(key: string, value: string): void {
    this.#run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  createHost(input: CreateHostInput): HostRow {
    return this.#transaction(() => {
      this.#run(
        `INSERT INTO hosts
           (id, environment_id, label, platform, host_key_hash, host_key_ciphertext,
            key_version, host_token_hash, online, paused, last_seen_at, created_at,
            revoked_at, connector_mode, tunnel_id, dns_record_id, hostname, origin_port, public_url)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, 0, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
        input.id,
        input.environmentId,
        input.label,
        input.platform,
        input.hostKeyHash,
        input.hostKeyCiphertext,
        input.hostTokenHash,
        input.now,
        input.now,
        input.connectorMode,
        input.hostname,
        input.originPort,
        input.publicUrl,
      );
      return this.#requireHost(input.id);
    });
  }

  getHost(hostId: string): HostRow | null {
    const row = this.#rows<HostDbRow>("SELECT * FROM hosts WHERE id = ?", hostId)[0];
    return row === undefined ? null : toHost(row);
  }

  findHostByEnvironment(environmentId: string): HostRow | null {
    const row = this.#rows<HostDbRow>(
      "SELECT * FROM hosts WHERE environment_id = ?",
      environmentId,
    )[0];
    return row === undefined ? null : toHost(row);
  }

  findHostByKeyHash(hostKeyHash: string): HostRow | null {
    const row = this.#rows<HostDbRow>(
      "SELECT * FROM hosts WHERE host_key_hash = ? AND revoked_at IS NULL",
      hostKeyHash,
    )[0];
    return row === undefined ? null : toHost(row);
  }

  findHostByTokenHash(hostTokenHash: string): HostRow | null {
    const row = this.#rows<HostDbRow>(
      "SELECT * FROM hosts WHERE host_token_hash = ? AND revoked_at IS NULL",
      hostTokenHash,
    )[0];
    return row === undefined ? null : toHost(row);
  }

  updateRegistration(input: UpdateRegistrationInput): HostRow | null {
    const current = this.getHost(input.hostId);
    if (current === null || current.revokedAt !== null) return null;
    this.#run(
      `UPDATE hosts
          SET label = ?, platform = ?, host_token_hash = ?, connector_mode = ?,
              hostname = ?, origin_port = ?, public_url = ?, online = 1, paused = 0,
              last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
      input.label,
      input.platform,
      input.hostTokenHash,
      input.connectorMode,
      input.hostname,
      input.originPort,
      input.publicUrl,
      input.now,
      input.hostId,
    );
    return this.getHost(input.hostId);
  }

  setConnector(input: SetConnectorInput): HostRow | null {
    const current = this.getHost(input.hostId);
    if (current === null || current.revokedAt !== null) return null;
    this.#run(
      `UPDATE hosts
          SET connector_mode = ?, tunnel_id = ?, dns_record_id = ?, hostname = ?,
              origin_port = ?, public_url = ?, last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
      input.connectorMode,
      input.tunnelId,
      input.dnsRecordId,
      input.hostname,
      input.originPort,
      input.publicUrl,
      input.now,
      input.hostId,
    );
    return this.getHost(input.hostId);
  }

  touchHeartbeat(input: TouchHeartbeatInput): HostRow | null {
    const current = this.getHost(input.hostId);
    if (current === null || current.revokedAt !== null) return null;
    const label = input.label === undefined ? null : input.label;
    const publicUrl =
      input.publicUrl === undefined || input.publicUrl.length === 0 ? null : input.publicUrl;
    this.#run(
      `UPDATE hosts
          SET last_seen_at = ?,
              online = ?,
              paused = ?,
              label = CASE WHEN ? THEN ? ELSE label END,
              public_url = CASE WHEN ? THEN ? ELSE public_url END
        WHERE id = ? AND revoked_at IS NULL`,
      input.now,
      input.online === false ? 0 : 1,
      input.online === false ? 1 : 0,
      input.label === undefined ? 0 : 1,
      label,
      publicUrl === null ? 0 : 1,
      publicUrl,
      input.hostId,
    );
    return this.getHost(input.hostId);
  }

  rotateHostKey(input: RotateHostKeyInput): number | null {
    const current = this.getHost(input.hostId);
    if (current === null || current.revokedAt !== null) return null;
    this.#run(
      `UPDATE hosts
          SET host_key_hash = ?, host_key_ciphertext = ?, key_version = key_version + 1,
              online = 1, paused = 0, last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
      input.hostKeyHash,
      input.hostKeyCiphertext,
      input.now,
      input.hostId,
    );
    return current.keyVersion + 1;
  }

  deleteHost(hostId: string): boolean {
    return this.#transaction(() => {
      const existing = this.getHost(hostId);
      if (existing === null) return false;
      this.#run("DELETE FROM host_clients WHERE host_id = ?", hostId);
      this.#run("DELETE FROM hosts WHERE id = ?", hostId);
      return true;
    });
  }

  revokeHost(hostId: string, now: number): boolean {
    const current = this.getHost(hostId);
    if (current === null || current.revokedAt !== null) return false;
    this.#run(
      `UPDATE hosts SET revoked_at = ?, online = 0, paused = 0, last_seen_at = ?
        WHERE id = ? AND revoked_at IS NULL`,
      now,
      now,
      hostId,
    );
    return true;
  }

  restoreHost(hostId: string, now: number): boolean {
    const current = this.getHost(hostId);
    if (current === null || current.revokedAt === null) return false;
    this.#run(
      `UPDATE hosts SET revoked_at = NULL, online = 0, paused = 0, last_seen_at = ?
        WHERE id = ? AND revoked_at IS NOT NULL`,
      now,
      hostId,
    );
    return true;
  }

  listHosts(): ReadonlyArray<HostRow> {
    return this.#rows<HostDbRow>("SELECT * FROM hosts ORDER BY created_at ASC, id ASC").map(toHost);
  }

  countActiveHosts(): number {
    const row = this.#rows<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM hosts WHERE revoked_at IS NULL",
    )[0];
    return row === undefined ? 0 : Number(row.count);
  }

  replaceClients(hostId: string, clients: ReadonlyArray<ClientSnapshotInput>, now: number): void {
    this.#transaction(() => {
      for (const client of clients) {
        this.#run(
          `INSERT INTO host_clients
             (host_id, session_id, client_label, platform, first_seen_at, last_seen_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (host_id, session_id) DO UPDATE SET
             client_label = excluded.client_label,
             platform = excluded.platform,
             first_seen_at = MIN(host_clients.first_seen_at, excluded.first_seen_at),
             last_seen_at = MAX(host_clients.last_seen_at, excluded.last_seen_at),
             revoked_at = COALESCE(excluded.revoked_at, host_clients.revoked_at)`,
          hostId,
          client.sessionId,
          client.clientLabel,
          client.platform,
          client.firstSeenAt,
          client.lastSeenAt,
          client.revokedAt ?? null,
        );
      }

      const reported = new Set(clients.map((client) => client.sessionId));
      const live = this.#rows<{ readonly session_id: string }>(
        "SELECT session_id FROM host_clients WHERE host_id = ? AND revoked_at IS NULL",
        hostId,
      );
      for (const row of live) {
        if (reported.has(row.session_id)) continue;
        this.#run(
          `UPDATE host_clients SET revoked_at = ?
            WHERE host_id = ? AND session_id = ? AND revoked_at IS NULL`,
          now,
          hostId,
          row.session_id,
        );
      }

      this.#run(
        `DELETE FROM host_clients
          WHERE host_id = ? AND revoked_at IS NOT NULL AND last_seen_at < ?`,
        hostId,
        now - STALE_CLIENT_MS,
      );
    });
  }

  listClients(hostId: string): ReadonlyArray<HostClientRow> {
    return this.#rows<HostClientDbRow>(
      "SELECT * FROM host_clients WHERE host_id = ? ORDER BY last_seen_at DESC, id ASC",
      hostId,
    ).map(toHostClient);
  }

  countClients(hostId: string): number {
    const row = this.#rows<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM host_clients WHERE host_id = ? AND revoked_at IS NULL",
      hostId,
    )[0];
    return row === undefined ? 0 : Number(row.count);
  }

  revokeClient(hostId: string, sessionId: string, now: number): boolean {
    const row = this.#rows<{ readonly revoked_at: number | null }>(
      "SELECT revoked_at FROM host_clients WHERE host_id = ? AND session_id = ?",
      hostId,
      sessionId,
    )[0];
    if (row === undefined || row.revoked_at !== null) return false;
    this.#run(
      `UPDATE host_clients SET revoked_at = ?
        WHERE host_id = ? AND session_id = ? AND revoked_at IS NULL`,
      now,
      hostId,
      sessionId,
    );
    return true;
  }

  revokedClients(hostId: string, now: number): ReadonlyArray<string> {
    return this.#rows<{ readonly session_id: string }>(
      `SELECT session_id FROM host_clients
        WHERE host_id = ? AND revoked_at IS NOT NULL AND revoked_at >= ?`,
      hostId,
      now - REVOKED_CLIENT_REPORT_MS,
    ).map((row) => row.session_id);
  }

  pruneClients(before: number): number {
    return this.#transaction(() => {
      const row = this.#rows<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM host_clients
          WHERE revoked_at IS NOT NULL AND last_seen_at < ?`,
        before,
      )[0];
      const count = row === undefined ? 0 : Number(row.count);
      if (count > 0) {
        this.#run(
          "DELETE FROM host_clients WHERE revoked_at IS NOT NULL AND last_seen_at < ?",
          before,
        );
      }
      return count;
    });
  }

  consumeRateLimit(input: RateLimitInput): RateLimitResult {
    const existing = this.#rows<{ readonly count: number; readonly reset_at: number }>(
      "SELECT count, reset_at FROM rate_limits WHERE scope = ? AND key = ?",
      input.scope,
      input.key,
    )[0];
    const bucket =
      existing === undefined || existing.reset_at <= input.now
        ? { count: 0, resetAt: input.now + input.windowMs }
        : { count: existing.count, resetAt: existing.reset_at };
    const count = bucket.count + 1;
    this.#run(
      `INSERT INTO rate_limits (scope, key, count, reset_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at`,
      input.scope,
      input.key,
      count,
      bucket.resetAt,
    );
    const allowed = count <= input.limit;
    return {
      allowed,
      remaining: Math.max(0, input.limit - count),
      retryAfterMs: allowed ? 0 : Math.max(0, bucket.resetAt - input.now),
    };
  }

  pruneRateLimits(before: number): number {
    return this.#transaction(() => {
      const row = this.#rows<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM rate_limits WHERE reset_at < ?",
        before,
      )[0];
      const count = row === undefined ? 0 : Number(row.count);
      if (count > 0) this.#run("DELETE FROM rate_limits WHERE reset_at < ?", before);
      return count;
    });
  }

  audit(input: AuditInput): void {
    this.#run(
      "INSERT INTO admin_audit (action, host_id, actor, created_at) VALUES (?, ?, ?, ?)",
      input.action,
      input.hostId,
      input.actor,
      input.now,
    );
  }

  #requireHost(hostId: string): HostRow {
    const host = this.getHost(hostId);
    if (host === null) throw new Error(`Host '${hostId}' disappeared during registration.`);
    return host;
  }
}

/**
 * Builds the SQLite-backed store. `transaction` defaults to no grouping, so tests
 * can use a plain SQL adapter; the Durable Object passes `storage.transactionSync`.
 */
export function createSqliteRegistryStore(
  sql: RegistrySql,
  transaction: RegistryTransaction = (callback) => callback(),
): RegistryStore {
  return new SqliteRegistryStore(sql, transaction);
}
