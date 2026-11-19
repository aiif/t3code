import { AgentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  AGENT_INSTRUCTION_CLOSE,
  composeAgentInstruction,
  parseAgentInstruction,
} from "./agentInstruction.ts";

const id = AgentId.make("t3-reviewer");

describe("composeAgentInstruction", () => {
  it("wraps the prompt and keeps the task", () => {
    expect(composeAgentInstruction({ agentId: id, prompt: "Review it.", text: "Task" })).toBe(
      `<!-- t3:agent:t3-reviewer -->\nReview it.\n${AGENT_INSTRUCTION_CLOSE}\nTask`,
    );
  });

  it("replaces an existing block instead of nesting it", () => {
    const once = composeAgentInstruction({ agentId: id, prompt: "Review it.", text: "Task" });
    expect(composeAgentInstruction({ agentId: id, prompt: "Review it.", text: once })).toBe(once);
  });

  it("never wraps an empty prompt", () => {
    expect(composeAgentInstruction({ agentId: id, prompt: "  \n", text: "Task" })).toBe("Task");
  });

  it("preserves CRLF and Unicode task text", () => {
    const composed = composeAgentInstruction({
      agentId: id,
      prompt: "Prompt",
      text: "línea uno\r\n行二",
    });
    expect(parseAgentInstruction(composed).text).toBe("línea uno\r\n行二");
  });
});

describe("parseAgentInstruction", () => {
  it("returns the id, prompt, and task", () => {
    const parsed = parseAgentInstruction(
      `<!-- t3:agent:t3-coder -->\nImplement it.\n${AGENT_INSTRUCTION_CLOSE}\nThe task`,
    );
    expect(parsed).toEqual({ agentId: "t3-coder", prompt: "Implement it.", text: "The task" });
  });

  it("leaves plain text alone", () => {
    expect(parseAgentInstruction("hello")).toEqual({
      agentId: null,
      prompt: null,
      text: "hello",
    });
  });

  it("does not treat an unclosed marker as a block", () => {
    const text = `<!-- t3:agent:t3-coder -->\nImplement it.\nnot closed`;
    expect(parseAgentInstruction(text)).toEqual({ agentId: null, prompt: null, text });
  });

  it("keeps a block with no task as an empty task", () => {
    const parsed = parseAgentInstruction(
      `<!-- t3:agent:t3-coder -->\nImplement it.\n${AGENT_INSTRUCTION_CLOSE}`,
    );
    expect(parsed).toEqual({ agentId: "t3-coder", prompt: "Implement it.", text: "" });
  });
});
