import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AgentId,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  builtinResolvedAgents,
  exampleAgentDefinition,
  staticAgentRegistryLayer,
} from "../agents/AgentRegistry.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as AgentRegistry from "../agents/AgentRegistry.ts";
import * as AgentTaskResolver from "./AgentTaskResolver.ts";
import { staticResolvedAgentTask } from "./AgentTaskResolver.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const environmentId = EnvironmentId.make("environment:agents");
const projectId = ProjectId.make("project:agents");
const parentThreadId = ThreadId.make("thread:agents-parent");
const childThreadId = ThreadId.make("thread:agents-child");

const agentDefinition = exampleAgentDefinition("test-agent");
const resolvedTask = staticResolvedAgentTask({
  definition: agentDefinition,
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "test-model" },
  runtimeMode: "auto",
  interactionMode: "default",
});

const threadScope = (agentId?: AgentId): McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:agents",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider:agents",
    providerInstanceId: ProviderInstanceId.make("codex"),
    ...(agentId === undefined ? {} : { agentId }),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const parentRun = {
  id: RunId.make("run:agents-parent"),
  ordinal: 1,
  status: "running",
  rootNodeId: NodeId.make("node:agents-root"),
  providerInstanceId: ProviderInstanceId.make("codex"),
} as unknown as OrchestrationV2Run;

const parentProjection = {
  thread: { ...liveThreadShell(parentThreadId), projectId },
  runs: [parentRun],
} as unknown as OrchestrationV2ThreadProjection;

type ThreadsService = ThreadManagementService.ThreadManagementService["Service"];
const baseDependencies = (threads: Partial<ThreadsService>) =>
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          id === parentThreadId
            ? ({ ...liveThreadShell(parentThreadId), projectId } as OrchestrationV2ThreadShell)
            : liveThreadShell(id),
        ),
      getThreadRecords: (id) =>
        Effect.succeed(
          (id === parentThreadId
            ? parentProjection
            : idleThreadProjection(liveThreadShell(id))) as never,
        ),
      hasReceipt: () => Effect.succeed(false),
      assertProviderInstanceEnabled: () => Effect.void,
      ...threads,
    }),
    ServerSettings.layerTest(),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeedSome({
          id,
          workspaceRoot: "/projects/test",
          defaultModelSelection: null,
        } as never),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(RemoteDelegation.RemoteDelegation)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  );

const serviceLayer = (registry: Layer.Layer<AgentRegistry.AgentRegistry, never, never>) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(registry),
    Layer.provide(AgentTaskResolver.layerStatic(resolvedTask)),
  );

const run = <A, E>(
  registry: Layer.Layer<AgentRegistry.AgentRegistry, never, never>,
  threads: Partial<ThreadsService>,
  use: (service: OrchestratorMcpService.OrchestratorMcpServiceShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* use(service);
  }).pipe(Effect.provide(serviceLayer(registry).pipe(Layer.provide(baseDependencies(threads)))));

const record = (dispatched: Ref.Ref<ReadonlyArray<unknown>>) => (command: unknown) =>
  Ref.update(dispatched, (commands) => [...commands, command]).pipe(
    Effect.as({ storedEvents: [] } as never),
  );

describe("OrchestratorMcpService agents", () => {
  it.effect("capabilities lists agents built-ins first and sets the agent flags", () =>
    Effect.gen(function* () {
      const projectEntry = {
        definition: exampleAgentDefinition("project-agent"),
        source: "project" as const,
      };
      const registry = staticAgentRegistryLayer([...builtinResolvedAgents(), projectEntry]);
      const result = yield* run(registry, {}, (service) => service.capabilities(threadScope(), {}));
      const sources = result.agents.map((agent) => agent.source);
      expect(sources.indexOf("builtin")).toBeLessThan(sources.indexOf("project"));
      expect(result.agents.map((agent) => agent.id)).toContain("project-agent");
      expect(result.agents.every((agent) => !("prompt" in agent))).toBe(true);
      expect(result.features).toMatchObject({
        agentDefinitions: true,
        agentDelegation: true,
        maxAgents: 20,
      });
    }),
  );

  it.effect(
    "delegate_task passes the resolved agent onto the command and keeps the task clean",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        yield* run(staticAgentRegistryLayer(), { dispatch: record(dispatched) }, (service) =>
          service
            .delegateTask(threadScope(), { task: "Build it", agent: AgentId.make("test-agent") })
            .pipe(Effect.flip),
        );
        const command = (yield* Ref.get(dispatched))[0] as {
          readonly type: string;
          readonly agentId: string;
          readonly agentInstruction: string;
          readonly task: string;
          readonly modelSelection: { readonly model: string };
          readonly runtimeMode: string;
        };
        expect(command).toMatchObject({
          type: "delegated_task.request",
          agentId: "test-agent",
          agentInstruction: "You are test-agent. Do the task.",
          task: "Build it",
          modelSelection: { model: "test-model" },
          runtimeMode: "auto",
        });
      }),
  );

  it.effect("delegate_task fails agent_not_found when the resolver cannot find the agent", () =>
    Effect.gen(function* () {
      const layer = OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(staticAgentRegistryLayer()),
        Layer.provide(AgentTaskResolver.layerUnavailable),
        Layer.provide(baseDependencies({})),
      );
      const error = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service
          .delegateTask(threadScope(), { task: "Build it", agent: AgentId.make("missing") })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      expect(error.code).toBe("agent_not_found");
    }),
  );

  it.effect(
    "create_threads composes the message, derives the title from the prompt, and passes the agentId",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const result = yield* run(
          staticAgentRegistryLayer(),
          { dispatch: record(dispatched) },
          (service) =>
            service.createThreads(threadScope(), {
              threads: [{ prompt: "Ship the feature", agent: AgentId.make("test-agent") }],
            }),
        );
        const command = (yield* Ref.get(dispatched))[0] as {
          readonly type: string;
          readonly agentId: string;
          readonly title: string;
          readonly initialMessage?: { readonly text: string };
        };
        expect(command.type).toBe("thread.create");
        expect(command.agentId).toBe("test-agent");
        expect(command.title).toBe("Ship the feature");
        expect(command.initialMessage?.text).toContain("<!-- t3:agent:test-agent -->");
        expect(command.initialMessage?.text).toContain("You are test-agent. Do the task.");
        expect(command.initialMessage?.text).toContain("Ship the feature");
        expect(result.threads[0]?.agentId).toBe("test-agent");
      }),
  );

  it.effect("t3_thread_list returns the shell's agentId", () =>
    Effect.gen(function* () {
      const shell = { ...liveThreadShell(childThreadId), agentId: AgentId.make("t3-coder") };
      const result = yield* run(
        staticAgentRegistryLayer(),
        {
          getThreadShell: (id: ThreadId) =>
            Effect.succeed(
              id === parentThreadId
                ? ({ ...liveThreadShell(parentThreadId), projectId } as never)
                : (shell as never),
            ),
          listProjectThreads: () => Effect.succeed([shell] as never),
          getShellSnapshot: () => Effect.succeed({ threads: [shell] } as never),
        },
        (service) => service.listThreads(threadScope(), {}),
      );
      expect(result.threads[0]?.agentId).toBe("t3-coder");
    }),
  );

  it.effect("t3_thread_read returns the projection's agentId", () =>
    Effect.gen(function* () {
      const shell = { ...liveThreadShell(childThreadId), agentId: AgentId.make("t3-coder") };
      const result = yield* run(
        staticAgentRegistryLayer(),
        {
          getThreadShell: (id: ThreadId) =>
            Effect.succeed(id === parentThreadId ? null : (shell as never)),
          getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(shell) as never),
          getTimelinePage: () =>
            Effect.succeed({
              items: [],
              totalItems: 0,
              hasMore: false,
              hasEarlier: false,
            } as never),
        },
        (service) => service.readThread(threadScope(), { threadId: childThreadId }),
      );
      expect(result.thread.agentId).toBe("t3-coder");
    }),
  );
});
