import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as AgentRegistry from "../../../agents/AgentRegistry.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable, type Caller } from "../../threadAccess.ts";
import { AgentToolkit } from "./tools.ts";

const agentRegistryFailure = (error: AgentRegistry.AgentRegistryError): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not_found"
        ? "agent_not_found"
        : error.reason === "invalid"
          ? "agent_invalid"
          : "orchestration_error",
    message: error.message,
  });

const projectRootOf = (projectId: ProjectId) =>
  ProjectService.ProjectService.pipe(
    Effect.flatMap((projects) => projects.getById(projectId)),
    Effect.mapError(unavailable),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The project was not found.",
            }),
          ),
        onSome: (project) => Effect.succeed(project.workspaceRoot),
      }),
    ),
  );

const resolveProjectRoot = (context: Caller, projectId: ProjectId | undefined) => {
  if (projectId !== undefined) return projectRootOf(projectId);
  if (context.caller !== undefined) return projectRootOf(context.caller.projectId);
  return Effect.succeed(undefined as string | undefined);
};

export const layer = McpToolAccess.toLayer(AgentToolkit, {
  t3_agent_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const registry = yield* AgentRegistry.AgentRegistry;
      const projectRoot = yield* resolveProjectRoot(context, input.projectId);
      const page = yield* registry
        .list({
          ...(projectRoot === undefined ? {} : { projectRoot }),
          ...(input.search === undefined ? {} : { search: input.search }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })
        .pipe(Effect.mapError(agentRegistryFailure));
      return {
        agents: page.agents,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        ...(page.warnings === undefined ? {} : { warnings: page.warnings }),
      };
    }),
  ),
  t3_agent_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const registry = yield* AgentRegistry.AgentRegistry;
      const projectRoot = yield* resolveProjectRoot(context, input.projectId);
      const resolved = yield* registry
        .read({ agentId: input.agentId, ...(projectRoot === undefined ? {} : { projectRoot }) })
        .pipe(Effect.mapError(agentRegistryFailure));
      return {
        agent: resolved.definition,
        source: resolved.source,
        // The file path is a local filesystem detail; linked/remote callers get the definition only.
        ...(context.scope.client?.linked !== true && resolved.path !== undefined
          ? { path: resolved.path }
          : {}),
      };
    }),
  ),
});
