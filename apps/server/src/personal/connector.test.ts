import type { PersonalConnector, PersonalHostRegistration } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import type { PersonalHostFile } from "./hostSharingState.ts";

import {
  connectorModeOf,
  connectorPlan,
  findQuickTunnelUrl,
  hostFileFromRegistration,
  normalizeHeartbeatInterval,
  normalizeHostRegistration,
  quickTunnelTimeoutDetail,
  QUICK_TUNNEL_TIMEOUT_MS,
  stripAnsi,
} from "./connector.ts";

const frp: PersonalConnector = {
  kind: "frp",
  serverAddr: "203.0.113.10",
  serverPort: 7001,
  authToken: "frp-auth-token",
  domain: "abcdef123456.example.test",
};

const named: PersonalConnector = {
  kind: "cloudflare-tunnel",
  mode: "named",
  tunnelToken: "tunnel-token-secret",
  hostname: "abcdef123456.example.test",
};

const quick: PersonalConnector = { kind: "cloudflare-tunnel", mode: "quick" };

const planInput = {
  port: 3773,
  configPath: "/state/personal/frpc.toml",
  frpcPath: "frpc",
  cloudflaredPath: "cloudflared",
} as const;

describe("connector plan", () => {
  it("keeps frpc on the generated config", () => {
    const plan = connectorPlan({ ...planInput, connector: frp });
    expect(plan.command).toBe("frpc");
    expect(plan.args).toEqual(["-c", "/state/personal/frpc.toml"]);
    expect(plan.env).toEqual({});
    expect(plan.kind).toBe("frp");
    expect(plan.mode).toBeNull();
    expect(connectorModeOf(frp)).toBeNull();
  });

  it("runs a named cloudflared tunnel with the token only in the environment", () => {
    const plan = connectorPlan({ ...planInput, connector: named });
    expect(plan.command).toBe("cloudflared");
    expect(plan.args).toEqual(["--no-autoupdate", "tunnel", "run"]);
    expect(Redacted.value(plan.env.TUNNEL_TOKEN!)).toBe("tunnel-token-secret");
    expect(plan.args.join(" ")).not.toContain("tunnel-token-secret");
    expect(plan.kind).toBe("cloudflare-tunnel");
    expect(plan.mode).toBe("named");
    expect(connectorModeOf(named)).toBe("named");
  });

  it("passes the protocol fallback between the tunnel command and run", () => {
    const plan = connectorPlan({ ...planInput, connector: named, cloudflaredProtocol: "http2" });
    expect(plan.args).toEqual(["--no-autoupdate", "tunnel", "--protocol", "http2", "run"]);
  });

  it("points a quick tunnel at loopback and keeps argv credential-free", () => {
    const plan = connectorPlan({ ...planInput, connector: quick });
    expect(plan.command).toBe("cloudflared");
    expect(plan.args).toEqual(["--no-autoupdate", "tunnel", "--url", "http://127.0.0.1:3773"]);
    expect(plan.env).toEqual({});
    expect(plan.mode).toBe("quick");
    expect(connectorModeOf(quick)).toBe("quick");
  });
});

describe("quick tunnel stderr", () => {
  it("finds the first address after stripping ANSI colour codes", () => {
    const stderr = [
      "\u001b[32mINF\u001b[0m |  Requesting a quick tunnel  |",
      "\u001b[32mINF\u001b[0m |  https://funny-panda-42.trycloudflare.com  |",
      "",
    ].join("\n");
    expect(findQuickTunnelUrl(stderr)).toBe("https://funny-panda-42.trycloudflare.com");
  });

  it("finds an address split across stderr chunks", () => {
    const text = ["INF |  https://funny-pa", "nda-42.trycloudflare.com  |"].join("");
    expect(findQuickTunnelUrl(text)).toBe("https://funny-panda-42.trycloudflare.com");
  });

  it("ignores unrelated lines and foreign origins", () => {
    expect(findQuickTunnelUrl("failed to request quick Tunnel: connection refused")).toBeNull();
    expect(findQuickTunnelUrl("https://example.test/index.html")).toBeNull();
    expect(findQuickTunnelUrl("https://UPPER.trycloudflare.com")).toBeNull();
  });

  it("strips ANSI so the stderr tail stays readable", () => {
    expect(stripAnsi("\u001b[31mERR\u001b[0m boom")).toBe("ERR boom");
  });

  it("uses a 30 second startup window and reports the stderr tail on timeout", () => {
    expect(QUICK_TUNNEL_TIMEOUT_MS).toBe(30_000);
    expect(quickTunnelTimeoutDetail("failed to request quick Tunnel: refused")).toContain(
      "failed to request quick Tunnel: refused",
    );
    expect(quickTunnelTimeoutDetail("")).toContain("within 30 seconds");
  });
});

describe("heartbeat interval", () => {
  it("uses the registration interval clamped to 15-120 seconds", () => {
    expect(normalizeHeartbeatInterval(60_000)).toBe(60_000);
    expect(normalizeHeartbeatInterval(5_000)).toBe(15_000);
    expect(normalizeHeartbeatInterval(600_000)).toBe(120_000);
    expect(normalizeHeartbeatInterval(undefined)).toBe(30_000);
  });
});

const baseRegistration = {
  hostId: "abcdef123456",
  hostKey: "host-key-for-tests",
  hostKeyVersion: 1,
  hostToken: "abcdef123456.host-token",
  environmentId: "environment-a",
  label: "Home PC",
  publicUrl: "",
} as const;

describe("registration normalization", () => {
  it("normalizes the legacy VPS frp response", () => {
    const normalized = normalizeHostRegistration({
      ...baseRegistration,
      frp: {
        serverAddr: "203.0.113.10",
        serverPort: 7001,
        authToken: "token",
        domain: "abc.example.test",
      },
      heartbeatIntervalMs: 30_000,
    });
    expect(normalized.connector).toEqual({
      kind: "frp",
      serverAddr: "203.0.113.10",
      serverPort: 7001,
      authToken: "token",
      domain: "abc.example.test",
    });
    expect(normalized.heartbeatIntervalMs).toBe(30_000);
  });

  it("keeps a cloudflare connector unchanged", () => {
    const normalized = normalizeHostRegistration({
      ...baseRegistration,
      connector: named,
      heartbeatIntervalMs: 60_000,
    });
    expect(normalized.connector).toEqual(named);
  });

  it("persists the relay key and clamped heartbeat interval in the host file", () => {
    const registration: PersonalHostRegistration = {
      ...baseRegistration,
      connector: quick,
      heartbeatIntervalMs: 600_000,
    };
    const host = hostFileFromRegistration({
      registration,
      previous: null,
      relayUrl: "https://relay.example.test",
      relayKey: "relay-key-secret",
      now: "2026-11-17T00:00:00.000Z",
    });
    expect(host.connector).toEqual(quick);
    expect(host.heartbeatIntervalMs).toBe(120_000);
    expect(host.relayKey).toBe("relay-key-secret");
    expect(host.enabled).toBe(true);
    expect(host.paused).toBe(false);
  });

  it("keeps a stored relay key only while the relay URL stays the same", () => {
    const previous: PersonalHostFile = {
      enabled: true,
      paused: false,
      relayUrl: "https://old.example.test",
      label: null,
      hostId: "old-host",
      hostKey: "old-key",
      hostKeyVersion: 1,
      hostToken: "old-token",
      publicUrl: "",
      relayKey: "old-relay-key",
      connector: quick,
      heartbeatIntervalMs: 30_000,
      updatedAt: "2026-11-17T00:00:00.000Z",
    };
    const registration: PersonalHostRegistration = {
      ...baseRegistration,
      connector: quick,
      heartbeatIntervalMs: 60_000,
    };
    const switched = hostFileFromRegistration({
      registration,
      previous,
      relayUrl: "https://new.example.test",
      now: "2026-11-17T00:00:00.000Z",
    });
    expect(switched.relayKey).toBeUndefined();

    const reused = hostFileFromRegistration({
      registration,
      previous,
      relayUrl: "https://old.example.test",
      now: "2026-11-17T00:00:00.000Z",
    });
    expect(reused.relayKey).toBe("old-relay-key");
  });
});
