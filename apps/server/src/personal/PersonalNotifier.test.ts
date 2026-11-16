import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import {
  notifyThread,
  type NotifierDependencies,
  personalNotificationPayload,
} from "./PersonalNotifier.ts";
const environmentId = EnvironmentId.make("env-home");
const threadId = ThreadId.make("thread-1");

function makeThread(input: {
  readonly updatedAt: DateTime.Utc;
  readonly status?: AgentAwarenessThread["status"];
  readonly pendingRuntimeRequest?: AgentAwarenessThread["pendingRuntimeRequest"];
  readonly archivedAt?: DateTime.Utc | null;
}): AgentAwarenessThread {
  return {
    id: threadId,
    projectId: "project-1",
    title: "Fix the login flow",
    status: input.status ?? "completed",
    activityRunStatus: input.status ?? "completed",
    lineage: { relationshipToParent: "root" },
    pendingRuntimeRequest: input.pendingRuntimeRequest ?? null,
    pendingBackgroundTasks: [],
    latestRunBackgroundWake: null,
    latestRunStopRequested: false,
    settledOverride: null,
    modelSelection: { model: "gpt-5", provider: "openai" },
    updatedAt: input.updatedAt,
    archivedAt: input.archivedAt ?? null,
  } as unknown as AgentAwarenessThread;
}

const onlineStatus = {
  enabled: true,
  relayUrl: "https://t3.example.test",
  hostId: "abcdef123456",
  publicUrl: "https://abcdef123456.t3.example.test",
  label: "Home",
  online: true,
  lastError: null,
} as const;

function deps(
  thread: AgentAwarenessThread,
  sent: Array<unknown>,
  overrides: Partial<NotifierDependencies> = {},
): NotifierDependencies {
  return {
    environmentId,
    hostLabel: "Home",
    loadThread: () => Effect.succeedSome(thread),
    loadProject: () => Effect.succeedSome({ title: "web" }),
    relayStatus: Effect.succeed(onlineStatus),
    notify: (input) =>
      Effect.sync(() => {
        sent.push(personalNotificationPayload(input));
        return true;
      }),
    now: Effect.succeed(1_700_000_000_000),
    ...overrides,
  };
}

it.effect("notifies for an approval wait with a redacted payload", () =>
  Effect.gen(function* () {
    const updatedAt = yield* DateTime.now;
    const sent: Array<unknown> = [];
    const thread = makeThread({
      updatedAt,
      status: "waiting",
      pendingRuntimeRequest: { id: "req-1", kind: "approval" } as never,
    });
    const cooldown = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    yield* notifyThread(threadId, deps(thread, sent), cooldown);

    expect(sent).toEqual([
      {
        hostId: "abcdef123456",
        environmentId: "env-home",
        threadId: "thread-1",
        phase: "waiting_for_approval",
        projectTitle: "web",
        threadTitle: "Fix the login flow",
        hostLabel: "Home",
      },
    ]);
  }),
);

it.effect("stays quiet while the agent is running", () =>
  Effect.gen(function* () {
    const updatedAt = yield* DateTime.now;
    const sent: Array<unknown> = [];
    const thread = makeThread({ updatedAt, status: "running" });
    const cooldown = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    yield* notifyThread(threadId, deps(thread, sent), cooldown);
    expect(sent).toEqual([]);
  }),
);

it.effect("cooldown blocks the same thread and phase but not another phase", () =>
  Effect.gen(function* () {
    const updatedAt = yield* DateTime.now;
    const sent: Array<unknown> = [];
    const cooldown = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const approval = makeThread({
      updatedAt,
      status: "waiting",
      pendingRuntimeRequest: { id: "req-1", kind: "approval" } as never,
    });

    yield* notifyThread(threadId, deps(approval, sent), cooldown);
    yield* notifyThread(threadId, deps(approval, sent), cooldown);
    expect(sent).toHaveLength(1);

    yield* notifyThread(threadId, deps(makeThread({ updatedAt }), sent), cooldown);
    expect(sent).toHaveLength(2);
    expect(sent.map((entry) => (entry as { phase: string }).phase)).toEqual([
      "waiting_for_approval",
      "completed",
    ]);
  }),
);

it.effect("skips archived threads and an offline relay", () =>
  Effect.gen(function* () {
    const updatedAt = yield* DateTime.now;
    const sent: Array<unknown> = [];
    const cooldown = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    yield* notifyThread(
      threadId,
      deps(makeThread({ updatedAt, archivedAt: updatedAt }), sent),
      cooldown,
    );
    expect(sent).toEqual([]);

    yield* notifyThread(
      threadId,
      deps(makeThread({ updatedAt }), sent, {
        relayStatus: Effect.succeed({ ...onlineStatus, online: false }),
      }),
      cooldown,
    );
    expect(sent).toEqual([]);
  }),
);
