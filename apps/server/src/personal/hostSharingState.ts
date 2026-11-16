import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Owner-only state file: the host key is a guest credential and never leaves the machine. */
const PERSONAL_HOST_FILE = "personal-host.json";

export const PersonalHostFile = Schema.Struct({
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  relayUrl: Schema.String,
  label: Schema.NullOr(Schema.String),
  hostId: Schema.String,
  hostKey: Schema.String,
  hostKeyVersion: Schema.Number,
  hostToken: Schema.String,
  publicUrl: Schema.String,
  frp: Schema.Struct({
    serverAddr: Schema.String,
    serverPort: Schema.Number,
    authToken: Schema.String,
    domain: Schema.String,
  }),
  updatedAt: Schema.String,
});
export type PersonalHostFile = typeof PersonalHostFile.Type;

const encode = Schema.encodeSync(Schema.fromJsonString(PersonalHostFile));
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalHostFile));

const PRIVATE_FILE = { mode: 0o600 } as const;

function personalHostPath(stateDir: string, path: Path.Path): string {
  return path.join(stateDir, "personal", PERSONAL_HOST_FILE);
}

export const readPersonalHostFile = Effect.fn("PersonalHostFile.read")(function* (input: {
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = personalHostPath(input.stateDir, path);
  const raw = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(raw)) return Option.none<PersonalHostFile>();
  return decode(raw.value);
});

export const writePersonalHostFile = Effect.fn("PersonalHostFile.write")(function* (input: {
  readonly stateDir: string;
  readonly state: PersonalHostFile;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = personalHostPath(input.stateDir, path);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encode(input.state)}\n`, PRIVATE_FILE);
});

export const clearPersonalHostFile = Effect.fn("PersonalHostFile.clear")(function* (input: {
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(personalHostPath(input.stateDir, path)).pipe(Effect.ignore);
});
