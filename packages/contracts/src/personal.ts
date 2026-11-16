import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * What a host knows about its personal-network connector. The host key never
 * appears here; revealing it is a separate, explicit call.
 */
export const PersonalRelayState = Schema.Struct({
  /** Sharing is configured and wanted. */
  enabled: Schema.Boolean,
  /** Temporarily hidden from guests; the host key stays valid. */
  paused: Schema.Boolean,
  relayUrl: Schema.NullOr(TrimmedNonEmptyString),
  hostId: Schema.NullOr(TrimmedNonEmptyString),
  publicUrl: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.NullOr(TrimmedNonEmptyString),
  /** Registered, online, and (unless paused) the frpc child is running. */
  online: Schema.Boolean,
  frpcRunning: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type PersonalRelayState = typeof PersonalRelayState.Type;

export const PersonalShareInput = Schema.Struct({
  relayUrl: Schema.String,
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
  publicUrl: TrimmedNonEmptyString,
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

export const PERSONAL_WS_METHODS = {
  relayStatus: "personal.relayStatus",
  startSharing: "personal.startSharing",
  stopSharing: "personal.stopSharing",
  pauseSharing: "personal.pauseSharing",
  resumeSharing: "personal.resumeSharing",
  rotateSharingKey: "personal.rotateSharingKey",
  revealSharingKey: "personal.revealSharingKey",
  resolveHostKey: "personal.resolveHostKey",
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
    ]),
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
