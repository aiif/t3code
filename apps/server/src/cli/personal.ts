// @effect-diagnostics globalFetchInEffect:off globalJsonInEffect:off globalDateInEffect:off anyUnknownInErrorContext:off -- The CLI joins a relay before the server runtime exists and writes its bootstrap state directly.
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PERSONAL_RELAY_STATUS_FILE, PersonalRelayStatusFile } from "../personal/PersonalRelay.ts";
import {
  clearPersonalHostFile,
  readPersonalHostFile,
  writePersonalHostFile,
} from "../personal/hostSharingState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { layer as layerBootService, reconcileService, writeServiceEnv } from "./service.ts";

const relayUrlFlag = Flag.String("relay").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Relay origin, for example https://t3.example.com."),
);
const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Display name for this host, for example `Home PC`."),
  Flag.optional,
);

const runPersonalCommand = Effect.fn("cli.personal.run")(function* <A, E, R>(
  flags: { readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"] },
  run: (
    config: ServerConfig.ServerConfig["Service"],
  ) => Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run(config).pipe(
    Effect.provide(
      Layer.mergeAll(layerBootService(config), ServerConfig.layer(config)).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
});

const restartService = Effect.gen(function* () {
  const result = yield* reconcileService({ start: true }).pipe(
    Effect.catchTags({
      BootServiceBaseDirUnsupportedError: () =>
        Effect.succeed(null).pipe(
          Effect.tap(() =>
            Console.log(
              "No background service is supported here. Restart your T3 Code server to apply the change.",
            ),
          ),
        ),
    }),
  );
  if (result !== null && result.changed) {
    const plan = result.plan;
    yield* Console.log(
      plan.handedOff === true
        ? `Service update queued; the server restarts and this session disconnects.\nLog: ${plan.logPath}`
        : `Service restarted with the new personal-mode settings.\nLog: ${plan.logPath}`,
    );
  }
});

const readEnvironmentId = Effect.fn("cli.personal.readEnvironmentId")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(config.environmentIdPath);
  const id = raw.trim();
  if (id.length === 0) {
    return yield* new CliError.UserError({
      cause: config.environmentIdPath,
      userMessage: `The environment id file ${config.environmentIdPath} is empty. Start the server once.`,
    });
  }
  return id;
});

const personalJoinCommand = Command.make("join", {
  ...projectLocationFlags,
  relay: relayUrlFlag,
  label: labelFlag,
}).pipe(
  Command.withDescription(
    "Register this host with a personal relay and store the host key it returns.",
  ),
  Command.withHandler((flags) =>
    runPersonalCommand(flags, (config) =>
      Effect.gen(function* () {
        const relayUrl = flags.relay.toString().replace(/\/+$/u, "");
        const environmentId = yield* readEnvironmentId(config);
        const platform = yield* HostProcess.Platform;
        const label = Option.getOrUndefined(flags.label)?.trim() || null;
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${relayUrl}/v1/hosts/register`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ environmentId, label, platform }),
            }),
          catch: (cause) =>
            new CliError.UserError({
              cause,
              userMessage: `Could not reach the relay at ${relayUrl}.`,
            }),
        });
        if (!response.ok) {
          return yield* new CliError.UserError({
            cause: response.status,
            userMessage: `The relay answered ${response.status}.`,
          });
        }
        const registration = (yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) =>
            new CliError.UserError({ cause, userMessage: "Invalid relay response." }),
        })) as {
          readonly hostId: string;
          readonly hostKey: string;
          readonly hostKeyVersion: number;
          readonly hostToken: string;
          readonly publicUrl: string;
          readonly frp: {
            readonly serverAddr: string;
            readonly serverPort: number;
            readonly authToken: string;
            readonly domain: string;
          };
        };
        yield* writePersonalHostFile({
          stateDir: config.stateDir,
          state: {
            enabled: true,
            paused: false,
            relayUrl,
            label,
            hostId: registration.hostId,
            hostKey: registration.hostKey,
            hostKeyVersion: registration.hostKeyVersion,
            hostToken: registration.hostToken,
            publicUrl: registration.publicUrl,
            frp: registration.frp,
            updatedAt: new Date().toISOString(),
          },
        }).pipe(
          Effect.mapError(
            (cause) =>
              new CliError.UserError({
                cause,
                userMessage: "Could not write the host state file.",
              }),
          ),
        );
        yield* writeServiceEnv(config.baseDir, {
          T3CODE_PERSONAL_ENABLED: "1",
          T3CODE_PERSONAL_MODE: "1",
          T3CODE_PERSONAL_RELAY_URL: relayUrl,
          ...(label === null ? {} : { T3CODE_PERSONAL_LABEL: label }),
        });
        yield* Console.log(
          `Joined ${relayUrl} as ${registration.hostId} (${registration.publicUrl}).`,
        );
        yield* Console.log(
          "Open Settings → Personal Network to copy the host key. It is stored owner-only in the T3 state directory.",
        );
        yield* restartService;
      }),
    ),
  ),
);

const personalStatusCommand = Command.make("status", projectLocationFlags).pipe(
  Command.withDescription("Show the personal relay state this host last reported."),
  Command.withHandler((flags) =>
    runPersonalCommand(flags, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const statusPath = path.join(config.stateDir, PERSONAL_RELAY_STATUS_FILE);
        const exists = yield* fs.exists(statusPath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          const host = yield* readPersonalHostFile({ stateDir: config.stateDir });
          yield* Console.log(
            Option.isNone(host)
              ? "Personal sharing is off. Run `t3 personal join --relay <url>` first."
              : "Sharing is configured, but the server has not reported a relay status yet.",
          );
          return;
        }
        const parsed = yield* fs
          .readFileString(statusPath)
          .pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(PersonalRelayStatusFile)),
            ),
            Effect.option,
          );
        if (Option.isNone(parsed)) {
          yield* Console.log(`Could not read ${statusPath}.`);
          return;
        }
        const status: PersonalRelayStatusFile = parsed.value;
        yield* Console.log(`Enabled: ${status.enabled ? "yes" : "no"}`);
        if (status.relayUrl !== null) yield* Console.log(`Relay: ${status.relayUrl}`);
        if (status.publicUrl !== null) yield* Console.log(`Host URL: ${status.publicUrl}`);
        if (status.hostId !== null) {
          yield* Console.log(`Host: ${status.hostId}${status.label ? ` (${status.label})` : ""}`);
        }
        yield* Console.log(
          `State: ${status.online ? "online" : "offline"}${status.paused ? " (paused)" : ""} · frpc ${status.frpcRunning ? "running" : "stopped"}${status.updatedAt ? ` · reported ${status.updatedAt}` : ""}`,
        );
        if (status.lastError !== null) yield* Console.log(`Error: ${status.lastError}`);
      }),
    ),
  ),
);

const personalDisableCommand = Command.make("disable", projectLocationFlags).pipe(
  Command.withDescription("Stop sharing this host; the relay invalidates its host key."),
  Command.withHandler((flags) =>
    runPersonalCommand(flags, (config) =>
      Effect.gen(function* () {
        yield* clearPersonalHostFile({ stateDir: config.stateDir });
        yield* writeServiceEnv(config.baseDir, { T3CODE_PERSONAL_ENABLED: "0" });
        yield* Console.log("Personal sharing disabled. Restarting the service.");
        yield* restartService;
      }),
    ),
  ),
);

export const personalCommand = Command.make("personal").pipe(
  Command.withDescription("Share this host with the personal network."),
  Command.withSubcommands([personalJoinCommand, personalStatusCommand, personalDisableCommand]),
);
