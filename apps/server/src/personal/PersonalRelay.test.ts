import { describe, expect, it } from "@effect/vitest";
import type { PersonalConnector } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PersonalHostFile } from "./hostSharingState.ts";
import {
  ConnectorProcess,
  decodePersonalRelayStatusFile,
  layerClient,
  layerConnectorProcess,
  PersonalRelayClient,
  toPersonalRelayState,
} from "./PersonalRelay.ts";

interface CapturedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, unknown>> | undefined;
}

const quick: PersonalConnector = { kind: "cloudflare-tunnel", mode: "quick" };
const named: PersonalConnector = {
  kind: "cloudflare-tunnel",
  mode: "named",
  tunnelToken: "tunnel-token-secret",
  hostname: "abcdef123456.example.test",
};

const spawnInput = {
  port: 3773,
  configPath: "/state/personal/frpc.toml",
  frpcPath: "frpc",
  cloudflaredPath: "cloudflared",
} as const;

const spawnerLayer = (input: {
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly captured: Array<CapturedCommand>;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const standard = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly options: { readonly env?: Record<string, unknown> };
        };
        input.captured.push({
          command: standard.command,
          args: standard.args,
          env: standard.options.env,
        });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: input.stderr,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

const connectorLayer = (input: Parameters<typeof spawnerLayer>[0]) =>
  layerConnectorProcess.pipe(Layer.provide(spawnerLayer(input)));

describe("PersonalRelayClient", () => {
  it.effect("includes the relay error body in a failed request", () =>
    Effect.gen(function* () {
      const client = yield* PersonalRelayClient;
      const error = yield* client
        .register({
          relayUrl: "https://relay.example.test",
          environmentId: "environment-1",
          label: "Home PC",
          platform: "win32",
          originPort: 3773,
          relayKey: "enrollment-key",
        })
        .pipe(Effect.flip);

      expect(error.status).toBe(502);
      expect(error.detail).toContain("Tunnel provisioning failed.");
      expect(error.detail).toContain("Zero Trust is not enabled.");
    }).pipe(
      Effect.provide(
        layerClient().pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json(
                      { error: "Tunnel provisioning failed. Zero Trust is not enabled." },
                      { status: 502 },
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});

describe("ConnectorProcess", () => {
  it.effect("waits for cloudflared's quick tunnel address", () => {
    const captured: Array<CapturedCommand> = [];
    const stderr = Stream.make(
      new TextEncoder().encode("\u001b[32mINF\u001b[0m |  Requesting a quick tunnel  |\n"),
      new TextEncoder().encode(
        "\u001b[32mINF\u001b[0m |  https://fresh-name-42.trycloudflare.com  |\n",
      ),
    );
    return Effect.gen(function* () {
      const processes = yield* ConnectorProcess;
      const handle = yield* processes.spawn({ ...spawnInput, connector: quick });
      expect(yield* handle.publicUrl).toBe("https://fresh-name-42.trycloudflare.com");
      expect(captured[0]?.command).toBe("cloudflared");
      expect(captured[0]?.args).toContain("http://127.0.0.1:3773");
      expect(captured[0]?.env?.["TUNNEL_TOKEN"]).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(connectorLayer({ stderr, captured })));
  });

  it.effect("passes a named tunnel token through the environment, never argv", () => {
    const captured: Array<CapturedCommand> = [];
    return Effect.gen(function* () {
      const processes = yield* ConnectorProcess;
      const handle = yield* processes.spawn({ ...spawnInput, connector: named });
      expect(yield* handle.publicUrl).toBeNull();
      expect(captured[0]?.command).toBe("cloudflared");
      expect(captured[0]?.args).toEqual(["--no-autoupdate", "tunnel", "run"]);
      expect(Redacted.value(captured[0]?.env?.["TUNNEL_TOKEN"] as Redacted.Redacted<string>)).toBe(
        "tunnel-token-secret",
      );
      expect(captured[0]?.args.join(" ")).not.toContain("tunnel-token-secret");
    }).pipe(Effect.scoped, Effect.provide(connectorLayer({ stderr: Stream.empty, captured })));
  });
});

const hostFile = (overrides: Partial<PersonalHostFile> = {}): PersonalHostFile => ({
  enabled: true,
  paused: false,
  relayUrl: "https://relay.example.test",
  label: "Home PC",
  hostId: "abcdef123456",
  hostKey: "host-key-secret",
  hostKeyVersion: 1,
  hostToken: "host-token-secret",
  publicUrl: "",
  relayKey: "relay-key-secret",
  connector: named,
  heartbeatIntervalMs: 60_000,
  updatedAt: "2026-11-17T00:00:00.000Z",
  ...overrides,
});

describe("relay status", () => {
  it("reports the connector without any credential", () => {
    const status = toPersonalRelayState(hostFile());
    expect(status.connectorKind).toBe("cloudflare-tunnel");
    expect(status.connectorMode).toBe("named");
    expect(status.connectorRunning).toBe(false);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("relay-key-secret");
    expect(serialized).not.toContain("tunnel-token-secret");
    expect(serialized).not.toContain("host-key-secret");
    expect(serialized).not.toContain("host-token-secret");
    expect(toPersonalRelayState(null).connectorKind).toBeNull();
    expect(toPersonalRelayState(hostFile({ connector: quick })).connectorMode).toBe("quick");
  });

  it("reads a legacy status file that still has frpcRunning", () => {
    const decoded = decodePersonalRelayStatusFile(
      JSON.stringify({
        enabled: true,
        paused: false,
        relayUrl: "https://t3.example.test",
        hostId: "abcdef123456",
        publicUrl: "https://abcdef123456.t3.example.test",
        label: "Home PC",
        online: true,
        frpcRunning: true,
        lastError: null,
        updatedAt: "2026-11-16T00:00:00.000Z",
      }),
    );
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isNone(decoded)) return;
    expect(decoded.value.connectorKind).toBe("frp");
    expect(decoded.value.connectorMode).toBeNull();
    expect(decoded.value.connectorRunning).toBe(true);
  });
});
