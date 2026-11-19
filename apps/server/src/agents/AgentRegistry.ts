import {
  AgentId,
  type AgentDefinition,
  type AgentSource,
  type AgentSummary,
  DEFAULT_AGENT_DELEGATION,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off - user definitions live outside the Effect filesystem's service graph.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import {
  type AgentDecodeResult,
  type AgentValidationIssue,
  decodeAgentDefinition,
  listAgentDefinitionFiles,
  MAX_AGENT_DEFINITION_BYTES,
  MAX_AGENT_FILES_PER_SCOPE,
} from "./AgentDefinition.ts";
import { BUILTIN_AGENTS } from "./builtin.ts";

export interface AgentListPage {
  readonly agents: ReadonlyArray<AgentSummary>;
  readonly nextCursor?: number;
  readonly warnings?: ReadonlyArray<string>;
}

/** A definition with where it came from. The path is absolute and local callers only. */
export interface ResolvedAgentDefinition {
  readonly definition: AgentDefinition;
  readonly source: AgentSource;
  readonly path?: string;
}

export class AgentRegistryError extends Schema.TaggedError<AgentRegistryError>()(
  "AgentRegistryError",
  {
    agentId: Schema.optional(AgentId),
    path: Schema.optional(Schema.String),
    reason: Schema.Literals(["not_found", "invalid", "unreadable", "too_many_files"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return `No agent definition named ${this.agentId ?? "?"} was found. Run t3_agent_list.`;
      case "invalid":
        return `${this.path ?? "The agent definition"} is not a valid agent definition. Run t3 agent validate ${this.path ?? ""}.`;
      case "unreadable":
        return `${this.path ?? "The agent definitions directory"} could not be read.`;
      case "too_many_files":
        return `${this.path ?? "The agent definitions directory"} holds more YAML files than the limit.`;
    }
  }
}

export interface AgentRegistryShape {
  readonly list: (input: {
    readonly projectRoot?: string;
    readonly search?: string;
    readonly limit?: number;
    readonly cursor?: number;
  }) => Effect.Effect<AgentListPage, AgentRegistryError>;

  readonly read: (input: {
    readonly agentId: AgentId;
    readonly projectRoot?: string;
  }) => Effect.Effect<ResolvedAgentDefinition, AgentRegistryError>;
}

export class AgentRegistry extends Context.Service<AgentRegistry, AgentRegistryShape>()(
  "t3/agents/AgentRegistry",
) {}

export function toAgentSummary(resolved: ResolvedAgentDefinition): AgentSummary {
  const { definition } = resolved;
  const delegation = definition.delegation ?? DEFAULT_AGENT_DELEGATION;
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    source: resolved.source,
    providerInstanceId: definition.provider?.instance ?? null,
    driverKind: definition.provider?.driver ?? null,
    model: definition.provider?.model ?? null,
    delegationEnabled: delegation.enabled,
    allowedAgents: delegation.allowedAgents ?? null,
    maxDepth: delegation.maxDepth,
    maxParallel: delegation.maxParallel,
  };
}

const builtinResolved: ReadonlyArray<ResolvedAgentDefinition> = BUILTIN_AGENTS.map(
  (definition) => ({ definition, source: "builtin" }),
);

interface ScopeResult {
  readonly definitions: ReadonlyArray<ResolvedAgentDefinition>;
  readonly warnings: ReadonlyArray<string>;
}

interface CachedDefinition {
  readonly mtimeMs: number;
  readonly size: number;
  readonly result: AgentDecodeResult;
}

const isNotFound = (cause: unknown): boolean => {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

const issueWarning = (issue: AgentValidationIssue): string => {
  const location =
    issue.line === undefined
      ? ""
      : `:${issue.line}${issue.column === undefined ? "" : `:${issue.column}`}`;
  return `${issue.path}${location}: ${issue.message}`;
};

const mergeScopes = (
  global: ScopeResult,
  project: ScopeResult,
): {
  readonly agents: ReadonlyArray<ResolvedAgentDefinition>;
  readonly warnings: ReadonlyArray<string>;
} => {
  const winners = new Map<string, ResolvedAgentDefinition>();
  for (const resolved of [...builtinResolved, ...global.definitions, ...project.definitions]) {
    winners.set(resolved.definition.id, resolved);
  }

  const agents: Array<ResolvedAgentDefinition> = [];
  const seen = new Set<string>();
  const append = (resolved: ResolvedAgentDefinition) => {
    if (seen.has(resolved.definition.id)) return;
    seen.add(resolved.definition.id);
    agents.push(winners.get(resolved.definition.id) ?? resolved);
  };
  for (const resolved of builtinResolved) append(resolved);
  for (const resolved of global.definitions) append(resolved);
  for (const resolved of project.definitions) append(resolved);

  const warnings = [...global.warnings, ...project.warnings];
  return { agents, warnings };
};

const matchesSearch = (definition: AgentDefinition, term: string): boolean =>
  definition.id.toLowerCase().includes(term) ||
  definition.name.toLowerCase().includes(term) ||
  definition.description.toLowerCase().includes(term);

const make = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
  const baseDir = Option.isSome(config)
    ? config.value.baseDir
    : Option.getOrElse(envHome, () => NodePath.join(NodeOS.homedir(), ".t3"));
  const globalAgentsDir = NodePath.resolve(baseDir, "agents");
  const cache = new Map<string, CachedDefinition>();

  const loadFile = async (
    filePath: string,
    source: AgentSource,
  ): Promise<{
    readonly resolved?: ResolvedAgentDefinition;
    readonly issues: ReadonlyArray<AgentValidationIssue>;
  }> => {
    let stats;
    try {
      stats = await NodeFSP.stat(filePath);
    } catch (cause) {
      if (isNotFound(cause)) return { issues: [] };
      throw cause;
    }
    if (!stats.isFile()) return { issues: [] };
    if (stats.size > MAX_AGENT_DEFINITION_BYTES) {
      return {
        issues: [
          {
            path: filePath,
            message: `The file is ${stats.size} bytes; the limit is ${MAX_AGENT_DEFINITION_BYTES} bytes (256 KiB).`,
          },
        ],
      };
    }

    const cached = cache.get(filePath);
    let result: AgentDecodeResult;
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      result = cached.result;
    } else {
      let contents: string;
      try {
        contents = await NodeFSP.readFile(filePath, "utf8");
      } catch (cause) {
        if (isNotFound(cause)) return { issues: [] };
        throw cause;
      }
      result = decodeAgentDefinition({ path: filePath, contents });
      cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, result });
    }

    return result.definition === undefined
      ? { issues: result.issues }
      : { resolved: { definition: result.definition, source, path: filePath }, issues: [] };
  };

  const loadScope = async (directory: string, source: AgentSource): Promise<ScopeResult> => {
    let files: ReadonlyArray<string>;
    try {
      files = await listAgentDefinitionFiles(directory);
    } catch (cause) {
      return {
        definitions: [],
        warnings: [
          `${directory}: could not read the directory: ${cause instanceof Error ? cause.message : String(cause)}`,
        ],
      };
    }

    const warnings: Array<string> = [];
    if (files.length > MAX_AGENT_FILES_PER_SCOPE) {
      warnings.push(
        `${directory}: holds ${files.length} YAML files; only the first ${MAX_AGENT_FILES_PER_SCOPE} are loaded.`,
      );
    }

    const byId = new Map<string, ResolvedAgentDefinition>();
    for (const filePath of files.slice(0, MAX_AGENT_FILES_PER_SCOPE)) {
      let loaded;
      try {
        loaded = await loadFile(filePath, source);
      } catch (cause) {
        warnings.push(
          `${filePath}: could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        continue;
      }
      if (loaded.resolved !== undefined) {
        const existing = byId.get(loaded.resolved.definition.id);
        if (existing !== undefined) {
          warnings.push(
            `${filePath}: duplicate agent id "${loaded.resolved.definition.id}"; using ${existing.path ?? "the first definition"}.`,
          );
          continue;
        }
        byId.set(loaded.resolved.definition.id, loaded.resolved);
      } else {
        warnings.push(...loaded.issues.map(issueWarning));
      }
    }

    return { definitions: [...byId.values()], warnings };
  };

  const loadScopes = Effect.fn("AgentRegistry.loadScopes")(function* (projectRoot?: string) {
    const global = yield* Effect.promise(() => loadScope(globalAgentsDir, "global"));
    if (projectRoot === undefined) {
      return { global, project: { definitions: [], warnings: [] } satisfies ScopeResult };
    }
    const projectDir = NodePath.resolve(projectRoot, ".t3code", "agents");
    const project = yield* Effect.promise(() => loadScope(projectDir, "project"));
    return { global, project };
  });

  const list = Effect.fn("AgentRegistry.list")(function* (input: {
    readonly projectRoot?: string;
    readonly search?: string;
    readonly limit?: number;
    readonly cursor?: number;
  }) {
    const scopes = yield* loadScopes(input.projectRoot);
    const merged = mergeScopes(scopes.global, scopes.project);
    const term = input.search?.trim().toLowerCase();
    const matched =
      term === undefined || term.length === 0
        ? merged.agents
        : merged.agents.filter(({ definition }) => matchesSearch(definition, term));
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? 0;
    const page = matched.slice(cursor, cursor + limit);
    return {
      agents: page.map(toAgentSummary),
      ...(cursor + limit < matched.length ? { nextCursor: cursor + limit } : {}),
      ...(merged.warnings.length === 0 ? {} : { warnings: merged.warnings }),
    };
  });

  const read = Effect.fn("AgentRegistry.read")(function* (input: {
    readonly agentId: AgentId;
    readonly projectRoot?: string;
  }) {
    const scopes = yield* loadScopes(input.projectRoot);
    const merged = mergeScopes(scopes.global, scopes.project);
    const found = merged.agents.find(({ definition }) => definition.id === input.agentId);
    if (found === undefined) {
      return yield* new AgentRegistryError({ agentId: input.agentId, reason: "not_found" });
    }
    return found;
  });

  return AgentRegistry.of({ list, read });
});

/**
 * Placeholder for lanes that run before the file loader is wired in: no
 * definitions, so the MCP layer graph compiles and old behavior stays unchanged.
 */
export const layerEmpty = Layer.succeed(
  AgentRegistry,
  AgentRegistry.of({
    list: Effect.fn("AgentRegistry.list")(() => Effect.succeed({ agents: [] })),
    read: Effect.fn("AgentRegistry.read")(({ agentId }) =>
      Effect.fail(new AgentRegistryError({ agentId, reason: "not_found" })),
    ),
  }),
);

/** A fixed registry for tests and for lanes that start before the loader lands. */
export const layerStatic = (entries: ReadonlyArray<ResolvedAgentDefinition>) =>
  Layer.succeed(
    AgentRegistry,
    AgentRegistry.of({
      list: Effect.fn("AgentRegistry.list")(({ search, limit = 50, cursor = 0 }) =>
        Effect.sync(() => {
          const term = search?.trim().toLowerCase();
          const matched =
            term === undefined || term.length === 0
              ? entries
              : entries.filter(
                  ({ definition }) =>
                    definition.id.toLowerCase().includes(term) ||
                    definition.name.toLowerCase().includes(term) ||
                    definition.description.toLowerCase().includes(term),
                );
          const page = matched.slice(cursor, cursor + limit);
          return {
            agents: page.map(toAgentSummary),
            ...(cursor + limit < matched.length ? { nextCursor: cursor + limit } : {}),
          };
        }),
      ),
      read: Effect.fn("AgentRegistry.read")(function* ({ agentId }) {
        const found = entries.find(({ definition }) => definition.id === agentId);
        if (found === undefined) {
          return yield* new AgentRegistryError({ agentId, reason: "not_found" });
        }
        return found;
      }),
    }),
  );

/** The live registry: built-ins plus global and project YAML files. */
export const layer = Layer.effect(AgentRegistry, make);
