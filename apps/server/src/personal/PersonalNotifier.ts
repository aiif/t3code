import type {
  EnvironmentId,
  OrchestrationV2DomainEvent,
  PersonalRelayState,
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
import * as HttpClient from "effect/http/HttpClient";
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
import {
  type PersonalNotifyInput,
  PersonalRelay,
  PersonalRelayClient,
  layerClient as layerRelayClient,
} from "./PersonalRelay.ts";
import { personalKeyValue } from "../auth/personalKey.ts";

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

/** The wire payload; it must never carry prompts, file content, or command output. */
export function personalNotificationPayload(
  notification: PersonalNotifyInput,
): PersonalNotifyInput {
  return {
    hostId: notification.hostId,
    environmentId: notification.environmentId,
    threadId: notification.threadId,
    phase: notification.phase,
    projectTitle: notification.projectTitle,
    threadTitle: notification.threadTitle,
    hostLabel: notification.hostLabel,
  };
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
  readonly relayStatus: Effect.Effect<PersonalRelayState>;
  readonly notify: (input: PersonalNotifyInput) => Effect.Effect<boolean>;
  readonly now: Effect.Effect<number>;
}

/**
 * Notifies once per thread and phase inside the cooldown. A second approval in
 * the same thread still alerts, while a repeated update of the same wait does
 * not.
 */
export const notifyThread = Effect.fn("PersonalNotifier.notifyThread")(function* (
  threadId: ThreadId,
  deps: NotifierDependencies,
  cooldown: Ref.Ref<ReadonlyMap<string, number>>,
) {
  yield* Effect.gen(function* () {
    const status: PersonalRelayState = yield* deps.relayStatus;
    if (!status.enabled || !status.online || status.hostId === null) return;
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
      hostId: status.hostId,
      environmentId: deps.environmentId,
      threadId,
      phase: state.phase as PersonalNotifyInput["phase"],
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
  const client = yield* PersonalRelayClient;
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
        relayStatus: relay.getStatus(),
        notify: (input) =>
          client.notify(input).pipe(
            Effect.as(true),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
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

/**
 * Only runs when personal mode is on: a missing relay URL, key, or enabled flag
 * yields a notifier that never fires, so startup never depends on the relay.
 */
export const layer: Layer.Layer<
  PersonalNotifier,
  never,
  | ServerConfig.ServerConfig
  | ServerEnvironment.ServerEnvironmentIdentity
  | OrchestrationEventStore.OrchestrationEventStore
  | ThreadManagement.ThreadManagementService
  | ProjectService.ProjectService
  | PersonalRelay
  | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const relayUrl = config.personalRelayUrl?.trim();
    const personalKey = personalKeyValue(config);
    if (
      config.personalEnabled !== true ||
      relayUrl === undefined ||
      relayUrl.length === 0 ||
      personalKey === undefined
    ) {
      return Layer.succeed(PersonalNotifier, { drain: Effect.void });
    }
    return Layer.effect(
      PersonalNotifier,
      make.pipe(Effect.provide(layerRelayClient({ relayUrl, personalKey }))),
    );
  }),
);
