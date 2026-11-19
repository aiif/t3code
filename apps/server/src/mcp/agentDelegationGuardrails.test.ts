import {
  type AgentDelegation,
  AgentId,
  DEFAULT_AGENT_DELEGATION,
  type OrchestrationV2AppThreadLineage,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ABSOLUTE_DEPTH_CAP,
  assertAgentAllowed,
  assertAgentDelegationAllowed,
  assertDepthWithinLimits,
  assertWithinParallelLimit,
  countImmediatelyStarting,
  delegatedChildDepth,
  depthOfThread,
  isActiveChildStatus,
  isDelegatedChild,
} from "./agentDelegationGuardrails.ts";

const delegation = (overrides: Partial<AgentDelegation>): AgentDelegation => ({
  ...DEFAULT_AGENT_DELEGATION,
  ...overrides,
});

const lineage = (
  parentThreadId: ThreadId | null,
  relationshipToParent: "fork" | "subagent" | null,
): OrchestrationV2AppThreadLineage => ({
  parentThreadId,
  relationshipToParent,
  rootThreadId: ThreadId.make("root"),
});

const parentLineageOf =
  (chain: ReadonlyMap<ThreadId, OrchestrationV2AppThreadLineage>) => (threadId: ThreadId) =>
    chain.get(threadId);

describe("agentDelegationGuardrails depth", () => {
  it("counts a top-level thread as depth 0", () => {
    expect(depthOfThread(lineage(null, null), () => undefined)).toBe(0);
  });

  it("counts a fork as depth 0, not a delegation", () => {
    expect(depthOfThread(lineage(ThreadId.make("parent"), "fork"), () => undefined)).toBe(0);
  });

  it("adds one per subagent ancestor", () => {
    const top = lineage(null, null);
    const child = lineage(ThreadId.make("top"), "subagent");
    const grandchild = lineage(ThreadId.make("child"), "subagent");
    const chain = new Map([
      [ThreadId.make("top"), top],
      [ThreadId.make("child"), child],
    ]);
    expect(depthOfThread(grandchild, parentLineageOf(chain))).toBe(2);
  });

  it("stops at a missing ancestor", () => {
    const child = lineage(ThreadId.make("missing"), "subagent");
    expect(depthOfThread(child, () => undefined)).toBe(1);
  });

  it("exposes the child depth and delegation predicates", () => {
    expect(delegatedChildDepth(3)).toBe(4);
    expect(isDelegatedChild(lineage(ThreadId.make("p"), "subagent"))).toBe(true);
    expect(isDelegatedChild(lineage(null, null))).toBe(false);
    expect(isDelegatedChild(lineage(ThreadId.make("p"), "fork"))).toBe(false);
  });
});

describe("agentDelegationGuardrails parallel", () => {
  it("recognizes active child statuses", () => {
    expect(isActiveChildStatus("queued")).toBe(true);
    expect(isActiveChildStatus("starting")).toBe(true);
    expect(isActiveChildStatus("running")).toBe(true);
    expect(isActiveChildStatus("waiting")).toBe(true);
    expect(isActiveChildStatus("completed")).toBe(false);
    expect(isActiveChildStatus("cancelled")).toBe(false);
  });

  it("counts only batch entries that start work immediately", () => {
    expect(
      countImmediatelyStarting([
        { prompt: "do work" },
        { prompt: "  " },
        { prompt: undefined },
        {},
        { prompt: "another task" },
      ]),
    ).toBe(2);
  });

  it.effect("refuses when active plus starting children exceed maxParallel", () =>
    Effect.gen(function* () {
      const error = yield* assertWithinParallelLimit({
        activeChildren: 3,
        startingNow: 2,
        maxParallel: 4,
      }).pipe(Effect.flip);
      expect(error.code).toBe("agent_parallel_limit_reached");
    }),
  );

  it.effect("allows children within maxParallel", () =>
    Effect.gen(function* () {
      yield* assertWithinParallelLimit({ activeChildren: 3, startingNow: 1, maxParallel: 4 });
      yield* assertWithinParallelLimit({
        activeChildren: 2,
        startingNow: 2,
        maxParallel: undefined,
      });
    }),
  );
});

describe("agentDelegationGuardrails allowed", () => {
  it.effect("refuses a non-delegating agent", () =>
    Effect.gen(function* () {
      const error = yield* assertAgentAllowed({
        delegation: delegation({ enabled: false }),
        requestedAgentId: AgentId.make("t3-coder"),
      }).pipe(Effect.flip);
      expect(error.code).toBe("agent_forbidden");
    }),
  );

  it.effect("refuses a child agent outside allowedAgents", () =>
    Effect.gen(function* () {
      const error = yield* assertAgentAllowed({
        delegation: delegation({ enabled: true, allowedAgents: [AgentId.make("t3-coder")] }),
        requestedAgentId: AgentId.make("t3-researcher"),
      }).pipe(Effect.flip);
      expect(error.code).toBe("agent_forbidden");
    }),
  );

  it.effect("allows a listed child agent and an unnamed delegation", () =>
    Effect.gen(function* () {
      yield* assertAgentAllowed({
        delegation: delegation({ enabled: true, allowedAgents: [AgentId.make("t3-coder")] }),
        requestedAgentId: AgentId.make("t3-coder"),
      });
      yield* assertAgentAllowed({
        delegation: delegation({ enabled: true, allowedAgents: [AgentId.make("t3-coder")] }),
        requestedAgentId: undefined,
      });
    }),
  );
});

describe("agentDelegationGuardrails depth limits", () => {
  it.effect("refuses past the absolute cap even without a definition", () =>
    Effect.gen(function* () {
      const error = yield* assertDepthWithinLimits({
        depth: ABSOLUTE_DEPTH_CAP + 1,
        maxDepth: undefined,
      }).pipe(Effect.flip);
      expect(error.code).toBe("agent_depth_exceeded");
    }),
  );

  it.effect("refuses past the agent's maxDepth", () =>
    Effect.gen(function* () {
      const error = yield* assertDepthWithinLimits({ depth: 3, maxDepth: 2 }).pipe(Effect.flip);
      expect(error.code).toBe("agent_depth_exceeded");
    }),
  );

  it.effect("allows below both caps", () =>
    Effect.gen(function* () {
      yield* assertDepthWithinLimits({ depth: ABSOLUTE_DEPTH_CAP, maxDepth: undefined });
      yield* assertDepthWithinLimits({ depth: 2, maxDepth: 2 });
    }),
  );
});

describe("agentDelegationGuardrails combined", () => {
  const base = {
    depth: 0,
    requestedAgentId: AgentId.make("t3-coder"),
    activeChildren: 0,
    startingNow: 1,
  };

  it.effect("keeps today's behavior without a definition except the absolute depth cap", () =>
    Effect.gen(function* () {
      yield* assertAgentDelegationAllowed({ ...base, delegation: undefined });
      const error = yield* assertAgentDelegationAllowed({
        ...base,
        delegation: undefined,
        depth: ABSOLUTE_DEPTH_CAP + 1,
      }).pipe(Effect.flip);
      expect(error.code).toBe("agent_depth_exceeded");
    }),
  );

  it.effect("checks the definition in order: forbidden before depth, depth before parallel", () =>
    Effect.gen(function* () {
      const disabled = yield* assertAgentDelegationAllowed({
        ...base,
        delegation: delegation({ enabled: false }),
      }).pipe(Effect.flip);
      expect(disabled.code).toBe("agent_forbidden");

      const tooDeep = yield* assertAgentDelegationAllowed({
        ...base,
        delegation: delegation({ enabled: true, maxDepth: 1 }),
        depth: 2,
      }).pipe(Effect.flip);
      expect(tooDeep.code).toBe("agent_depth_exceeded");

      const tooMany = yield* assertAgentDelegationAllowed({
        ...base,
        delegation: delegation({ enabled: true, maxDepth: 2, maxParallel: 1 }),
        activeChildren: 1,
      }).pipe(Effect.flip);
      expect(tooMany.code).toBe("agent_parallel_limit_reached");
    }),
  );

  it.effect("allows a compliant delegation", () =>
    assertAgentDelegationAllowed({
      ...base,
      delegation: delegation({ enabled: true, maxDepth: 2, maxParallel: 2 }),
    }),
  );
});
