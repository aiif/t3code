import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Owner-only relay memory: enrollment and host keys never leave the host. */
const PERSONAL_RELAYS_FILE = "relays.json";
export const MAX_RELAY_PROFILES = 20;

export const PersonalRelayProfile = Schema.Struct({
  relayUrl: Schema.String,
  relayKey: Schema.optionalKey(Schema.String),
  hostId: Schema.optionalKey(Schema.String),
  hostKey: Schema.optionalKey(Schema.String),
  publicUrl: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String,
});
export type PersonalRelayProfile = typeof PersonalRelayProfile.Type;

export const PersonalRelayProfilesFile = Schema.Struct({
  relays: Schema.Array(PersonalRelayProfile),
});
export type PersonalRelayProfilesFile = typeof PersonalRelayProfilesFile.Type;

const decodeProfiles = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalRelayProfilesFile));
const encodeProfiles = Schema.encodeSync(Schema.fromJsonString(PersonalRelayProfilesFile));
const PRIVATE_FILE = { mode: 0o600 } as const;

function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

export function findRelayProfile(
  profiles: ReadonlyArray<PersonalRelayProfile>,
  relayUrl: string,
): PersonalRelayProfile | null {
  const normalized = normalizeRelayUrl(relayUrl);
  return profiles.find((profile) => profile.relayUrl === normalized) ?? null;
}

export function relayKeyFor(
  profiles: ReadonlyArray<PersonalRelayProfile>,
  relayUrl: string,
): string | undefined {
  return text(findRelayProfile(profiles, relayUrl)?.relayKey);
}

export function upsertRelayProfile(
  profiles: ReadonlyArray<PersonalRelayProfile>,
  input: {
    readonly relayUrl: string;
    readonly relayKey?: string | undefined;
    readonly hostId?: string | undefined;
    readonly hostKey?: string | undefined;
    readonly publicUrl?: string | undefined;
    readonly now: string;
  },
): ReadonlyArray<PersonalRelayProfile> {
  const relayUrl = normalizeRelayUrl(input.relayUrl);
  if (relayUrl === "") return profiles;
  const existing = findRelayProfile(profiles, relayUrl);
  const relayKey = text(input.relayKey) ?? existing?.relayKey;
  const hostId = text(input.hostId) ?? existing?.hostId;
  const hostKey = text(input.hostKey) ?? existing?.hostKey;
  const publicUrl =
    input.publicUrl === undefined
      ? existing?.publicUrl
      : (text(input.publicUrl) ?? existing?.publicUrl);
  const next: PersonalRelayProfile = {
    relayUrl,
    updatedAt: input.now,
    ...(relayKey === undefined ? {} : { relayKey }),
    ...(hostId === undefined ? {} : { hostId }),
    ...(hostKey === undefined ? {} : { hostKey }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
  return [next, ...profiles.filter((profile) => profile.relayUrl !== relayUrl)].slice(
    0,
    MAX_RELAY_PROFILES,
  );
}

export function removeRelayProfile(
  profiles: ReadonlyArray<PersonalRelayProfile>,
  relayUrl: string,
): ReadonlyArray<PersonalRelayProfile> {
  const normalized = normalizeRelayUrl(relayUrl);
  return profiles.filter((profile) => profile.relayUrl !== normalized);
}

/** Keep the relay and its enrollment key, but drop a registration the relay invalidated. */
export function clearRelayRegistration(
  profiles: ReadonlyArray<PersonalRelayProfile>,
  relayUrl: string,
  now: string,
): ReadonlyArray<PersonalRelayProfile> {
  const normalized = normalizeRelayUrl(relayUrl);
  return profiles.map((profile) => {
    if (profile.relayUrl !== normalized) return profile;
    const relayKey = text(profile.relayKey);
    return {
      relayUrl: profile.relayUrl,
      updatedAt: now,
      ...(relayKey === undefined ? {} : { relayKey }),
    };
  });
}

export function relayProfileSummaries(profiles: ReadonlyArray<PersonalRelayProfile>) {
  return profiles.map((profile) => ({
    relayUrl: profile.relayUrl,
    hasRelayKey: text(profile.relayKey) !== undefined,
    hostId: text(profile.hostId) ?? null,
    updatedAt: profile.updatedAt,
  }));
}

function relayProfilesPath(stateDir: string, path: Path.Path): string {
  return path.join(stateDir, "personal", PERSONAL_RELAYS_FILE);
}

export const readRelayProfiles = Effect.fn("PersonalRelayProfiles.read")(function* (input: {
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs.readFileString(relayProfilesPath(input.stateDir, path)).pipe(Effect.option);
  if (Option.isNone(raw)) return [] as ReadonlyArray<PersonalRelayProfile>;
  return Option.match(decodeProfiles(raw.value), {
    onNone: () => [] as ReadonlyArray<PersonalRelayProfile>,
    onSome: (file) => file.relays,
  });
});

export const writeRelayProfiles = Effect.fn("PersonalRelayProfiles.write")(function* (input: {
  readonly stateDir: string;
  readonly profiles: ReadonlyArray<PersonalRelayProfile>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = relayProfilesPath(input.stateDir, path);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encodeProfiles({ relays: input.profiles })}\n`, PRIVATE_FILE);
});
