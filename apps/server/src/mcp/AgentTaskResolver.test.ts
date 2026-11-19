import {
  type AgentDefinition,
  AgentId,
  type ModelSelection,
  type OrchestratorMcpTarget,
  OrchestratorMcpFailure,
  type ServerProvider,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ResolvedAgentDefinition } from "../agents/AgentRegistry.ts";
import {
  exampleAgentDefinition,
  fakeProviderSnapshot,
  staticAgentRegistryLayer,
} from "../agents/AgentRegistry.testkit.ts";
import {
  AgentTaskResolver,
  layer,
  layerStatic,
  type ResolvedAgentTask,
  staticResolvedAgentTask,
} from "./AgentTaskResolver.ts";

const definition = exampleAgentDefinition("test-agent");
const task = staticResolvedAgentTask({
  definition,
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "test-model" },
});

describe("AgentTaskResolver static layer", () => {
  it.effect("returns the fixed task", () =>
    Effect.gen(function* () {
      const resolver = yield* AgentTaskResolver;
      const resolved = yield* resolver.resolve({
        projectRoot: ".",
        agentId: AgentId.make("test-agent"),
        parent: { runtimeMode: "full-access", interactionMode: "default" },
        providers: [
          fakeProviderSnapshot({
            instanceId: ProviderInstanceId.make("opencode"),
            model: "test-model",
          }),
        ],
      });
      expect(resolved).toEqual(task);
    }).pipe(Effect.provide(layerStatic(task))),
  );

  it("applies the definition modes and delegation", () => {
    expect(task).toMatchObject({
      agentId: "test-agent",
      runtimeMode: "approval-required",
      interactionMode: "plan",
      instruction: definition.prompt,
      delegation: { enabled: false, maxDepth: 1, maxParallel: 2 },
    });
  });
});

const parentSelection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const providerOf = (input: Parameters<typeof fakeProviderSnapshot>[0]): ServerProvider =>
  fakeProviderSnapshot(input);

const resolve = (
  input: {
    readonly agentId: string;
    readonly parentModelSelection?: ModelSelection;
    readonly parentRuntimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly parentInteractionMode?: "plan" | "default";
    readonly explicitTarget?: OrchestratorMcpTarget;
    readonly explicitRuntimeMode?:
      | "inherit"
      | "approval-required"
      | "auto-accept-edits"
      | "auto"
      | "full-access";
    readonly explicitInteractionMode?: "inherit" | "plan" | "default";
    readonly providers: ReadonlyArray<ServerProvider>;
  },
  definitions: ReadonlyArray<ResolvedAgentDefinition>,
) =>
  Effect.gen(function* () {
    const resolver = yield* AgentTaskResolver;
    return yield* resolver.resolve({
      projectRoot: ".",
      agentId: AgentId.make(input.agentId),
      parent: {
        ...(input.parentModelSelection === undefined
          ? {}
          : { modelSelection: input.parentModelSelection }),
        runtimeMode: input.parentRuntimeMode ?? "full-access",
        interactionMode: input.parentInteractionMode ?? "default",
      },
      ...(input.explicitTarget === undefined ? {} : { explicitTarget: input.explicitTarget }),
      ...(input.explicitRuntimeMode === undefined
        ? {}
        : { explicitRuntimeMode: input.explicitRuntimeMode }),
      ...(input.explicitInteractionMode === undefined
        ? {}
        : { explicitInteractionMode: input.explicitInteractionMode }),
      providers: input.providers,
    });
  }).pipe(Effect.provide(layer.pipe(Layer.provide(staticAgentRegistryLayer(definitions)))));

const failure = (
  effect: Effect.Effect<ResolvedAgentTask, OrchestratorMcpFailure>,
): Effect.Effect<string, ResolvedAgentTask> =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

const resolvedDefinition = (definition: AgentDefinition): ResolvedAgentDefinition => ({
  definition,
  source: "builtin",
});

const agentWithProvider = (id: string, provider: AgentDefinition["provider"]): AgentDefinition => ({
  ...exampleAgentDefinition(id),
  provider,
});

const instances = ["parent", "agent", "target"].map((name) => ProviderInstanceId.make(name));

describe("AgentTaskResolver registry layer", () => {
  it.effect("resolves an unknown agent as agent_not_found", () =>
    Effect.gen(function* () {
      const code = yield* failure(
        resolve({ agentId: "not-an-agent", providers: [] }, [resolvedDefinition(definition)]),
      );
      expect(code).toBe("agent_not_found");
    }),
  );

  it.effect("falls back to the parent model selection", () =>
    Effect.gen(function* () {
      const resolved = yield* resolve(
        {
          agentId: "plain",
          parentModelSelection: parentSelection("parent", "parent-model"),
          providers: [providerOf({ instanceId: instances[0]!, model: "parent-model" })],
        },
        [resolvedDefinition(exampleAgentDefinition("plain"))],
      );
      expect(resolved.modelSelection).toEqual({
        instanceId: ProviderInstanceId.make("parent"),
        model: "parent-model",
      });
      expect(resolved.instruction).toBe(exampleAgentDefinition("plain").prompt);
    }),
  );

  it.effect(
    "lets the agent's provider override the parent, and an explicit target override both",
    () =>
      Effect.gen(function* () {
        const withAgentProvider = agentWithProvider("with-provider", {
          instance: instances[1],
          model: "agent-model",
        });
        const providers = [
          providerOf({ instanceId: instances[0]!, model: "parent-model" }),
          providerOf({ instanceId: instances[1]!, model: "agent-model" }),
          providerOf({ instanceId: instances[2]!, model: "target-model" }),
        ];

        const fromAgent = yield* resolve(
          {
            agentId: "with-provider",
            parentModelSelection: parentSelection("parent", "parent-model"),
            providers,
          },
          [resolvedDefinition(withAgentProvider)],
        );
        expect(fromAgent.modelSelection).toEqual({
          instanceId: instances[1],
          model: "agent-model",
        });

        const fromTarget = yield* resolve(
          {
            agentId: "with-provider",
            parentModelSelection: parentSelection("parent", "parent-model"),
            explicitTarget: { providerInstanceId: instances[2], model: "target-model" },
            providers,
          },
          [resolvedDefinition(withAgentProvider)],
        );
        expect(fromTarget.modelSelection).toEqual({
          instanceId: instances[2],
          model: "target-model",
        });
      }),
  );

  it.effect("inherits the parent model when the agent's provider names the same instance", () =>
    Effect.gen(function* () {
      const withAgentProvider = agentWithProvider("same-instance", { instance: instances[0] });
      const resolved = yield* resolve(
        {
          agentId: "same-instance",
          parentModelSelection: parentSelection("parent", "parent-model"),
          providers: [providerOf({ instanceId: instances[0]!, model: "parent-model" })],
        },
        [resolvedDefinition(withAgentProvider)],
      );
      expect(resolved.modelSelection.model).toBe("parent-model");
    }),
  );

  it.effect("lets an agent narrow the runtime mode but never broaden it", () =>
    Effect.gen(function* () {
      const narrows = agentWithProvider("narrows", { instance: instances[0] });
      const narrowsDefinition = { ...narrows, runtimeMode: "approval-required" as const };
      const narrowsProviders = [providerOf({ instanceId: instances[0]!, model: "m" })];
      const narrowed = yield* resolve(
        {
          agentId: "narrows",
          parentRuntimeMode: "full-access",
          providers: narrowsProviders,
        },
        [resolvedDefinition(narrowsDefinition)],
      );
      expect(narrowed.runtimeMode).toBe("approval-required");

      const broadensDefinition = { ...narrows, runtimeMode: "full-access" as const };
      const code = yield* failure(
        resolve(
          {
            agentId: "broadens",
            parentRuntimeMode: "approval-required",
            providers: narrowsProviders,
          },
          [resolvedDefinition({ ...broadensDefinition, id: AgentId.make("broadens") })],
        ),
      );
      expect(code).toBe("runtime_mode_escalation_denied");
    }),
  );

  it.effect("lets an explicit runtime mode override the agent's own", () =>
    Effect.gen(function* () {
      const agent = agentWithProvider("explicit", { instance: instances[0] });
      const definition = { ...agent, runtimeMode: "auto" as const };
      const resolved = yield* resolve(
        {
          agentId: "explicit",
          parentRuntimeMode: "full-access",
          explicitRuntimeMode: "approval-required",
          providers: [providerOf({ instanceId: instances[0]!, model: "m" })],
        },
        [resolvedDefinition(definition)],
      );
      expect(resolved.runtimeMode).toBe("approval-required");
    }),
  );

  it.effect("fails provider_unavailable for a missing instance", () =>
    Effect.gen(function* () {
      const agent = agentWithProvider("missing", { instance: ProviderInstanceId.make("gone") });
      const code = yield* failure(
        resolve(
          {
            agentId: "missing",
            providers: [providerOf({ instanceId: instances[0]!, model: "m" })],
          },
          [resolvedDefinition(agent)],
        ),
      );
      expect(code).toBe("provider_unavailable");
    }),
  );

  it.effect(
    "fails provider_unavailable for a disabled, uninstalled, or unauthenticated instance",
    () =>
      Effect.gen(function* () {
        const disabled = {
          ...providerOf({ instanceId: instances[0]!, model: "m" }),
          enabled: false,
        };
        const disabledCode = yield* failure(
          resolve({ agentId: "disabled", providers: [disabled] }, [
            resolvedDefinition(agentWithProvider("disabled", { instance: instances[0] })),
          ]),
        );
        expect(disabledCode).toBe("provider_unavailable");

        const uninstalled = {
          ...providerOf({ instanceId: instances[0]!, model: "m" }),
          installed: false,
        };
        const uninstalledCode = yield* failure(
          resolve({ agentId: "uninstalled", providers: [uninstalled] }, [
            resolvedDefinition(agentWithProvider("uninstalled", { instance: instances[0] })),
          ]),
        );
        expect(uninstalledCode).toBe("provider_unavailable");

        const unauthenticated = {
          ...providerOf({ instanceId: instances[0]!, model: "m" }),
          auth: { status: "unauthenticated" as const },
        };
        const unauthenticatedCode = yield* failure(
          resolve({ agentId: "unauthenticated", providers: [unauthenticated] }, [
            resolvedDefinition(agentWithProvider("unauthenticated", { instance: instances[0] })),
          ]),
        );
        expect(unauthenticatedCode).toBe("provider_unavailable");
      }),
  );

  it.effect("fails model_unavailable for a model the provider does not advertise", () =>
    Effect.gen(function* () {
      const agent = agentWithProvider("bad-model", { instance: instances[0], model: "not-listed" });
      const code = yield* failure(
        resolve(
          {
            agentId: "bad-model",
            providers: [providerOf({ instanceId: instances[0]!, model: "listed-model" })],
          },
          [resolvedDefinition(agent)],
        ),
      );
      expect(code).toBe("model_unavailable");
    }),
  );

  it.effect("returns the normalized delegation", () =>
    Effect.gen(function* () {
      const delegating = agentWithProvider("delegating", { instance: instances[0] });
      const resolved = yield* resolve(
        {
          agentId: "delegating",
          providers: [providerOf({ instanceId: instances[0]!, model: "m" })],
        },
        [resolvedDefinition(delegating)],
      );
      expect(resolved.delegation.enabled).toBe(false);
      expect(resolved.instruction).toBe(delegating.prompt);
    }),
  );
});
