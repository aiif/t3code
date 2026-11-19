import { AgentId, type AgentSummary, type AgentProviderOptions } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as AgentRegistryModule from "../agents/AgentRegistry.ts";
import { validateAgentPaths as validateAgentPathsFromDefinition } from "../agents/AgentDefinition.ts";
import { BUILTIN_AGENTS } from "../agents/builtin.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const AgentRegistry = AgentRegistryModule.AgentRegistry;
const AgentRegistryError = AgentRegistryModule.AgentRegistryError;
type ResolvedAgentDefinition = AgentRegistryModule.ResolvedAgentDefinition;

export interface AgentValidationIssue {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
}

export interface AgentValidationResult {
  readonly issues: ReadonlyArray<AgentValidationIssue>;
  readonly fileCount?: number;
}

export type ValidateAgentPaths = (
  paths: ReadonlyArray<string>,
) => Effect.Effect<
  AgentValidationResult,
  AgentRegistryModule.AgentRegistryError,
  FileSystem.FileSystem | Path.Path
>;

export class AgentUsageError extends Schema.TaggedError<AgentUsageError>()("AgentUsageError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class AgentValidationUnavailableError extends Schema.TaggedError<AgentValidationUnavailableError>()(
  "AgentValidationUnavailableError",
  {},
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return "Agent definition validation is unavailable in this build. Update T3 Code to a build with the agent registry.";
  }
}

export class AgentValidationFailedError extends Schema.TaggedError<AgentValidationFailedError>()(
  "AgentValidationFailedError",
  { count: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `${this.count} agent definition error(s).`;
  }
}

const AgentCliError = Schema.Union([
  AgentUsageError,
  AgentValidationUnavailableError,
  AgentValidationFailedError,
  AgentRegistryError,
]);
const isAgentCliError = Schema.is(AgentCliError);
const isAgentRegistryError = Schema.is(AgentRegistryError);

const describeAgentError = (error: typeof AgentCliError.Type): string => {
  if (isAgentRegistryError(error) && error.reason === "not_found") {
    return `No agent definition named ${error.agentId ?? "?"} was found. Run t3 agent list.`;
  }
  return error.message;
};

const reportAgentErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isAgentCliError(error) ? Console.error(describeAgentError(error)) : Effect.void,
    ),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => Console.log(encodeJson(value));

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const projectFlag = Flag.String("project").pipe(
  Flag.withDescription("Project root or a path inside it. Defaults to this directory."),
  Flag.withDefault("."),
);

const agentIdArgument = Argument.String("id").pipe(
  Argument.withDescription("Agent id from t3 agent list."),
);

const agentPathsArgument = Argument.String("path").pipe(
  Argument.withDescription("Agent definition YAML file or directory."),
  Argument.variadic({ min: 1 }),
);

type AgentRegistryLayer = Layer.Layer<AgentRegistryModule.AgentRegistry, never, never>;

const registryModule = AgentRegistryModule as unknown as {
  readonly layer?: Layer.Layer<AgentRegistryModule.AgentRegistry, never, never>;
};

/** Built-ins only until the filesystem-backed registry from the agents lane lands. */
const builtinRegistryLayer: AgentRegistryLayer = AgentRegistryModule.layerStatic(
  BUILTIN_AGENTS.map((definition) => ({ definition, source: "builtin" as const })),
);

const liveRegistryLayer: Layer.Layer<AgentRegistryModule.AgentRegistry, never, never> =
  registryModule.layer ?? builtinRegistryLayer;

const resolveAgentBaseDir = Effect.fn("cli.agent.baseDir")(function* (
  configured: Option.Option<string>,
) {
  const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
  const explicit = Option.orElse(configured, () =>
    Option.filter(envHome, (value) => value.trim().length > 0),
  );
  return yield* resolveBaseDir(Option.getOrUndefined(explicit));
});

const resolveAgentProjectRoot = Effect.fn("cli.agent.projectRoot")(function* (project: string) {
  const path = yield* Path.Path;
  const cwd = yield* HostProcess.WorkingDirectory;
  return path.resolve(cwd, yield* expandHomePath(project));
});

/**
 * The live registry resolves its global directory from ServerConfig. Tests and
 * lanes that start before the loader lands pass a fixed layer instead.
 */
const withAgentRegistry = Effect.fn("cli.agent.withRegistry")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  injected: AgentRegistryLayer | undefined,
  program: Effect.Effect<A, E, R | AgentRegistryModule.AgentRegistry>,
) {
  if (injected !== undefined) {
    return yield* program.pipe(Effect.provide(injected));
  }
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
  const layer: Layer.Layer<AgentRegistryModule.AgentRegistry> = liveRegistryLayer.pipe(
    Layer.provide(Layer.succeed(AgentRegistryModule.AgentHomeDir, config.baseDir)),
  );
  return yield* program.pipe(Effect.provide(layer));
});

const listAllAgents = Effect.fn("cli.agent.listAll")(function* (projectRoot: string) {
  const registry = yield* AgentRegistry;
  const agents: Array<AgentSummary> = [];
  const warnings = new Set<string>();
  let cursor: number | undefined = 0;
  while (cursor !== undefined) {
    const page: AgentRegistryModule.AgentListPage = yield* registry.list({
      projectRoot,
      limit: 100,
      cursor,
    });
    agents.push(...page.agents);
    for (const warning of page.warnings ?? []) warnings.add(warning);
    cursor = page.nextCursor;
  }
  return { agents, warnings: [...warnings] };
});

const providerLabel = (summary: AgentSummary): string => {
  if (summary.providerInstanceId === null && summary.driverKind === null) {
    return summary.model === null ? "inherit" : `inherit/${summary.model}`;
  }
  const provider = summary.providerInstanceId ?? summary.driverKind ?? "inherit";
  return `${provider}/${summary.model ?? "default"}`;
};

const formatAgentTable = (agents: ReadonlyArray<AgentSummary>): string => {
  const rows = agents.map((agent) => [
    agent.id,
    agent.source,
    providerLabel(agent),
    agent.description,
  ]);
  const widths = [0, 1, 2].map((column) => Math.max(0, ...rows.map((row) => row[column]!.length)));
  return rows
    .map(
      (row) =>
        `${row[0]!.padEnd(widths[0]!)}  ${row[1]!.padEnd(widths[1]!)}  ${row[2]!.padEnd(widths[2]!)}  ${row[3]!}`,
    )
    .join("\n");
};

const formatOptions = (options: AgentProviderOptions | undefined): string | null => {
  if (options === undefined) return null;
  const entries = Array.isArray(options)
    ? options
    : Object.entries(options).map(([id, value]) => ({ id, value }));
  return entries.length === 0
    ? null
    : entries.map((entry) => `${entry.id}=${String(entry.value)}`).join(", ");
};

const promptFence = (prompt: string): string => {
  const longestRun = Math.max(0, ...(prompt.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
};

const formatAgentDetail = (resolved: ResolvedAgentDefinition): string => {
  const { definition } = resolved;
  const delegation = definition.delegation;
  const provider = definition.provider;
  const providerText =
    provider === undefined
      ? "inherit"
      : provider.instance !== undefined
        ? `${provider.instance}/${provider.model ?? "default"}`
        : provider.driver !== undefined
          ? `${provider.driver}/${provider.model ?? "default"}`
          : `inherit/${provider.model ?? "default"}`;
  const options = formatOptions(provider?.options);
  const delegationText =
    delegation === undefined
      ? "disabled (default)"
      : `${delegation.enabled ? "enabled" : "disabled"} (depth ${delegation.maxDepth}, parallel ${delegation.maxParallel}, isolation ${delegation.defaultIsolation}, mode ${delegation.defaultMode})`;
  const allowed =
    delegation?.allowedAgents === undefined
      ? "any"
      : delegation.allowedAgents.length === 0
        ? "none"
        : delegation.allowedAgents.join(", ");
  const fence = promptFence(definition.prompt);
  const lines = [
    `${definition.id}  (${resolved.source})`,
    `Name: ${definition.name}`,
    `Description: ${definition.description}`,
    `Schema version: ${definition.schemaVersion}`,
    `Provider: ${providerText}`,
    ...(options === null ? [] : [`Options: ${options}`]),
    `Path: ${resolved.path ?? "(built-in)"}`,
    `Delegation: ${delegationText}`,
    `Allowed agents: ${allowed}`,
    `Runtime mode: ${definition.runtimeMode ?? "inherit"}`,
    `Interaction mode: ${definition.interactionMode ?? "inherit"}`,
    "",
    "Prompt:",
    `${fence}text`,
    definition.prompt,
    fence,
  ];
  return lines.join("\n");
};

const decodeAgentId = Schema.decodeUnknownEffect(AgentId);
const readAgentId = (value: string) =>
  decodeAgentId(value.trim()).pipe(
    Effect.mapError(
      () => new AgentUsageError({ detail: `'${value}' is not an agent id. Run t3 agent list.` }),
    ),
  );

const makeListCommand = (registryLayer: AgentRegistryLayer | undefined) =>
  Command.make("list", {
    ...projectLocationFlags,
    project: projectFlag,
    json: jsonFlag,
  }).pipe(
    Command.withDescription("List built-in, global, and project agent definitions."),
    Command.withHandler((flags) =>
      reportAgentErrors(
        withAgentRegistry(
          flags,
          registryLayer,
          Effect.gen(function* () {
            const projectRoot = yield* resolveAgentProjectRoot(flags.project);
            const { agents, warnings } = yield* listAllAgents(projectRoot);
            if (flags.json) {
              return yield* printJson({
                agents,
                ...(warnings.length === 0 ? {} : { warnings }),
              });
            }
            if (agents.length > 0) yield* Console.log(formatAgentTable(agents));
            for (const warning of warnings) yield* Console.error(warning);
          }),
        ),
      ),
    ),
  );

const makeShowCommand = (registryLayer: AgentRegistryLayer | undefined) =>
  Command.make("show", {
    ...projectLocationFlags,
    id: agentIdArgument,
    project: projectFlag,
    json: jsonFlag,
  }).pipe(
    Command.withDescription("Show one agent definition, including its prompt and file path."),
    Command.withHandler((flags) =>
      reportAgentErrors(
        withAgentRegistry(
          flags,
          registryLayer,
          Effect.gen(function* () {
            const agentId = yield* readAgentId(flags.id);
            const projectRoot = yield* resolveAgentProjectRoot(flags.project);
            const registry = yield* AgentRegistry;
            const resolved = yield* registry.read({ agentId, projectRoot });
            if (flags.json) return yield* printJson(resolved);
            yield* Console.log(formatAgentDetail(resolved));
          }),
        ),
      ),
    ),
  );

const makeValidateCommand = (validate: ValidateAgentPaths | undefined) =>
  Command.make("validate", {
    paths: agentPathsArgument,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      "Validate agent definition YAML files or directories. Exits 1 on any error.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        if (validate === undefined) {
          return yield* new AgentValidationUnavailableError();
        }
        const path = yield* Path.Path;
        const cwd = yield* HostProcess.WorkingDirectory;
        const paths = yield* Effect.forEach(flags.paths, (input) =>
          Effect.map(expandHomePath(input), (expanded) => path.resolve(cwd, expanded)),
        );
        const result = yield* Effect.result(validate(paths));
        const rawIssues: ReadonlyArray<AgentValidationIssue> =
          result._tag === "Success"
            ? result.success.issues
            : [
                {
                  path: result.failure.path ?? paths.join(", "),
                  message: result.failure.message,
                },
              ];
        const issues = rawIssues.map((issue) => ({
          path: issue.path,
          line: issue.line ?? 1,
          column: issue.column ?? 1,
          message: issue.message.replace(/\s*\r?\n\s*/g, " "),
        }));
        if (flags.json) {
          yield* printJson({ errors: issues });
        } else {
          for (const issue of issues) {
            yield* Console.error(`${issue.path}:${issue.line}:${issue.column}: ${issue.message}`);
          }
          if (issues.length === 0) yield* Console.log("No agent definition errors.");
        }
        if (issues.length > 0) {
          return yield* new AgentValidationFailedError({ count: issues.length });
        }
      }),
    ),
  );

const makePathCommand = () =>
  Command.make("path", {
    ...projectLocationFlags,
    project: projectFlag,
  }).pipe(
    Command.withDescription("Print the global and project agent definition directories."),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseDir = yield* resolveAgentBaseDir(flags.baseDir);
        const projectRoot = yield* resolveAgentProjectRoot(flags.project);
        yield* Console.log(`Global: ${path.join(baseDir, "agents")}`);
        yield* Console.log(`Project: ${path.join(projectRoot, ".t3code", "agents")}`);
      }),
    ),
  );

export interface AgentCommandOptions {
  readonly registryLayer?: AgentRegistryLayer;
  readonly validateAgentPaths?: ValidateAgentPaths;
}

export const makeAgentCommand = (options: AgentCommandOptions = {}) => {
  const validateAgentPaths = options.validateAgentPaths ?? validateAgentPathsFromDefinition;
  return Command.make("agent").pipe(
    Command.withDescription("Inspect and validate local agent definitions."),
    Command.withSubcommands([
      makeListCommand(options.registryLayer),
      makeShowCommand(options.registryLayer),
      makeValidateCommand(validateAgentPaths),
      makePathCommand(),
    ]),
  );
};

export const agentCommand = makeAgentCommand();
