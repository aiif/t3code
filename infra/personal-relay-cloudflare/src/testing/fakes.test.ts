import { describe, expect, it } from "vite-plus/test";

import { createInMemoryRegistryStore } from "../store/memory.ts";
import { createFakeTunnelProvisioner } from "../tunnel/fake.ts";
import { TunnelProvisionError } from "../tunnel/types.ts";
import { createFakeCloudflare } from "./fakeCloudflare.ts";
import { FakeWranglerRunner } from "./fakeWrangler.ts";

const createHost = (store: ReturnType<typeof createInMemoryRegistryStore>) =>
  store.createHost({
    id: "abc123def456",
    environmentId: "env-a",
    label: "Home PC",
    platform: "win32",
    hostKeyHash: "key-hash",
    hostKeyCiphertext: "v1.nonce.tag.ciphertext",
    hostTokenHash: "token-hash",
    connectorMode: "quick",
    hostname: null,
    originPort: null,
    publicUrl: "",
    now: 1_000,
  });

describe("in-memory registry store", () => {
  it("creates, finds and revokes a host without losing its row", () => {
    const store = createInMemoryRegistryStore();
    createHost(store);

    expect(store.findHostByKeyHash("key-hash")?.id).toBe("abc123def456");
    expect(store.countActiveHosts()).toBe(1);

    expect(store.revokeHost("abc123def456", 2_000)).toBe(true);
    expect(store.findHostByKeyHash("key-hash")).toBeNull();
    expect(store.findHostByTokenHash("token-hash")).toBeNull();
    expect(store.getHost("abc123def456")?.revokedAt).toBe(2_000);
    expect(store.countActiveHosts()).toBe(0);

    expect(store.restoreHost("abc123def456", 3_000)).toBe(true);
    expect(store.getHost("abc123def456")?.revokedAt).toBeNull();
  });

  it("keeps the host key version across registration and rotation", () => {
    const store = createInMemoryRegistryStore();
    createHost(store);

    expect(
      store.updateRegistration({
        hostId: "abc123def456",
        label: "Renamed",
        platform: "win32",
        hostTokenHash: "token-two",
        connectorMode: "named",
        hostname: "abc123def456.example.test",
        originPort: 3773,
        publicUrl: "https://abc123def456.example.test",
        now: 2_000,
      })?.label,
    ).toBe("Renamed");

    expect(
      store.rotateHostKey({
        hostId: "abc123def456",
        hostKeyHash: "key-two",
        hostKeyCiphertext: "v1.nonce.tag.ciphertext2",
        now: 3_000,
      }),
    ).toBe(2);
    expect(store.findHostByKeyHash("key-hash")).toBeNull();
    expect(store.findHostByKeyHash("key-two")?.keyVersion).toBe(2);
  });

  it("reports a fresh client snapshot and revokes the missing ones", () => {
    const store = createInMemoryRegistryStore();
    createHost(store);
    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "session-a",
          clientLabel: "Laptop",
          platform: "darwin",
          firstSeenAt: 1_000,
          lastSeenAt: 1_000,
        },
      ],
      1_100,
    );

    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "session-a",
          clientLabel: "Laptop",
          platform: "darwin",
          firstSeenAt: 1_000,
          lastSeenAt: 2_000,
        },
        {
          sessionId: "session-b",
          clientLabel: "Phone",
          platform: "android",
          firstSeenAt: 2_000,
          lastSeenAt: 2_000,
        },
      ],
      2_100,
    );
    expect(store.countClients("abc123def456")).toBe(2);

    store.replaceClients(
      "abc123def456",
      [
        {
          sessionId: "session-b",
          clientLabel: "Phone",
          platform: "android",
          firstSeenAt: 2_000,
          lastSeenAt: 3_000,
        },
      ],
      3_100,
    );
    expect(store.countClients("abc123def456")).toBe(1);
    expect(store.revokedClients("abc123def456", 3_100)).toContain("session-a");
  });

  it("allows a fixed number of requests per window", () => {
    const store = createInMemoryRegistryStore();
    const input = { scope: "register", key: "127.0.0.1", limit: 2, windowMs: 60_000, now: 1_000 };
    expect(store.consumeRateLimit(input).allowed).toBe(true);
    expect(store.consumeRateLimit(input).allowed).toBe(true);
    const blocked = store.consumeRateLimit(input);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(60_000);
    expect(store.consumeRateLimit({ ...input, now: 61_000 }).allowed).toBe(true);
  });
});

describe("test doubles", () => {
  it("provisions one fake tunnel per host and cleans it up", async () => {
    const provisioner = createFakeTunnelProvisioner();
    const first = await provisioner.ensure({
      hostId: "abc123def456",
      hostname: "abc123def456.example.test",
      originPort: 3773,
      now: 1_000,
    });
    const second = await provisioner.ensure({
      hostId: "abc123def456",
      hostname: "abc123def456.example.test",
      originPort: 3773,
      now: 2_000,
    });
    expect(second.tunnelId).toBe(first.tunnelId);
    await provisioner.remove({ hostId: "abc123def456" });
    expect(provisioner.resultFor("abc123def456")).toBeNull();
  });

  it("fails the next provision and records the error", async () => {
    const provisioner = createFakeTunnelProvisioner();
    provisioner.failNext(
      new TunnelProvisionError("Rate limited.", { status: 429, retryable: true }),
    );
    await expect(
      provisioner.ensure({
        hostId: "abc123def456",
        hostname: "abc123def456.example.test",
        originPort: 3773,
        now: 1_000,
      }),
    ).rejects.toThrow("Rate limited.");
    expect(provisioner.state.failures[0]?.retryable).toBe(true);
  });

  it("mimics tunnel, token and DNS calls for provisioning tests", async () => {
    const cloudflare = createFakeCloudflare();
    const created = await cloudflare.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflare.state.accountId}/cfd_tunnel`,
      {
        method: "POST",
        body: JSON.stringify({ name: "t3cf-abc123def456", config_src: "cloudflare" }),
      },
    );
    expect(created.status).toBe(200);
    const tunnel = (await created.json()) as { result: { id: string } };

    const listed = await cloudflare.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflare.state.accountId}/cfd_tunnel?name=t3cf-abc123def456`,
    );
    expect(((await listed.json()) as { result: Array<{ id: string }> }).result).toHaveLength(1);

    const token = await cloudflare.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflare.state.accountId}/cfd_tunnel/${tunnel.result.id}/token`,
    );
    expect(((await token.json()) as { result: string }).result).toContain("fake-tunnel-token");

    const dns = await cloudflare.fetch(
      `https://api.cloudflare.com/client/v4/zones/${cloudflare.state.zoneId}/dns_records`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "CNAME",
          name: "abc123def456.example.test",
          content: `${tunnel.result.id}.cfargotunnel.com`,
          proxied: true,
          ttl: 1,
        }),
      },
    );
    expect(dns.status).toBe(200);
    expect(cloudflare.state.dnsRecords.size).toBe(1);

    cloudflare.failNext(429, { pathIncludes: "/cfd_tunnel", times: 1 });
    const failed = await cloudflare.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflare.state.accountId}/cfd_tunnel`,
      { method: "POST", body: JSON.stringify({ name: "t3cf-other" }) },
    );
    expect(failed.status).toBe(429);
  });

  it("records wrangler calls and queued results", async () => {
    const wrangler = new FakeWranglerRunner();
    wrangler.queue({ code: 1, stderr: "boom" });
    const result = await wrangler.run(["deploy"], { cwd: "infra/personal-relay-cloudflare" });
    expect(result.code).toBe(1);
    expect(wrangler.calls[0]?.args).toEqual(["deploy"]);
  });
});
