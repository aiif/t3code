import type { PersonalRelayState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { personalKeyValue } from "../auth/personalKey.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export const PERSONAL_RELAY_STATUS_FILE = "personal-relay.json";

/** The status file adds when it was written, so the CLI can show staleness. */
export const PersonalRelayStatusFile = Schema.Struct({
  enabled: Schema.Boolean,
  relayUrl: Schema.NullOr(Schema.String),
  hostId: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PersonalRelayStatusFile = typeof PersonalRelayStatusFile.Type;

const encodeStatusFile = Schema.encodeSync(Schema.fromJsonString(PersonalRelayStatusFile));
const RESTART_DELAY = "10 seconds";
const REQUEST_TIMEOUT = "15 seconds";
/** frpc.toml and the status file hold the relay token, so keep them owner-only. */
const PRIVATE_FILE = { mode: 0o600 } as const;

export const FrpRegistration = Schema.Struct({
  hostId: Schema.String,
  hostToken: Schema.String,
  environmentId: Schema.String,
  label: Schema.NullOr(Schema.String),
  publicUrl: Schema.String,
  frp: Schema.Struct({
    serverAddr: Schema.String,
    serverPort: Schema.Number,
    authToken: Schema.String,
    domain: Schema.String,
  }),
  heartbeatIntervalMs: Schema.Number,
});
export type FrpRegistration = typeof FrpRegistration.Type;

export class PersonalRelayRequestError extends Schema.TaggedError<PersonalRelayRequestError>()(
  "PersonalRelayRequestError",
  {
    operation: Schema.Literals(["register", "heartbeat", "unregister", "notify"]),
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return `Personal relay ${this.operation} failed: ${this.detail}`;
  }
}

export class FrpcSpawnError extends Schema.TaggedError<FrpcSpawnError>()("FrpcSpawnError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `frpc could not start: ${this.detail}`;
  }
}

/** The frpc child, separated so supervision tests do not need a real binary. */
export interface FrpcHandle {
  readonly exited: Effect.Effect<void>;
  readonly lastError: Effect.Effect<string>;
}

class FrpcProcess extends Context.Service<
  FrpcProcess,
  {
    readonly spawn: (input: {
      readonly frpcPath: string;
      readonly configPath: string;
    }) => Effect.Effect<FrpcHandle, FrpcSpawnError, Scope.Scope>;
  }
>()("t3/personal/PersonalRelay/FrpcProcess") {}

export type PersonalNotificationPhase =
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed";

export interface PersonalNotifyInput {
  readonly hostId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly phase: PersonalNotificationPhase;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly hostLabel: string | null;
}

export class PersonalRelayClient extends Context.Service<
  PersonalRelayClient,
  {
    readonly register: (input: {
      readonly environmentId: string;
      readonly label: string | null;
    }) => Effect.Effect<FrpRegistration, PersonalRelayRequestError>;
    readonly heartbeat: (input: {
      readonly hostToken: string;
      readonly label: string | null;
    }) => Effect.Effect<void, PersonalRelayRequestError>;
    readonly unregister: (input: {
      readonly hostToken: string;
    }) => Effect.Effect<void, PersonalRelayRequestError>;
    readonly notify: (input: PersonalNotifyInput) => Effect.Effect<void, PersonalRelayRequestError>;
  }
>()("t3/personal/PersonalRelay/PersonalRelayClient") {}

export class PersonalRelay extends Context.Service<
  PersonalRelay,
  {
    readonly getStatus: () => Effect.Effect<PersonalRelayState>;
  }
>()("t3/personal/PersonalRelay") {}

/** frpc.toml for one registration. Values come from the registry, not the user. */
export function renderFrpcConfig(input: {
  readonly serverAddr: string;
  readonly serverPort: number;
  readonly authToken: string;
  readonly domain: string;
  readonly localPort: number;
}): string {
  return `# Generated by T3 Code personal mode. Changes are overwritten.
serverAddr = "${input.serverAddr}"
serverPort = ${input.serverPort}
loginFailExit = false

auth.method = "token"
auth.token = "${input.authToken}"

[[proxies]]
name = "t3-${input.domain.split(".")[0] ?? "host"}"
type = "http"
localIP = "127.0.0.1"
localPort = ${input.localPort}
customDomains = ["${input.domain}"]
`;
}

function disabledState(config: {
  readonly personalRelayUrl?: string | undefined;
  readonly personalLabel?: string | undefined;
}): PersonalRelayState {
  return {
    enabled: false,
    relayUrl: config.personalRelayUrl?.trim().replace(/\/+$/u, "") || null,
    hostId: null,
    publicUrl: null,
    label: config.personalLabel?.trim() || null,
    online: false,
    lastError: null,
  };
}

const requestError = (
  operation: "register" | "heartbeat" | "unregister" | "notify",
  cause: unknown,
) =>
  new PersonalRelayRequestError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });

export const layerClient = (input: {
  readonly relayUrl: string;
  readonly personalKey: string;
}): Layer.Layer<PersonalRelayClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    PersonalRelayClient,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const baseUrl = input.relayUrl.replace(/\/+$/u, "");

      const execute = (
        operation: "register" | "heartbeat" | "unregister" | "notify",
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, PersonalRelayRequestError> =>
        httpClient.execute(request).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) => requestError(operation, cause)),
          Effect.filterOrFail(
            (response) => response.status < 400,
            (response) =>
              new PersonalRelayRequestError({
                operation,
                detail: `Relay answered ${response.status}.`,
                status: response.status,
              }),
          ),
        );

      return PersonalRelayClient.of({
        register: Effect.fn("PersonalRelayClient.register")(function* (registration) {
          const response = yield* execute(
            "register",
            HttpClientRequest.post(`${baseUrl}/v1/hosts/register`).pipe(
              HttpClientRequest.bearerToken(input.personalKey),
              HttpClientRequest.bodyJsonUnsafe({
                environmentId: registration.environmentId,
                label: registration.label,
              }),
            ),
          );
          const decoded = yield* HttpClientResponse.schemaBodyJson(FrpRegistration)(response).pipe(
            Effect.option,
          );
          if (Option.isNone(decoded)) {
            return yield* new PersonalRelayRequestError({
              operation: "register",
              detail: "Relay returned an unexpected registration response.",
            });
          }
          return decoded.value;
        }),
        heartbeat: Effect.fn("PersonalRelayClient.heartbeat")(function* ({ hostToken, label }) {
          yield* execute(
            "heartbeat",
            HttpClientRequest.post(`${baseUrl}/v1/hosts/heartbeat`).pipe(
              HttpClientRequest.bearerToken(hostToken),
              HttpClientRequest.bodyJsonUnsafe({ label }),
            ),
          );
        }),
        unregister: Effect.fn("PersonalRelayClient.unregister")(function* ({ hostToken }) {
          yield* execute(
            "unregister",
            HttpClientRequest.post(`${baseUrl}/v1/hosts/unregister`).pipe(
              HttpClientRequest.bearerToken(hostToken),
            ),
          );
        }),
        notify: Effect.fn("PersonalRelayClient.notify")(function* (notification) {
          yield* execute(
            "notify",
            HttpClientRequest.post(`${baseUrl}/v1/notify`).pipe(
              HttpClientRequest.bearerToken(input.personalKey),
              HttpClientRequest.bodyJsonUnsafe({
                hostId: notification.hostId,
                environmentId: notification.environmentId,
                threadId: notification.threadId,
                phase: notification.phase,
                projectTitle: notification.projectTitle,
                threadTitle: notification.threadTitle,
                hostLabel: notification.hostLabel,
              }),
            ),
          );
        }),
      });
    }),
  );

/** The real frpc child. The caller's scope owns it, so shutdown kills only this PID. */
const layerFrpcProcess: Layer.Layer<FrpcProcess, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    FrpcProcess,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return FrpcProcess.of({
        spawn: Effect.fn("FrpcProcess.spawn")(function* ({ frpcPath, configPath }) {
          const child = yield* spawner
            .spawn(
              ChildProcess.make(frpcPath, ["-c", configPath], {
                detached: false,
                shell: false,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "pipe",
              }),
            )
            .pipe(Effect.mapError((cause) => new FrpcSpawnError({ detail: String(cause) })));
          yield* Effect.addFinalizer(() =>
            child
              .kill()
              .pipe(
                Effect.ignore,
                Effect.andThen(Effect.logInfo("Stopped frpc for personal mode.")),
              ),
          );
          const tail = yield* Ref.make("");
          yield* child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (_, chunk) => chunk.slice(-500),
            ),
            Effect.flatMap((last) => Ref.set(tail, last)),
            Effect.ignore,
            Effect.forkScoped,
          );
          return {
            exited: child.exitCode.pipe(Effect.ignore),
            lastError: Ref.get(tail),
          } satisfies FrpcHandle;
        }),
      });
    }),
  );

export interface PersonalRelaySupervisorDeps {
  readonly label: string | null;
  readonly register: () => Effect.Effect<FrpRegistration, PersonalRelayRequestError>;
  readonly heartbeat: (input: {
    readonly hostToken: string;
    readonly label: string | null;
  }) => Effect.Effect<void, PersonalRelayRequestError>;
  readonly writeConfig: (
    registration: FrpRegistration,
  ) => Effect.Effect<void, PersonalRelayRequestError>;
  readonly spawnFrpc: (
    registration: FrpRegistration,
  ) => Effect.Effect<FrpcHandle, FrpcSpawnError, Scope.Scope>;
  readonly updateStatus: (
    update: (current: PersonalRelayState) => PersonalRelayState,
  ) => Effect.Effect<void>;
}

/**
 * Registers, writes frpc.toml, runs frpc, and heartbeats until the scope closes.
 * Every failure restarts registration after a delay instead of failing the host.
 */
export const superviseRelay = Effect.fn("PersonalRelay.supervise")(function* (
  deps: PersonalRelaySupervisorDeps,
) {
  const heartbeatLoop = Effect.fn("PersonalRelay.heartbeatLoop")(function* (
    registration: FrpRegistration,
  ) {
    return yield* Effect.forever(
      Effect.sleep(`${registration.heartbeatIntervalMs} millis`).pipe(
        Effect.andThen(
          deps.heartbeat({ hostToken: registration.hostToken, label: deps.label }).pipe(
            Effect.tapError((error) =>
              // A 401 means the registry no longer knows this host token: register again.
              error.status === 401
                ? Effect.fail(error)
                : deps.updateStatus((current) => ({ ...current, lastError: error.message })),
            ),
          ),
        ),
      ),
    );
  });

  const attempt = Effect.gen(function* () {
    const registration = yield* deps.register();
    yield* deps.writeConfig(registration);
    yield* deps.updateStatus((current) => ({
      ...current,
      hostId: registration.hostId,
      publicUrl: registration.publicUrl,
      label: registration.label ?? current.label,
      online: true,
      lastError: null,
    }));
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* deps.spawnFrpc(registration);
        return yield* Effect.raceFirst(
          heartbeatLoop(registration),
          handle.exited.pipe(
            Effect.andThen(handle.lastError),
            Effect.flatMap((lastError) =>
              Effect.fail(
                new FrpcSpawnError({
                  detail:
                    lastError.length > 0
                      ? `frpc exited: ${lastError}`
                      : "frpc exited unexpectedly.",
                }),
              ),
            ),
          ),
        );
      }),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      deps.updateStatus((current) => ({
        ...current,
        online: false,
        lastError: String(cause).slice(0, 500),
      })),
    ),
    Effect.andThen(Effect.sleep(RESTART_DELAY)),
  );

  return yield* Effect.forever(attempt);
});

const makeEnabled = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* PersonalRelayClient;
  const processes = yield* FrpcProcess;
  const relayUrl = (config.personalRelayUrl ?? "").trim().replace(/\/+$/u, "");
  const label = config.personalLabel?.trim() || null;
  const personalDirectory = path.join(config.stateDir, "personal");
  const configPath = path.join(personalDirectory, "frpc.toml");
  const statusPath = path.join(config.stateDir, PERSONAL_RELAY_STATUS_FILE);
  const frpcPath = config.personalFrpcPath?.trim() || "frpc";
  const statusRef = yield* Ref.make<PersonalRelayState>({
    enabled: true,
    relayUrl,
    hostId: null,
    publicUrl: null,
    label,
    online: false,
    lastError: null,
  });
  const writeStatusFile = Effect.fn("PersonalRelay.writeStatusFile")(function* (
    status: PersonalRelayState,
  ) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* fs
      .writeFileString(statusPath, `${encodeStatusFile({ ...status, updatedAt })}\n`, PRIVATE_FILE)
      .pipe(Effect.ignore);
  });
  const updateStatus = (update: (current: PersonalRelayState) => PersonalRelayState) =>
    Ref.modify(statusRef, (current) => {
      const next = update(current);
      return [next, next] as const;
    }).pipe(Effect.flatMap(writeStatusFile), Effect.asVoid);
  const environmentId = yield* environment.getEnvironmentId;
  const writeConfig = Effect.fn("PersonalRelay.writeConfig")(
    function* (registration: FrpRegistration) {
      yield* fs.makeDirectory(personalDirectory, { recursive: true });
      yield* fs.writeFileString(
        configPath,
        renderFrpcConfig({
          serverAddr: registration.frp.serverAddr,
          serverPort: registration.frp.serverPort,
          authToken: registration.frp.authToken,
          domain: registration.frp.domain,
          localPort: config.port,
        }),
        PRIVATE_FILE,
      );
    },
    Effect.mapError(
      (cause) => new PersonalRelayRequestError({ operation: "register", detail: String(cause) }),
    ),
  );
  yield* Effect.forkScoped(
    superviseRelay({
      label,
      register: () => client.register({ environmentId, label }),
      heartbeat: (input) => client.heartbeat(input),
      writeConfig,
      spawnFrpc: () => processes.spawn({ frpcPath, configPath }),
      updateStatus,
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Personal relay stopped.", { cause }))),
  );

  return PersonalRelay.of({
    getStatus: Effect.fn("PersonalRelay.getStatus")(() => Ref.get(statusRef)),
  });
});

/**
 * Personal mode is opt-in and never fails server startup: without a key or a
 * relay URL the service reports disabled and does nothing.
 */
export const layer: Layer.Layer<
  PersonalRelay,
  never,
  | ServerConfig.ServerConfig
  | ServerEnvironment.ServerEnvironmentIdentity
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const relayUrl = config.personalRelayUrl?.trim().replace(/\/+$/u, "");
    const personalKey = personalKeyValue(config);
    if (config.personalEnabled !== true || !relayUrl || personalKey === undefined) {
      return Layer.succeed(PersonalRelay, {
        getStatus: Effect.fn("PersonalRelay.getStatus")(() =>
          Effect.succeed(disabledState(config)),
        ),
      });
    }
    return Layer.effect(
      PersonalRelay,
      makeEnabled.pipe(
        Effect.provide(Layer.merge(layerClient({ relayUrl, personalKey }), layerFrpcProcess)),
      ),
    );
  }),
);
