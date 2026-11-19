import type { AgentCase } from "./grading.ts";

/**
 * Lane evals fills this with the §14 cases: baseline, tech lead, coder,
 * reviewer, debate, and deep research. Prompts must come from the built-in
 * definitions, never copied here.
 */
export const agentDefinitionCases: ReadonlyArray<AgentCase> = [];
