import {
  CommandId,
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2SubagentTokenUsage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Mirrors a delegated task's child-thread token usage onto the parent's task record. Usage
 * streams per delta, so a report only crosses while the task is active and the context fill
 * moved by a twentieth of the window or the last mirror is two seconds old.
 */
export class DelegatedTaskUsageReactor extends Context.Service<
  DelegatedTaskUsageReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskUsageReactor") {}

const MIN_MIRROR_INTERVAL_MS = 2_000;
const FILL_BUCKET_COUNT = 20;

type MirrorState = { readonly atMs: number; readonly fillBucket: number | null };

function fillBucketOf(usage: OrchestrationV2ProviderTurnTokenUsage): number | null {
  const maxTokens = usage.maxTokens ?? null;
  if (maxTokens === null || maxTokens <= 0) return null;
  return Math.floor(Math.min(1, usage.usedTokens / maxTokens) * FILL_BUCKET_COUNT);
}

function subagentTokenUsageOf(
  usage: OrchestrationV2ProviderTurnTokenUsage,
): OrchestrationV2SubagentTokenUsage {
  return {
    usedTokens: usage.usedTokens,
    maxTokens: usage.maxTokens ?? null,
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    updatedAt: usage.updatedAt,
  };
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const lastMirrored = new Map<NodeId, MirrorState>();

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskUsageReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "provider-turn.updated") return;
      const usage = event.payload.tokenUsage;
      if (usage === undefined) return;
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId: ThreadId | null = child.lineage.parentThreadId;
      if (parentThreadId === null) return;
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
      if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
      const task = parent.subagents.find(
        (candidate) =>
          candidate.origin === "app_owned" &&
          candidate.childThreadId === event.threadId &&
          isOrchestrationV2WorkActive(candidate.status),
      );
      if (task === undefined) return;
      // The command refuses a repeat of the stored mirror; the reactor reads it cheaper.
      if (task.tokenUsage?.updatedAt === usage.updatedAt) return;
      const atMs = Date.parse(usage.updatedAt);
      const previous = lastMirrored.get(task.id);
      const bucket = fillBucketOf(usage);
      if (
        previous !== undefined &&
        (atMs < previous.atMs ||
          (atMs - previous.atMs < MIN_MIRROR_INTERVAL_MS && bucket === previous.fillBucket))
      ) {
        return;
      }
      lastMirrored.set(task.id, { atMs, fillBucket: bucket });
      yield* engine.dispatch({
        type: "delegated_task.usage",
        commandId: CommandId.make(`server:delegated-task-usage:${task.id}:${usage.updatedAt}`),
        parentThreadId,
        taskId: task.id,
        tokenUsage: subagentTokenUsageOf(usage),
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("mirroring delegated task usage failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DelegatedTaskUsageReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task usage event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskUsageReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskUsageReactor, make);
