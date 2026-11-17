import { describe, expect, it } from "vite-plus/test";

import type { WorkerEnv } from "./config.ts";
import worker from "./worker.ts";

const ADMIN_KEY = "admin-key-for-tests-0123456789abcdef";
const ENROLL_KEY = "enroll-key-for-tests-0123456789abcd";

interface WorkerHarness {
  readonly env: WorkerEnv;
  readonly registryCalls: string[];
  readonly assetCalls: string[];
}

function makeEnv(overrides: Record<string, string | undefined> = {}): WorkerHarness {
  const registryCalls: string[] = [];
  const assetCalls: string[] = [];
  const env = {
    T3CODE_ADMIN_KEY: ADMIN_KEY,
    T3CODE_SECRET_KEY: "07".repeat(32),
    T3CODE_ENROLL_KEY: ENROLL_KEY,
    REGISTRY: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: (request: Request): Promise<Response> => {
          registryCalls.push(new URL(request.url).pathname);
          return Promise.resolve(new Response(`registry:${new URL(request.url).pathname}`));
        },
      }),
    },
    ASSETS: {
      fetch: (request: Request): Promise<Response> => {
        const pathname = new URL(request.url).pathname;
        assetCalls.push(pathname);
        return Promise.resolve(new Response(`asset:${pathname}`));
      },
    },
    ...overrides,
  } as unknown as WorkerEnv;
  return { env, registryCalls, assetCalls };
}

const handler = worker as unknown as {
  fetch(request: Request, env: WorkerEnv): Promise<Response> | Response;
};

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://relay.test${path}`, init);
}

describe("Worker routing", () => {
  it("serves health without touching the Durable Object", async () => {
    const { env, registryCalls } = makeEnv();
    const response = await handler.fetch(request("/v1/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "t3-personal-registry",
      version: 2,
      mode: "quick",
    });
    expect(registryCalls).toHaveLength(0);
  });

  it("returns 503 for health when config is invalid", async () => {
    const { env } = makeEnv({ T3CODE_ENROLL_KEY: undefined });
    const response = await handler.fetch(request("/v1/health"), env);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("T3CODE_ENROLL_KEY is required.");
  });

  it("routes /v1 and /v1/* to the registry Durable Object", async () => {
    const { env, registryCalls, assetCalls } = makeEnv();
    for (const path of ["/v1", "/v1/hosts/register", "/v1/admin/hosts"]) {
      const response = await handler.fetch(request(path), env);
      expect(await response.text()).toBe(`registry:${path}`);
    }
    expect(registryCalls).toEqual(["/v1", "/v1/hosts/register", "/v1/admin/hosts"]);
    expect(assetCalls).toHaveLength(0);
  });

  it("serves assets for everything outside /v1", async () => {
    const { env, registryCalls, assetCalls } = makeEnv();
    for (const path of ["/", "/admin", "/assets/app.js"]) {
      const response = await handler.fetch(request(path), env);
      expect(await response.text()).toBe(`asset:${path}`);
    }
    expect(assetCalls).toEqual(["/", "/admin", "/assets/app.js"]);
    expect(registryCalls).toHaveLength(0);
  });

  it("answers CORS preflight for allowed origins and never uses a wildcard", async () => {
    const { env, registryCalls } = makeEnv({ T3CODE_ALLOWED_ORIGINS: "https://app.t3.codes" });
    const preflight = await handler.fetch(
      request("/v1/hosts/register", {
        method: "OPTIONS",
        headers: { origin: "https://app.t3.codes" },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.t3.codes");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );

    const ownOrigin = await handler.fetch(
      request("/v1/hosts/register", {
        method: "OPTIONS",
        headers: { origin: "https://relay.test" },
      }),
      env,
    );
    expect(ownOrigin.headers.get("access-control-allow-origin")).toBe("https://relay.test");

    const foreign = await handler.fetch(
      request("/v1/hosts/register", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.test" },
      }),
      env,
    );
    expect(foreign.status).toBe(204);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(registryCalls).toHaveLength(0);
  });

  it("adds CORS headers to health for allowed origins", async () => {
    const { env } = makeEnv({ T3CODE_ALLOWED_ORIGINS: "https://app.t3.codes" });
    const response = await handler.fetch(
      request("/v1/health", { headers: { origin: "https://app.t3.codes" } }),
      env,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.t3.codes");
  });

  it("answers preflight even when config is invalid", async () => {
    const { env } = makeEnv({ T3CODE_SECRET_KEY: undefined });
    const response = await handler.fetch(
      request("/v1/hosts/register", {
        method: "OPTIONS",
        headers: { origin: "https://relay.test" },
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://relay.test");
  });
});
