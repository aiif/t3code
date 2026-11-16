import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { RegistryService } from "./registry.ts";
import { RegistryStore } from "./store.ts";
import { TEST_ADMIN_KEY, TEST_SECRET_KEY } from "./testkit.ts";

it("migrates v1 key-space hosts in place and keeps their ids", async () => {
  const directory = await NodeFSP.mkdtemp("t3-registry-migration-");
  const path = NodePath.join(directory, "registry.sqlite");
  try {
    const old = new NodeSqlite.DatabaseSync(path);
    old.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE hosts (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        space_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE notification_dedupe (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('space-a', 1);
      INSERT INTO hosts VALUES ('62c764eff9c2', 'space-a', 'env-studio', 'Studio PC', 1, 2, 3);
      INSERT INTO push_subscriptions
        (space_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
      VALUES ('space-a', 'https://push.example.test/one', 'p', 'a', 'ua', 1, 1);
    `);
    old.close();

    const store = new RegistryStore(path, TEST_SECRET_KEY);
    expect(store.migratedHosts).toEqual([
      { hostId: "62c764eff9c2", environmentId: "env-studio", hostKey: expect.any(String) },
    ]);
    const migrated = store.migratedHosts[0]!;
    store.close();

    const reopened = new RegistryStore(path, TEST_SECRET_KEY);
    const service = new RegistryService({
      store: reopened,
      sender: { send: async () => "sent" },
      adminKey: TEST_ADMIN_KEY,
      secretKey: TEST_SECRET_KEY,
      portalUrl: "https://t3.example.test",
      hostDomain: "t3.example.test",
      frpServerAddr: "203.0.113.10",
      frpServerPort: 7001,
      frpAuthToken: "frp-token",
      heartbeatTtlMs: 90_000,
      notifyDedupeMs: 30_000,
      now: () => 10,
    });
    expect(service.resolveHostKey(migrated.hostKey)).toMatchObject({
      hostId: "62c764eff9c2",
      environmentId: "env-studio",
      online: false,
    });
    const adminHosts = service.listAdminHosts().hosts;
    expect(adminHosts).toHaveLength(1);
    expect(adminHosts[0]?.hostKey).toBe(migrated.hostKey);

    // Re-registering the migrated environment keeps the id and key.
    const registered = service.registerHost({ environmentId: "env-studio", label: "Studio PC" });
    expect(registered.hostId).toBe("62c764eff9c2");
    expect(registered.hostKey).toBe(migrated.hostKey);
    reopened.close();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
