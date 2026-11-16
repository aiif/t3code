import * as NodeSqlite from "node:sqlite";

import {
  encryptHostKey,
  hashHostKey,
  hashToken,
  newHostId,
  newHostKey,
  newHostToken,
} from "./crypto.ts";

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

export interface PushSubscriptionRow {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export type PushScope = "admin" | "host";

interface HostDbRow {
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
}

interface HostClientDbRow {
  readonly id: number;
  readonly host_id: string;
  readonly session_id: string;
  readonly client_label: string | null;
  readonly platform: string | null;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly revoked_at: number | null;
}

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
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
  revoked_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS host_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  client_label TEXT,
  platform TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (host_id, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  host_id TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, host_id, endpoint)
) STRICT;

CREATE TABLE IF NOT EXISTS notification_dedupe (
  key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  host_id TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`;

const SCHEMA_VERSION = 2;
const STALE_CLIENT_MS = 30 * 24 * 60 * 60 * 1_000;

export interface MigratedHost {
  readonly hostId: string;
  readonly environmentId: string;
  readonly hostKey: string;
}

/** SQLite persistence for the registry. All calls are synchronous by design. */
export class RegistryStore {
  readonly db: NodeSqlite.DatabaseSync;
  readonly #secretKey: Buffer;
  readonly #migratedHosts: Array<MigratedHost> = [];

  constructor(path: string, secretKey: Buffer) {
    this.db = new NodeSqlite.DatabaseSync(path);
    this.#secretKey = secretKey;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** Hosts carried over from the v1 key-space schema; their host record is kept. */
  get migratedHosts(): ReadonlyArray<MigratedHost> {
    return this.#migratedHosts;
  }

  private migrate(): void {
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (version >= SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      return;
    }
    this.transaction(() => {
      if (this.hasV1Hosts()) {
        this.migrateV1();
      }
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private hasV1Hosts(): boolean {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hosts'")
      .get() as { readonly name?: string } | undefined;
    if (table === undefined) return false;
    const columns = this.db.prepare("PRAGMA table_info(hosts)").all() as unknown as ReadonlyArray<{
      readonly name: string;
    }>;
    return columns.some((column) => column.name === "space_id");
  }

  /**
   * Keep each host's id and environment id, generate its host key and host
   * token, and park it offline until the new host version re-registers.
   */
  private migrateV1(): void {
    const oldHosts = this.db.prepare("SELECT * FROM hosts").all() as unknown as ReadonlyArray<{
      readonly id: string;
      readonly environment_id: string;
      readonly label: string | null;
      readonly created_at: number;
      readonly registered_at: number;
      readonly updated_at: number;
    }>;
    const oldSubscriptions = this.db
      .prepare("SELECT * FROM push_subscriptions")
      .all() as unknown as
      | ReadonlyArray<{
          readonly endpoint: string;
          readonly p256dh: string;
          readonly auth: string;
          readonly user_agent: string | null;
          readonly created_at: number;
          readonly updated_at: number;
        }>
      | undefined;
    this.db.exec("DROP TABLE IF EXISTS notification_dedupe");
    this.db.exec("DROP TABLE IF EXISTS push_subscriptions");
    this.db.exec("DROP TABLE IF EXISTS hosts");
    this.db.exec("DROP TABLE IF EXISTS spaces");
    this.db.exec(SCHEMA);
    for (const host of oldHosts) {
      const hostKey = newHostKey();
      const hostToken = newHostToken(host.id);
      this.db
        .prepare(
          `INSERT INTO hosts
             (id, environment_id, label, platform, host_key_hash, host_key_ciphertext,
              key_version, host_token_hash, online, paused, last_seen_at, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, 1, ?, 0, 0, ?, ?)`,
        )
        .run(
          host.id,
          host.environment_id,
          host.label,
          hashHostKey(hostKey),
          encryptHostKey(this.#secretKey, hostKey),
          hashToken(hostToken),
          host.updated_at,
          host.created_at,
        );
      this.#migratedHosts.push({
        hostId: host.id,
        environmentId: host.environment_id,
        hostKey,
      });
    }
    for (const subscription of oldSubscriptions ?? []) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO push_subscriptions
             (scope, host_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
           VALUES ('admin', '', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          subscription.endpoint,
          subscription.p256dh,
          subscription.auth,
          subscription.user_agent,
          subscription.created_at,
          subscription.updated_at,
        );
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  createHost(input: {
    readonly environmentId: string;
    readonly label: string | null;
    readonly platform: string | null;
    readonly now: number;
  }): { readonly host: HostRow; readonly hostKey: string; readonly hostToken: string } {
    return this.transaction(() => {
      const hostId = newHostId();
      const hostKey = newHostKey();
      const hostToken = newHostToken(hostId);
      this.db
        .prepare(
          `INSERT INTO hosts
             (id, environment_id, label, platform, host_key_hash, host_key_ciphertext,
              key_version, host_token_hash, online, paused, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, 0, ?, ?)`,
        )
        .run(
          hostId,
          input.environmentId,
          input.label,
          input.platform,
          hashHostKey(hostKey),
          encryptHostKey(this.#secretKey, hostKey),
          hashToken(hostToken),
          input.now,
          input.now,
        );
      return { host: this.requireHost(hostId), hostKey, hostToken };
    });
  }

  getHost(hostId: string): HostRow | null {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(hostId) as
      | HostDbRow
      | undefined;
    return row === undefined ? null : toHost(row);
  }

  findHostByEnvironment(environmentId: string): HostRow | null {
    const row = this.db
      .prepare("SELECT * FROM hosts WHERE environment_id = ?")
      .get(environmentId) as HostDbRow | undefined;
    return row === undefined ? null : toHost(row);
  }

  findHostByKeyHash(hostKeyHash: string): HostRow | null {
    const row = this.db
      .prepare("SELECT * FROM hosts WHERE host_key_hash = ? AND revoked_at IS NULL")
      .get(hostKeyHash) as HostDbRow | undefined;
    return row === undefined ? null : toHost(row);
  }

  findHostByTokenHash(hostTokenHash: string): HostRow | null {
    const row = this.db
      .prepare("SELECT * FROM hosts WHERE host_token_hash = ? AND revoked_at IS NULL")
      .get(hostTokenHash) as HostDbRow | undefined;
    return row === undefined ? null : toHost(row);
  }

  updateRegistration(input: {
    readonly hostId: string;
    readonly label: string | null;
    readonly platform: string | null;
    readonly hostToken: string;
    readonly now: number;
  }): HostRow | null {
    this.db
      .prepare(
        `UPDATE hosts
            SET label = ?, platform = ?, host_token_hash = ?, online = 1, paused = 0,
                last_seen_at = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(input.label, input.platform, hashToken(input.hostToken), input.now, input.hostId);
    return this.getHost(input.hostId);
  }

  touchHeartbeat(input: {
    readonly hostId: string;
    readonly label?: string | null | undefined;
    readonly online?: boolean | undefined;
    readonly now: number;
  }): HostRow | null {
    const current = this.getHost(input.hostId);
    if (current === null) return null;
    this.db
      .prepare(
        `UPDATE hosts
            SET last_seen_at = ?,
                online = ?,
                paused = CASE WHEN ? THEN 1 ELSE 0 END,
                label = CASE WHEN ? THEN ? ELSE label END
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(
        input.now,
        input.online === false ? 0 : 1,
        input.online === false ? 1 : 0,
        input.label === undefined ? 0 : 1,
        input.label ?? null,
        input.hostId,
      );
    return this.getHost(input.hostId);
  }

  rotateHostKey(input: {
    readonly hostId: string;
    readonly hostKey: string;
    readonly now: number;
  }): number | null {
    const current = this.getHost(input.hostId);
    if (current === null) return null;
    this.db
      .prepare(
        `UPDATE hosts
            SET host_key_hash = ?, host_key_ciphertext = ?, key_version = key_version + 1,
                online = 1, paused = 0, last_seen_at = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(
        hashHostKey(input.hostKey),
        encryptHostKey(this.#secretKey, input.hostKey),
        input.now,
        input.hostId,
      );
    return (current.keyVersion ?? 0) + 1;
  }

  deleteHost(hostId: string): boolean {
    const result = this.db.prepare("DELETE FROM hosts WHERE id = ?").run(hostId);
    return Number(result.changes) > 0;
  }

  /** Admin removal keeps the row so the same environment cannot silently register again. */
  revokeHost(hostId: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE hosts SET revoked_at = ?, online = 0, paused = 0, last_seen_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(now, now, hostId);
    return Number(result.changes) > 0;
  }

  deleteRevokedHost(hostId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM hosts WHERE id = ? AND revoked_at IS NOT NULL")
      .run(hostId);
    return Number(result.changes) > 0;
  }

  listHosts(): ReadonlyArray<HostRow> {
    const rows = this.db
      .prepare("SELECT * FROM hosts WHERE revoked_at IS NULL ORDER BY created_at ASC")
      .all() as unknown as ReadonlyArray<HostDbRow>;
    return rows.map(toHost);
  }

  countClients(hostId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM host_clients WHERE host_id = ? AND revoked_at IS NULL",
      )
      .get(hostId) as { readonly count: number };
    return Number(row.count);
  }

  replaceClients(
    hostId: string,
    clients: ReadonlyArray<{
      readonly sessionId: string;
      readonly clientLabel: string | null;
      readonly platform: string | null;
      readonly firstSeenAt: number;
      readonly lastSeenAt: number;
      readonly revokedAt?: number | null;
    }>,
    now: number,
  ): void {
    this.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO host_clients
           (host_id, session_id, client_label, platform, first_seen_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host_id, session_id) DO UPDATE SET
           client_label = excluded.client_label,
           platform = excluded.platform,
           first_seen_at = MIN(host_clients.first_seen_at, excluded.first_seen_at),
           last_seen_at = MAX(host_clients.last_seen_at, excluded.last_seen_at),
           revoked_at = COALESCE(excluded.revoked_at, host_clients.revoked_at)`,
      );
      for (const client of clients) {
        upsert.run(
          hostId,
          client.sessionId,
          client.clientLabel,
          client.platform,
          client.firstSeenAt,
          client.lastSeenAt,
          client.revokedAt ?? null,
        );
      }
      // A session missing from a fresh snapshot is stale and stops counting as a live guest.
      const reported = new Set(clients.map((client) => client.sessionId));
      const rows = this.db
        .prepare("SELECT session_id FROM host_clients WHERE host_id = ? AND revoked_at IS NULL")
        .all(hostId) as unknown as ReadonlyArray<{ readonly session_id: string }>;
      const revoke = this.db.prepare(
        "UPDATE host_clients SET revoked_at = ? WHERE host_id = ? AND session_id = ? AND revoked_at IS NULL",
      );
      for (const row of rows) {
        if (!reported.has(row.session_id)) revoke.run(now, hostId, row.session_id);
      }
      this.db
        .prepare(
          "DELETE FROM host_clients WHERE host_id = ? AND last_seen_at < ? AND revoked_at IS NOT NULL",
        )
        .run(hostId, now - STALE_CLIENT_MS);
    });
  }

  listClients(hostId: string): ReadonlyArray<HostClientRow> {
    const rows = this.db
      .prepare("SELECT * FROM host_clients WHERE host_id = ? ORDER BY last_seen_at DESC")
      .all(hostId) as unknown as ReadonlyArray<HostClientDbRow>;
    return rows.map(toHostClient);
  }

  revokeClient(hostId: string, sessionId: string, now: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE host_clients SET revoked_at = ? WHERE host_id = ? AND session_id = ? AND revoked_at IS NULL",
      )
      .run(now, hostId, sessionId);
    return Number(result.changes) > 0;
  }

  revokedClients(hostId: string, now: number): ReadonlyArray<string> {
    const rows = this.db
      .prepare(
        "SELECT session_id FROM host_clients WHERE host_id = ? AND revoked_at IS NOT NULL AND revoked_at >= ?",
      )
      .all(hostId, now - 24 * 60 * 60 * 1_000) as unknown as ReadonlyArray<{
      readonly session_id: string;
    }>;
    return rows.map((row) => row.session_id);
  }

  upsertPushSubscription(input: {
    readonly scope: PushScope;
    readonly hostId: string;
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly userAgent: string | null;
    readonly now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions
           (scope, host_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, host_id, endpoint) DO UPDATE SET
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.scope,
        input.hostId,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.userAgent,
        input.now,
        input.now,
      );
  }

  deletePushSubscription(scope: PushScope, hostId: string, endpoint: string): boolean {
    const result = this.db
      .prepare("DELETE FROM push_subscriptions WHERE scope = ? AND host_id = ? AND endpoint = ?")
      .run(scope, hostId, endpoint);
    return Number(result.changes) > 0;
  }

  listPushSubscriptions(scope: PushScope, hostId: string): ReadonlyArray<PushSubscriptionRow> {
    const rows = this.db
      .prepare(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE scope = ? AND host_id = ?",
      )
      .all(scope, hostId) as unknown as ReadonlyArray<PushSubscriptionRow>;
    return rows.map((row) => ({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }));
  }

  /** True when this host/thread/phase sent a notification inside the window. */
  wasNotifiedRecently(key: string, now: number, windowMs: number): boolean {
    const row = this.db
      .prepare("SELECT sent_at FROM notification_dedupe WHERE key = ?")
      .get(key) as { readonly sent_at: number } | undefined;
    return row !== undefined && now - row.sent_at < windowMs;
  }

  recordNotification(key: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO notification_dedupe (key, sent_at) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET sent_at = excluded.sent_at`,
      )
      .run(key, now);
  }

  pruneNotifications(before: number): void {
    this.db.prepare("DELETE FROM notification_dedupe WHERE sent_at < ?").run(before);
  }

  audit(input: {
    readonly action: string;
    readonly hostId: string | null;
    readonly actor: string;
    readonly now: number;
  }): void {
    this.db
      .prepare("INSERT INTO admin_audit (action, host_id, actor, created_at) VALUES (?, ?, ?, ?)")
      .run(input.action, input.hostId, input.actor, input.now);
  }

  private requireHost(hostId: string): HostRow {
    const host = this.getHost(hostId);
    if (host === null) {
      throw new Error(`Host '${hostId}' disappeared during registration.`);
    }
    return host;
  }
}
