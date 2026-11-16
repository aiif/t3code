import type {
  EnvironmentId,
  OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  type AgentAwarenessPhase,
  type AgentAwarenessState,
  projectThreadAwarenessV2,
} from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { PersonalRelay } from "./PersonalRelay.ts";

/** Phases that interrupt a person; `starting`, `running`, and `stale` stay quiet. */
const PERSONAL_NOTIFICATION_PHASES = [
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
] as const satisfies ReadonlyArray<AgentAwarenessPhase>;

const COOLDOWN_MS = 2 * 60 * 1_000;

function isNotifiablePhase(phase: AgentAwarenessPhase): boolean {
  return (PERSONAL_NOTIFICATION_PHASES as ReadonlyArray<string>).includes(phase);
}

export class PersonalNotifier extends Context.Service<
  PersonalNotifier,
  {
    readonly drain: Effect.Effect<void>;
  }
>()("t3/personal/PersonalNotifier") {}

function shouldEnqueue(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.settled":
    case "thread.unsettled":
    case "run.created":
    case "run.updated":
    case "subagent.updated":
    case "runtime-request.updated":
      return true;
    default:
      return false;
  }
}

export type AwarenessThread = Parameters<typeof projectThreadAwarenessV2>[0]["thread"] & {
  readonly projectId: ProjectId;
  readonly archivedAt: DateTime.Utc | null;
};

export interface NotifierDependencies {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string | null;
  readonly loadThread: (threadId: ThreadId) => Effect.Effect<Option.Option<AwarenessThread>>;
  readonly loadProject: (input: {
    readonly thread: AwarenessThread;
  }) => Effect.Effect<Option.Option<{ readonly title: string }>>;
  readonly sharingOnline: Effect.Effect<boolean>;
  readonly notify: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly phase: "waiting_for_approval" | "waiting_for_input" | "completed" | "failed";
    readonly projectTitle: string;
    readonly threadTitle: string;
    readonly hostLabel: string | null;
  }) => Effect.Effect<void>;
  readonly now: Effect.Effect<number>;
}

/**
 * Notifies once per thread and phase inside the cooldown. A second approval in
 * the same thread still alerts, while a repeated update of the same wait does
 * not.
 */
const notifyThread = Effect.fn("PersonalNotifier.notifyThread")(function* (
  threadId: ThreadId,
  deps: NotifierDependencies,
  cooldown: Ref.Ref<ReadonlyMap<string, number>>,
) {
  yield* Effect.gen(function* () {
    if (!(yield* deps.sharingOnline)) return;
    const thread = yield* deps.loadThread(threadId);
    if (Option.isNone(thread) || thread.value.archivedAt !== null) return;
    const project = yield* deps.loadProject({ thread: thread.value });
    if (Option.isNone(project)) return;
    const state: AgentAwarenessState | null = projectThreadAwarenessV2({
      environmentId: deps.environmentId,
      project: project.value,
      thread: thread.value,
    });
    if (state === null || !isNotifiablePhase(state.phase)) return;

    const now = yield* deps.now;
    const key = `${threadId}:${state.phase}`;
    const lastSent = (yield* Ref.get(cooldown)).get(key);
    if (lastSent !== undefined && now - lastSent < COOLDOWN_MS) return;
    yield* Ref.update(cooldown, (current) => new Map(current).set(key, now));

    yield* deps.notify({
      environmentId: deps.environmentId,
      threadId,
      phase: state.phase as "waiting_for_approval" | "waiting_for_input" | "completed" | "failed",
      projectTitle: state.projectTitle,
      threadTitle: state.threadTitle,
      hostLabel: deps.hostLabel,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Personal notification skipped.", { threadId, cause }),
    ),
  );
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const relay = yield* PersonalRelay;
  const environmentId = yield* environment.getEnvironmentId;
  const cooldown = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    notifyThread(
      threadId,
      {
        environmentId,
        hostLabel: config.personalLabel?.trim() || null,
        loadThread: (id) =>
          threads.getAgentAwarenessSnapshot(id).pipe(
            Effect.map((snapshot) =>
              snapshot.threads[0] === undefined
                ? Option.none<AwarenessThread>()
                : Option.some(snapshot.threads[0] as unknown as AwarenessThread),
            ),
            Effect.catchCause(() => Effect.succeed(Option.none<AwarenessThread>())),
          ),
        loadProject: ({ thread }) =>
          projects.getById(thread.projectId).pipe(
            Effect.map((project) => Option.map(project, (value) => ({ title: value.title }))),
            Effect.catchCause(() => Effect.succeedNone),
          ),
        sharingOnline: relay
          .getStatus()
          .pipe(Effect.map((status) => status.enabled && !status.paused && status.online)),
        notify: (input) => relay.notify(input),
        now: DateTime.now.pipe(Effect.map((now) => now.epochMilliseconds)),
      },
      cooldown,
    ),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const afterSequence = yield* events.latestApplicationSequence;
      yield* events.streamApplicationEvents({ afterSequence }).pipe(
        Stream.filter((stored) => "event" in stored && shouldEnqueue(stored.event)),
        Stream.tapCause((cause) =>
          Effect.logWarning("Personal notifier event stream failed.", { cause }),
        ),
        Stream.retry(Schedule.spaced("5 seconds")),
        Stream.runForEach((stored) =>
          "event" in stored ? worker.enqueue(stored.event.threadId) : Effect.void,
        ),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Personal notifier stopped.", { cause })),
    ),
  );

  return PersonalNotifier.of({ drain: worker.drain });
});

/** Personal-mode builds only; other builds get a notifier that never fires. */
export const layer: Layer.Layer<
  PersonalNotifier,
  never,
  | ServerConfig.ServerConfig
  | ServerEnvironment.ServerEnvironmentIdentity
  | OrchestrationEventStore.OrchestrationEventStore
  | ThreadManagement.ThreadManagementService
  | ProjectService.ProjectService
  | PersonalRelay
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.personalMode !== true) {
      return Layer.succeed(PersonalNotifier, { drain: Effect.void });
    }
    return Layer.effect(PersonalNotifier, make);
  }),
);
