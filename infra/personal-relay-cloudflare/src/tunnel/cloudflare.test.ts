import { describe, expect, it, vi } from "vite-plus/test";

import { createFakeCloudflare } from "../testing/fakeCloudflare.ts";
import { createCloudflareTunnelProvisioner } from "./index.ts";
import { TunnelProvisionError } from "./types.ts";

const HOST_A = "abc123def456";
const HOST_B = "abc123def999";
const API_TOKEN = "cf-api-token-secret";
const API_BASE = "https://api.cloudflare.com/client/v4";

type Cloudflare = ReturnType<typeof createFakeCloudflare>;

function provisionerFor(
  cloudflare: Cloudflare,
  options?: { readonly suffix?: string; readonly fetch?: typeof fetch },
) {
  return createCloudflareTunnelProvisioner({
    accountId: cloudflare.state.accountId,
    zoneId: cloudflare.state.zoneId,
    hostsSuffix: options?.suffix ?? "example.test",
    tunnelPrefix: "t3cf",
    apiToken: API_TOKEN,
    fetch: options?.fetch ?? cloudflare.fetch,
    now: () => 1_000,
  });
}

function setup(options?: { readonly suffix?: string; readonly fetch?: typeof fetch }): {
  readonly cloudflare: Cloudflare;
  readonly provisioner: ReturnType<typeof createCloudflareTunnelProvisioner>;
} {
  const cloudflare = createFakeCloudflare();
  return { cloudflare, provisioner: provisionerFor(cloudflare, options) };
}

function ensureInput(hostId: string, originPort = 3773) {
  return { hostId, hostname: `${hostId}.example.test`, originPort, now: 1_000 };
}

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

describe("CloudflareTunnelProvisioner", () => {
  it("creates one tunnel per host, reuses it, and updates ingress", async () => {
    const { cloudflare, provisioner } = setup();

    const first = await provisioner.ensure(ensureInput(HOST_A, 3773));
    const second = await provisioner.ensure(ensureInput(HOST_A, 4000));

    expect(second.tunnelId).toBe(first.tunnelId);
    expect(second.dnsRecordId).toBe(first.dnsRecordId);
    expect(second.hostname).toBe(`${HOST_A}.example.test`);
    expect(cloudflare.state.tunnels.size).toBe(1);
    expect(cloudflare.state.dnsRecords.size).toBe(1);

    const tunnel = [...cloudflare.state.tunnels.values()][0]!;
    expect(tunnel.name).toBe(`t3cf-${HOST_A}`);
    expect(tunnel.configSrc).toBe("cloudflare");
    expect(tunnel.ingress).toEqual([
      { hostname: `${HOST_A}.example.test`, service: "http://127.0.0.1:4000" },
      { service: "http_status:404" },
    ]);
    expect(second.tunnelToken).toBe(tunnel.token);

    const record = [...cloudflare.state.dnsRecords.values()][0]!;
    expect(record).toMatchObject({
      type: "CNAME",
      name: `${HOST_A}.example.test`,
      content: `${first.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    });
    expect(record.id).toBe(first.dnsRecordId);

    const tunnelPosts = cloudflare.state.calls.filter(
      (call) =>
        call.method === "POST" &&
        call.path === `/client/v4/accounts/${cloudflare.state.accountId}/cfd_tunnel`,
    );
    expect(tunnelPosts).toHaveLength(1);
    expect(
      cloudflare.state.calls.filter(
        (call) => call.method === "PUT" && call.path.endsWith("/configurations"),
      ),
    ).toHaveLength(2);
    expect(
      cloudflare.state.calls.filter(
        (call) => call.method === "GET" && call.path.endsWith("/token"),
      ),
    ).toHaveLength(2);
  });

  it("updates an existing cfargotunnel CNAME instead of creating one", async () => {
    const { cloudflare, provisioner } = setup();
    const seeded = await cloudflare.fetch(apiUrl(`/zones/${cloudflare.state.zoneId}/dns_records`), {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: `${HOST_A}.example.test`,
        content: "11111111-2222-3333-4444-555555555555.cfargotunnel.com",
        proxied: false,
        ttl: 300,
      }),
    });
    const seededRecord = (await seeded.json()) as { result: { id: string } };

    const result = await provisioner.ensure(ensureInput(HOST_A));

    const records = [...cloudflare.state.dnsRecords.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: seededRecord.result.id,
      content: `${result.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    });
    expect(result.dnsRecordId).toBe(seededRecord.result.id);
  });

  it("rejects a DNS name owned by another record type", async () => {
    const { cloudflare, provisioner } = setup();
    await cloudflare.fetch(apiUrl(`/zones/${cloudflare.state.zoneId}/dns_records`), {
      method: "POST",
      body: JSON.stringify({
        type: "A",
        name: `${HOST_A}.example.test`,
        content: "203.0.113.10",
      }),
    });

    const error = await provisioner.ensure(ensureInput(HOST_A)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TunnelProvisionError);
    expect(error).toMatchObject({ status: 409, retryable: false });
  });

  it("rejects a CNAME that points at an unrelated target", async () => {
    const { cloudflare, provisioner } = setup();
    await cloudflare.fetch(apiUrl(`/zones/${cloudflare.state.zoneId}/dns_records`), {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: `${HOST_A}.example.test`,
        content: "guest.example.com",
      }),
    });

    const error = await provisioner.ensure(ensureInput(HOST_A)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 409, retryable: false });
  });

  it("surfaces Cloudflare 1055 as a non-retryable no-configuration error", async () => {
    const cloudflare = createFakeCloudflare();
    const baseFetch = cloudflare.fetch;
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/token")) {
        return Promise.resolve(
          Response.json(
            {
              success: false,
              errors: [{ code: 1055, message: "This tunnel has no configuration." }],
              messages: [],
              result: null,
            },
            { status: 400 },
          ),
        );
      }
      return baseFetch(input, init);
    };
    const provisioner = provisionerFor(cloudflare, { fetch });

    const error = await provisioner.ensure(ensureInput(HOST_A)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TunnelProvisionError);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect((error as Error).message).toContain("no remote configuration");
  });

  it("recovers when a concurrent DNS create wins the race", async () => {
    const { cloudflare, provisioner } = setup();
    cloudflare.failNext(409, { method: "POST", pathIncludes: "/dns_records" });

    const result = await provisioner.ensure(ensureInput(HOST_A));

    expect(cloudflare.state.dnsRecords.size).toBe(1);
    expect(result.dnsRecordId).toBe([...cloudflare.state.dnsRecords.keys()][0]);
  });

  it("maps a rate limit to a retryable error", async () => {
    const { cloudflare, provisioner } = setup();
    cloudflare.failNext(429, { method: "GET", pathIncludes: "/cfd_tunnel" });

    const error = await provisioner.ensure(ensureInput(HOST_A)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TunnelProvisionError);
    expect(error).toMatchObject({ status: 502, retryable: true });
    expect((error as Error).message).toContain("429");
  });

  it("times out a stalled Cloudflare call as retryable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetch: typeof globalThis.fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      const { provisioner } = setup({ fetch });

      const pending = provisioner.ensure(ensureInput(HOST_A)).catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await pending;

      expect(error).toBeInstanceOf(TunnelProvisionError);
      expect(error).toMatchObject({ status: 502, retryable: true });
      expect((error as Error).message).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes connections, then the tunnel, then DNS", async () => {
    const { cloudflare, provisioner } = setup();
    const result = await provisioner.ensure(ensureInput(HOST_A));
    const start = cloudflare.state.calls.length;

    await provisioner.remove({
      hostId: HOST_A,
      tunnelId: result.tunnelId,
      dnsRecordId: result.dnsRecordId,
      hostname: result.hostname,
    });

    const deletes = cloudflare.state.calls
      .slice(start)
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path);
    expect(deletes).toHaveLength(3);
    expect(deletes[0]).toMatch(new RegExp(`/cfd_tunnel/${result.tunnelId}/connections$`, "u"));
    expect(deletes[1]).toMatch(new RegExp(`/cfd_tunnel/${result.tunnelId}$`, "u"));
    expect(deletes[2]).toMatch(new RegExp(`/dns_records/${result.dnsRecordId}$`, "u"));
    expect(cloudflare.state.tunnels.size).toBe(0);
    expect(cloudflare.state.dnsRecords.size).toBe(0);
  });

  it("removes a host twice without failing", async () => {
    const { provisioner } = setup();
    const result = await provisioner.ensure(ensureInput(HOST_A));
    const input = {
      hostId: HOST_A,
      tunnelId: result.tunnelId,
      dnsRecordId: result.dnsRecordId,
      hostname: result.hostname,
    };

    await provisioner.remove(input);
    await expect(provisioner.remove(input)).resolves.toBeUndefined();
    await expect(provisioner.remove({ hostId: HOST_A })).resolves.toBeUndefined();
  });

  it("removes a DNS record by tunnel target when its name moved", async () => {
    const { cloudflare, provisioner } = setup();
    const result = await provisioner.ensure(ensureInput(HOST_A));
    const record = [...cloudflare.state.dnsRecords.values()][0]!;
    await cloudflare.fetch(apiUrl(`/zones/${cloudflare.state.zoneId}/dns_records/${record.id}`), {
      method: "PATCH",
      body: JSON.stringify({ name: `${HOST_A}.old.example` }),
    });

    await provisioner.remove({ hostId: HOST_A, tunnelId: result.tunnelId });

    expect(cloudflare.state.tunnels.size).toBe(0);
    expect(cloudflare.state.dnsRecords.size).toBe(0);
  });

  it("leaves a DNS record that no longer points at our tunnel", async () => {
    const { cloudflare, provisioner } = setup();
    const result = await provisioner.ensure(ensureInput(HOST_A));
    const record = [...cloudflare.state.dnsRecords.values()][0]!;
    await cloudflare.fetch(apiUrl(`/zones/${cloudflare.state.zoneId}/dns_records/${record.id}`), {
      method: "PATCH",
      body: JSON.stringify({
        content: "99999999-8888-7777-6666-555555555555.cfargotunnel.com",
      }),
    });

    await provisioner.remove({
      hostId: HOST_A,
      tunnelId: result.tunnelId,
      dnsRecordId: result.dnsRecordId,
      hostname: result.hostname,
    });

    expect(cloudflare.state.tunnels.size).toBe(0);
    expect(cloudflare.state.dnsRecords.size).toBe(1);
  });

  it("sweeps inactive tunnels but not active hosts or other prefixes", async () => {
    const { cloudflare, provisioner } = setup();
    await provisioner.ensure(ensureInput(HOST_A));
    await provisioner.ensure(ensureInput(HOST_B));
    for (const name of [`other-${HOST_A}`, `t3cfx-${HOST_A}`]) {
      await cloudflare.fetch(apiUrl(`/accounts/${cloudflare.state.accountId}/cfd_tunnel`), {
        method: "POST",
        body: JSON.stringify({ name, config_src: "cloudflare" }),
      });
    }

    await provisioner.sweep({ activeHostIds: new Set([HOST_A]), now: 10_000 });

    expect([...cloudflare.state.tunnels.values()].map((tunnel) => tunnel.name).sort()).toEqual(
      [`other-${HOST_A}`, `t3cf-${HOST_A}`, `t3cfx-${HOST_A}`].sort(),
    );
    expect([...cloudflare.state.dnsRecords.values()].map((entry) => entry.name)).toEqual([
      `${HOST_A}.example.test`,
    ]);
  });

  it("moves a DNS record when the hosts suffix changes", async () => {
    const cloudflare = createFakeCloudflare();
    const oldProvisioner = provisionerFor(cloudflare, { suffix: "old.example" });
    const result = await oldProvisioner.ensure(ensureInput(HOST_A));
    const nextProvisioner = provisionerFor(cloudflare, { suffix: "new.example" });

    await nextProvisioner.sweep({ activeHostIds: new Set([HOST_A]), now: 10_000 });

    const records = [...cloudflare.state.dnsRecords.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: `${HOST_A}.new.example`,
      content: `${result.tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    });
    expect(cloudflare.state.tunnels.size).toBe(1);
  });

  it("keeps the API token and tunnel token out of errors", async () => {
    const { cloudflare, provisioner } = setup();
    cloudflare.failNext(500, {
      method: "GET",
      pathIncludes: "/dns_records",
      message: `rejected ${API_TOKEN}`,
    });

    const error = await provisioner.ensure(ensureInput(HOST_A)).catch((caught: unknown) => caught);

    const tunnel = [...cloudflare.state.tunnels.values()][0]!;
    expect(error).toBeInstanceOf(TunnelProvisionError);
    expect((error as Error).message).not.toContain(API_TOKEN);
    expect((error as Error).message).not.toContain(tunnel.token);
    expect(JSON.stringify(error)).not.toContain(API_TOKEN);
    expect(JSON.stringify(error)).not.toContain(tunnel.token);
  });
});
