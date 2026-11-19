import {
  type AgentDelegation,
  type AgentId,
  OrchestratorMcpFailure,
  type OrchestrationV2AppThreadLineage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** The hard cap on delegation depth, enforced even without an agent definition. */
export const ABSOLUTE_DEPTH_CAP = 8;

/** A delegated child's depth is its parent's plus one. */
export const delegatedChildDepth = (parentDepth: number): number => parentDepth + 1;

/** Whether a lineage names a delegated child (a subagent of its parent). */
export const isDelegatedChild = (lineage: OrchestrationV2AppThreadLineage): boolean =>
  lineage.parentThreadId !== null && lineage.relationshipToParent === "subagent";

/**
 * A thread's delegation depth, walked from its persisted lineage: top-level is
 * 0, a delegated child is its parent's depth plus one. `parentLineage` reads a
 * parent's lineage so the caller controls how far the chain is trusted.
 */
export const depthOfThread = (
  lineage: OrchestrationV2AppThreadLineage,
  parentLineage: (threadId: ThreadId) => OrchestrationV2AppThreadLineage | undefined,
): number => {
  let depth = 0;
  let current: OrchestrationV2AppThreadLineage | undefined = lineage;
  while (
    current !== undefined &&
    current.parentThreadId !== null &&
    current.relationshipToParent === "subagent"
  ) {
    depth += 1;
    current = parentLineage(current.parentThreadId);
  }
  return depth;
};

/** Child task statuses that count as active work toward `maxParallel`. */
const ACTIVE_CHILD_STATUSES = ["queued", "starting", "running", "waiting"] as const;

export const isActiveChildStatus = (status: string): boolean =>
  (ACTIVE_CHILD_STATUSES as ReadonlyArray<string>).includes(status);

/** How many of a batch start work immediately: the entries that carry a prompt. */
export const countImmediatelyStarting = (
  entries: ReadonlyArray<{ readonly prompt?: string | undefined }>,
): number => entries.filter((entry) => (entry.prompt?.trim().length ?? 0) > 0).length;

const forbidden = (message: string) =>
  new OrchestratorMcpFailure({ code: "agent_forbidden", message });

const depthExceeded = (message: string) =>
  new OrchestratorMcpFailure({ code: "agent_depth_exceeded", message });

const parallelLimitReached = (message: string) =>
  new OrchestratorMcpFailure({ code: "agent_parallel_limit_reached", message });

/** `delegation.enabled` and `allowedAgents`, checked before depth and parallelism. */
export const assertAgentAllowed = (input: {
  readonly delegation: AgentDelegation;
  readonly requestedAgentId: AgentId | undefined;
}): Effect.Effect<void, OrchestratorMcpFailure> => {
  const { delegation, requestedAgentId } = input;
  if (!delegation.enabled) {
    return Effect.fail(forbidden("This agent may not delegate work."));
  }
  if (
    delegation.allowedAgents !== undefined &&
    requestedAgentId !== undefined &&
    !delegation.allowedAgents.includes(requestedAgentId)
  ) {
    return Effect.fail(forbidden(`This agent may not delegate to ${requestedAgentId}.`));
  }
  return Effect.void;
};

/** A caller's depth must stay under the absolute cap and, for a defined agent, its maxDepth. */
export const assertDepthWithinLimits = (input: {
  readonly depth: number;
  readonly maxDepth: number | undefined;
}): Effect.Effect<void, OrchestratorMcpFailure> => {
  if (input.depth > ABSOLUTE_DEPTH_CAP) {
    return Effect.fail(
      depthExceeded(
        `Delegation depth ${input.depth} exceeds the absolute cap of ${ABSOLUTE_DEPTH_CAP}.`,
      ),
    );
  }
  if (input.maxDepth !== undefined && input.depth > input.maxDepth) {
    return Effect.fail(
      depthExceeded(
        `Delegation depth ${input.depth} exceeds this agent's maxDepth ${input.maxDepth}.`,
      ),
    );
  }
  return Effect.void;
};

/** Active plus immediately-starting children must stay within `maxParallel`. */
export const assertWithinParallelLimit = (input: {
  readonly activeChildren: number;
  readonly startingNow: number;
  readonly maxParallel: number | undefined;
}): Effect.Effect<void, OrchestratorMcpFailure> => {
  if (input.maxParallel === undefined) return Effect.void;
  if (input.activeChildren + input.startingNow > input.maxParallel) {
    return Effect.fail(
      parallelLimitReached(
        `This agent has ${input.activeChildren} active child tasks and is starting ${input.startingNow} more, above its maxParallel ${input.maxParallel}.`,
      ),
    );
  }
  return Effect.void;
};

/**
 * One check for a caller delegating to a child. A caller with no agent
 * definition keeps today's behavior except the absolute depth cap, so
 * `delegation` and its limits are optional here.
 */
export const assertAgentDelegationAllowed = Effect.fn(
  "agentDelegationGuardrails.assertAgentDelegationAllowed",
)(function* (input: {
  readonly delegation: AgentDelegation | undefined;
  readonly depth: number;
  readonly requestedAgentId: AgentId | undefined;
  readonly activeChildren: number;
  readonly startingNow: number;
}) {
  yield* assertDepthWithinLimits({
    depth: input.depth,
    maxDepth: input.delegation?.maxDepth,
  });
  if (input.delegation === undefined) return yield* Effect.void;
  yield* assertAgentAllowed({
    delegation: input.delegation,
    requestedAgentId: input.requestedAgentId,
  });
  yield* assertWithinParallelLimit({
    activeChildren: input.activeChildren,
    startingNow: input.startingNow,
    maxParallel: input.delegation.maxParallel,
  });
});
