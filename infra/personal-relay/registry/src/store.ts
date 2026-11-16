import * as NodeSqlite from "node:sqlite";

import { newHostId } from "./crypto.ts";

export interface HostRow {
  readonly id: string;
  readonly spaceId: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly createdAt: number;
  readonly registeredAt: number;
  readonly updatedAt: number;
}

export interface PushSubscriptionRow {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

interface HostDbRow {
  readonly id: string;
  readonly space_id: string;
  readonly environment_id: string;
  readonly label: string | null;
  readonly created_at: number;
  readonly registered_at: number;
  readonly updated_at: number;
}

interface PushSubscriptionDbRow {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

function toHost(row: HostDbRow): HostRow {
  return {
    id: row.id,
    spaceId: row.space_id,
    environmentId: row.environment_id,
    label: row.label,
    createdAt: row.created_at,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (space_id, environment_id)
) STRICT;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (space_id, endpoint)
) STRICT;

CREATE TABLE IF NOT EXISTS notification_dedupe (
  key TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
) STRICT;
`;

const SCHEMA_VERSION = 1;

/** SQLite persistence for the registry. All calls are synchronous by design. */
export class RegistryStore {
  readonly db: NodeSqlite.DatabaseSync;

  constructor(path: string) {
    this.db = new NodeSqlite.DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
    if (version >= SCHEMA_VERSION) return;
    this.transaction(() => {
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
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

  ensureSpace(spaceId: string, now: number): void {
    this.db
      .prepare("INSERT INTO spaces (id, created_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING")
      .run(spaceId, now);
  }

  /**
   * Registers a host once per environment. Re-registering keeps the host id so
   * its public URL and existing push notifications stay valid.
   */
  registerHost(input: {
    readonly spaceId: string;
    readonly environmentId: string;
    readonly label: string | null;
    readonly now: number;
  }): HostRow {
    return this.transaction(() => {
      this.ensureSpace(input.spaceId, input.now);
      const existing = this.db
        .prepare("SELECT id FROM hosts WHERE space_id = ? AND environment_id = ?")
        .get(input.spaceId, input.environmentId) as { readonly id: string } | undefined;
      if (existing !== undefined) {
        this.db
          .prepare("UPDATE hosts SET label = ?, registered_at = ?, updated_at = ? WHERE id = ?")
          .run(input.label, input.now, input.now, existing.id);
        return this.requireHost(existing.id);
      }
      const hostId = newHostId();
      this.db
        .prepare(
          `INSERT INTO hosts
             (id, space_id, environment_id, label, created_at, registered_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hostId,
          input.spaceId,
          input.environmentId,
          input.label,
          input.now,
          input.now,
          input.now,
        );
      return this.requireHost(hostId);
    });
  }

  private requireHost(hostId: string): HostRow {
    const host = this.getHost(hostId);
    if (host === null) {
      throw new Error(`Host '${hostId}' disappeared during registration.`);
    }
    return host;
  }

  getHost(hostId: string): HostRow | null {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(hostId) as
      | HostDbRow
      | undefined;
    return row === undefined ? null : toHost(row);
  }

  touchHost(input: {
    readonly hostId: string;
    readonly environmentId?: string | undefined;
    readonly label?: string | null | undefined;
    readonly now: number;
  }): HostRow | null {
    const current = this.getHost(input.hostId);
    if (current === null) return null;
    this.db
      .prepare(
        `UPDATE hosts
            SET updated_at = ?,
                environment_id = COALESCE(?, environment_id),
                label = CASE WHEN ? THEN ? ELSE label END
          WHERE id = ?`,
      )
      .run(
        input.now,
        input.environmentId ?? null,
        input.label === undefined ? 0 : 1,
        input.label ?? null,
        input.hostId,
      );
    return this.getHost(input.hostId);
  }

  deleteHost(hostId: string): boolean {
    const result = this.db.prepare("DELETE FROM hosts WHERE id = ?").run(hostId);
    return Number(result.changes) > 0;
  }

  listHosts(spaceId: string): ReadonlyArray<HostRow> {
    const rows = this.db
      .prepare("SELECT * FROM hosts WHERE space_id = ? ORDER BY created_at ASC")
      .all(spaceId) as unknown as ReadonlyArray<HostDbRow>;
    return rows.map(toHost);
  }

  upsertPushSubscription(input: {
    readonly spaceId: string;
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly userAgent: string | null;
    readonly now: number;
  }): void {
    this.transaction(() => {
      this.ensureSpace(input.spaceId, input.now);
      this.db
        .prepare(
          `INSERT INTO push_subscriptions
             (space_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (space_id, endpoint) DO UPDATE SET
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             user_agent = excluded.user_agent,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.spaceId,
          input.endpoint,
          input.p256dh,
          input.auth,
          input.userAgent,
          input.now,
          input.now,
        );
    });
  }

  deletePushSubscription(spaceId: string, endpoint: string): boolean {
    const result = this.db
      .prepare("DELETE FROM push_subscriptions WHERE space_id = ? AND endpoint = ?")
      .run(spaceId, endpoint);
    return Number(result.changes) > 0;
  }

  listPushSubscriptions(spaceId: string): ReadonlyArray<PushSubscriptionRow> {
    const rows = this.db
      .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE space_id = ?")
      .all(spaceId) as unknown as ReadonlyArray<PushSubscriptionDbRow>;
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
}
