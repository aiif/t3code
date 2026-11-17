import type {
  PersonalConnector,
  PersonalConnectorKind,
  PersonalConnectorMode,
  PersonalHostRegistration,
  PersonalHostRegistrationResponse,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";

import type { PersonalHostFile } from "./hostSharingState.ts";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_HEARTBEAT_INTERVAL_MS = 120_000;
export const QUICK_TUNNEL_TIMEOUT_MS = 30_000;

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/g;
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** The first quick-tunnel address in cloudflared output, ignoring ANSI colour codes. */
export function findQuickTunnelUrl(text: string): string | null {
  return stripAnsi(text).match(QUICK_TUNNEL_URL_PATTERN)?.[0] ?? null;
}

export function stderrTail(text: string, limit = 500): string {
  return stripAnsi(text).slice(-limit);
}

/** The error shown when cloudflared never prints a quick-tunnel address. */
export function quickTunnelTimeoutDetail(tail: string): string {
  return tail.length > 0
    ? `cloudflared did not print a tunnel address: ${tail}`
    : "cloudflared did not print a tunnel address within 30 seconds.";
}

export function normalizeHeartbeatInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  return Math.min(
    MAX_HEARTBEAT_INTERVAL_MS,
    Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.round(value)),
  );
}

export function connectorModeOf(connector: PersonalConnector): PersonalConnectorMode | null {
  return connector.kind === "cloudflare-tunnel" ? connector.mode : null;
}

export interface ConnectorPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Only the tunnel token travels in the environment; argv stays free of credentials. */
  readonly env: Readonly<Record<string, Redacted.Redacted<string>>>;
  readonly kind: PersonalConnectorKind;
  readonly mode: PersonalConnectorMode | null;
}

export function connectorPlan(input: {
  readonly connector: PersonalConnector;
  readonly port: number;
  readonly configPath: string;
  readonly frpcPath: string;
  readonly cloudflaredPath: string;
  readonly cloudflaredProtocol?: "http2" | undefined;
}): ConnectorPlan {
  if (input.connector.kind === "frp") {
    return {
      command: input.frpcPath,
      args: ["-c", input.configPath],
      env: {},
      kind: "frp",
      mode: null,
    };
  }

  const args = ["--no-autoupdate", "tunnel"];
  if (input.cloudflaredProtocol !== undefined) {
    args.push("--protocol", input.cloudflaredProtocol);
  }
  if (input.connector.mode === "named") {
    return {
      command: input.cloudflaredPath,
      args: [...args, "run"],
      env: { TUNNEL_TOKEN: Redacted.make(input.connector.tunnelToken) },
      kind: "cloudflare-tunnel",
      mode: "named",
    };
  }
  return {
    command: input.cloudflaredPath,
    args: [...args, "--url", `http://127.0.0.1:${input.port}`],
    env: {},
    kind: "cloudflare-tunnel",
    mode: "quick",
  };
}

/** The VPS relay still answers with `frp`, so normalize both shapes to a connector. */
export function normalizeHostRegistration(
  registration: PersonalHostRegistrationResponse,
): PersonalHostRegistration {
  if ("connector" in registration) return registration;
  return {
    hostId: registration.hostId,
    hostKey: registration.hostKey,
    hostKeyVersion: registration.hostKeyVersion,
    hostToken: registration.hostToken,
    environmentId: registration.environmentId,
    label: registration.label,
    publicUrl: registration.publicUrl,
    connector: { kind: "frp", ...registration.frp },
    heartbeatIntervalMs: registration.heartbeatIntervalMs,
  };
}

export function hostFileFromRegistration(input: {
  readonly registration: PersonalHostRegistration;
  readonly previous: PersonalHostFile | null;
  readonly relayUrl: string;
  readonly relayKey?: string | undefined;
  readonly now: string;
}): PersonalHostFile {
  const previousRelayKey =
    input.previous?.relayUrl === input.relayUrl ? input.previous.relayKey : undefined;
  const relayKey = input.relayKey?.trim() || previousRelayKey?.trim() || undefined;
  return {
    enabled: true,
    paused: input.previous?.paused ?? false,
    relayUrl: input.relayUrl,
    label: input.registration.label ?? input.previous?.label ?? null,
    hostId: input.registration.hostId,
    hostKey: input.registration.hostKey,
    hostKeyVersion: input.registration.hostKeyVersion,
    hostToken: input.registration.hostToken,
    publicUrl: input.registration.publicUrl,
    connector: input.registration.connector,
    heartbeatIntervalMs: normalizeHeartbeatInterval(input.registration.heartbeatIntervalMs),
    ...(relayKey === undefined ? {} : { relayKey }),
    updatedAt: input.now,
  };
}
