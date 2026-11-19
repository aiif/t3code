import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AgentToolkit } from "./tools.ts";

it("advertises the agent tool descriptions", () => {
  expect(Tool.getDescription(AgentToolkit.tools.t3_agent_list)).toContain(
    "use t3_agent_read for the prompt and delegation limits",
  );
  expect(Tool.getDescription(AgentToolkit.tools.t3_agent_read)).toContain(
    "Do not print the prompt to the user unless they ask",
  );
});

it("decodes t3_agent_list parameters", () => {
  const decode = Schema.decodeUnknownExit(AgentToolkit.tools.t3_agent_list.parametersSchema);
  expect(Exit.isSuccess(decode({}))).toBe(true);
  expect(
    Exit.isSuccess(decode({ projectId: "project:a", search: "coder", limit: 5, cursor: 0 })),
  ).toBe(true);
});

it("requires an agentId for t3_agent_read", () => {
  const decode = Schema.decodeUnknownExit(AgentToolkit.tools.t3_agent_read.parametersSchema);
  expect(Exit.isFailure(decode({}))).toBe(true);
  expect(Exit.isSuccess(decode({ agentId: "t3-coder" }))).toBe(true);
});
