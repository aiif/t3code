import { describe, expect, it } from "vite-plus/test";

import { RegistryRequestError } from "./registry.ts";
import {
  makeTestRegistry,
  registerTestHost,
  subscribeTestDevice,
  TEST_PERSONAL_KEY as PERSONAL_KEY,
} from "./testkit.ts";

describe("personal key", () => {
  it("accepts only the configured key and derives a stable space", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    expect(spaceId).toBe(registry.service.authenticatePersonalKey(PERSONAL_KEY));
    expect(() => registry.service.authenticatePersonalKey("wrong-key")).toThrow(
      RegistryRequestError,
    );
    expect(() => registry.service.authenticatePersonalKey("")).toThrow(RegistryRequestError);
    registry.close();
  });
});

describe("host registration", () => {
  it("re-registering the same environment keeps the host id and token", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    const first = registry.service.registerHost(spaceId, {
      environmentId: "env-a",
      label: "Home PC",
    });
    registry.advance(1_000);
    const second = registry.service.registerHost(spaceId, {
      environmentId: "env-a",
      label: "Home PC (renamed)",
    });

    expect(second.hostId).toBe(first.hostId);
    expect(second.hostToken).toBe(first.hostToken);
    expect(second.label).toBe("Home PC (renamed)");
    expect(second.publicUrl).toBe(`https://${first.hostId}.t3.example.test`);
    expect(second.frp).toEqual({
      serverAddr: "203.0.113.10",
      serverPort: 7001,
      authToken: "frp-shared-token",
      domain: `${first.hostId}.t3.example.test`,
    });
    expect(registry.service.listHosts(spaceId).hosts).toHaveLength(1);
    registry.close();
  });

  it("registers distinct environments as distinct hosts", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    const first = registry.service.registerHost(spaceId, { environmentId: "env-a" });
    const second = registry.service.registerHost(spaceId, { environmentId: "env-b" });

    expect(second.hostId).not.toBe(first.hostId);
    expect(second.hostToken).not.toBe(first.hostToken);
    expect(registry.service.listHosts(spaceId).hosts).toHaveLength(2);
    registry.close();
  });

  it("rejects a malformed registration", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    expect(() => registry.service.registerHost(spaceId, {})).toThrow(RegistryRequestError);
    expect(() =>
      registry.service.registerHost(spaceId, { environmentId: "x".repeat(201) }),
    ).toThrow(RegistryRequestError);
    registry.close();
  });
});

describe("host liveness", () => {
  it("reports online until the heartbeat TTL passes, then offline", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    const host = registry.service.registerHost(spaceId, { environmentId: "env-a" });

    expect(registry.service.listHosts(spaceId).hosts[0]?.online).toBe(true);
    registry.advance(91_000);
    expect(registry.service.listHosts(spaceId).hosts[0]?.online).toBe(false);

    const row = registry.service.authenticateHostToken(host.hostToken);
    registry.service.heartbeat(row, {});
    expect(registry.service.listHosts(spaceId).hosts[0]?.online).toBe(true);
    registry.close();
  });

  it("accepts only the matching host token", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    const host = registry.service.registerHost(spaceId, { environmentId: "env-a" });
    const other = registry.service.registerHost(spaceId, { environmentId: "env-b" });

    const row = registry.service.authenticateHostToken(host.hostToken);
    expect(row.id).toBe(host.hostId);
    expect(() =>
      registry.service.authenticateHostToken(other.hostToken.replace(other.hostId, host.hostId)),
    ).toThrow(RegistryRequestError);
    expect(() => registry.service.authenticateHostToken("garbage")).toThrow(RegistryRequestError);
    registry.close();
  });

  it("unregistering removes the host", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    const registered = registry.service.registerHost(spaceId, { environmentId: "env-a" });
    const host = registry.service.authenticateHostToken(registered.hostToken);

    expect(registry.service.unregister(host)).toEqual({ removed: true });
    expect(registry.service.listHosts(spaceId).hosts).toHaveLength(0);
    expect(() => registry.service.authenticateHostToken(registered.hostToken)).toThrow(
      RegistryRequestError,
    );
    registry.close();
  });
});

describe("web push", () => {
  it("stores subscriptions idempotently and removes them", () => {
    const registry = makeTestRegistry();
    const spaceId = subscribeTestDevice(registry);
    subscribeTestDevice(registry);

    expect(registry.store.listPushSubscriptions(spaceId)).toHaveLength(1);
    expect(
      registry.service.unsubscribe(spaceId, {
        endpoint: "https://push.example.test/subscription/one",
      }),
    ).toEqual({ removed: true });
    expect(registry.store.listPushSubscriptions(spaceId)).toHaveLength(0);
    registry.close();
  });

  it("rejects a subscription without an https endpoint", () => {
    const registry = makeTestRegistry();
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);
    expect(() =>
      registry.service.subscribe(spaceId, {
        subscription: {
          endpoint: "http://push.example.test/subscription/one",
          keys: { p256dh: "p", auth: "a" },
        },
      }),
    ).toThrow(RegistryRequestError);
    registry.close();
  });

  it("notifies every subscription with a redacted payload", async () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const spaceId = subscribeTestDevice(registry);

    const result = await registry.service.notify(spaceId, {
      hostId: host.hostId,
      environmentId: "env-a",
      threadId: "thread-1",
      phase: "waiting_for_approval",
      threadTitle: "Fix the login flow",
      projectTitle: "web",
      hostLabel: "Home PC",
      // Hosts must never send these; the registry never forwards unknown fields.
      prompt: "secret prompt",
      output: "secret output",
    });

    expect(result).toEqual({ delivered: 1, removed: 0, skipped: null });
    expect(registry.sent).toHaveLength(1);
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

  it("deduplicates the same host, thread and phase inside the window", async () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const spaceId = subscribeTestDevice(registry);
    const notification = {
      hostId: host.hostId,
      environmentId: "env-a",
      threadId: "thread-1",
      phase: "completed" as const,
    };

    expect((await registry.service.notify(spaceId, notification)).delivered).toBe(1);
    expect(await registry.service.notify(spaceId, notification)).toEqual({
      delivered: 0,
      removed: 0,
      skipped: "deduped",
    });
    registry.advance(30_001);
    expect((await registry.service.notify(spaceId, notification)).delivered).toBe(1);
    registry.close();
  });

  it("removes a subscription the push service reports as gone", async () => {
    const registry = makeTestRegistry({
      sender: {
        send: async () => "gone",
      },
    });
    const host = registerTestHost(registry);
    const spaceId = subscribeTestDevice(registry);

    const result = await registry.service.notify(spaceId, {
      hostId: host.hostId,
      environmentId: "env-a",
      threadId: "thread-1",
      phase: "failed",
    });

    expect(result).toEqual({ delivered: 0, removed: 1, skipped: null });
    expect(registry.store.listPushSubscriptions(spaceId)).toHaveLength(0);
    registry.close();
  });

  it("reports when no device is subscribed and never fails the caller", async () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const spaceId = registry.service.authenticatePersonalKey(PERSONAL_KEY);

    expect(
      await registry.service.notify(spaceId, {
        hostId: host.hostId,
        environmentId: "env-a",
        threadId: "thread-1",
        phase: "completed",
      }),
    ).toEqual({ delivered: 0, removed: 0, skipped: "no-subscriptions" });
    registry.close();
  });

  it("rejects notifications for unknown hosts, phases, and mismatched environments", async () => {
    const registry = makeTestRegistry();
    const host = registerTestHost(registry);
    const spaceId = subscribeTestDevice(registry);
    const base = {
      hostId: host.hostId,
      environmentId: "env-a",
      threadId: "thread-1",
      phase: "completed",
    };

    await expect(
      registry.service.notify(spaceId, { ...base, hostId: "ffffffffffff" }),
    ).rejects.toThrow(RegistryRequestError);
    await expect(
      registry.service.notify(spaceId, { ...base, environmentId: "other-env" }),
    ).rejects.toThrow(RegistryRequestError);
    await expect(registry.service.notify(spaceId, { ...base, phase: "running" })).rejects.toThrow(
      RegistryRequestError,
    );
    registry.close();
  });
});

describe("push sender failure", () => {
  it("keeps the subscription when delivery fails for another reason", async () => {
    const registry = makeTestRegistry({
      sender: {
        send: async () => {
          throw new Error("network");
        },
      },
    });
    const host = registerTestHost(registry);
    const spaceId = subscribeTestDevice(registry);

    expect(
      await registry.service.notify(spaceId, {
        hostId: host.hostId,
        environmentId: "env-a",
        threadId: "thread-1",
        phase: "completed",
      }),
    ).toEqual({ delivered: 0, removed: 0, skipped: null });
    expect(registry.store.listPushSubscriptions(spaceId)).toHaveLength(1);
    registry.close();
  });
});
