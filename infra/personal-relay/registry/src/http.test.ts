import { expect, it } from "vite-plus/test";
import type * as NodeNet from "node:net";

import { createRegistryServer } from "./http.ts";
import { makeTestRegistry, TEST_PERSONAL_KEY as PERSONAL_KEY } from "./testkit.ts";

async function startServer() {
  const registry = makeTestRegistry();
  const server = createRegistryServer({
    service: registry.service,
    vapidPublicKey: "vapid-public-key",
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

it("serves health and the VAPID public key without a credential", async () => {
  const harness = await startServer();
  try {
    const health = await fetch(harness.url("/v1/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const key = await fetch(harness.url("/v1/push/public-key"));
    expect(await key.json()).toEqual({ publicKey: "vapid-public-key" });
  } finally {
    await harness.close();
  }
});

it("rejects missing and wrong personal keys", async () => {
  const harness = await startServer();
  try {
    expect((await fetch(harness.url("/v1/hosts"))).status).toBe(401);
    const wrong = await fetch(harness.url("/v1/hosts"), {
      headers: { authorization: "Bearer not-the-key" },
    });
    expect(wrong.status).toBe(401);
  } finally {
    await harness.close();
  }
});

it("registers a host and lists it by personal key", async () => {
  const harness = await startServer();
  try {
    const register = await fetch(harness.url("/v1/hosts/register"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${PERSONAL_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ environmentId: "env-http", label: "Office" }),
    });
    expect(register.status).toBe(200);
    const registered = (await register.json()) as {
      hostId: string;
      hostToken: string;
      publicUrl: string;
    };
    expect(registered.publicUrl).toBe(`https://${registered.hostId}.t3.example.test`);

    const list = await fetch(harness.url("/v1/hosts"), {
      headers: { authorization: `Bearer ${PERSONAL_KEY}` },
    });
    const listed = (await list.json()) as {
      hosts: ReadonlyArray<{ hostId: string; online: boolean; label: string }>;
    };
    expect(listed.hosts).toHaveLength(1);
    expect(listed.hosts[0]).toMatchObject({
      hostId: registered.hostId,
      online: true,
      label: "Office",
    });

    const heartbeat = await fetch(harness.url("/v1/hosts/heartbeat"), {
      method: "POST",
      headers: { authorization: `Bearer ${registered.hostToken}` },
      body: JSON.stringify({ label: "Office 2" }),
    });
    expect(heartbeat.status).toBe(200);

    const unregister = await fetch(harness.url("/v1/hosts/unregister"), {
      method: "POST",
      headers: { authorization: `Bearer ${registered.hostToken}` },
      body: "{}",
    });
    expect(unregister.status).toBe(200);
    const empty = await fetch(harness.url("/v1/hosts"), {
      headers: { authorization: `Bearer ${PERSONAL_KEY}` },
    });
    expect(((await empty.json()) as { hosts: unknown[] }).hosts).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it("subscribes a device and delivers a notification", async () => {
  const harness = await startServer();
  try {
    const register = await fetch(harness.url("/v1/hosts/register"), {
      method: "POST",
      headers: { authorization: `Bearer ${PERSONAL_KEY}` },
      body: JSON.stringify({ environmentId: "env-http" }),
    });
    const host = (await register.json()) as { hostId: string };

    const subscribe = await fetch(harness.url("/v1/push/subscribe"), {
      method: "POST",
      headers: { authorization: `Bearer ${PERSONAL_KEY}` },
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
      headers: { authorization: `Bearer ${PERSONAL_KEY}` },
      body: JSON.stringify({
        hostId: host.hostId,
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

it("returns JSON errors for malformed requests", async () => {
  const harness = await startServer();
  try {
    const malformed = await fetch(harness.url("/v1/hosts/register"), {
      method: "POST",
      headers: { authorization: `Bearer ${PERSONAL_KEY}` },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "Request body must be valid JSON." });

    const missing = await fetch(harness.url("/v1/nope"), {
      headers: { authorization: `Bearer ${PERSONAL_KEY}` },
    });
    expect(missing.status).toBe(404);
  } finally {
    await harness.close();
  }
});
