import { describe, expect, it } from "vite-plus/test";

import { resolveWorkerConfig, WorkerConfigError, type WorkerEnv } from "./config.ts";

const ADMIN_KEY = "admin-key-for-tests-0123456789abcdef";
const ENROLL_KEY = "enroll-key-for-tests-0123456789abcd";
const SECRET_KEY_HEX = "07".repeat(32);

function env(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  return {
    T3CODE_ADMIN_KEY: ADMIN_KEY,
    T3CODE_SECRET_KEY: SECRET_KEY_HEX,
    T3CODE_ENROLL_KEY: ENROLL_KEY,
    ...overrides,
  } as unknown as WorkerEnv;
}

function namedEnv(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  return env({
    T3CODE_TUNNEL_MODE: "named",
    T3CODE_CF_ACCOUNT_ID: "account-test",
    T3CODE_CF_ZONE_ID: "zone-test",
    T3CODE_CF_API_TOKEN: "cf-api-token",
    T3CODE_HOSTS_SUFFIX: "example.test",
    ...overrides,
  });
}

describe("resolveWorkerConfig", () => {
  it("defaults to quick mode with the documented limits", () => {
    const config = resolveWorkerConfig(env());
    expect(config).toMatchObject({
      configuredMode: "auto",
      mode: "quick",
      tunnelPrefix: "t3cf",
      maxHosts: 20,
      heartbeatIntervalMs: 60_000,
      heartbeatTtlMs: 180_000,
      hostsSuffix: null,
      accountId: null,
      zoneId: null,
      cfApiToken: null,
      allowedOrigins: [],
    });
    expect(config.secretKey).toHaveLength(32);
    expect(config.adminKey).toBe(ADMIN_KEY);
    expect(config.enrollKey).toBe(ENROLL_KEY);
  });

  it("picks named mode when every named setting is present", () => {
    const config = resolveWorkerConfig(namedEnv({ T3CODE_TUNNEL_MODE: undefined }));
    expect(config.mode).toBe("named");
    expect(config.hostsSuffix).toBe("example.test");
  });

  it("stays quick when auto mode lacks the named settings", () => {
    const config = resolveWorkerConfig(env({ T3CODE_CF_ACCOUNT_ID: "account-test" }));
    expect(config.mode).toBe("quick");
  });

  it("rejects explicit named mode without every named setting", () => {
    expect(() => resolveWorkerConfig(namedEnv({ T3CODE_CF_ZONE_ID: undefined }))).toThrow(
      WorkerConfigError,
    );
  });

  it("keeps quick mode even when named settings exist", () => {
    const config = resolveWorkerConfig(namedEnv({ T3CODE_TUNNEL_MODE: "quick" }));
    expect(config.configuredMode).toBe("quick");
    expect(config.mode).toBe("quick");
  });

  it("requires distinct admin and enrollment keys of at least 32 characters", () => {
    expect(() => resolveWorkerConfig(env({ T3CODE_ADMIN_KEY: undefined }))).toThrow(
      "T3CODE_ADMIN_KEY is required.",
    );
    expect(() => resolveWorkerConfig(env({ T3CODE_ENROLL_KEY: undefined }))).toThrow(
      "T3CODE_ENROLL_KEY is required.",
    );
    expect(() => resolveWorkerConfig(env({ T3CODE_ADMIN_KEY: "short" }))).toThrow(
      "at least 32 characters",
    );
    expect(() => resolveWorkerConfig(env({ T3CODE_ENROLL_KEY: ADMIN_KEY }))).toThrow("must differ");
  });

  it("accepts hex, base64url and raw 32-byte secret keys", () => {
    expect(resolveWorkerConfig(env()).secretKey).toEqual(
      new Uint8Array(Array.from({ length: 32 }, () => 7)),
    );

    const base64url = Buffer.alloc(32, 5).toString("base64url");
    expect(resolveWorkerConfig(env({ T3CODE_SECRET_KEY: base64url })).secretKey).toEqual(
      new Uint8Array(Array.from({ length: 32 }, () => 5)),
    );

    const raw = "x".repeat(32);
    expect(
      new TextDecoder().decode(resolveWorkerConfig(env({ T3CODE_SECRET_KEY: raw })).secretKey),
    ).toBe(raw);

    expect(() => resolveWorkerConfig(env({ T3CODE_SECRET_KEY: "too-short" }))).toThrow(
      WorkerConfigError,
    );
    expect(() => resolveWorkerConfig(env({ T3CODE_SECRET_KEY: undefined }))).toThrow(
      "T3CODE_SECRET_KEY is required.",
    );
  });

  it("normalizes the hosts suffix and tunnel prefix", () => {
    const config = resolveWorkerConfig(
      namedEnv({
        T3CODE_HOSTS_SUFFIX: ".Example.Test.",
        TUNNEL_PREFIX: "T3CF",
      }),
    );
    expect(config.hostsSuffix).toBe("example.test");
    expect(config.tunnelPrefix).toBe("t3cf");
    expect(() => resolveWorkerConfig(namedEnv({ T3CODE_HOSTS_SUFFIX: "-bad.example" }))).toThrow(
      "DNS zone or sub-zone",
    );
    expect(() => resolveWorkerConfig(env({ TUNNEL_PREFIX: "bad prefix" }))).toThrow(
      "lowercase DNS label",
    );
  });

  it("parses allowed origins and never accepts a wildcard", () => {
    const config = resolveWorkerConfig(
      env({
        T3CODE_ALLOWED_ORIGINS:
          "https://app.t3.codes, https://Relay.Example.test/path, https://app.t3.codes",
      }),
    );
    expect(config.allowedOrigins).toEqual(["https://app.t3.codes", "https://relay.example.test"]);
    expect(() => resolveWorkerConfig(env({ T3CODE_ALLOWED_ORIGINS: "*" }))).toThrow(
      "cannot contain *",
    );
    expect(() => resolveWorkerConfig(env({ T3CODE_ALLOWED_ORIGINS: "not a url" }))).toThrow(
      "is not an origin",
    );
  });

  it("validates numeric settings", () => {
    expect(() => resolveWorkerConfig(env({ T3CODE_MAX_HOSTS: "0" }))).toThrow("positive integer");
    expect(() => resolveWorkerConfig(env({ T3CODE_MAX_HOSTS: "2.5" }))).toThrow("positive integer");
    expect(() => resolveWorkerConfig(env({ T3CODE_HEARTBEAT_INTERVAL_MS: "fast" }))).toThrow(
      "T3CODE_HEARTBEAT_INTERVAL_MS",
    );
    expect(() => resolveWorkerConfig(env({ T3CODE_HEARTBEAT_TTL_MS: "-1" }))).toThrow(
      "T3CODE_HEARTBEAT_TTL_MS",
    );
    expect(resolveWorkerConfig(env({ T3CODE_MAX_HOSTS: "3" })).maxHosts).toBe(3);
  });

  it("rejects an unknown tunnel mode", () => {
    expect(() => resolveWorkerConfig(env({ T3CODE_TUNNEL_MODE: "frp" }))).toThrow(
      "T3CODE_TUNNEL_MODE must be auto, named or quick.",
    );
  });
});
