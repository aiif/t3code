import { expect, it } from "@effect/vitest";
import {
  AgentId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  builtinResolvedAgents,
  exampleAgentDefinition,
  staticAgentRegistryLayer,
} from "../../../agents/AgentRegistry.testkit.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as AgentHandlers from "./handlers.ts";
import { AgentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:agent");
const threadId = ThreadId.make("thread:agent");

const projectEntry = {
  definition: exampleAgentDefinition("project-agent"),
  source: "project" as const,
  path: "C:\\projects\\test\\.t3code\\agents\\project-agent.yaml",
};

const registryLayer = staticAgentRegistryLayer([...builtinResolvedAgents(), projectEntry]);

const threadScope = (linked = false): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:agent",
  thread: {
    threadId,
    providerSessionId: "provider:agent",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: linked
    ? { sessionId: "session-1", label: "Linked", access: "full-access", linked: true }
    : undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const projectService = Layer.mock(ProjectService.ProjectService)({
  getById: (id) => Effect.succeedSome({ id, workspaceRoot: "C:\\projects\\test" } as never),
});

const layer = (scope: McpInvocationContext.McpInvocationScope) =>
  McpToolAccess.HandlersLayer.layer(AgentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        projectService,
        registryLayer,
      ),
    ),
  );

const call = <N extends keyof typeof AgentToolkit.tools>(
  scope: McpInvocationContext.McpInvocationScope,
  name: N,
  params: Schema.Json,
) =>
  Effect.gen(function* () {
    const toolkit = yield* AgentToolkit;
    return yield* toolkit.handle(name, params).pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(Effect.provide(layer(scope)));

it.effect("lists built-in and project agent summaries", () =>
  Effect.gen(function* () {
    const result = yield* call(threadScope(), "t3_agent_list", {});
    const listed = result.at(-1)?.result as {
      readonly agents: ReadonlyArray<{ readonly id: string; readonly source: string }>;
    };
    expect(listed.agents.map((agent) => agent.id)).toContain("project-agent");
    expect(listed.agents.map((agent) => agent.id)).toContain("t3-tech-lead");
    expect(listed.agents.every((agent) => !("prompt" in agent))).toBe(true);
  }),
);

it.effect("searches summaries by term", () =>
  Effect.gen(function* () {
    const result = yield* call(threadScope(), "t3_agent_list", { search: "project-agent" });
    const listed = result.at(-1)?.result as { readonly agents: ReadonlyArray<{ id: string }> };
    expect(listed.agents.map((agent) => agent.id)).toEqual(["project-agent"]);
  }),
);

it.effect("reads a definition with its path for a local caller", () =>
  Effect.gen(function* () {
    const result = yield* call(threadScope(), "t3_agent_read", {
      agentId: AgentId.make("project-agent"),
    });
    const read = result.at(-1)?.result as {
      readonly agent: { readonly id: string };
      readonly source: string;
      readonly path?: string;
    };
    expect(read.agent.id).toBe("project-agent");
    expect(read.source).toBe("project");
    expect(read.path).toBe("C:\\projects\\test\\.t3code\\agents\\project-agent.yaml");
  }),
);

it.effect("strips the path for a linked caller", () =>
  Effect.gen(function* () {
    const result = yield* call(threadScope(true), "t3_agent_read", {
      agentId: AgentId.make("project-agent"),
    });
    const read = result.at(-1)?.result as { readonly path?: string };
    expect(read.path).toBeUndefined();
  }),
);

it.effect("maps a missing agent to agent_not_found", () =>
  Effect.gen(function* () {
    const result = yield* call(threadScope(), "t3_agent_read", {
      agentId: AgentId.make("no-such-agent"),
    });
    expect(result.at(-1)?.result).toMatchObject({ code: "agent_not_found" });
  }),
);

it.effect("defaults to the caller's project outside an explicit projectId", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const scopedLayer = McpToolAccess.HandlersLayer.layer(AgentHandlers.layer).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, threadScope()),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.gen(function* () {
                yield* Ref.update(seen, (ids) => [...ids, id]);
                return yield* Effect.succeedSome({
                  id,
                  workspaceRoot: "C:\\projects\\test",
                } as never);
              }),
          }),
          registryLayer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* AgentToolkit;
      return yield* toolkit.handle("t3_agent_list", {}).pipe(Stream.unwrap, Stream.runCollect);
    }).pipe(Effect.provide(scopedLayer));
    expect(yield* Ref.get(seen)).toEqual([ProjectId.make("project:mcp-test")]);
  }),
);
