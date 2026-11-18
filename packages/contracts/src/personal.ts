import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PersonalConnectorKind = Schema.Literals(["frp", "cloudflare-tunnel"]);
export type PersonalConnectorKind = typeof PersonalConnectorKind.Type;

export const PersonalConnectorMode = Schema.Literals(["named", "quick"]);
export type PersonalConnectorMode = typeof PersonalConnectorMode.Type;

/** The frp settings a VPS relay returns inside its legacy registration response. */
export const PersonalFrpSettings = Schema.Struct({
  serverAddr: TrimmedNonEmptyString,
  serverPort: Schema.Number,
  authToken: TrimmedNonEmptyString,
  domain: TrimmedNonEmptyString,
});
export type PersonalFrpSettings = typeof PersonalFrpSettings.Type;

export const PersonalFrpConnector = Schema.Struct({
  kind: Schema.Literal("frp"),
  serverAddr: TrimmedNonEmptyString,
  serverPort: Schema.Number,
  authToken: TrimmedNonEmptyString,
  domain: TrimmedNonEmptyString,
});
export type PersonalFrpConnector = typeof PersonalFrpConnector.Type;

export const PersonalCloudflareNamedConnector = Schema.Struct({
  kind: Schema.Literal("cloudflare-tunnel"),
  mode: Schema.Literal("named"),
  tunnelToken: TrimmedNonEmptyString,
  hostname: TrimmedNonEmptyString,
});
export type PersonalCloudflareNamedConnector = typeof PersonalCloudflareNamedConnector.Type;

export const PersonalCloudflareQuickConnector = Schema.Struct({
  kind: Schema.Literal("cloudflare-tunnel"),
  mode: Schema.Literal("quick"),
});
export type PersonalCloudflareQuickConnector = typeof PersonalCloudflareQuickConnector.Type;

/**
 * The connector a relay assigns to a host. `frp` keeps the VPS relay working;
 * `cloudflare-tunnel` named runs a remotely-managed tunnel and quick reports a
 * temporary `trycloudflare.com` URL through heartbeats.
 */
export const PersonalConnector = Schema.Union([
  PersonalFrpConnector,
  PersonalCloudflareNamedConnector,
  PersonalCloudflareQuickConnector,
]);
export type PersonalConnector = typeof PersonalConnector.Type;

export const PersonalHostRegistration = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  hostKey: TrimmedNonEmptyString,
  hostKeyVersion: Schema.Number,
  hostToken: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  /** Empty in quick mode until the host reports its tunnel URL. */
  publicUrl: Schema.String,
  connector: PersonalConnector,
  heartbeatIntervalMs: Schema.Number,
});
export type PersonalHostRegistration = typeof PersonalHostRegistration.Type;

/** The VPS relay's registration response, normalized to a connector by the host. */
export const PersonalLegacyHostRegistration = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  hostKey: TrimmedNonEmptyString,
  hostKeyVersion: Schema.Number,
  hostToken: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  publicUrl: Schema.String,
  frp: PersonalFrpSettings,
  heartbeatIntervalMs: Schema.Number,
});
export type PersonalLegacyHostRegistration = typeof PersonalLegacyHostRegistration.Type;

export const PersonalHostRegistrationResponse = Schema.Union([
  PersonalHostRegistration,
  PersonalLegacyHostRegistration,
]);
export type PersonalHostRegistrationResponse = typeof PersonalHostRegistrationResponse.Type;

export const PersonalHeartbeatInput = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  hostKeyVersion: Schema.Number,
  /** Quick mode reports the current `trycloudflare.com` URL; named mode omits it. */
  publicUrl: Schema.optionalKey(Schema.String),
});
export type PersonalHeartbeatInput = typeof PersonalHeartbeatInput.Type;

export const PersonalHeartbeatResult = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  hostKey: Schema.optionalKey(TrimmedNonEmptyString),
  hostKeyVersion: Schema.optionalKey(Schema.Number),
  revokedSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  heartbeatIntervalMs: Schema.optionalKey(Schema.Number),
});
export type PersonalHeartbeatResult = typeof PersonalHeartbeatResult.Type;

/**
 * What a host knows about its personal-network connector. The host key never
 * appears here; revealing it is a separate, explicit call. The enrollment key
 * is never returned either.
 */
export const PersonalRelayState = Schema.Struct({
  /** Sharing is configured and wanted. */
  enabled: Schema.Boolean,
  /** Temporarily hidden from guests; the host key stays valid. */
  paused: Schema.Boolean,
  relayUrl: Schema.NullOr(TrimmedNonEmptyString),
  hostId: Schema.NullOr(TrimmedNonEmptyString),
  publicUrl: Schema.NullOr(Schema.String),
  label: Schema.NullOr(TrimmedNonEmptyString),
  /** Registered, online, and (unless paused) the connector child is running. */
  online: Schema.Boolean,
  connectorKind: Schema.NullOr(PersonalConnectorKind),
  connectorMode: Schema.NullOr(PersonalConnectorMode),
  connectorRunning: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type PersonalRelayState = typeof PersonalRelayState.Type;

export const PersonalShareInput = Schema.Struct({
  relayUrl: Schema.String,
  /** Cloudflare relays require this at registration; omit to reuse the stored one. */
  relayKey: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
});
export type PersonalShareInput = typeof PersonalShareInput.Type;

export const PersonalHostKeyResult = Schema.Struct({
  hostKey: TrimmedNonEmptyString,
});
export type PersonalHostKeyResult = typeof PersonalHostKeyResult.Type;

/** The relay's answer to a guest that resolved a host key. */
export const PersonalResolvedHost = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  /** Empty while a quick-mode host has not reported its tunnel URL. */
  publicUrl: Schema.String,
  online: Schema.Boolean,
  paused: Schema.Boolean,
});
export type PersonalResolvedHost = typeof PersonalResolvedHost.Type;

export const PersonalResolveHostInput = Schema.Struct({
  relayUrl: Schema.String,
  hostKey: Schema.String,
});
export type PersonalResolveHostInput = typeof PersonalResolveHostInput.Type;

/** One guest session as the relay lists it for the admin console. */
export const PersonalGuestClient = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  clientLabel: Schema.NullOr(Schema.String),
  platform: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
});
export type PersonalGuestClient = typeof PersonalGuestClient.Type;

export const PersonalAdminHost = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  platform: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  paused: Schema.Boolean,
  lastSeenAt: Schema.String,
  publicUrl: Schema.String,
  /** Revealed because the admin key is the relay's root credential. */
  hostKey: TrimmedNonEmptyString,
  clientsCount: Schema.Number,
  createdAt: Schema.String,
  /** Set while a host is removed; restore clears it and lets the environment register again. */
  revokedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type PersonalAdminHost = typeof PersonalAdminHost.Type;

export const PersonalAdminHosts = Schema.Struct({
  hosts: Schema.Array(PersonalAdminHost),
});
export type PersonalAdminHosts = typeof PersonalAdminHosts.Type;

export const PersonalAdminHostDetail = Schema.Struct({
  host: PersonalAdminHost,
  clients: Schema.Array(PersonalGuestClient),
});
export type PersonalAdminHostDetail = typeof PersonalAdminHostDetail.Type;

/** What the renderer tells the desktop shell for its tray menu and close behavior. */
export const DesktopPersonalShareState = Schema.Struct({
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  online: Schema.Boolean,
});
export type DesktopPersonalShareState = typeof DesktopPersonalShareState.Type;

/** A relay this host remembers. The enrollment key and host key never appear here. */
export const PersonalRelayProfileSummary = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  hasRelayKey: Schema.Boolean,
  hostId: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.String,
});
export type PersonalRelayProfileSummary = typeof PersonalRelayProfileSummary.Type;

export const PersonalRelayProfiles = Schema.Struct({
  relays: Schema.Array(PersonalRelayProfileSummary),
});
export type PersonalRelayProfiles = typeof PersonalRelayProfiles.Type;

export const PersonalSaveRelayInput = Schema.Struct({
  relayUrl: Schema.String,
  /** Omit or leave empty to keep the saved enrollment key. */
  relayKey: Schema.optionalKey(Schema.String),
});
export type PersonalSaveRelayInput = typeof PersonalSaveRelayInput.Type;

export const PersonalForgetRelayInput = Schema.Struct({
  relayUrl: Schema.String,
});
export type PersonalForgetRelayInput = typeof PersonalForgetRelayInput.Type;

/**
 * One relay route a paired guest may add for this host. The host key is the
 * guest credential, so this only travels over an already authenticated session.
 */
export const PersonalGuestRoute = Schema.Struct({
  relayUrl: TrimmedNonEmptyString,
  hostKey: TrimmedNonEmptyString,
  hostId: TrimmedNonEmptyString,
  publicUrl: Schema.String,
});
export type PersonalGuestRoute = typeof PersonalGuestRoute.Type;

export const PersonalGuestRoutes = Schema.Struct({
  routes: Schema.Array(PersonalGuestRoute),
});
export type PersonalGuestRoutes = typeof PersonalGuestRoutes.Type;

export const PERSONAL_WS_METHODS = {
  relayStatus: "personal.relayStatus",
  startSharing: "personal.startSharing",
  stopSharing: "personal.stopSharing",
  pauseSharing: "personal.pauseSharing",
  resumeSharing: "personal.resumeSharing",
  rotateSharingKey: "personal.rotateSharingKey",
  revealSharingKey: "personal.revealSharingKey",
  resolveHostKey: "personal.resolveHostKey",
  listRelays: "personal.listRelays",
  saveRelay: "personal.saveRelay",
  forgetRelay: "personal.forgetRelay",
  guestRoutes: "personal.guestRoutes",
} as const;

export class PersonalNetworkError extends Schema.TaggedError<PersonalNetworkError>()(
  "PersonalNetworkError",
  {
    operation: Schema.Literals([
      "start",
      "stop",
      "pause",
      "resume",
      "rotate",
      "reveal",
      "resolve",
      "status",
      "relay",
    ]),
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
