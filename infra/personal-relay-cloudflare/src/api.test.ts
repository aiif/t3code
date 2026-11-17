import { describe, expect, it } from "vite-plus/test";

import { handleApiRequest, type RegistryRequestContext } from "./api.ts";
import { resolveWorkerConfig, type WorkerEnv } from "./config.ts";
import { createInMemoryRegistryStore } from "./store/memory.ts";
import type { RegistryStore } from "./store/types.ts";
import { createFakeTunnelProvisioner, type FakeTunnelProvisioner } from "./tunnel/fake.ts";
import { TunnelProvisionError } from "./tunnel/types.ts";

const ADMIN_KEY = "admin-key-for-tests-0123456789abcdef";
const ENROLL_KEY = "enroll-key-for-tests-0123456789abcd";
const SECRET_KEY_HEX = "07".repeat(32);
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface RegisteredHost {
  readonly hostId: string;
  readonly hostKey: string;
  readonly hostKeyVersion: number;
  readonly hostToken: string;
  readonly environmentId: string;
  readonly label: string | null;
  readonly publicUrl: string;
  readonly connector: Record<string, unknown>;
  readonly heartbeatIntervalMs: number;
}

interface CallOptions {
  readonly method?: "GET" | "POST";
  readonly auth?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly origin?: string;
  readonly clientIp?: string;
}

interface Harness {
  readonly context: RegistryRequestContext;
  readonly store: RegistryStore;
  readonly provisioner: FakeTunnelProvisioner;
  advance(milliseconds: number): void;
  call(path: string, options?: CallOptions): Promise<Response>;
  register(overrides?: Record<string, unknown>): Promise<RegisteredHost>;
}

function workerEnv(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  return {
    T3CODE_ADMIN_KEY: ADMIN_KEY,
    T3CODE_SECRET_KEY: SECRET_KEY_HEX,
    T3CODE_ENROLL_KEY: ENROLL_KEY,
    ...overrides,
  } as unknown as WorkerEnv;
}

function namedEnv(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  return workerEnv({
    T3CODE_TUNNEL_MODE: "named",
    T3CODE_CF_ACCOUNT_ID: "account-test",
    T3CODE_CF_ZONE_ID: "zone-test",
    T3CODE_CF_API_TOKEN: "cf-api-token",
    T3CODE_HOSTS_SUFFIX: "example.test",
    ...overrides,
  });
}

function makeHarness(
  options: {
    readonly named?: boolean;
    readonly maxHosts?: string;
    readonly allowedOrigins?: string;
    readonly now?: number;
    readonly provisioner?: FakeTunnelProvisioner;
    readonly clientIp?: string;
  } = {},
): Harness {
  let now = options.now ?? NOW;
  const env = options.named === true ? namedEnv() : workerEnv();
  const config = resolveWorkerConfig(
    options.maxHosts === undefined && options.allowedOrigins === undefined
      ? env
      : ({
          ...env,
          ...(options.maxHosts === undefined ? {} : { T3CODE_MAX_HOSTS: options.maxHosts }),
          ...(options.allowedOrigins === undefined
            ? {}
            : { T3CODE_ALLOWED_ORIGINS: options.allowedOrigins }),
        } as WorkerEnv),
  );
  const store = createInMemoryRegistryStore();
  const provisioner = options.provisioner ?? createFakeTunnelProvisioner();
  const context: RegistryRequestContext = {
    env,
    config,
    store,
    provisioner,
    now: () => now,
    clientIp: options.clientIp ?? "203.0.113.7",
  };

  const call = (path: string, callOptions: CallOptions = {}): Promise<Response> => {
    const headers = new Headers();
    if (callOptions.auth !== undefined) {
      headers.set("authorization", `Bearer ${callOptions.auth}`);
    }
    if (callOptions.origin !== undefined) headers.set("origin", callOptions.origin);
    const body =
      callOptions.rawBody ??
      (callOptions.body === undefined ? undefined : JSON.stringify(callOptions.body));
    if (body !== undefined) headers.set("content-type", "application/json");
    const method = callOptions.method ?? (body === undefined ? "GET" : "POST");
    return handleApiRequest(
      new Request(`https://relay.test${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      }),
      context,
    );
  };

  const register = async (overrides: Record<string, unknown> = {}): Promise<RegisteredHost> => {
    const response = await call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: {
        environmentId: "env-a",
        label: "Home PC",
        platform: "win32",
        apiVersion: 2,
        ...(options.named === true ? { origin: { host: "127.0.0.1", port: 3773 } } : {}),
        ...overrides,
      },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as RegisteredHost;
  };

  return {
    context,
    store,
    provisioner,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    call,
    register,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorOf(body: Record<string, unknown>): string {
  expect(typeof body["error"]).toBe("string");
  return body["error"] as string;
}

describe("health and routing", () => {
  it("reports the relay identity and mode", async () => {
    const harness = makeHarness();
    const response = await harness.call("/v1/health");
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      service: "t3-personal-registry",
      version: 2,
      mode: "quick",
    });
  });

  it("serves bare paths and rejects unknown routes and methods", async () => {
    const harness = makeHarness();
    expect((await harness.call("/health")).status).toBe(200);
    expect((await harness.call("/v1/unknown")).status).toBe(404);
    expect((await harness.call("/v1")).status).toBe(404);
    expect((await harness.call("/v1/hosts/register")).status).toBe(404);
    expect(errorOf(await json(await harness.call("/v1/unknown")))).toBe("Not found.");
  });
});

describe("host registration", () => {
  it("requires the enrollment key and rejects the admin key", async () => {
    const harness = makeHarness();
    const body = { environmentId: "env-a", apiVersion: 2 };

    const missing = await harness.call("/v1/hosts/register", { method: "POST", body });
    expect(missing.status).toBe(401);
    expect(errorOf(await json(missing))).toBe("Missing bearer credential.");

    const admin = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ADMIN_KEY,
      body,
    });
    expect(admin.status).toBe(403);
    expect(errorOf(await json(admin))).toBe("The admin key cannot be used here.");

    const wrong = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: "not-the-enrollment-key-0123456789",
      body,
    });
    expect(wrong.status).toBe(401);
    expect(harness.store.countActiveHosts()).toBe(0);
  });

  it("requires apiVersion 2 with a clear error", async () => {
    const harness = makeHarness();
    for (const apiVersion of [undefined, 1, "2", 3]) {
      const response = await harness.call("/v1/hosts/register", {
        method: "POST",
        auth: ENROLL_KEY,
        body: { environmentId: "env-a", apiVersion },
      });
      expect(response.status).toBe(400);
      expect(errorOf(await json(response))).toContain("apiVersion 2 is required");
    }
    expect(harness.store.countActiveHosts()).toBe(0);
  });

  it("registers a quick host without an origin", async () => {
    const harness = makeHarness();
    const registered = await harness.register();

    expect(registered).toMatchObject({
      environmentId: "env-a",
      label: "Home PC",
      publicUrl: "",
      hostKeyVersion: 1,
      heartbeatIntervalMs: 60_000,
      connector: { kind: "cloudflare-tunnel", mode: "quick" },
    });
    expect(registered.hostId).toMatch(/^[a-z0-9]{12}$/u);
    expect(registered.hostKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(registered.hostToken.startsWith(`${registered.hostId}.`)).toBe(true);
    expect(harness.provisioner.state.ensured).toHaveLength(0);

    const stored = harness.store.getHost(registered.hostId);
    expect(stored).toMatchObject({ connectorMode: "quick", publicUrl: "", hostname: null });
  });

  it("re-registers the same environment idempotently with a fresh host token", async () => {
    const harness = makeHarness();
    const first = await harness.register();
    harness.advance(1_000);
    const second = await harness.register({ label: "Renamed" });

    expect(second.hostId).toBe(first.hostId);
    expect(second.hostKey).toBe(first.hostKey);
    expect(second.hostKeyVersion).toBe(1);
    expect(second.hostToken).not.toBe(first.hostToken);
    expect(second.label).toBe("Renamed");
    expect(harness.store.countActiveHosts()).toBe(1);

    const oldToken = await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: first.hostToken,
      body: { online: true },
    });
    expect(oldToken.status).toBe(401);

    const resolve = await harness.call("/v1/hosts/resolve", {
      method: "POST",
      auth: first.hostKey,
    });
    expect(resolve.status).toBe(200);
  });

  it("enforces the configured host limit but still allows re-registration", async () => {
    const harness = makeHarness({ maxHosts: "2" });
    await harness.register({ environmentId: "env-a" });
    await harness.register({ environmentId: "env-b" });

    const third = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: { environmentId: "env-c", apiVersion: 2 },
    });
    expect(third.status).toBe(409);
    expect(errorOf(await json(third))).toBe("This relay allows at most 2 hosts.");

    const again = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: { environmentId: "env-b", apiVersion: 2 },
    });
    expect(again.status).toBe(200);
  });

  it("refuses to resurrect an admin-removed host", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    await harness.call(`/v1/admin/hosts/${host.hostId}/remove`, {
      method: "POST",
      auth: ADMIN_KEY,
    });
    const response = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: { environmentId: "env-a", apiVersion: 2 },
    });
    expect(response.status).toBe(410);
    expect(errorOf(await json(response))).toBe("This host was removed.");
  });
});

describe("named mode provisioning", () => {
  it("provisions a tunnel and returns the named connector", async () => {
    const harness = makeHarness({ named: true });
    const registered = await harness.register();

    expect(harness.provisioner.state.ensured).toHaveLength(1);
    expect(harness.provisioner.state.ensured[0]).toMatchObject({
      hostId: registered.hostId,
      hostname: `${registered.hostId}.example.test`,
      originPort: 3773,
    });
    expect(registered.publicUrl).toBe(`https://${registered.hostId}.example.test`);
    expect(registered.connector).toEqual({
      kind: "cloudflare-tunnel",
      mode: "named",
      tunnelToken: `token-${registered.hostId}`,
      hostname: `${registered.hostId}.example.test`,
    });
    expect(harness.store.getHost(registered.hostId)).toMatchObject({
      connectorMode: "named",
      tunnelId: `tunnel-${registered.hostId}`,
      dnsRecordId: `dns-${registered.hostId}`,
      hostname: `${registered.hostId}.example.test`,
      originPort: 3773,
      publicUrl: `https://${registered.hostId}.example.test`,
    });
  });

  it("requires a loopback origin and a valid port in named mode", async () => {
    const harness = makeHarness({ named: true });
    const cases: ReadonlyArray<[unknown, string]> = [
      [undefined, "origin is required in named mode."],
      [{ host: "0.0.0.0", port: 3773 }, "origin.host must be 127.0.0.1."],
      [{ host: "127.0.0.1", port: 0 }, "origin.port must be an integer between 1 and 65535."],
      [{ host: "127.0.0.1", port: 70_000 }, "origin.port must be an integer between 1 and 65535."],
      [{ host: "127.0.0.1", port: 3.5 }, "origin.port must be an integer between 1 and 65535."],
    ];
    for (const [origin, message] of cases) {
      const response = await harness.call("/v1/hosts/register", {
        method: "POST",
        auth: ENROLL_KEY,
        body: { environmentId: "env-a", apiVersion: 2, origin },
      });
      expect(response.status).toBe(400);
      expect(errorOf(await json(response))).toBe(message);
    }
    expect(harness.store.countActiveHosts()).toBe(0);
  });

  it("maps provisioning failures to 502 and conflicts to 409", async () => {
    const harness = makeHarness({ named: true });
    harness.provisioner.failNext(
      new TunnelProvisionError("Rate limited.", { status: 429, retryable: true }),
    );
    const retryable = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: {
        environmentId: "env-a",
        apiVersion: 2,
        origin: { host: "127.0.0.1", port: 3773 },
      },
    });
    expect(retryable.status).toBe(502);
    expect(errorOf(await json(retryable))).toBe("Tunnel provisioning failed. Try again later.");
    expect(harness.store.countActiveHosts()).toBe(0);

    harness.provisioner.failNext(new TunnelProvisionError("Conflict.", { status: 409 }));
    const conflict = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: {
        environmentId: "env-a",
        apiVersion: 2,
        origin: { host: "127.0.0.1", port: 3773 },
      },
    });
    expect(conflict.status).toBe(409);
    expect(errorOf(await json(conflict))).toBe("The hostname is already in use.");
  });

  it("removes the tunnel when the host unregisters", async () => {
    const harness = makeHarness({ named: true });
    const registered = await harness.register();
    const response = await harness.call("/v1/hosts/unregister", {
      method: "POST",
      auth: registered.hostToken,
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ removed: true });
    expect(harness.provisioner.state.removed).toEqual([
      {
        hostId: registered.hostId,
        tunnelId: `tunnel-${registered.hostId}`,
        dnsRecordId: `dns-${registered.hostId}`,
        hostname: `${registered.hostId}.example.test`,
      },
    ]);
    expect(harness.store.getHost(registered.hostId)).toBeNull();
  });
});

describe("heartbeats and resolving", () => {
  it("keeps quick hosts offline until they report a public URL", async () => {
    const harness = makeHarness();
    const host = await harness.register();

    const offline = await harness.call("/v1/hosts/resolve", {
      method: "POST",
      auth: host.hostKey,
    });
    expect(offline.status).toBe(200);
    expect(await json(offline)).toEqual({
      hostId: host.hostId,
      environmentId: "env-a",
      label: "Home PC",
      publicUrl: "",
      online: false,
      paused: false,
    });

    const heartbeat = await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostToken,
      body: { online: true, hostKeyVersion: 1 },
    });
    expect(heartbeat.status).toBe(200);
    expect(await json(heartbeat)).toEqual({
      hostId: host.hostId,
      revokedSessionIds: [],
      heartbeatIntervalMs: 60_000,
    });

    const reported = await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostToken,
      body: {
        online: true,
        hostKeyVersion: 1,
        publicUrl: "https://quick-test.trycloudflare.com",
      },
    });
    expect(reported.status).toBe(200);

    const online = await json(
      await harness.call("/v1/hosts/resolve", { method: "POST", auth: host.hostKey }),
    );
    expect(online["publicUrl"]).toBe("https://quick-test.trycloudflare.com");
    expect(online["online"]).toBe(true);
  });

  it("rejects non-https quick URLs", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    const response = await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostToken,
      body: { online: true, publicUrl: "http://insecure.trycloudflare.com" },
    });
    expect(response.status).toBe(400);
    expect(errorOf(await json(response))).toBe("publicUrl must use https.");
  });

  it("marks a paused host offline and expires stale heartbeats", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostToken,
      body: { online: false },
    });
    let resolved = await json(
      await harness.call("/v1/hosts/resolve", { method: "POST", auth: host.hostKey }),
    );
    expect(resolved).toMatchObject({ online: false, paused: true });

    await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostToken,
      body: { online: true },
    });
    harness.advance(180_001);
    resolved = await json(
      await harness.call("/v1/hosts/resolve", { method: "POST", auth: host.hostKey }),
    );
    expect(resolved["online"]).toBe(false);
    expect(resolved["paused"]).toBe(false);
  });

  it("keeps host keys working across heartbeats and rejects mismatched environments", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    const mismatched = await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostToken,
      body: { environmentId: "env-other", online: true },
    });
    expect(mismatched.status).toBe(403);
    expect(errorOf(await json(mismatched))).toBe("Host token does not match this environment.");
  });
});

describe("authentication boundaries", () => {
  it("rejects the admin key on every host endpoint", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    const endpoints: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["/v1/hosts/heartbeat", { online: true }],
      ["/v1/hosts/unregister", {}],
      ["/v1/hosts/clients", { clients: [] }],
      ["/v1/hosts/rotate-key", {}],
      ["/v1/hosts/resolve", {}],
    ];
    for (const [path, body] of endpoints) {
      const response = await harness.call(path, { method: "POST", auth: ADMIN_KEY, body });
      expect(response.status).toBe(403);
      expect(errorOf(await json(response))).toBe("The admin key cannot be used here.");
    }
    expect(harness.store.getHost(host.hostId)).not.toBeNull();
  });

  it("separates host tokens from host keys", async () => {
    const harness = makeHarness();
    const host = await harness.register();

    const tokenOnResolve = await harness.call("/v1/hosts/resolve", {
      method: "POST",
      auth: host.hostToken,
    });
    expect(tokenOnResolve.status).toBe(401);

    const keyOnHeartbeat = await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostKey,
      body: { online: true },
    });
    expect(keyOnHeartbeat.status).toBe(401);

    const badKey = await harness.call("/v1/hosts/resolve", {
      method: "POST",
      auth: "not-a-host-key",
    });
    expect(badKey.status).toBe(401);
    expect(errorOf(await json(badKey))).toBe("Invalid host key.");
  });

  it("requires the admin key for admin endpoints", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    expect((await harness.call("/v1/admin/hosts")).status).toBe(401);
    for (const auth of [ENROLL_KEY, host.hostKey]) {
      const response = await harness.call("/v1/admin/hosts", { auth });
      expect(response.status).toBe(401);
      expect(errorOf(await json(response))).toBe("Invalid admin key.");
    }
    expect((await harness.call("/v1/admin/hosts", { auth: ADMIN_KEY })).status).toBe(200);
  });
});

describe("client snapshots and revocation", () => {
  it("reports clients, revokes missing sessions, and exposes them to admins", async () => {
    const harness = makeHarness();
    const host = await harness.register();

    const first = await harness.call("/v1/hosts/clients", {
      method: "POST",
      auth: host.hostToken,
      body: {
        clients: [
          {
            sessionId: "session-a",
            clientLabel: "Laptop",
            platform: "darwin",
            firstSeenAt: NOW - 5_000,
            lastSeenAt: NOW - 1_000,
          },
          {
            sessionId: "session-b",
            clientLabel: "Phone",
            platform: "android",
            firstSeenAt: NOW - 2_000,
            lastSeenAt: NOW - 2_000,
          },
        ],
      },
    });
    expect(await json(first)).toEqual({ recorded: 2 });

    const second = await harness.call("/v1/hosts/clients", {
      method: "POST",
      auth: host.hostToken,
      body: {
        clients: [
          {
            sessionId: "session-a",
            clientLabel: "Laptop",
            platform: "darwin",
            firstSeenAt: NOW - 5_000,
            lastSeenAt: NOW,
          },
        ],
      },
    });
    expect(await json(second)).toEqual({ recorded: 1 });

    const heartbeat = await json(
      await harness.call("/v1/hosts/heartbeat", {
        method: "POST",
        auth: host.hostToken,
        body: { online: true, hostKeyVersion: 1 },
      }),
    );
    expect(heartbeat["revokedSessionIds"]).toEqual(["session-b"]);

    const admin = await json(
      await harness.call(`/v1/admin/hosts/${host.hostId}/clients`, { auth: ADMIN_KEY }),
    );
    expect(admin["clients"]).toEqual([
      {
        sessionId: "session-a",
        clientLabel: "Laptop",
        platform: "darwin",
        firstSeenAt: new Date(NOW - 5_000).toISOString(),
        lastSeenAt: new Date(NOW).toISOString(),
        revokedAt: null,
      },
      {
        sessionId: "session-b",
        clientLabel: "Phone",
        platform: "android",
        firstSeenAt: new Date(NOW - 2_000).toISOString(),
        lastSeenAt: new Date(NOW - 2_000).toISOString(),
        revokedAt: new Date(NOW).toISOString(),
      },
    ]);

    const revoke = await harness.call(`/v1/admin/hosts/${host.hostId}/revoke-client`, {
      method: "POST",
      auth: ADMIN_KEY,
      body: { sessionId: "session-a" },
    });
    expect(await json(revoke)).toEqual({ revoked: true });
    expect(harness.store.countClients(host.hostId)).toBe(0);
  });

  it("validates the client report shape", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    const notArray = await harness.call("/v1/hosts/clients", {
      method: "POST",
      auth: host.hostToken,
      body: { clients: "nope" },
    });
    expect(notArray.status).toBe(400);

    const tooLong = await harness.call("/v1/hosts/clients", {
      method: "POST",
      auth: host.hostToken,
      body: {
        clients: Array.from({ length: 501 }, (_, index) => ({ sessionId: `s-${index}` })),
      },
    });
    expect(tooLong.status).toBe(400);
    expect(errorOf(await json(tooLong))).toBe("clients is too long.");
  });
});

describe("key rotation", () => {
  it("rotates from the host and reports the new key to an old heartbeat", async () => {
    const harness = makeHarness();
    const host = await harness.register();

    const rotate = await harness.call("/v1/hosts/rotate-key", {
      method: "POST",
      auth: host.hostToken,
    });
    const rotated = (await json(rotate)) as { hostKey: string; hostKeyVersion: number };
    expect(rotate.status).toBe(200);
    expect(rotated.hostKeyVersion).toBe(2);
    expect(rotated.hostKey).not.toBe(host.hostKey);

    const oldKey = await harness.call("/v1/hosts/resolve", {
      method: "POST",
      auth: host.hostKey,
    });
    expect(oldKey.status).toBe(401);

    const newKey = await harness.call("/v1/hosts/resolve", {
      method: "POST",
      auth: rotated.hostKey,
    });
    expect(newKey.status).toBe(200);

    const heartbeat = await json(
      await harness.call("/v1/hosts/heartbeat", {
        method: "POST",
        auth: host.hostToken,
        body: { online: true, hostKeyVersion: 1 },
      }),
    );
    expect(heartbeat).toMatchObject({
      hostKey: rotated.hostKey,
      hostKeyVersion: 2,
    });
  });

  it("rotates from the admin console and reveals the current key", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    const rotate = await harness.call(`/v1/admin/hosts/${host.hostId}/rotate-key`, {
      method: "POST",
      auth: ADMIN_KEY,
    });
    expect(rotate.status).toBe(200);
    const rotated = (await json(rotate)) as { hostKey: string; hostKeyVersion: number };
    expect(rotated.hostKeyVersion).toBe(2);

    const listed = (await json(await harness.call("/v1/admin/hosts", { auth: ADMIN_KEY }))) as {
      hosts: ReadonlyArray<Record<string, unknown>>;
    };
    expect(listed.hosts[0]).toMatchObject({
      hostId: host.hostId,
      hostKey: rotated.hostKey,
      online: false,
    });
  });
});

describe("admin host management", () => {
  it("lists hosts with VPS-compatible fields", async () => {
    const harness = makeHarness();
    const host = await harness.register({ label: "Office", platform: "darwin" });
    const body = (await json(await harness.call("/v1/admin/hosts", { auth: ADMIN_KEY }))) as {
      hosts: ReadonlyArray<Record<string, unknown>>;
    };
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]).toMatchObject({
      hostId: host.hostId,
      environmentId: "env-a",
      label: "Office",
      platform: "darwin",
      online: false,
      paused: false,
      lastSeenAt: new Date(NOW).toISOString(),
      publicUrl: "",
      hostKey: host.hostKey,
      clientsCount: 0,
      createdAt: new Date(NOW).toISOString(),
      revokedAt: null,
      connectorMode: "quick",
      hostname: null,
    });

    const detail = await harness.call(`/v1/admin/hosts/${host.hostId}`, { auth: ADMIN_KEY });
    expect((await json(detail))["host"]).toMatchObject({ hostId: host.hostId });
    expect((await harness.call("/v1/admin/hosts/unknown00000", { auth: ADMIN_KEY })).status).toBe(
      404,
    );
  });

  it("removes and restores a host without banning its environment", async () => {
    const harness = makeHarness();
    const host = await harness.register();

    const remove = await harness.call(`/v1/admin/hosts/${host.hostId}/remove`, {
      method: "POST",
      auth: ADMIN_KEY,
    });
    expect(await json(remove)).toEqual({ removed: true });
    expect((await harness.call(`/v1/admin/hosts/${host.hostId}`, { auth: ADMIN_KEY })).status).toBe(
      404,
    );
    expect(
      (
        await harness.call("/v1/hosts/resolve", {
          method: "POST",
          auth: host.hostKey,
        })
      ).status,
    ).toBe(401);

    const restore = await harness.call(`/v1/admin/hosts/${host.hostId}/restore`, {
      method: "POST",
      auth: ADMIN_KEY,
    });
    expect(await json(restore)).toEqual({ restored: true });
    const restored = await json(
      await harness.call(`/v1/admin/hosts/${host.hostId}`, { auth: ADMIN_KEY }),
    );
    expect((restored["host"] as Record<string, unknown>)["revokedAt"]).toBeNull();

    const again = await harness.register();
    expect(again.hostId).toBe(host.hostId);
    expect(again.hostKey).toBe(host.hostKey);
  });

  it("audits remove and restore in the store", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    await harness.call(`/v1/admin/hosts/${host.hostId}/remove`, {
      method: "POST",
      auth: ADMIN_KEY,
    });
    await harness.call(`/v1/admin/hosts/${host.hostId}/restore`, {
      method: "POST",
      auth: ADMIN_KEY,
    });
    expect(harness.store.getHost(host.hostId)?.revokedAt).toBeNull();
  });
});

describe("rate limits", () => {
  it("limits registration to 10 per minute per IP", async () => {
    const harness = makeHarness();
    for (let index = 0; index < 10; index += 1) {
      const response = await harness.call("/v1/hosts/register", {
        method: "POST",
        auth: ENROLL_KEY,
        body: { environmentId: `env-${index}`, apiVersion: 2 },
      });
      expect(response.status).toBe(200);
    }
    const blocked = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: { environmentId: "env-blocked", apiVersion: 2 },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(errorOf(await json(blocked))).toBe("Too many requests. Try again later.");

    harness.advance(60_001);
    const allowed = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      body: { environmentId: "env-after-window", apiVersion: 2 },
    });
    expect(allowed.status).toBe(200);
  });

  it("limits resolves to 120 per minute per IP", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    for (let index = 0; index < 120; index += 1) {
      const response = await harness.call("/v1/hosts/resolve", {
        method: "POST",
        auth: host.hostKey,
      });
      expect(response.status).toBe(200);
    }
    const blocked = await harness.call("/v1/hosts/resolve", {
      method: "POST",
      auth: host.hostKey,
    });
    expect(blocked.status).toBe(429);
  });

  it("limits admin calls to 300 per minute per IP", async () => {
    const harness = makeHarness();
    for (let index = 0; index < 300; index += 1) {
      const response = await harness.call("/v1/admin/hosts", { auth: ADMIN_KEY });
      expect(response.status).toBe(200);
    }
    expect((await harness.call("/v1/admin/hosts", { auth: ADMIN_KEY })).status).toBe(429);
  });
});

describe("CORS, bodies and push no-ops", () => {
  it("echoes configured origins and same-origin requests only", async () => {
    const harness = makeHarness({ allowedOrigins: "https://app.t3.codes" });
    const allowed = await harness.call("/v1/health", { origin: "https://app.t3.codes" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.t3.codes");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const sameOrigin = await harness.call("/v1/health", { origin: "https://relay.test" });
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBe("https://relay.test");

    const foreign = await harness.call("/v1/health", { origin: "https://evil.example.test" });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();

    const failed = await harness.call("/v1/unknown", { origin: "https://app.t3.codes" });
    expect(failed.status).toBe(404);
    expect(failed.headers.get("access-control-allow-origin")).toBe("https://app.t3.codes");
  });

  it("returns JSON error bodies for malformed and oversized requests", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    const malformed = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      rawBody: "{",
    });
    expect(malformed.status).toBe(400);
    expect(errorOf(await json(malformed))).toBe("Request body must be valid JSON.");

    const arrayBody = await harness.call("/v1/hosts/register", {
      method: "POST",
      auth: ENROLL_KEY,
      rawBody: "[]",
    });
    expect(arrayBody.status).toBe(400);
    expect(errorOf(await json(arrayBody))).toBe("Request body must be a JSON object.");

    const oversized = await harness.call("/v1/hosts/heartbeat", {
      method: "POST",
      auth: host.hostToken,
      rawBody: JSON.stringify({ padding: "x".repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(errorOf(await json(oversized))).toBe("Request body is too large.");
  });

  it("answers the push and notify no-ops without storing anything", async () => {
    const harness = makeHarness();
    const host = await harness.register();

    const publicKey = await harness.call("/v1/push/public-key");
    expect(publicKey.status).toBe(200);
    expect(await json(publicKey)).toEqual({ publicKey: "" });

    const subscribe = await harness.call("/v1/push/subscribe", {
      method: "POST",
      auth: host.hostKey,
      body: {
        subscription: { endpoint: "https://push.example.test/x", keys: { p256dh: "p", auth: "a" } },
      },
    });
    expect(subscribe.status).toBe(200);
    expect(await json(subscribe)).toEqual({ subscribed: true });

    const unsubscribe = await harness.call("/v1/push/unsubscribe", {
      method: "POST",
      auth: ADMIN_KEY,
      body: { endpoint: "https://push.example.test/x" },
    });
    expect(await json(unsubscribe)).toEqual({ removed: false });

    const notify = await harness.call("/v1/notify", {
      method: "POST",
      auth: host.hostToken,
      body: { environmentId: "env-a", threadId: "thread-1", phase: "completed" },
    });
    expect(notify.status).toBe(200);
    expect(await json(notify)).toEqual({
      delivered: 0,
      removed: 0,
      skipped: "no-subscriptions",
    });

    const badPush = await harness.call("/v1/push/subscribe", {
      method: "POST",
      auth: "invalid-key",
      body: {},
    });
    expect(badPush.status).toBe(401);
  });

  it("removes a host on unregister", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    harness.store.replaceClients(
      host.hostId,
      [
        {
          sessionId: "session-a",
          clientLabel: null,
          platform: null,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ],
      NOW,
    );
    const response = await harness.call("/v1/hosts/unregister", {
      method: "POST",
      auth: host.hostToken,
    });
    expect(await json(response)).toEqual({ removed: true });
    expect(harness.store.getHost(host.hostId)).toBeNull();
    expect(harness.store.listClients(host.hostId)).toHaveLength(0);
    expect(
      (
        await harness.call("/v1/hosts/resolve", {
          method: "POST",
          auth: host.hostKey,
        })
      ).status,
    ).toBe(401);
  });
});

describe("VPS parity spot checks", () => {
  it("keeps the same registration, resolve, and admin field names", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    expect(Object.keys(host).sort()).toEqual(
      [
        "connector",
        "environmentId",
        "heartbeatIntervalMs",
        "hostId",
        "hostKey",
        "hostKeyVersion",
        "hostToken",
        "label",
        "publicUrl",
      ].sort(),
    );
    const resolved = await json(
      await harness.call("/v1/hosts/resolve", { method: "POST", auth: host.hostKey }),
    );
    expect(Object.keys(resolved).sort()).toEqual(
      ["environmentId", "hostId", "label", "online", "paused", "publicUrl"].sort(),
    );
  });

  it("treats an ISO timestamp client report like the VPS relay", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    const response = await harness.call("/v1/hosts/clients", {
      method: "POST",
      auth: host.hostToken,
      body: {
        clients: [
          {
            sessionId: "session-a",
            firstSeenAt: new Date(NOW - 1_000).toISOString(),
            lastSeenAt: new Date(NOW).toISOString(),
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(harness.store.listClients(host.hostId)[0]?.firstSeenAt).toBe(NOW - 1_000);
  });

  it("does not report revoked hosts from a host token", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    await harness.call(`/v1/admin/hosts/${host.hostId}/remove`, {
      method: "POST",
      auth: ADMIN_KEY,
    });
    for (const path of ["/v1/hosts/heartbeat", "/v1/hosts/clients", "/v1/hosts/rotate-key"]) {
      const response = await harness.call(path, {
        method: "POST",
        auth: host.hostToken,
        body: { clients: [] },
      });
      expect(response.status).toBe(401);
    }
  });
});

describe("clock boundaries", () => {
  it("expires the host after the heartbeat TTL", async () => {
    const harness = makeHarness();
    const host = await harness.register();
    harness.advance(DAY_MS);
    const resolved = await json(
      await harness.call("/v1/hosts/resolve", { method: "POST", auth: host.hostKey }),
    );
    expect(resolved["online"]).toBe(false);
  });
});
