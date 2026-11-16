import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What the host knows about its personal relay connector. */
export const PersonalRelayState = Schema.Struct({
  enabled: Schema.Boolean,
  relayUrl: Schema.NullOr(TrimmedNonEmptyString),
  hostId: Schema.NullOr(TrimmedNonEmptyString),
  publicUrl: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.NullOr(TrimmedNonEmptyString),
  /** Registered, heartbeating, and the frpc child is running. */
  online: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
});
export type PersonalRelayState = typeof PersonalRelayState.Type;

export const PERSONAL_WS_METHODS = {
  relayStatus: "personal.relayStatus",
} as const;

/** One host as the registry lists it for the portal. */
export const PersonalRegistryHost = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  publicUrl: Schema.String,
  online: Schema.Boolean,
  lastSeenAt: Schema.String,
});
export type PersonalRegistryHost = typeof PersonalRegistryHost.Type;

export const PersonalRegistryHosts = Schema.Struct({
  hosts: Schema.Array(PersonalRegistryHost),
});
export type PersonalRegistryHosts = typeof PersonalRegistryHosts.Type;
