import type { AgentCase } from "./grading.ts";

/** A case with this agent id runs without a persona, as the control. */
export const NO_PERSONA_AGENT_ID = "none";

/**
 * The §14 agent-definition cases. Persona text is never copied here: the runner imports
 * BUILTIN_AGENTS and composes each first message from the current definition.
 */
export const agentDefinitionCases: ReadonlyArray<AgentCase> = [
  {
    id: "baseline",
    source: "persona: none (control)",
    agentId: NO_PERSONA_AGENT_ID,
    task: "The retry helper in `src/retry.ts` gives up after one attempt, and `src/retry.test.ts` fails. Fix the helper and report what you changed and how you verified it.",
    expect: {
      editsFiles: true,
      noDelegation: true,
      reports: true,
    },
  },
  {
    id: "t3-tech-lead",
    source: "persona: T3 Tech Lead",
    agentId: "t3-tech-lead",
    task: "The retry helper in `src/retry.ts` gives up after one attempt, and `src/retry.test.ts` fails. Ship a fix for the retry test. Plan the work and use the built-in agents on this project as your team.",
    expect: {
      delegatesBeforeEditing: true,
      allowedAgents: ["t3-coder", "t3-reviewer", "t3-researcher", "t3-deep-research"],
      minimumDelegations: 2,
      differentProviderAgents: ["t3-coder", "t3-reviewer"],
      reports: true,
    },
  },
  {
    id: "t3-coder",
    source: "persona: T3 Coder",
    agentId: "t3-coder",
    task: "Fix the retry helper in `src/retry.ts` so the retry test passes. Run the tests and report the evidence with your change.",
    expect: {
      editsFiles: true,
      noDelegation: true,
      testEvidence: true,
      reports: true,
    },
  },
  {
    id: "t3-reviewer",
    source: "persona: T3 Reviewer",
    agentId: "t3-reviewer",
    task: "Review the uncommitted diff in this checkout. It changes the retry helper in `src/retry.ts`. Return prioritized findings, highest severity first.",
    expect: {
      readOnly: true,
      noDelegation: true,
      reports: true,
    },
  },
  {
    id: "t3-debate",
    source: "persona: T3 Debate",
    agentId: "t3-debate",
    task: "We need a retry strategy for the API client: exponential backoff with jitter, or fixed-interval retries. Debate both sides and give a recommendation with the tradeoffs.",
    expect: {
      allowedAgents: ["t3-researcher"],
      minimumDelegations: 2,
      sameTurnDispatches: 2,
      distinctProviders: true,
      reports: true,
    },
  },
  {
    id: "t3-deep-research",
    source: "persona: T3 Deep Research",
    agentId: "t3-deep-research",
    task: "Research how production API clients implement retry backoff and jitter. Return a cited report comparing the common approaches and their failure modes.",
    expect: {
      readOnly: true,
      allowedAgents: ["t3-researcher"],
      subQueries: { minimum: 3, maximum: 6 },
      minimumCitations: 3,
      reports: true,
    },
  },
];
