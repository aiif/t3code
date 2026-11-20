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

import * as AgentRegistry from "../agents/AgentRegistry.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";

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

const advertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

const registryFailure = (
  error: AgentRegistry.AgentRegistryError,
  agentId: AgentId,
): OrchestratorMcpFailure =>
  error.reason === "not_found"
    ? new OrchestratorMcpFailure({
        code: "agent_not_found",
        message: `No agent named ${agentId} was found. Run t3_agent_list.`,
      })
    : new OrchestratorMcpFailure({ code: "agent_invalid", message: error.message });

const providerUnavailable = (agentId: AgentId, message: string): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code: "provider_unavailable",
    message: `Agent ${agentId} cannot run: ${message}`,
  });

const modelUnavailable = (agentId: AgentId, message: string): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code: "model_unavailable",
    message: `Agent ${agentId} cannot run: ${message}`,
  });

const resolveModelSelection = (
  input: Parameters<AgentTaskResolverShape["resolve"]>[0],
  definition: AgentDefinition,
): Effect.Effect<
  { readonly modelSelection: ModelSelection; readonly provider: ServerProvider },
  OrchestratorMcpFailure
> => {
  const { agentId, parent, explicitTarget, providers } = input;
  const agentProvider = definition.provider;
  const parentSelection = parent.modelSelection;

  let instanceId = explicitTarget?.providerInstanceId ?? agentProvider?.instance;
  const requestedDriver = explicitTarget?.driverKind ?? agentProvider?.driver;
  if (instanceId === undefined && requestedDriver !== undefined) {
    const matches = providers.filter((candidate) => candidate.driver === requestedDriver);
    if (matches.length === 0) {
      return Effect.fail(
        providerUnavailable(
          agentId,
          `it requests driver ${requestedDriver}, but no provider instance of that driver is registered. Install or enable one, or set a provider instance on the agent.`,
        ),
      );
    }
    const inherited = matches.find(
      (candidate) => candidate.instanceId === parentSelection?.instanceId,
    );
    instanceId = (inherited ?? matches[0])!.instanceId;
  }
  instanceId ??= parentSelection?.instanceId;

  if (instanceId === undefined) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "target_required",
        message: `Agent ${agentId} has no provider instance and none was inherited or requested. Set the agent's provider instance or model, or pass an explicit target.`,
      }),
    );
  }

  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  if (provider === undefined) {
    return Effect.fail(
      providerUnavailable(
        agentId,
        `it names provider instance ${instanceId}, which is not registered.`,
      ),
    );
  }
  if (!provider.enabled) {
    return Effect.fail(
      providerUnavailable(
        agentId,
        `provider instance ${instanceId} is disabled. Enable it or set a different instance on the agent.`,
      ),
    );
  }
  if (!provider.installed) {
    return Effect.fail(
      providerUnavailable(
        agentId,
        `provider instance ${instanceId} is not installed. Install it or set a different instance on the agent.`,
      ),
    );
  }
  // A provider with no sign-in flow (a local replay or CLI agent) may report
  // unauthenticated until a probe confirms it. An agent that pins it opts into
  // the stricter check; an inherited provider surfaces the real failure at run time.
  const pinnedByAgent =
    definition.provider?.instance !== undefined || definition.provider?.driver !== undefined;
  if (
    provider.auth.status === "unauthenticated" &&
    (pinnedByAgent || provider.setup?.canAuthenticate === true)
  ) {
    return Effect.fail(
      providerUnavailable(
        agentId,
        `provider instance ${instanceId} is not authenticated. Sign in or set a different instance on the agent.`,
      ),
    );
  }

  let model = explicitTarget?.model ?? agentProvider?.model;
  if (model === undefined) {
    model =
      instanceId === parentSelection?.instanceId
        ? parentSelection?.model
        : provider.models[0]?.slug;
  }
  if (model === undefined) {
    return Effect.fail(
      modelUnavailable(
        agentId,
        `provider instance ${instanceId} has no model available to inherit.`,
      ),
    );
  }
  if (provider.models.length > 0 && advertisedModel(provider, model) === undefined) {
    return Effect.fail(
      modelUnavailable(
        agentId,
        `model ${model} is not advertised by provider instance ${instanceId}.`,
      ),
    );
  }

  const options = explicitTarget?.options ?? agentProvider?.options ?? parentSelection?.options;
  return Effect.succeed({
    modelSelection: {
      instanceId,
      model,
      ...(options === undefined ? {} : { options }),
    },
    provider,
  });
};

/**
 * Registry-backed resolver: reads the agent definition, then applies the
 * parent model selection, the agent's provider defaults, an explicit target,
 * and finally the explicit runtime/interaction modes. Depends only on
 * `AgentRegistry` and the provider snapshots passed in.
 */
export const makeAgentTaskResolver = (
  registry: AgentRegistry.AgentRegistryShape,
): AgentTaskResolverShape =>
  AgentTaskResolver.of({
    resolve: Effect.fn("AgentTaskResolver.resolve")(function* (input) {
      const resolved = yield* registry
        .read({ agentId: input.agentId, projectRoot: input.projectRoot })
        .pipe(Effect.mapError((error) => registryFailure(error, input.agentId)));
      const definition = resolved.definition;

      const { modelSelection, provider } = yield* resolveModelSelection(input, definition);

      const runtimeMode = yield* resolveRuntimeMode(
        input.parent.runtimeMode,
        input.explicitRuntimeMode ?? definition.runtimeMode,
        provider.supportedRuntimeModes === undefined
          ? undefined
          : { modelSelection, supportedRuntimeModes: provider.supportedRuntimeModes },
      );
      const interactionMode = yield* resolveInteractionMode(
        input.parent.interactionMode,
        input.explicitInteractionMode ?? definition.interactionMode,
      );

      return {
        agentId: input.agentId,
        definition,
        modelSelection,
        runtimeMode,
        interactionMode,
        instruction: definition.prompt,
        delegation: definition.delegation ?? DEFAULT_AGENT_DELEGATION,
      };
    }),
  });

export const layer = Layer.effect(
  AgentTaskResolver,
  Effect.gen(function* () {
    const registry = yield* AgentRegistry.AgentRegistry;
    return makeAgentTaskResolver(registry);
  }),
);

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
