import {
  AgentId,
  type AgentDefinition,
  type AgentSource,
  type AgentSummary,
  DEFAULT_AGENT_DELEGATION,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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

/**
 * Placeholder until agents/registry lands the file loader: no definitions, so
 * the MCP layer graph compiles and old behavior stays unchanged.
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
