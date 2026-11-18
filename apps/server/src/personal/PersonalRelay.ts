import {
  AuthSessionId,
  type PersonalConnector,
  PersonalConnectorKind,
  PersonalConnectorMode,
  type PersonalGuestRoute,
  type PersonalGuestRoutes,
  type PersonalHostRegistration,
  PersonalHostRegistrationResponse,
  type PersonalRelayProfiles,
  type PersonalRelayState,
  type PersonalResolvedHost,
  PersonalNetworkError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
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
import {
  clearRelayRegistration,
  findRelayProfile,
  type PersonalRelayProfile,
  readRelayProfiles,
  relayKeyFor,
  relayProfileSummaries,
  removeRelayProfile,
  upsertRelayProfile,
  writeRelayProfiles,
} from "./relayProfiles.ts";
import {
  connectorModeOf,
  connectorPlan,
  findQuickTunnelUrl,
  hostFileFromRegistration,
  normalizeHeartbeatInterval,
  normalizeHostRegistration,
  quickTunnelTimeoutDetail,
  QUICK_TUNNEL_TIMEOUT_MS,
  stderrTail,
  stripAnsi,
} from "./connector.ts";
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
  connectorKind: Schema.NullOr(PersonalConnectorKind),
  connectorMode: Schema.NullOr(PersonalConnectorMode),
  connectorRunning: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type PersonalRelayStatusFile = typeof PersonalRelayStatusFile.Type;

const LegacyPersonalRelayStatusFile = Schema.Struct({
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  relayUrl: Schema.NullOr(Schema.String),
  hostId: Schema.NullOr(Schema.String),
  publicUrl: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  frpcRunning: Schema.Boolean,
  connectorKind: Schema.optionalKey(Schema.NullOr(PersonalConnectorKind)),
  connectorMode: Schema.optionalKey(Schema.NullOr(PersonalConnectorMode)),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const encodeStatusFile = Schema.encodeSync(Schema.fromJsonString(PersonalRelayStatusFile));
const decodeCurrentStatusFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersonalRelayStatusFile),
);
const decodeLegacyStatusFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(LegacyPersonalRelayStatusFile),
);
const RESTART_DELAY = "10 seconds";
const REQUEST_TIMEOUT = "15 seconds";
const PRIVATE_FILE = { mode: 0o600 } as const;

export function decodePersonalRelayStatusFile(raw: string): Option.Option<PersonalRelayStatusFile> {
  const current = decodeCurrentStatusFile(raw);
  if (Option.isSome(current)) return current;
  const legacy = decodeLegacyStatusFile(raw);
  if (Option.isNone(legacy)) return Option.none();
  const file = legacy.value;
  return Option.some({
    enabled: file.enabled,
    paused: file.paused,
    relayUrl: file.relayUrl,
    hostId: file.hostId,
    publicUrl: file.publicUrl,
    label: file.label,
    online: file.online,
    connectorKind: file.connectorKind ?? "frp",
    connectorMode: file.connectorMode ?? null,
    connectorRunning: file.frpcRunning,
    lastError: file.lastError,
    updatedAt: file.updatedAt,
  });
}

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

export class ConnectorSpawnError extends Schema.TaggedError<ConnectorSpawnError>()(
  "ConnectorSpawnError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The personal relay connector could not start: ${this.detail}`;
  }
}

/** The connector child, separated so supervision tests do not need a real binary. */
export interface ConnectorHandle {
  readonly exited: Effect.Effect<void>;
  readonly lastError: Effect.Effect<string>;
  /** Set once cloudflared prints its quick-tunnel address. */
  readonly publicUrl: Effect.Effect<string | null>;
}

export interface ConnectorSpawnInput {
  readonly connector: PersonalConnector;
  readonly port: number;
  readonly configPath: string;
  readonly frpcPath: string;
  readonly cloudflaredPath: string;
  readonly cloudflaredProtocol?: "http2" | undefined;
}

export class ConnectorProcess extends Context.Service<
  ConnectorProcess,
  {
    readonly spawn: (
      input: ConnectorSpawnInput,
    ) => Effect.Effect<ConnectorHandle, ConnectorSpawnError, Scope.Scope>;
  }
>()("t3/personal/PersonalRelay/ConnectorProcess") {}

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

export class PersonalRelayClient extends Context.Service<
  PersonalRelayClient,
  {
    readonly register: (input: {
      readonly relayUrl: string;
      readonly environmentId: string;
      readonly label: string | null;
      readonly platform: string | null;
      readonly originPort: number;
      readonly relayKey?: string | undefined;
    }) => Effect.Effect<PersonalHostRegistrationResponse, PersonalNetworkError>;
    readonly heartbeat: (input: {
      readonly relayUrl: string;
      readonly hostToken: string;
      readonly hostKeyVersion: number;
      readonly label: string | null;
      readonly online: boolean;
      readonly publicUrl?: string | undefined;
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
      readonly relayKey?: string | undefined;
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
    readonly listRelays: () => Effect.Effect<PersonalRelayProfiles>;
    readonly saveRelay: (input: {
      readonly relayUrl: string;
      readonly relayKey?: string | undefined;
    }) => Effect.Effect<PersonalRelayProfiles, PersonalNetworkError>;
    readonly forgetRelay: (input: {
      readonly relayUrl: string;
    }) => Effect.Effect<PersonalRelayProfiles, PersonalNetworkError>;
    readonly guestRoutes: () => Effect.Effect<PersonalGuestRoutes>;
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

function relayErrorFallback(operation: PersonalNetworkError["operation"], status: number): string {
  if (status === 401) {
    return operation === "start"
      ? "The relay rejected the enrollment key."
      : "The relay rejected this host key.";
  }
  if (status === 410) return "This host was removed from the relay.";
  return `The relay answered ${status}.`;
}

const relayError = Effect.fn("PersonalRelay.relayError")(function* (
  operation: PersonalNetworkError["operation"],
  response: HttpClientResponse.HttpClientResponse,
) {
  const fallback = relayErrorFallback(operation, response.status);
  const body = yield* HttpClientResponse.schemaBodyJson(
    Schema.Struct({ error: Schema.optional(Schema.String) }),
  )(response).pipe(Effect.option);
  const serverError = Option.isSome(body) ? (body.value.error?.trim() ?? "") : "";
  return yield* new PersonalNetworkError({
    operation,
    detail:
      serverError.length === 0
        ? fallback
        : `${fallback.replace(/\.$/u, "")}: ${serverError.slice(0, 300)}`,
    status: response.status,
  });
});

export const layerClient = (): Layer.Layer<PersonalRelayClient, never, HttpClient.HttpClient> =>
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
          Effect.filterOrElse(
            (response) => response.status < 400,
            (response) => relayError(operation, response),
          ),
        );

      return PersonalRelayClient.of({
        register: Effect.fn("PersonalRelayClient.register")(function* (input) {
          const request = HttpClientRequest.post(
            `${baseUrlOf(input.relayUrl)}/v1/hosts/register`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              environmentId: input.environmentId,
              label: input.label,
              platform: input.platform,
              apiVersion: 2,
              origin: { host: "127.0.0.1", port: input.originPort },
            }),
          );
          const response = yield* execute(
            "start",
            input.relayKey === undefined || input.relayKey.length === 0
              ? request
              : HttpClientRequest.bearerToken(request, input.relayKey),
          );
          const decoded = yield* HttpClientResponse.schemaBodyJson(
            PersonalHostRegistrationResponse,
          )(response).pipe(Effect.option);
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
                ...(input.publicUrl === undefined || input.publicUrl.length === 0
                  ? {}
                  : { publicUrl: input.publicUrl }),
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

/** The real connector child. The caller's scope owns it, so shutdown kills only this PID. */
export const layerConnectorProcess: Layer.Layer<
  ConnectorProcess,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  ConnectorProcess,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ConnectorProcess.of({
      spawn: Effect.fn("ConnectorProcess.spawn")(function* (input) {
        const plan = connectorPlan(input);
        const child = yield* spawner
          .spawn(
            ChildProcess.make(plan.command, plan.args, {
              detached: false,
              shell: false,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "pipe",
              ...(Object.keys(plan.env).length === 0 ? {} : { env: plan.env, extendEnv: true }),
            }),
          )
          .pipe(Effect.mapError((cause) => new ConnectorSpawnError({ detail: String(cause) })));
        yield* Effect.addFinalizer(() =>
          child
            .kill()
            .pipe(
              Effect.ignore,
              Effect.andThen(Effect.logInfo("Stopped the personal relay connector.")),
            ),
        );
        const tail = yield* Ref.make("");
        const scan = yield* Ref.make("");
        const publicUrl = yield* Ref.make<string | null>(null);
        const firstUrl = yield* Deferred.make<void>();
        yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              const plain = stripAnsi(chunk);
              yield* Ref.update(tail, (current) => stderrTail(`${current}${plain}`));
              yield* Ref.update(scan, (current) => `${current}${plain}`.slice(-4096));
              if (plan.mode !== "quick" || (yield* Ref.get(publicUrl)) !== null) return;
              const found = findQuickTunnelUrl(yield* Ref.get(scan));
              if (found === null) return;
              yield* Ref.set(publicUrl, found);
              yield* Deferred.succeed(firstUrl, void 0);
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
        if (plan.mode === "quick") {
          const ready = yield* Deferred.await(firstUrl).pipe(
            Effect.timeoutOption(`${QUICK_TUNNEL_TIMEOUT_MS} millis`),
          );
          if (Option.isNone(ready)) {
            const last = yield* Ref.get(tail);
            return yield* new ConnectorSpawnError({ detail: quickTunnelTimeoutDetail(last) });
          }
        }
        return {
          exited: child.exitCode.pipe(Effect.ignore),
          lastError: Ref.get(tail),
          publicUrl: Ref.get(publicUrl),
        } satisfies ConnectorHandle;
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
  connectorKind: null,
  connectorMode: null,
  connectorRunning: false,
  lastError: null,
  updatedAt: null,
});

export const toPersonalRelayState = (host: PersonalHostFile | null): PersonalRelayState =>
  host === null
    ? {
        enabled: false,
        paused: false,
        relayUrl: null,
        hostId: null,
        publicUrl: null,
        label: null,
        online: false,
        connectorKind: null,
        connectorMode: null,
        connectorRunning: false,
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
        connectorKind: host.connector.kind,
        connectorMode: connectorModeOf(host.connector),
        connectorRunning: false,
        lastError: null,
        updatedAt: host.updatedAt,
      };

/**
 * Switching relays only changes which connector runs. The host record stays on
 * the previous relay, so switching back keeps the same host id and host key.
 */
const makeEnabled = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* PersonalRelayClient;
  const processes = yield* ConnectorProcess;
  const sessions = yield* SessionStore.SessionStore;
  const grants = yield* PairingGrantStore.PairingGrantStore;
  const scope = yield* Effect.scope;
  const environmentId = yield* environment.getEnvironmentId;
  const sandbox = yield* Semaphore.make(1);
  const personalDirectory = path.join(config.stateDir, "personal");
  const configPath = path.join(personalDirectory, "frpc.toml");
  const statusPath = path.join(config.stateDir, PERSONAL_RELAY_STATUS_FILE);
  const frpcPath = config.personalFrpcPath?.trim() || "frpc";
  const cloudflaredPath = config.personalCloudflaredPath?.trim() || "cloudflared";
  const cloudflaredProtocol = config.personalCloudflaredProtocol;
  const configRelayKey =
    config.personalRelayKey === undefined
      ? undefined
      : Redacted.value(config.personalRelayKey).trim() || undefined;

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
    initialHost === null ? disabledState(config) : toPersonalRelayState(initialHost),
  );
  const initialProfiles = yield* readRelayProfiles({ stateDir: config.stateDir }).pipe(
    provideHostFileServices,
    Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<PersonalRelayProfile>)),
  );
  const profilesRef = yield* Ref.make<ReadonlyArray<PersonalRelayProfile>>(initialProfiles);
  const profilesLock = yield* Semaphore.make(1);
  const withProfiles = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    profilesLock.withPermits(1)(effect);
  const persistProfiles = Effect.fn("PersonalRelay.persistProfiles")(function* (
    profiles: ReadonlyArray<PersonalRelayProfile>,
  ) {
    yield* writeRelayProfiles({ stateDir: config.stateDir, profiles }).pipe(
      provideHostFileServices,
      Effect.mapError(
        (cause) => new PersonalNetworkError({ operation: "relay", detail: String(cause) }),
      ),
    );
    yield* Ref.set(profilesRef, profiles);
  });
  const rememberRelay = Effect.fn("PersonalRelay.rememberRelay")(function* (input: {
    readonly relayUrl: string;
    readonly relayKey?: string | undefined;
    readonly hostId?: string | undefined;
    readonly hostKey?: string | undefined;
    readonly publicUrl?: string | undefined;
  }) {
    yield* withProfiles(
      Effect.gen(function* () {
        const profiles = upsertRelayProfile(yield* Ref.get(profilesRef), {
          ...input,
          now: DateTime.formatIso(yield* DateTime.now),
        });
        yield* persistProfiles(profiles);
      }),
    );
  });
  if (initialHost !== null) {
    yield* rememberRelay({
      relayUrl: initialHost.relayUrl,
      relayKey: initialHost.relayKey,
      hostId: initialHost.hostId,
      hostKey: initialHost.hostKey,
      publicUrl: initialHost.publicUrl,
    }).pipe(Effect.ignore);
  }

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
          connectorKind: status.connectorKind,
          connectorMode: status.connectorMode,
          connectorRunning: status.connectorRunning,
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
            ...toPersonalRelayState(host),
            online: false,
            connectorRunning: false,
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
    yield* rememberRelay({
      relayUrl: next.relayUrl,
      hostId: next.hostId,
      hostKey: next.hostKey,
      publicUrl: next.publicUrl,
    }).pipe(Effect.ignore);
    return next;
  });

  const applyRegistration = Effect.fn("PersonalRelay.applyRegistration")(function* (input: {
    readonly registration: PersonalHostRegistration;
    readonly relayKey?: string | undefined;
  }) {
    const registration = input.registration;
    const previous = yield* Ref.get(hostRef);
    const next = hostFileFromRegistration({
      registration,
      previous,
      relayUrl: previous?.relayUrl ?? "",
      relayKey: input.relayKey,
      now: DateTime.formatIso(yield* DateTime.now),
    });
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
    yield* rememberRelay({
      relayUrl: next.relayUrl,
      relayKey: input.relayKey ?? next.relayKey,
      hostId: next.hostId,
      hostKey: next.hostKey,
      publicUrl: next.publicUrl,
    }).pipe(Effect.ignore);
    yield* updateStatus((current) => ({
      ...current,
      enabled: true,
      paused: next.paused,
      relayUrl: next.relayUrl,
      hostId: next.hostId,
      publicUrl: next.publicUrl,
      label: next.label,
      connectorKind: next.connector.kind,
      connectorMode: connectorModeOf(next.connector),
      lastError: null,
    }));
    return next;
  });

  const prepareConnectorFiles = Effect.fn("PersonalRelay.prepareConnectorFiles")(function* (
    host: PersonalHostFile,
  ) {
    if (host.connector.kind !== "frp") {
      yield* fs.remove(configPath).pipe(Effect.ignore);
      return;
    }
    yield* fs.makeDirectory(personalDirectory, { recursive: true });
    yield* fs.writeFileString(
      configPath,
      renderFrpcConfig({
        serverAddr: host.connector.serverAddr,
        serverPort: host.connector.serverPort,
        authToken: host.connector.authToken,
        domain: host.connector.domain,
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
    while (true) {
      const current = yield* Ref.get(hostRef);
      if (current === null || !current.enabled) return;
      yield* Effect.sleep(`${normalizeHeartbeatInterval(current.heartbeatIntervalMs)} millis`);
      const latest = yield* Ref.get(hostRef);
      if (latest === null || !latest.enabled) return;
      const quickPublicUrl =
        latest.connector.kind === "cloudflare-tunnel" && latest.connector.mode === "quick"
          ? latest.publicUrl.trim()
          : "";
      const result = yield* client.heartbeat({
        relayUrl: latest.relayUrl,
        hostToken: latest.hostToken,
        hostKeyVersion: latest.hostKeyVersion,
        label: latest.label,
        online: !latest.paused,
        ...(quickPublicUrl.length === 0 ? {} : { publicUrl: quickPublicUrl }),
      });
      if (result.hostKey !== undefined && result.hostKeyVersion !== undefined) {
        yield* applyHostKey({
          host: latest,
          hostKey: result.hostKey,
          hostKeyVersion: result.hostKeyVersion,
        });
      }
      if (result.revokedSessionIds !== undefined) {
        yield* Effect.forEach(result.revokedSessionIds, (sessionId) =>
          sessions.revoke(AuthSessionId.make(sessionId)).pipe(Effect.ignore),
        );
      }
      yield* reportClients(latest);
    }
  });

  const updateQuickPublicUrl = Effect.fn("PersonalRelay.updateQuickPublicUrl")(function* (
    publicUrl: string,
  ) {
    const current = yield* Ref.get(hostRef);
    if (current === null || !current.enabled) return;
    if (current.connector.kind !== "cloudflare-tunnel" || current.connector.mode !== "quick") {
      return;
    }
    if (current.publicUrl === publicUrl) return;
    const next: PersonalHostFile = {
      ...current,
      publicUrl,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* Ref.set(hostRef, next);
    yield* persistPersonalHost(next).pipe(Effect.ignore);
    yield* rememberRelay({
      relayUrl: next.relayUrl,
      hostId: next.hostId,
      hostKey: next.hostKey,
      publicUrl,
    }).pipe(Effect.ignore);
    yield* updateStatus((status) => ({ ...status, publicUrl }));
  });

  const connectorExitMessage = (connector: PersonalConnector, lastError: string) => {
    const label = connector.kind === "cloudflare-tunnel" ? "cloudflared" : "frpc";
    if (lastError.length > 0) return `${label} exited: ${lastError}`;
    return connector.kind === "frp"
      ? "frpc exited unexpectedly. Install frpc or set T3CODE_FRPC_PATH."
      : "cloudflared exited unexpectedly. Install cloudflared or set T3CODE_CLOUDFLARED_PATH.";
  };

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
        connectorRunning: false,
      }));
      yield* Effect.sleep(`${normalizeHeartbeatInterval(existing.heartbeatIntervalMs)} millis`);
      return;
    }
    const relayKey = existing.relayKey ?? configRelayKey;
    const registration = normalizeHostRegistration(
      yield* client.register({
        relayUrl: existing.relayUrl,
        environmentId,
        label: existing.label,
        platform: yield* HostProcess.Platform,
        originPort: config.port,
        ...(relayKey === undefined ? {} : { relayKey }),
      }),
    );
    const host = yield* applyRegistration({ registration, relayKey });
    yield* prepareConnectorFiles(host);
    yield* updateStatus((current) => ({
      ...current,
      enabled: true,
      paused: false,
      online: true,
      connectorKind: host.connector.kind,
      connectorMode: connectorModeOf(host.connector),
      connectorRunning: false,
      lastError: null,
    }));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* processes.spawn({
          connector: host.connector,
          port: config.port,
          configPath,
          frpcPath,
          cloudflaredPath,
          cloudflaredProtocol,
        });
        if (host.connector.kind === "cloudflare-tunnel" && host.connector.mode === "quick") {
          const publicUrl = yield* handle.publicUrl;
          if (publicUrl !== null) yield* updateQuickPublicUrl(publicUrl);
        }
        yield* updateStatus((current) => ({
          ...current,
          online: true,
          connectorRunning: true,
          connectorKind: host.connector.kind,
          connectorMode: connectorModeOf(host.connector),
        }));
        yield* Effect.raceFirst(
          heartbeatLoop(),
          handle.exited.pipe(
            Effect.andThen(handle.lastError),
            Effect.flatMap((lastError) =>
              Effect.fail(
                new PersonalNetworkError({
                  operation: "start",
                  detail: connectorExitMessage(host.connector, lastError),
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
              if (host !== null) {
                yield* withProfiles(
                  persistProfiles(
                    clearRelayRegistration(
                      yield* Ref.get(profilesRef),
                      host.relayUrl,
                      DateTime.formatIso(yield* DateTime.now),
                    ),
                  ).pipe(Effect.ignore),
                );
              }
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
            connectorRunning: false,
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
        const profiles = yield* Ref.get(profilesRef);
        const relayKey =
          input.relayKey?.trim() ||
          relayKeyFor(profiles, relayUrl) ||
          (previous?.relayUrl === relayUrl ? previous.relayKey : undefined) ||
          configRelayKey;
        const label =
          input.label?.trim() || previous?.label || config.personalLabel?.trim() || null;
        yield* Effect.logInfo("personal relay starting", {
          relayUrl,
          previousRelayUrl: previous?.relayUrl ?? null,
          relaySwitched: previous !== null && previous.relayUrl !== relayUrl,
          previousRelayLeftRegistered: previous !== null && previous.relayUrl !== relayUrl,
          hasRelayKey: relayKey !== undefined,
          label,
        });
        const registration = normalizeHostRegistration(
          yield* client.register({
            relayUrl,
            environmentId,
            label,
            platform: yield* HostProcess.Platform,
            originPort: config.port,
            ...(relayKey === undefined ? {} : { relayKey }),
          }),
        );
        yield* Effect.logInfo("personal relay registered", {
          hostId: registration.hostId,
          environmentId,
          relayUrl,
          connectorKind: registration.connector.kind,
          connectorMode: connectorModeOf(registration.connector),
          publicUrl: registration.publicUrl,
          hostKeyChanged: previous !== null && previous.hostKey !== registration.hostKey,
        });
        if (
          previous !== null &&
          previous.relayUrl === relayUrl &&
          (previous.hostId !== registration.hostId || previous.hostKey !== registration.hostKey)
        ) {
          // The relay re-created this host under the same URL; the old key is gone.
          yield* revokeGuestSessions(previous.hostId);
        }
        yield* stopConnector;
        const host: PersonalHostFile = {
          ...hostFileFromRegistration({
            registration,
            previous,
            relayUrl,
            relayKey,
            now: DateTime.formatIso(yield* DateTime.now),
          }),
          paused: false,
        };
        yield* Ref.set(hostRef, host);
        yield* persistPersonalHost(host);
        yield* grants.setHostKeyGrant({ hostKey: host.hostKey, hostId: host.hostId });
        yield* rememberRelay({
          relayUrl: host.relayUrl,
          relayKey: host.relayKey,
          hostId: host.hostId,
          hostKey: host.hostKey,
          publicUrl: host.publicUrl,
        });
        yield* updateStatus((current) => ({
          ...current,
          enabled: true,
          paused: false,
          relayUrl: host.relayUrl,
          hostId: host.hostId,
          publicUrl: host.publicUrl,
          label: host.label,
          online: false,
          connectorKind: host.connector.kind,
          connectorMode: connectorModeOf(host.connector),
          connectorRunning: false,
          lastError: null,
        }));
        yield* startConnector;
        return yield* Ref.get(statusRef);
      }),
    ).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("personal relay start failed", {
            relayUrl: input.relayUrl,
            operation: error.operation,
            detail: error.detail,
          });
          if (error.status === 401 || error.status === 410) {
            yield* withProfiles(
              persistProfiles(
                clearRelayRegistration(
                  yield* Ref.get(profilesRef),
                  input.relayUrl,
                  DateTime.formatIso(yield* DateTime.now),
                ),
              ).pipe(Effect.ignore),
            );
          }
        }),
      ),
    );

  const stopSharing: PersonalRelay["Service"]["stopSharing"] = () =>
    lock(
      Effect.gen(function* () {
        const host = yield* Ref.get(hostRef);
        yield* Effect.logInfo("personal relay stopping", {
          hostId: host?.hostId ?? null,
          relayUrl: host?.relayUrl ?? null,
        });
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
        if (host !== null) {
          yield* withProfiles(
            persistProfiles(
              clearRelayRegistration(
                yield* Ref.get(profilesRef),
                host.relayUrl,
                DateTime.formatIso(yield* DateTime.now),
              ),
            ).pipe(Effect.ignore),
          );
        }
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
        yield* Effect.logInfo("personal relay pausing", {
          hostId: host.hostId,
          relayUrl: host.relayUrl,
        });
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
          connectorRunning: false,
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
        yield* Effect.logInfo("personal relay resuming", {
          hostId: host.hostId,
          relayUrl: host.relayUrl,
        });
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
        yield* rememberRelay({
          relayUrl: next.relayUrl,
          hostId: next.hostId,
          hostKey: next.hostKey,
          publicUrl: next.publicUrl,
        }).pipe(Effect.ignore);
        yield* Effect.logInfo("personal relay host key rotated", {
          hostId: next.hostId,
          relayUrl: next.relayUrl,
          keyVersion: next.hostKeyVersion,
        });
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

  const listRelays: PersonalRelay["Service"]["listRelays"] = () =>
    Ref.get(profilesRef).pipe(
      Effect.map((profiles) => ({ relays: relayProfileSummaries(profiles) })),
    );

  const saveRelay: PersonalRelay["Service"]["saveRelay"] = (input) =>
    lock(
      withProfiles(
        Effect.gen(function* () {
          const relayUrl = baseUrlOf(input.relayUrl);
          if (!/^https?:\/\//u.test(relayUrl)) {
            return yield* new PersonalNetworkError({
              operation: "relay",
              detail: "The relay URL must be an http or https origin.",
            });
          }
          const savedAt = DateTime.formatIso(yield* DateTime.now);
          let profiles = upsertRelayProfile(yield* Ref.get(profilesRef), {
            relayUrl,
            relayKey: input.relayKey,
            now: savedAt,
          });
          const current = yield* Ref.get(hostRef);
          const active = current !== null && current.enabled && current.relayUrl === relayUrl;
          const saved = findRelayProfile(profiles, relayUrl);
          if (
            !active &&
            saved !== null &&
            (saved.hostKey === undefined || input.relayKey?.trim())
          ) {
            const relayKey = saved.relayKey?.trim() || configRelayKey;
            const label = current?.label ?? config.personalLabel?.trim() ?? null;
            const prepared = yield* client
              .register({
                relayUrl,
                environmentId,
                label,
                platform: yield* HostProcess.Platform,
                originPort: config.port,
                ...(relayKey === undefined ? {} : { relayKey }),
              })
              .pipe(Effect.option);
            if (Option.isSome(prepared)) {
              const registration = normalizeHostRegistration(prepared.value);
              profiles = upsertRelayProfile(profiles, {
                relayUrl,
                relayKey,
                hostId: registration.hostId,
                hostKey: registration.hostKey,
                publicUrl: registration.publicUrl,
                now: DateTime.formatIso(yield* DateTime.now),
              });
              yield* Effect.logInfo("personal relay prepared", {
                relayUrl,
                hostId: registration.hostId,
                publicUrl: registration.publicUrl,
              });
            }
          }
          yield* persistProfiles(profiles);
          return { relays: relayProfileSummaries(profiles) };
        }),
      ),
    );

  const forgetRelay: PersonalRelay["Service"]["forgetRelay"] = (input) =>
    lock(
      withProfiles(
        Effect.gen(function* () {
          const relayUrl = baseUrlOf(input.relayUrl);
          const host = yield* Ref.get(hostRef);
          if (host !== null && host.enabled && host.relayUrl === relayUrl) {
            return yield* new PersonalNetworkError({
              operation: "relay",
              detail: "Stop sharing before forgetting this relay.",
            });
          }
          const profiles = removeRelayProfile(yield* Ref.get(profilesRef), relayUrl);
          yield* persistProfiles(profiles);
          return { relays: relayProfileSummaries(profiles) };
        }),
      ),
    );

  const guestRoutes: PersonalRelay["Service"]["guestRoutes"] = () =>
    Ref.get(profilesRef).pipe(
      Effect.map((profiles) => ({
        routes: profiles.flatMap((profile): ReadonlyArray<PersonalGuestRoute> => {
          const hostKey = profile.hostKey?.trim() ?? "";
          const hostId = profile.hostId?.trim() ?? "";
          if (hostKey === "" || hostId === "") return [];
          return [
            {
              relayUrl: profile.relayUrl,
              hostKey,
              hostId,
              publicUrl: profile.publicUrl?.trim() ?? "",
            },
          ];
        }),
      })),
    );

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
    listRelays,
    saveRelay,
    forgetRelay,
    guestRoutes,
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
  makeEnabled.pipe(Effect.provide(Layer.merge(layerClient(), layerConnectorProcess))),
);
