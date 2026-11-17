import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PersonalHostRegistrationResponse,
  PersonalRelayState,
  PersonalHeartbeatInput,
} from "./personal.ts";

const decodeRegistration = Schema.decodeUnknownSync(PersonalHostRegistrationResponse);
const decodeHeartbeat = Schema.decodeUnknownSync(PersonalHeartbeatInput);
const isRelayState = Schema.is(PersonalRelayState);

describe("personal relay registration contract", () => {
  it("decodes the legacy VPS response with frp settings", () => {
    const registration = decodeRegistration({
      hostId: "abc123def456",
      hostKey: "host-key",
      hostKeyVersion: 1,
      hostToken: "abc123def456.token",
      environmentId: "env-a",
      label: "Home PC",
      publicUrl: "https://abc123def456.example.test",
      frp: {
        serverAddr: "203.0.113.10",
        serverPort: 7001,
        authToken: "frp-token",
        domain: "abc123def456.example.test",
      },
      heartbeatIntervalMs: 30_000,
    });
    expect("frp" in registration).toBe(true);
  });

  it("decodes named and quick Cloudflare connectors", () => {
    const base = {
      hostId: "abc123def456",
      hostKey: "host-key",
      hostKeyVersion: 1,
      hostToken: "abc123def456.token",
      environmentId: "env-a",
      label: "Home PC",
      publicUrl: "",
      heartbeatIntervalMs: 60_000,
    };
    const named = decodeRegistration({
      ...base,
      connector: {
        kind: "cloudflare-tunnel",
        mode: "named",
        tunnelToken: "tunnel-token",
        hostname: "abc123def456.example.test",
      },
    });
    expect("connector" in named && named.connector.kind).toBe("cloudflare-tunnel");

    const quick = decodeRegistration({
      ...base,
      connector: { kind: "cloudflare-tunnel", mode: "quick" },
    });
    const quickConnector = "connector" in quick ? quick.connector : null;
    expect(quickConnector?.kind === "cloudflare-tunnel" ? quickConnector.mode : null).toBe("quick");
  });

  it("keeps quick-mode heartbeats optional and relay state explicit", () => {
    expect(
      decodeHeartbeat({
        label: "Home PC",
        online: true,
        hostKeyVersion: 1,
      }).publicUrl,
    ).toBeUndefined();
    expect(
      decodeHeartbeat({
        label: "Home PC",
        online: false,
        hostKeyVersion: 1,
        publicUrl: "https://fresh-name.trycloudflare.com",
      }).publicUrl,
    ).toBe("https://fresh-name.trycloudflare.com");

    expect(
      isRelayState({
        enabled: true,
        paused: false,
        relayUrl: "https://relay.example.test",
        hostId: "abc123def456",
        publicUrl: "",
        label: "Home PC",
        online: false,
        connectorKind: "cloudflare-tunnel",
        connectorMode: "quick",
        connectorRunning: false,
        lastError: null,
        updatedAt: null,
      }),
    ).toBe(true);
  });
});
