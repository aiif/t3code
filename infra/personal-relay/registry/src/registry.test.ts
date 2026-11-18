import { describe, expect, it } from "vite-plus/test";

import { RegistryRequestError } from "./registry.ts";
import {
  makeTestRegistry,
  registerTestHost,
  subscribeTestDevice,
  TEST_ADMIN_KEY,
} from "./testkit.ts";

describe("admin key", () => {
  it("accepts only the configured admin key", () => {
    const registry = makeTestRegistry();
    expect(() => registry.service.authenticateAdminKey(TEST_ADMIN_KEY)).not.toThrow();
    expect(() => registry.service.authenticateAdminKey("wrong-key")).toThrow(RegistryRequestError);
    expect(() => registry.service.authenticateAdminKey("")).toThrow(RegistryRequestError);
    registry.close();
  });
});

describe("host registration", () => {
  it("re-registering the same environment keeps the host id and host key", () => {
    const registry = makeTestRegistry();
    const first = registry.service.registerHost({
      environmentId: "env-a",
      label: "Home PC",
      platform: "win32",
    });
    registry.advance(1_000);
    const second = registry.service.registerHost({
      environmentId: "env-a",
      label: "Home PC (renamed)",
      platform: "win32",
    });

    expect(second.hostId).toBe(first.hostId);
    expect(second.hostKey).toBe(first.hostKey);
    expect(second.hostKeyVersion).toBe(first.hostKeyVersion);
    expect(second.hostToken).not.toBe(first.hostToken);
    expect(second.label).toBe("Home PC (renamed)");
    expect(second.publicUrl).toBe(`https://${first.hostId}.t3.example.test`);
    expect(second.frp).toEqual({
      serverAddr: "203.0.113.10",
      serverPort: 7001,
      authToken: "frp-shared-token",
      domain: `${first.hostId}.t3.example.test`,
    });
    expect(registry.service.listAdminHosts().hosts).toHaveLength(1);
    registry.close();
  });

  it("registers distinct environments as distinct hosts with distinct keys", () => {
    const registry = makeTestRegistry();
    const first = registerTestHost(registry, "env-a");
    const second = registerTestHost(registry, "env-b");

    expect(second.hostId).not.toBe(first.hostId);
    expect(second.hostKey).not.toBe(first.hostKey);
    expect(second.hostToken).not.toBe(first.hostToken);
    expect(registry.service.listAdminHosts().hosts).toHaveLength(2);
    registry.close();
  });

  it("rejects a malformed registration", () => {
    const registry = makeTestRegistry();
    expect(() => registry.service.registerHost({})).toThrow(RegistryRequestError);
    expect(() => registry.service.registerHost({ environmentId: "x".repeat(201) })).toThrow(
      RegistryRequestError,
    );
    registry.close();
  });

  it("round-trips the host key through encryption and the admin reveal", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const listed = registry.service.getAdminHost(host.hostId).host;
    expect(listed.hostKey).toBe(host.hostKey);
    registry.close();
  });
});

describe("host liveness", () => {
  it("reports online until the heartbeat TTL passes, then offline", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    expect(registry.service.listAdminHosts().hosts[0]?.online).toBe(true);
    registry.advance(91_000);
    expect(registry.service.listAdminHosts().hosts[0]?.online).toBe(false);

    const row = registry.service.authenticateHostToken(host.hostToken);
    registry.service.heartbeat(row, { hostKeyVersion: host.hostKeyVersion });
    expect(registry.service.listAdminHosts().hosts[0]?.online).toBe(true);
    registry.close();
  });

  it("pausing makes the host offline while its host key still resolves", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const row = registry.service.authenticateHostToken(host.hostToken);
    registry.service.heartbeat(row, { online: false });

    const resolved = registry.service.resolveHostKey(host.hostKey);
    expect(resolved.online).toBe(false);
    expect(resolved.paused).toBe(true);

    registry.service.heartbeat(registry.service.authenticateHostToken(host.hostToken), {
      online: true,
    });
    expect(registry.service.resolveHostKey(host.hostKey).online).toBe(true);
    registry.close();
  });

  it("accepts only the matching host token", () => {
    const registry = makeTestRegistry();
    const first = registerTestHost(registry, "env-a");
    const second = registerTestHost(registry, "env-b");
    expect(registry.service.authenticateHostToken(first.hostToken).id).toBe(first.hostId);
    expect(() => registry.service.authenticateHostToken(second.hostToken)).not.toThrow();
    expect(() =>
      registry.service.authenticateHostToken(first.hostToken.replace(first.hostId, second.hostId)),
    ).toThrow(RegistryRequestError);
    expect(() => registry.service.authenticateHostToken("garbage")).toThrow(RegistryRequestError);
    registry.close();
  });

  it("unregistering removes the host and invalidates its key", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const row = registry.service.authenticateHostToken(host.hostToken);
    expect(registry.service.unregister(row)).toEqual({ removed: true });
    expect(registry.service.listAdminHosts().hosts).toHaveLength(0);
    expect(() => registry.service.resolveHostKey(host.hostKey)).toThrow(RegistryRequestError);
    registry.close();
  });
});

describe("host keys", () => {
  it("resolves only the host the key belongs to", () => {
    const registry = makeTestRegistry();
    const first = registerTestHost(registry, "env-a");
    const second = registerTestHost(registry, "env-b");

    expect(registry.service.resolveHostKey(first.hostKey)).toMatchObject({
      hostId: first.hostId,
      environmentId: "env-a",
    });
    expect(registry.service.resolveHostKey(second.hostKey)).toMatchObject({
      hostId: second.hostId,
      environmentId: "env-b",
    });
    expect(() => registry.service.resolveHostKey(TEST_ADMIN_KEY)).toThrow(RegistryRequestError);
    registry.close();
  });

  it("rotation invalidates the old key and tells the host the new version", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const rotated = registry.service.rotateHostKey(host.hostId, "admin");

    expect(rotated.hostKey).not.toBe(host.hostKey);
    expect(() => registry.service.resolveHostKey(host.hostKey)).toThrow(RegistryRequestError);
    expect(registry.service.resolveHostKey(rotated.hostKey).hostId).toBe(host.hostId);

    const heartbeat = registry.service.heartbeat(
      registry.service.authenticateHostToken(host.hostToken),
      { hostKeyVersion: host.hostKeyVersion },
    );
    expect(heartbeat.hostKey).toBe(rotated.hostKey);
    expect(heartbeat.hostKeyVersion).toBeGreaterThan(host.hostKeyVersion);

    const repeated = registry.service.heartbeat(
      registry.service.authenticateHostToken(host.hostToken),
      { hostKeyVersion: heartbeat.hostKeyVersion },
    );
    expect(repeated.hostKey).toBeUndefined();
    registry.close();
  });
});

describe("guest clients", () => {
  it("stores a snapshot, revokes missing sessions, and reports revocation", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const row = registry.service.authenticateHostToken(host.hostToken);
    registry.service.reportClients(row, {
      clients: [
        {
          sessionId: "session-1",
          clientLabel: "Phone",
          platform: "mobile",
          firstSeenAt: "2026-11-16T00:00:00.000Z",
          lastSeenAt: "2026-11-16T00:05:00.000Z",
        },
      ],
    });
    expect(registry.service.listAdminClients(host.hostId).clients).toHaveLength(1);
    expect(registry.service.getAdminHost(host.hostId).host.clientsCount).toBe(1);

    registry.service.reportClients(row, { clients: [] });
    expect(registry.service.listAdminClients(host.hostId).clients[0]?.revokedAt).not.toBeNull();
    expect(registry.service.heartbeat(row, {}).revokedSessionIds).toEqual(["session-1"]);
    registry.close();
  });

  it("marks a client revoked on admin request", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    registry.service.reportClients(registry.service.authenticateHostToken(host.hostToken), {
      clients: [{ sessionId: "session-1", firstSeenAt: 1, lastSeenAt: 2 }],
    });
    expect(
      registry.service.revokeClient(host.hostId, { sessionId: "session-1" }, "admin").revoked,
    ).toBe(true);
    expect(registry.service.listAdminClients(host.hostId).clients[0]?.revokedAt).not.toBeNull();
    registry.close();
  });
});

describe("admin host management", () => {
  it("removes hosts and restores them", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    expect(registry.service.removeHost(host.hostId, "admin")).toEqual({ removed: true });
    expect(registry.service.listAdminHosts().hosts).toMatchObject([
      { hostId: host.hostId, revokedAt: expect.any(String) },
    ]);
    expect(() => registry.service.getAdminHost(host.hostId)).toThrow(RegistryRequestError);
    expect(() => registry.service.authenticateHostToken(host.hostToken)).toThrow(
      RegistryRequestError,
    );
    expect(() =>
      registry.service.registerHost({ environmentId: "env-a", label: "Home PC" }),
    ).toThrow(RegistryRequestError);

    expect(registry.service.restoreHost(host.hostId, "admin")).toEqual({ restored: true });
    const restored = registry.service.registerHost({ environmentId: "env-a", label: "Home PC" });
    expect(restored.hostId).toBe(host.hostId);
    expect(restored.hostKey).toBe(host.hostKey);
    registry.close();
  });
});

describe("web push", () => {
  it("stores a host subscription and removes it", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const scope = subscribeTestDevice(registry, undefined, host.hostKey);
    expect(scope).toEqual({ scope: "host", hostId: host.hostId });
    expect(registry.store.listPushSubscriptions("host", host.hostId)).toHaveLength(1);
    expect(
      registry.service.unsubscribe(scope, {
        endpoint: "https://push.example.test/subscription/one",
      }),
    ).toEqual({ removed: true });
    registry.close();
  });

  it("notifies host and admin subscriptions with a redacted payload", async () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    subscribeTestDevice(registry, "https://push.example.test/host", host.hostKey);
    subscribeTestDevice(registry, "https://push.example.test/admin", TEST_ADMIN_KEY);

    const result = await registry.service.notify(
      registry.service.authenticateHostToken(host.hostToken),
      {
        environmentId: "env-a",
        threadId: "thread-1",
        phase: "waiting_for_approval",
        threadTitle: "Fix the login flow",
        projectTitle: "web",
        hostLabel: "Home PC",
        prompt: "secret prompt",
      },
    );

    expect(result).toEqual({ delivered: 2, removed: 0, skipped: null });
    expect(registry.sent[0]?.payload).toEqual({
      title: "Approval needed · Home PC",
      body: "Fix the login flow · web",
      hostId: host.hostId,
      environmentId: "env-a",
      threadId: "thread-1",
      phase: "waiting_for_approval",
      tag: "thread-1",
    });
    expect(JSON.stringify(registry.sent[0]?.payload)).not.toContain("secret");
    registry.close();
  });

  it("deduplicates and drops gone subscriptions", async () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    subscribeTestDevice(registry, "https://push.example.test/host", host.hostKey);
    const notification = {
      environmentId: "env-a",
      threadId: "thread-1",
      phase: "completed" as const,
    };
    const row = registry.service.authenticateHostToken(host.hostToken);
    expect((await registry.service.notify(row, notification)).delivered).toBe(1);
    expect(await registry.service.notify(row, notification)).toEqual({
      delivered: 0,
      removed: 0,
      skipped: "deduped",
    });
    registry.close();
  });
});

describe("on-demand TLS host check", () => {
  it("normalizes the domain and rejects unknown, revoked, and deeper names", () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const domain = `${host.hostId}.t3.example.test`;

    expect(registry.service.servesHostDomain(domain)).toBe(true);
    expect(registry.service.servesHostDomain(`  ${domain.toUpperCase()}.  `)).toBe(true);
    expect(registry.service.servesHostDomain(`unknownhost.t3.example.test`)).toBe(false);
    expect(registry.service.servesHostDomain(`${host.hostId}.other.example.test`)).toBe(false);
    expect(registry.service.servesHostDomain(`a.${domain}`)).toBe(false);
    expect(registry.service.servesHostDomain(domain.slice(0, -1))).toBe(false);

    registry.service.removeHost(host.hostId, "test");
    expect(registry.service.servesHostDomain(domain)).toBe(false);
    registry.close();
  });
});
