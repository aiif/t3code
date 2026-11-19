import { describe, expect, it } from "@effect/vitest";

import { gradeAgentCase } from "./grading.ts";

const output = {
  delegatedAgentIds: ["t3-coder"],
  editedFiles: ["src/a.ts"],
  delegatedProviders: ["claude-code:sonnet"],
  citations: [],
  subQueryCount: 0,
  reported: true,
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
});
