import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerConfig from "../config.ts";
import { PERSONAL_RELAY_STATUS_FILE, PersonalRelayStatusFile } from "../personal/PersonalRelay.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  layer as layerBootService,
  reconcileService,
  readServiceEnv,
  writeServiceEnv,
} from "./service.ts";

const relayUrlFlag = Flag.String("relay").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Portal origin, for example https://t3.example.com."),
);
const keyFlag = Flag.String("key").pipe(
  Flag.withDescription(
    "The personal key every device will use. Generate one with `openssl rand -base64 32`.",
  ),
);
const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Display name for this host, for example `Home PC`."),
  Flag.optional,
);

const runPersonalCommand = Effect.fn("cli.personal.run")(function* <A, E, R>(
  flags: { readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"] },
  run: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run(config).pipe(
    Effect.provide(Layer.merge(layerBootService(config), ServerConfig.layer(config))),
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

const personalJoinCommand = Command.make("join", {
  ...projectLocationFlags,
  relay: relayUrlFlag,
  key: keyFlag,
  label: labelFlag,
}).pipe(
  Command.withDescription(
    "Register this host with a personal relay and keep the key in the service environment.",
  ),
  Command.withHandler((flags) =>
    runPersonalCommand(flags, (config) =>
      Effect.gen(function* () {
        const relayUrl = flags.relay;
        const key = flags.key.trim();
        if (key.length < 32) {
          return yield* new CliError.UserError({
            cause: "T3CODE_PERSONAL_KEY",
            userMessage: "The personal key must contain at least 32 characters.",
          });
        }
        const label = Option.getOrUndefined(flags.label)?.trim();
        yield* writeServiceEnv(config.baseDir, {
          T3CODE_PERSONAL_ENABLED: "1",
          T3CODE_PERSONAL_MODE: "1",
          T3CODE_PERSONAL_RELAY_URL: relayUrl.toString().replace(/\/+$/u, ""),
          T3CODE_PERSONAL_KEY: key,
          ...(label === undefined ? {} : { T3CODE_PERSONAL_LABEL: label }),
        });
        yield* Console.log(`Personal mode saved for ${config.baseDir}.`);
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
        const paths = yield* ServerConfig.deriveServerPaths(config.baseDir, undefined, {
          baseDirIsExplicit: true,
        });
        const env = yield* readServiceEnv(config.baseDir);
        const statusPath = path.join(paths.stateDir, PERSONAL_RELAY_STATUS_FILE);
        const exists = yield* fs.exists(statusPath).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          yield* Console.log(
            env.entries.T3CODE_PERSONAL_RELAY_URL === undefined
              ? "Personal mode is off. Run `t3 personal join --relay <url> --key <key>` first."
              : "Personal mode is configured, but the server has not reported a relay status yet.",
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
          `State: ${status.online ? "online" : "offline"}${status.updatedAt ? ` · reported ${status.updatedAt}` : ""}`,
        );
        if (status.lastError !== null) yield* Console.log(`Error: ${status.lastError}`);
      }),
    ),
  ),
);

const personalDisableCommand = Command.make("disable", projectLocationFlags).pipe(
  Command.withDescription(
    "Stop this host's relay connector. The registry reports it offline once its heartbeat expires.",
  ),
  Command.withHandler((flags) =>
    runPersonalCommand(flags, (config) =>
      Effect.gen(function* () {
        yield* writeServiceEnv(config.baseDir, { T3CODE_PERSONAL_ENABLED: "0" });
        yield* Console.log("Personal mode disabled. Restarting the service to stop the connector.");
        yield* restartService;
      }),
    ),
  ),
);

export const personalCommand = Command.make("personal").pipe(
  Command.withDescription("Run this host under a personal relay: one key, every host, one portal."),
  Command.withSubcommands([personalJoinCommand, personalStatusCommand, personalDisableCommand]),
);
