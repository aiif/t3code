import { describe, expect, it } from "@effect/vitest";

import { BUILTIN_AGENTS } from "../../apps/server/src/agents/builtin.ts";
import { NO_PERSONA_AGENT_ID, agentDefinitionCases } from "./cases.ts";
import { gradeAgentCase, type AgentCaseOutput } from "./grading.ts";

const output: AgentCaseOutput = {
  delegatedAgentIds: ["t3-coder"],
  completedAgentIds: ["t3-coder"],
  editedFiles: ["src/a.ts"],
  delegatedProviders: ["claude-code:sonnet"],
  citations: [],
  subQueryCount: 0,
  reported: true,
  maxSameTurnDispatches: 1,
  delegationPrecededEdits: true,
  testEvidence: true,
  delegations: [{ agentId: "t3-coder", provider: "claude-code" }],
};

describe("gradeAgentCase", () => {
  it("passes a delegating coder", () => {
    expect(
      gradeAgentCase({
        expectation: { delegatesBeforeEditing: true, allowedAgents: ["t3-coder"] },
        output,
      }),
    ).toEqual({ pass: true, failures: [] });
  });

  it("fails a read-only case that edited files", () => {
    const result = gradeAgentCase({ expectation: { readOnly: true }, output });
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual(["edited src/a.ts but the case is read-only."]);
  });

  it("fails a non-delegating case that delegated", () => {
    expect(gradeAgentCase({ expectation: { noDelegation: true }, output }).pass).toBe(false);
  });

  it("fails a debate that used one provider", () => {
    expect(gradeAgentCase({ expectation: { distinctProviders: true }, output }).pass).toBe(false);
  });

  it("fails a deep-research report below the citation floor", () => {
    expect(gradeAgentCase({ expectation: { minimumCitations: 2 }, output }).pass).toBe(false);
  });

  it("fails a control that did not edit anything", () => {
    expect(
      gradeAgentCase({
        expectation: { editsFiles: true },
        output: { ...output, editedFiles: [] },
      }),
    ).toEqual({ pass: false, failures: ["did not edit any files."] });
  });

  it("fails below the delegation floor", () => {
    expect(gradeAgentCase({ expectation: { minimumDelegations: 2 }, output }).failures).toEqual([
      "delegated 1, expected at least 2.",
    ]);
  });

  it("fails two dispatches made in separate turns", () => {
    expect(
      gradeAgentCase({
        expectation: { sameTurnDispatches: 2 },
        output: { ...output, maxSameTurnDispatches: 1 },
      }).failures,
    ).toEqual(["dispatched 1 in one turn, expected at least 2."]);
  });

  it("fails a coder without test evidence", () => {
    expect(
      gradeAgentCase({
        expectation: { testEvidence: true },
        output: { ...output, testEvidence: false },
      }).failures,
    ).toEqual(["did not report test evidence."]);
  });

  it("fails an edit made before the first delegation", () => {
    expect(
      gradeAgentCase({
        expectation: { delegatesBeforeEditing: true },
        output: { ...output, delegationPrecededEdits: false },
      }).failures,
    ).toEqual(["edited files before delegating."]);
  });

  it("counts two models on one provider as one provider", () => {
    expect(
      gradeAgentCase({
        expectation: { distinctProviders: true },
        output: {
          ...output,
          delegatedProviders: ["claude-code:sonnet", "claude-code:opus"],
        },
      }).failures,
    ).toEqual(["did not use two distinct providers."]);
  });

  it("passes two children on different providers", () => {
    expect(
      gradeAgentCase({
        expectation: { distinctProviders: true },
        output: {
          ...output,
          delegatedProviders: ["claude-code:sonnet", "codex:gpt-6-luna"],
        },
      }),
    ).toEqual({ pass: true, failures: [] });
  });

  it("fails a review on the implementer's provider", () => {
    expect(
      gradeAgentCase({
        expectation: { differentProviderAgents: ["t3-coder", "t3-reviewer"] },
        output: {
          ...output,
          delegations: [
            { agentId: "t3-coder", provider: "claude-code" },
            { agentId: "t3-reviewer", provider: "claude-code" },
          ],
        },
      }).failures,
    ).toEqual(["t3-coder and t3-reviewer used the same provider."]);
  });

  it("passes a review on another provider", () => {
    expect(
      gradeAgentCase({
        expectation: { differentProviderAgents: ["t3-coder", "t3-reviewer"] },
        output: {
          ...output,
          delegations: [
            { agentId: "t3-coder", provider: "claude-code" },
            { agentId: "t3-reviewer", provider: "codex" },
          ],
        },
      }),
    ).toEqual({ pass: true, failures: [] });
  });
});

describe("agentDefinitionCases", () => {
  it("defines the six cases over built-in personas", () => {
    expect(agentDefinitionCases.map((testCase) => testCase.id)).toEqual([
      "baseline",
      "t3-tech-lead",
      "t3-coder",
      "t3-reviewer",
      "t3-debate",
      "t3-deep-research",
    ]);
    for (const testCase of agentDefinitionCases) {
      if (testCase.agentId === NO_PERSONA_AGENT_ID) continue;
      expect(BUILTIN_AGENTS.some((definition) => definition.id === testCase.agentId)).toBe(true);
    }
    expect(agentDefinitionCases[0]?.agentId).toBe(NO_PERSONA_AGENT_ID);
  });
});
