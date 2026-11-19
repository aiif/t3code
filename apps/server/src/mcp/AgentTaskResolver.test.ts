import { AgentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { exampleAgentDefinition, fakeProviderSnapshot } from "../agents/AgentRegistry.testkit.ts";
import { AgentTaskResolver, layerStatic, staticResolvedAgentTask } from "./AgentTaskResolver.ts";

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
