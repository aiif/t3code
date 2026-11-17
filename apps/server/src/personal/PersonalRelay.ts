import {
  AuthSessionId,
  type PersonalRelayState,
  type PersonalResolvedHost,
  PersonalNetworkError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SessionStore from "../auth/SessionStore.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import {
  clearPersonalHostFile,
  type PersonalHostFile,
  readPersonalHostFile,
  writePersonalHostFile,
} from "./hostSharingState.ts";
export const PERSONAL_RELAY_STATUS_FILE = "personal-relay.json";

/** The status file adds when it was written, so the CLI can show staleness. */
export const PersonalRelayStatusFile = Schema.Struct({
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  relayUrl: Schema.NullOr(Schema.String),
  hostId: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  frpcRunning: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PersonalRelayStatusFile = typeof PersonalRelayStatusFile.Type;

const encodeStatusFile = Schema.encodeSync(Schema.fromJsonString(PersonalRelayStatusFile));
const RESTART_DELAY = "10 seconds";
const REQUEST_TIMEOUT = "15 seconds";
const PRIVATE_FILE = { mode: 0o600 } as const;

export const FrpRegistration = Schema.Struct({
  hostId: Schema.String,
  hostKey: Schema.String,
  hostKeyVersion: Schema.Number,
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

const HeartbeatResult = Schema.Struct({
  hostId: Schema.String,
  hostKey: Schema.optionalKey(Schema.String),
  hostKeyVersion: Schema.optionalKey(Schema.Number),
  revokedSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HeartbeatResult = typeof HeartbeatResult.Type;

const RotateResult = Schema.Struct({
  hostKey: Schema.String,
  hostKeyVersion: Schema.Number,
});
export type RotateResult = typeof RotateResult.Type;

const ResolvedHost = Schema.Struct({
  hostId: Schema.String,
  environmentId: Schema.String,
  label: Schema.NullOr(Schema.String),
  publicUrl: Schema.String,
  online: Schema.Boolean,
  paused: Schema.Boolean,
});
export type ResolvedHost = typeof ResolvedHost.Type;

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
  readonly environmentId: string;
  readonly threadId: string;
  readonly phase: PersonalNotificationPhase;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly hostLabel: string | null;
}

export interface GuestClientReport {
  readonly sessionId: string;
  readonly clientLabel: string | null;
  readonly platform: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

class PersonalRelayClient extends Context.Service<
  PersonalRelayClient,
  {
    readonly register: (input: {
      readonly relayUrl: string;
      readonly environmentId: string;
      readonly label: string | null;
      readonly platform: string | null;
    }) => Effect.Effect<FrpRegistration, PersonalNetworkError>;
    readonly heartbeat: (input: {
      readonly relayUrl: string;
      readonly hostToken: string;
      readonly hostKeyVersion: number;
      readonly label: string | null;
      readonly online: boolean;
    }) => Effect.Effect<HeartbeatResult, PersonalNetworkError>;
    readonly unregister: (input: {
      readonly relayUrl: string;
      readonly hostToken: string;
    }) => Effect.Effect<void, PersonalNetworkError>;
    readonly rotateKey: (input: {
      readonly relayUrl: string;
      readonly hostToken: string;
    }) => Effect.Effect<RotateResult, PersonalNetworkError>;
    readonly reportClients: (input: {
      readonly relayUrl: string;
      readonly hostToken: string;
      readonly clients: ReadonlyArray<GuestClientReport>;
    }) => Effect.Effect<void, PersonalNetworkError>;
    readonly resolveHost: (input: {
      readonly relayUrl: string;
      readonly hostKey: string;
    }) => Effect.Effect<ResolvedHost, PersonalNetworkError>;
    readonly notify: (input: {
      readonly relayUrl: string;
      readonly hostToken: string;
      readonly notification: PersonalNotifyInput & { readonly hostId: string };
    }) => Effect.Effect<void, PersonalNetworkError>;
  }
>()("t3/personal/PersonalRelay/PersonalRelayClient") {}

export class PersonalRelay extends Context.Service<
  PersonalRelay,
  {
    readonly getStatus: () => Effect.Effect<PersonalRelayState>;
    readonly startSharing: (input: {
      readonly relayUrl: string;
      readonly label?: string | undefined;
    }) => Effect.Effect<PersonalRelayState, PersonalNetworkError>;
    readonly stopSharing: () => Effect.Effect<PersonalRelayState, PersonalNetworkError>;
    readonly pauseSharing: () => Effect.Effect<PersonalRelayState, PersonalNetworkError>;
    readonly resumeSharing: () => Effect.Effect<PersonalRelayState, PersonalNetworkError>;
    readonly rotateKey: () => Effect.Effect<{ readonly hostKey: string }, PersonalNetworkError>;
    readonly revealKey: () => Effect.Effect<{ readonly hostKey: string }, PersonalNetworkError>;
    readonly resolveHost: (input: {
      readonly relayUrl: string;
      readonly hostKey: string;
    }) => Effect.Effect<PersonalResolvedHost, PersonalNetworkError>;
    readonly notify: (input: PersonalNotifyInput) => Effect.Effect<void>;
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

const requestError = (
  operation: PersonalNetworkError["operation"],
  cause: unknown,
): PersonalNetworkError =>
  new PersonalNetworkError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });

const baseUrlOf = (relayUrl: string) => relayUrl.trim().replace(/\/+$/u, "");

const layerClient = (): Layer.Layer<PersonalRelayClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    PersonalRelayClient,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;

      const execute = (
        operation: PersonalNetworkError["operation"],
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, PersonalNetworkError> =>
        httpClient.execute(request).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) => requestError(operation, cause)),
          Effect.filterOrFail(
            (response) => response.status < 400,
            (response) =>
              new PersonalNetworkError({
                operation,
                detail:
                  response.status === 401
                    ? "The relay rejected this host key."
                    : response.status === 410
                      ? "This host was removed from the relay."
                      : `The relay answered ${response.status}.`,
                status: response.status,
              }),
          ),
        );

      return PersonalRelayClient.of({
        register: Effect.fn("PersonalRelayClient.register")(function* (input) {
          const response = yield* execute(
            "start",
            HttpClientRequest.post(`${baseUrlOf(input.relayUrl)}/v1/hosts/register`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                environmentId: input.environmentId,
                label: input.label,
                platform: input.platform,
              }),
            ),
          );
          const decoded = yield* HttpClientResponse.schemaBodyJson(FrpRegistration)(response).pipe(
            Effect.option,
          );
          if (Option.isNone(decoded)) {
            return yield* new PersonalNetworkError({
              operation: "start",
              detail: "The relay returned an unexpected registration response.",
            });
          }
          return decoded.value;
        }),
        heartbeat: Effect.fn("PersonalRelayClient.heartbeat")(function* (input) {
          const response = yield* execute(
            "status",
            HttpClientRequest.post(`${baseUrlOf(input.relayUrl)}/v1/hosts/heartbeat`).pipe(
              HttpClientRequest.bearerToken(input.hostToken),
              HttpClientRequest.bodyJsonUnsafe({
                label: input.label,
                online: input.online,
                hostKeyVersion: input.hostKeyVersion,
              }),
            ),
          );
          const decoded = yield* HttpClientResponse.schemaBodyJson(HeartbeatResult)(response).pipe(
            Effect.option,
          );
          return Option.isSome(decoded) ? decoded.value : { hostId: "", revokedSessionIds: [] };
        }),
        unregister: Effect.fn("PersonalRelayClient.unregister")(function* (input) {
          yield* execute(
            "stop",
            HttpClientRequest.post(`${baseUrlOf(input.relayUrl)}/v1/hosts/unregister`).pipe(
              HttpClientRequest.bearerToken(input.hostToken),
            ),
          );
        }),
        rotateKey: Effect.fn("PersonalRelayClient.rotateKey")(function* (input) {
          const response = yield* execute(
            "rotate",
            HttpClientRequest.post(`${baseUrlOf(input.relayUrl)}/v1/hosts/rotate-key`).pipe(
              HttpClientRequest.bearerToken(input.hostToken),
            ),
          );
          const decoded = yield* HttpClientResponse.schemaBodyJson(RotateResult)(response).pipe(
            Effect.option,
          );
          if (Option.isNone(decoded)) {
            return yield* new PersonalNetworkError({
              operation: "rotate",
              detail: "The relay returned an unexpected rotation response.",
            });
          }
          return decoded.value;
        }),
        reportClients: Effect.fn("PersonalRelayClient.reportClients")(function* (input) {
          yield* execute(
            "status",
            HttpClientRequest.post(`${baseUrlOf(input.relayUrl)}/v1/hosts/clients`).pipe(
              HttpClientRequest.bearerToken(input.hostToken),
              HttpClientRequest.bodyJsonUnsafe({ clients: input.clients }),
            ),
          );
        }),
        resolveHost: Effect.fn("PersonalRelayClient.resolveHost")(function* (input) {
          const response = yield* execute(
            "resolve",
            HttpClientRequest.post(`${baseUrlOf(input.relayUrl)}/v1/hosts/resolve`).pipe(
              HttpClientRequest.bearerToken(input.hostKey.trim()),
            ),
          );
          const decoded = yield* HttpClientResponse.schemaBodyJson(ResolvedHost)(response).pipe(
            Effect.option,
          );
          if (Option.isNone(decoded)) {
            return yield* new PersonalNetworkError({
              operation: "resolve",
              detail: "The relay returned an unexpected resolve response.",
            });
          }
          return decoded.value;
        }),
        notify: Effect.fn("PersonalRelayClient.notify")(function* (input) {
          const { hostId, ...notification } = input.notification;
          yield* execute(
            "status",
            HttpClientRequest.post(`${baseUrlOf(input.relayUrl)}/v1/notify`).pipe(
              HttpClientRequest.bearerToken(input.hostToken),
              HttpClientRequest.bodyJsonUnsafe({
                hostId,
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

const disabledState = (config: {
  readonly personalRelayUrl?: string | undefined;
  readonly personalLabel?: string | undefined;
}): PersonalRelayState => ({
  enabled: false,
  paused: false,
  relayUrl: config.personalRelayUrl?.trim().replace(/\/+$/u, "") || null,
  hostId: null,
  publicUrl: null,
  label: config.personalLabel?.trim() || null,
  online: false,
  frpcRunning: false,
  lastError: null,
  updatedAt: null,
});

const toStatus = (host: PersonalHostFile | null): PersonalRelayState =>
  host === null
    ? {
        enabled: false,
        paused: false,
        relayUrl: null,
        hostId: null,
        publicUrl: null,
        label: null,
        online: false,
        frpcRunning: false,
        lastError: null,
        updatedAt: null,
      }
    : {
        enabled: host.enabled,
        paused: host.paused,
        relayUrl: host.relayUrl,
        hostId: host.hostId,
        publicUrl: host.publicUrl,
        label: host.label,
        online: false,
        frpcRunning: false,
        lastError: null,
        updatedAt: host.updatedAt,
      };

const makeEnabled = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* PersonalRelayClient;
  const processes = yield* FrpcProcess;
  const sessions = yield* SessionStore.SessionStore;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const scope = yield* Effect.scope;
  const environmentId = yield* environment.getEnvironmentId;
  const sandbox = yield* Semaphore.make(1);
  const personalDirectory = path.join(config.stateDir, "personal");
  const configPath = path.join(personalDirectory, "frpc.toml");
  const statusPath = path.join(config.stateDir, PERSONAL_RELAY_STATUS_FILE);
  const frpcPath = config.personalFrpcPath?.trim() || "frpc";

  const provideHostFileServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const readHost = readPersonalHostFile({ stateDir: config.stateDir }).pipe(
    provideHostFileServices,
    Effect.catchCause(() => Effect.succeed(Option.none<PersonalHostFile>())),
  );
  const persistPersonalHost = (state: PersonalHostFile) =>
    writePersonalHostFile({ stateDir: config.stateDir, state }).pipe(
      provideHostFileServices,
      Effect.mapError(
        (cause) => new PersonalNetworkError({ operation: "start", detail: String(cause) }),
      ),
    );
  const clearHost = clearPersonalHostFile({ stateDir: config.stateDir }).pipe(
    provideHostFileServices,
    Effect.ignore,
  );

  const loaded = yield* readHost;
  const initialHost = Option.getOrNull(loaded);
  const hostRef = yield* Ref.make<PersonalHostFile | null>(initialHost);
  const fiberRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
  const statusRef = yield* Ref.make<PersonalRelayState>(
    initialHost === null ? disabledState(config) : toStatus(initialHost),
  );

  const writeStatusFile = Effect.fn("PersonalRelay.writeStatusFile")(function* (
    status: PersonalRelayState,
  ) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* fs
      .writeFileString(
        statusPath,
        `${encodeStatusFile({
          enabled: status.enabled,
          paused: status.paused,
          relayUrl: status.relayUrl,
          hostId: status.hostId,
          publicUrl: status.publicUrl,
          label: status.label,
          online: status.online,
          frpcRunning: status.frpcRunning,
          lastError: status.lastError,
          updatedAt,
        })}\n`,
        PRIVATE_FILE,
      )
      .pipe(Effect.ignore);
  });

  const updateStatus = (update: (current: PersonalRelayState) => PersonalRelayState) =>
    Ref.modify(statusRef, (current) => {
      const next = update(current);
      return [next, next] as const;
    }).pipe(
      Effect.flatMap((status) => writeStatusFile(status)),
      Effect.asVoid,
    );

  const persistHost = Effect.fn("PersonalRelay.persistHost")(function* (
    host: PersonalHostFile | null,
  ) {
    yield* Ref.set(hostRef, host);
    if (host === null) {
      yield* clearHost;
    } else {
      yield* persistPersonalHost(host);
    }
    yield* updateStatus(() =>
      host === null
        ? disabledState(config)
        : {
            ...toStatus(host),
            online: false,
            frpcRunning: false,
            lastError: null,
          },
    );
  });

  const revokeGuestSessions = Effect.fn("PersonalRelay.revokeGuestSessions")(function* (
    hostId: string,
  ) {
    yield* sessions.revokeBySubject(`host-key:${hostId}`).pipe(Effect.ignore);
  });

  const applyHostKey = Effect.fn("PersonalRelay.applyHostKey")(function* (input: {
    readonly host: PersonalHostFile;
    readonly hostKey: string;
    readonly hostKeyVersion: number;
  }) {
    if (input.host.hostKey !== input.hostKey) {
      yield* grants.clearHostKeyGrant();
      yield* revokeGuestSessions(input.host.hostId);
    }
    const next: PersonalHostFile = {
      ...input.host,
      hostKey: input.hostKey,
      hostKeyVersion: input.hostKeyVersion,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* persistHost(next);
    yield* grants.setHostKeyGrant({ hostKey: input.hostKey, hostId: next.hostId });
    return next;
  });

  const applyRegistration = Effect.fn("PersonalRelay.applyRegistration")(function* (
    registration: FrpRegistration,
  ) {
    const previous = yield* Ref.get(hostRef);
    const next: PersonalHostFile = {
      enabled: true,
      paused: previous?.paused ?? false,
      relayUrl: previous?.relayUrl ?? "",
      label: registration.label ?? previous?.label ?? null,
      hostId: registration.hostId,
      hostKey: registration.hostKey,
      hostKeyVersion: registration.hostKeyVersion,
      hostToken: registration.hostToken,
      publicUrl: registration.publicUrl,
      frp: registration.frp,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    if (previous !== null && previous.hostKey !== registration.hostKey) {
      yield* grants.clearHostKeyGrant();
      yield* revokeGuestSessions(previous.hostId);
    }
    if (previous !== null && previous.hostId !== registration.hostId) {
      yield* revokeGuestSessions(previous.hostId);
    }
    yield* Ref.set(hostRef, next);
    yield* persistPersonalHost(next);
    yield* grants.setHostKeyGrant({ hostKey: next.hostKey, hostId: next.hostId });
    yield* updateStatus((current) => ({
      ...current,
      enabled: true,
      paused: next.paused,
      relayUrl: next.relayUrl,
      hostId: next.hostId,
      publicUrl: next.publicUrl,
      label: next.label,
      lastError: null,
    }));
    return next;
  });

  const writeConfig = Effect.fn("PersonalRelay.writeConfig")(function* (host: PersonalHostFile) {
    yield* fs.makeDirectory(personalDirectory, { recursive: true });
    yield* fs.writeFileString(
      configPath,
      renderFrpcConfig({
        serverAddr: host.frp.serverAddr,
        serverPort: host.frp.serverPort,
        authToken: host.frp.authToken,
        domain: host.frp.domain,
        localPort: config.port,
      }),
      PRIVATE_FILE,
    );
  });

  const reportClients = Effect.fn("PersonalRelay.reportClients")(function* (
    host: PersonalHostFile,
  ) {
    const rows = yield* sessions.listActive().pipe(Effect.option);
    if (Option.isNone(rows)) return;
    const clients = rows.value
      .filter((session) => session.subject === `host-key:${host.hostId}`)
      .map((session) => ({
        sessionId: session.sessionId,
        clientLabel: session.client.label ?? null,
        platform: session.client.deviceType ?? null,
        firstSeenAt: DateTime.formatIso(session.issuedAt),
        lastSeenAt: DateTime.formatIso(session.lastConnectedAt ?? session.issuedAt),
      }));
    yield* client
      .reportClients({ relayUrl: host.relayUrl, hostToken: host.hostToken, clients })
      .pipe(Effect.ignore);
  });

  const heartbeatLoop = Effect.fn("PersonalRelay.heartbeatLoop")(function* () {
    const interval = 30_000;
    while (true) {
      yield* Effect.sleep(`${interval} millis`);
      const current = yield* Ref.get(hostRef);
      if (current === null || !current.enabled) return;
      const result = yield* client.heartbeat({
        relayUrl: current.relayUrl,
        hostToken: current.hostToken,
        hostKeyVersion: current.hostKeyVersion,
        label: current.label,
        online: !current.paused,
      });
      if (result.hostKey !== undefined && result.hostKeyVersion !== undefined) {
        yield* applyHostKey({
          host: current,
          hostKey: result.hostKey,
          hostKeyVersion: result.hostKeyVersion,
        });
      }
      if (result.revokedSessionIds !== undefined) {
        yield* Effect.forEach(result.revokedSessionIds, (sessionId) =>
          sessions.revoke(AuthSessionId.make(sessionId)).pipe(Effect.ignore),
        );
      }
      yield* reportClients(current);
    }
  });

  const connectorAttempt = Effect.fn("PersonalRelay.connectorAttempt")(function* () {
    const existing = yield* Ref.get(hostRef);
    if (existing === null || !existing.enabled) return;
    if (existing.paused) {
      yield* client.heartbeat({
        relayUrl: existing.relayUrl,
        hostToken: existing.hostToken,
        hostKeyVersion: existing.hostKeyVersion,
        label: existing.label,
        online: false,
      });
      yield* updateStatus((current) => ({
        ...current,
        online: false,
        paused: true,
        frpcRunning: false,
      }));
      yield* Effect.sleep("30 seconds");
      return;
    }
    const registration = yield* client.register({
      relayUrl: existing.relayUrl,
      environmentId,
      label: existing.label,
      platform: yield* HostProcess.Platform,
    });
    const host = yield* applyRegistration(registration);
    yield* writeConfig(host);
    yield* updateStatus((current) => ({
      ...current,
      enabled: true,
      paused: false,
      online: true,
      frpcRunning: false,
      lastError: null,
    }));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* processes.spawn({ frpcPath, configPath });
        yield* updateStatus((current) => ({ ...current, frpcRunning: true }));
        yield* Effect.raceFirst(
          heartbeatLoop(),
          handle.exited.pipe(
            Effect.andThen(handle.lastError),
            Effect.flatMap((lastError) =>
              Effect.fail(
                new PersonalNetworkError({
                  operation: "start",
                  detail:
                    lastError.length > 0
                      ? `frpc exited: ${lastError}`
                      : "frpc exited unexpectedly. Install frpc or set T3CODE_FRPC_PATH.",
                }),
              ),
            ),
          ),
        );
      }),
    );
  });

  const connectorLoop = Effect.fn("PersonalRelay.connectorLoop")(function* () {
    while (true) {
      const current = yield* Ref.get(hostRef);
      if (current === null || !current.enabled) return;
      yield* connectorAttempt().pipe(
        Effect.catchIf(
          (error): error is PersonalNetworkError =>
            error._tag === "PersonalNetworkError" && error.status === 410,
          () =>
            Effect.gen(function* () {
              const host = yield* Ref.get(hostRef);
              if (host !== null) yield* revokeGuestSessions(host.hostId);
              yield* grants.clearHostKeyGrant();
              yield* Ref.set(hostRef, null);
              yield* clearHost;
              yield* updateStatus(() => ({
                ...disabledState(config),
                lastError: "This host was removed from the relay.",
              }));
            }),
        ),
        Effect.catchCause((cause) =>
          updateStatus((current) => ({
            ...current,
            online: false,
            frpcRunning: false,
            lastError: String(cause).slice(0, 500),
          })).pipe(Effect.andThen(Effect.sleep(RESTART_DELAY))),
        ),
      );
    }
  });

  const stopConnector = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(fiberRef, null);
    if (fiber !== null) {
      yield* Fiber.interrupt(fiber);
    }
  });

  const startConnector = Effect.gen(function* () {
    yield* stopConnector;
    const fiber = yield* Effect.forkIn(
      connectorLoop().pipe(Effect.withSpan("PersonalRelay.connector")),
      scope,
    );
    yield* Ref.set(fiberRef, fiber);
  });

  if (initialHost !== null && initialHost.enabled) {
    yield* grants.setHostKeyGrant({
      hostKey: initialHost.hostKey,
      hostId: initialHost.hostId,
    });
    yield* startConnector;
  }

  const lock = <A, E>(effect: Effect.Effect<A, E>) => sandbox.withPermits(1)(effect);

  const startSharing: PersonalRelay["Service"]["startSharing"] = (input) =>
    lock(
      Effect.gen(function* () {
        const relayUrl = baseUrlOf(input.relayUrl);
        if (!/^https?:\/\//u.test(relayUrl)) {
          return yield* new PersonalNetworkError({
            operation: "start",
            detail: "The relay URL must be an http or https origin.",
          });
        }
        const previous = yield* Ref.get(hostRef);
        if (previous !== null) {
          yield* stopConnector;
          if (previous.relayUrl !== relayUrl) {
            yield* client
              .unregister({ relayUrl: previous.relayUrl, hostToken: previous.hostToken })
              .pipe(Effect.ignore);
          }
        }
        const registration = yield* client.register({
          relayUrl,
          environmentId,
          label: input.label?.trim() || previous?.label || config.personalLabel?.trim() || null,
          platform: yield* HostProcess.Platform,
        });
        const host: PersonalHostFile = {
          enabled: true,
          paused: false,
          relayUrl,
          label: registration.label,
          hostId: registration.hostId,
          hostKey: registration.hostKey,
          hostKeyVersion: registration.hostKeyVersion,
          hostToken: registration.hostToken,
          publicUrl: registration.publicUrl,
          frp: registration.frp,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* Ref.set(hostRef, host);
        yield* persistPersonalHost(host);
        yield* grants.setHostKeyGrant({ hostKey: host.hostKey, hostId: host.hostId });
        yield* updateStatus((current) => ({
          ...current,
          enabled: true,
          paused: false,
          relayUrl: host.relayUrl,
          hostId: host.hostId,
          publicUrl: host.publicUrl,
          label: host.label,
          online: false,
          frpcRunning: false,
          lastError: null,
        }));
        yield* startConnector;
        return yield* Ref.get(statusRef);
      }),
    );

  const stopSharing: PersonalRelay["Service"]["stopSharing"] = () =>
    lock(
      Effect.gen(function* () {
        const host = yield* Ref.get(hostRef);
        yield* stopConnector;
        if (host !== null) {
          yield* client
            .unregister({ relayUrl: host.relayUrl, hostToken: host.hostToken })
            .pipe(Effect.ignore);
          yield* grants.clearHostKeyGrant();
          yield* revokeGuestSessions(host.hostId);
        }
        yield* Ref.set(hostRef, null);
        yield* clearHost;
        yield* updateStatus(() => disabledState(config));
        return yield* Ref.get(statusRef);
      }),
    );

  const pauseSharing: PersonalRelay["Service"]["pauseSharing"] = () =>
    lock(
      Effect.gen(function* () {
        const host = yield* Ref.get(hostRef);
        if (host === null || !host.enabled) {
          return yield* new PersonalNetworkError({
            operation: "pause",
            detail: "Sharing is not enabled on this computer.",
          });
        }
        yield* stopConnector;
        const next: PersonalHostFile = {
          ...host,
          paused: true,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* persistPersonalHost(next);
        yield* Ref.set(hostRef, next);
        yield* client
          .heartbeat({
            relayUrl: next.relayUrl,
            hostToken: next.hostToken,
            hostKeyVersion: next.hostKeyVersion,
            label: next.label,
            online: false,
          })
          .pipe(Effect.ignore);
        yield* updateStatus((current) => ({
          ...current,
          paused: true,
          online: false,
          frpcRunning: false,
          lastError: null,
        }));
        yield* startConnector;
        return yield* Ref.get(statusRef);
      }),
    );

  const resumeSharing: PersonalRelay["Service"]["resumeSharing"] = () =>
    lock(
      Effect.gen(function* () {
        const host = yield* Ref.get(hostRef);
        if (host === null || !host.enabled) {
          return yield* new PersonalNetworkError({
            operation: "resume",
            detail: "Sharing is not enabled on this computer.",
          });
        }
        const next: PersonalHostFile = {
          ...host,
          paused: false,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* persistPersonalHost(next);
        yield* Ref.set(hostRef, next);
        yield* updateStatus((current) => ({
          ...current,
          paused: false,
          lastError: null,
        }));
        yield* startConnector;
        return yield* Ref.get(statusRef);
      }),
    );

  const rotateKey: PersonalRelay["Service"]["rotateKey"] = () =>
    lock(
      Effect.gen(function* () {
        const host = yield* Ref.get(hostRef);
        if (host === null || !host.enabled) {
          return yield* new PersonalNetworkError({
            operation: "rotate",
            detail: "Sharing is not enabled on this computer.",
          });
        }
        const rotated = yield* client.rotateKey({
          relayUrl: host.relayUrl,
          hostToken: host.hostToken,
        });
        yield* grants.clearHostKeyGrant();
        yield* revokeGuestSessions(host.hostId);
        const next: PersonalHostFile = {
          ...host,
          hostKey: rotated.hostKey,
          hostKeyVersion: rotated.hostKeyVersion,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* persistPersonalHost(next);
        yield* Ref.set(hostRef, next);
        yield* grants.setHostKeyGrant({ hostKey: next.hostKey, hostId: next.hostId });
        return { hostKey: rotated.hostKey };
      }),
    );

  const revealKey: PersonalRelay["Service"]["revealKey"] = () =>
    Ref.get(hostRef).pipe(
      Effect.flatMap((host) =>
        host === null || !host.enabled
          ? Effect.fail(
              new PersonalNetworkError({
                operation: "reveal",
                detail: "Sharing is not enabled on this computer.",
              }),
            )
          : Effect.succeed({ hostKey: host.hostKey }),
      ),
    );

  const resolveHost: PersonalRelay["Service"]["resolveHost"] = (input) =>
    client.resolveHost({
      relayUrl: baseUrlOf(input.relayUrl),
      hostKey: input.hostKey,
    });

  const notifyInternal = Effect.fn("PersonalRelay.notify")(function* (input: PersonalNotifyInput) {
    const host = yield* Ref.get(hostRef);
    if (host === null || !host.enabled || host.paused) return;
    yield* client.notify({
      relayUrl: host.relayUrl,
      hostToken: host.hostToken,
      notification: { ...input, hostId: host.hostId },
    });
  });
  const notify = (input: PersonalNotifyInput) => notifyInternal(input).pipe(Effect.ignore);

  const getStatus: PersonalRelay["Service"]["getStatus"] = () => Ref.get(statusRef);

  return PersonalRelay.of({
    getStatus,
    startSharing,
    stopSharing,
    pauseSharing,
    resumeSharing,
    rotateKey,
    revealKey,
    resolveHost,
    notify,
  });
});

export const layer: Layer.Layer<
  PersonalRelay,
  never,
  | ServerConfig.ServerConfig
  | ServerEnvironment.ServerEnvironmentIdentity
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | SessionStore.SessionStore
  | PairingGrantStore.PairingGrantStore
> = Layer.effect(
  PersonalRelay,
  makeEnabled.pipe(Effect.provide(Layer.merge(layerClient(), layerFrpcProcess))),
);
