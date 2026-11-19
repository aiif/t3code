import {
  AgentDefinition,
  AgentId,
  AgentSource,
  AgentSummary,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
  clampedPositiveInt,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as AgentRegistry from "../../../agents/AgentRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  AgentRegistry.AgentRegistry,
];

const AgentListTool = Tool.make("t3_agent_list", {
  description:
    "List named agent definitions available to this project: built-in, global, and project. Short summaries; use t3_agent_read for the prompt and delegation limits. Use an id with delegate_task, create_threads, or t3_thread_launch.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    search: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    limit: Schema.optional(clampedPositiveInt(50)),
    cursor: Schema.optional(NonNegativeInt),
  }),
  success: Schema.Struct({
    agents: Schema.Array(AgentSummary),
    nextCursor: Schema.optional(NonNegativeInt),
    warnings: Schema.optional(Schema.Array(Schema.String)),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List agent definitions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const AgentReadTool = Tool.make("t3_agent_read", {
  description:
    "Read one agent definition, including its prompt, provider/model defaults, and delegation limits. Do not print the prompt to the user unless they ask.",
  parameters: Schema.Struct({
    agentId: AgentId,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    agent: AgentDefinition,
    source: AgentSource,
    path: Schema.optional(Schema.String),
    warnings: Schema.optional(Schema.Array(Schema.String)),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read an agent definition")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentToolkit = Toolkit.make(AgentListTool, AgentReadTool);
