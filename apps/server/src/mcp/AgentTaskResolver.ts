import {
  type AgentDelegation,
  type AgentDefinition,
  type AgentId,
  DEFAULT_AGENT_DELEGATION,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpTarget,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ResolvedAgentTask {
  readonly agentId: AgentId;
  readonly definition: AgentDefinition;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** The agent prompt, without markers. The Orchestrator composes the first-message block. */
  readonly instruction: string;
  readonly delegation: AgentDelegation;
}

export interface AgentTaskResolverShape {
  readonly resolve: (input: {
    readonly projectRoot: string;
    readonly agentId: AgentId;
    readonly parent: {
      readonly modelSelection?: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    };
    readonly explicitTarget?: OrchestratorMcpTarget;
    readonly explicitRuntimeMode?: OrchestratorMcpRuntimeMode;
    readonly explicitInteractionMode?: OrchestratorMcpInteractionMode;
    readonly providers: ReadonlyArray<ServerProvider>;
  }) => Effect.Effect<ResolvedAgentTask, OrchestratorMcpFailure>;
}

export class AgentTaskResolver extends Context.Service<AgentTaskResolver, AgentTaskResolverShape>()(
  "t3/mcp/AgentTaskResolver",
) {}

/**
 * Placeholder until the registry-backed resolver lands: every lookup fails as
 * an unknown agent, so the MCP layer graph compiles without changing behavior.
 */
export const layerUnavailable = Layer.succeed(
  AgentTaskResolver,
  AgentTaskResolver.of({
    resolve: Effect.fn("AgentTaskResolver.resolve")(() =>
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "agent_not_found",
          message: "Agent definitions are not available in this build yet.",
        }),
      ),
    ),
  }),
);

/** A fixed resolver for tests and for lanes that start before the registry-backed one lands. */
export const layerStatic = (task: ResolvedAgentTask) =>
  Layer.succeed(
    AgentTaskResolver,
    AgentTaskResolver.of({
      resolve: Effect.fn("AgentTaskResolver.resolve")(() => Effect.succeed(task)),
    }),
  );

export const staticResolvedAgentTask = (input: {
  readonly definition: AgentDefinition;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}): ResolvedAgentTask => ({
  agentId: input.definition.id,
  definition: input.definition,
  modelSelection: input.modelSelection,
  runtimeMode:
    input.runtimeMode ??
    (input.definition.runtimeMode === undefined || input.definition.runtimeMode === "inherit"
      ? "approval-required"
      : input.definition.runtimeMode),
  interactionMode:
    input.interactionMode ??
    (input.definition.interactionMode === undefined ||
    input.definition.interactionMode === "inherit"
      ? "plan"
      : input.definition.interactionMode),
  instruction: input.definition.prompt,
  delegation: input.definition.delegation ?? DEFAULT_AGENT_DELEGATION,
});
