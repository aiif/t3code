import { expect, it } from "vite-plus/test";
import type * as NodeNet from "node:net";

import { createRegistryServer } from "./http.ts";
import { makeTestRegistry, TEST_ADMIN_KEY } from "./testkit.ts";

async function startServer() {
  const registry = makeTestRegistry();
  const server = createRegistryServer({
    service: registry.service,
    vapidPublicKey: "vapid-public-key",
    allowedOrigins: ["https://t3.example.test"],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return {
    registry,
    server,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      registry.close();
    },
  };
}

async function register(harness: Awaited<ReturnType<typeof startServer>>, environmentId: string) {
  const response = await fetch(harness.url("/v1/hosts/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentId, label: "Office", platform: "win32" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    hostId: string;
    hostKey: string;
    hostKeyVersion: number;
    hostToken: string;
    publicUrl: string;
  };
}

it("serves health and the VAPID public key without a credential", async () => {
  const harness = await startServer();
  try {
    const health = await fetch(harness.url("/v1/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: 2 });

    const key = await fetch(harness.url("/v1/push/public-key"));
    expect(await key.json()).toEqual({ publicKey: "vapid-public-key" });
  } finally {
    await harness.close();
  }
});

it("registers without a credential and resolves with the returned host key", async () => {
  const harness = await startServer();
  try {
    const registered = await register(harness, "env-http");
    expect(registered.publicUrl).toBe(`https://${registered.hostId}.t3.example.test`);

    const resolved = await fetch(harness.url("/v1/hosts/resolve"), {
      method: "POST",
      headers: { authorization: `Bearer ${registered.hostKey}` },
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      hostId: registered.hostId,
      environmentId: "env-http",
      online: true,
    });

    const adminKeyAsGuest = await fetch(harness.url("/v1/hosts/resolve"), {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(adminKeyAsGuest.status).toBe(401);
  } finally {
    await harness.close();
  }
});

it("lists, reveals, rotates, and removes hosts with the admin key", async () => {
  const harness = await startServer();
  try {
    const host = await register(harness, "env-http");
    expect((await fetch(harness.url("/v1/admin/hosts"))).status).toBe(401);

    const list = await fetch(harness.url("/v1/admin/hosts"), {
      headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      hosts: ReadonlyArray<{ hostId: string; hostKey: string; online: boolean }>;
    };
    expect(listed.hosts).toHaveLength(1);
    expect(listed.hosts[0]).toMatchObject({
      hostId: host.hostId,
      hostKey: host.hostKey,
      online: true,
    });

    const clients = await fetch(harness.url(`/v1/admin/hosts/${host.hostId}/clients`), {
      headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(clients.status).toBe(200);
    expect(await clients.json()).toMatchObject({ clients: [] });

    const rotate = await fetch(harness.url(`/v1/admin/hosts/${host.hostId}/rotate-key`), {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    const rotated = (await rotate.json()) as { hostKey: string };
    expect(rotated.hostKey).not.toBe(host.hostKey);

    const remove = await fetch(harness.url(`/v1/admin/hosts/${host.hostId}/remove`), {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(remove.status).toBe(200);
    expect(harness.registry.service.listAdminHosts().hosts).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it("heartbeats, reports clients, and goes offline on pause", async () => {
  const harness = await startServer();
  try {
    const host = await register(harness, "env-http");
    const heartbeat = await fetch(harness.url("/v1/hosts/heartbeat"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${host.hostToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ online: false, hostKeyVersion: host.hostKeyVersion }),
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ hostId: host.hostId });

    const resolved = await fetch(harness.url("/v1/hosts/resolve"), {
      method: "POST",
      headers: { authorization: `Bearer ${host.hostKey}` },
    });
    expect(await resolved.json()).toMatchObject({ online: false, paused: true });

    const clients = await fetch(harness.url("/v1/hosts/clients"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${host.hostToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clients: [{ sessionId: "s1", clientLabel: "Phone", platform: "mobile" }],
      }),
    });
    expect(clients.status).toBe(200);
    expect(await clients.json()).toEqual({ recorded: 1 });
    expect(harness.registry.service.listAdminClients(host.hostId).host.clientsCount).toBe(1);
  } finally {
    await harness.close();
  }
});

it("subscribes with a host key and delivers a notification from that host", async () => {
  const harness = await startServer();
  try {
    const host = await register(harness, "env-http");
    const subscribe = await fetch(harness.url("/v1/push/subscribe"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${host.hostKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subscription: {
          endpoint: "https://push.example.test/subscription/http",
          keys: { p256dh: "p", auth: "a" },
        },
      }),
    });
    expect(subscribe.status).toBe(200);

    const notify = await fetch(harness.url("/v1/notify"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${host.hostToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        environmentId: "env-http",
        threadId: "thread-http",
        phase: "waiting_for_input",
      }),
    });
    expect(notify.status).toBe(200);
    expect(await notify.json()).toEqual({ delivered: 1, removed: 0, skipped: null });
    expect(harness.registry.sent).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

it("answers CORS preflight for the portal and returns JSON errors", async () => {
  const harness = await startServer();
  try {
    const preflight = await fetch(harness.url("/v1/admin/hosts"), {
      method: "OPTIONS",
      headers: { origin: "https://t3.example.test" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://t3.example.test");

    const malformed = await fetch(harness.url("/v1/hosts/register"), {
      method: "POST",
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Request body must be valid JSON." });

    const missing = await fetch(harness.url("/v1/nope"), {
      headers: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(missing.status).toBe(401);
  } finally {
    await harness.close();
  }
});
