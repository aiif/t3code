import { type AgentDefinition, AgentId, DEFAULT_AGENT_DELEGATION } from "@t3tools/contracts";

// Lane agents/registry replaces each placeholder with the persona text from the goal's §6.
const PENDING_PROMPT = "This built-in persona prompt is supplied by the agents/registry lane.";

const techLead: AgentDefinition = {
  schemaVersion: 1,
  id: AgentId.make("t3-tech-lead"),
  name: "T3 Tech Lead",
  description: "Plans work, delegates it to specialist agents, reviews results, and reports.",
  prompt: PENDING_PROMPT,
  delegation: {
    ...DEFAULT_AGENT_DELEGATION,
    enabled: true,
    allowedAgents: [
      AgentId.make("t3-coder"),
      AgentId.make("t3-reviewer"),
      AgentId.make("t3-researcher"),
      AgentId.make("t3-deep-research"),
    ],
    maxDepth: 2,
    maxParallel: 4,
    defaultIsolation: "worktree",
  },
  runtimeMode: "inherit",
  interactionMode: "inherit",
};

const coder: AgentDefinition = {
  schemaVersion: 1,
  id: AgentId.make("t3-coder"),
  name: "T3 Coder",
  description: "Implements one scoped task and reports the diff and test evidence.",
  prompt: PENDING_PROMPT,
  delegation: { ...DEFAULT_AGENT_DELEGATION },
  runtimeMode: "inherit",
  interactionMode: "inherit",
};

const reviewer: AgentDefinition = {
  schemaVersion: 1,
  id: AgentId.make("t3-reviewer"),
  name: "T3 Reviewer",
  description: "Reviews a diff read-only and returns prioritized findings.",
  prompt: PENDING_PROMPT,
  delegation: { ...DEFAULT_AGENT_DELEGATION },
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

const researcher: AgentDefinition = {
  schemaVersion: 1,
  id: AgentId.make("t3-researcher"),
  name: "T3 Researcher",
  description: "Investigates a question and returns a cited summary.",
  prompt: PENDING_PROMPT,
  delegation: { ...DEFAULT_AGENT_DELEGATION },
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

const debate: AgentDefinition = {
  schemaVersion: 1,
  id: AgentId.make("t3-debate"),
  name: "T3 Debate",
  description: "Asks two providers the same question, presents both, and converges after critique.",
  prompt: PENDING_PROMPT,
  delegation: {
    ...DEFAULT_AGENT_DELEGATION,
    enabled: true,
    allowedAgents: [AgentId.make("t3-researcher")],
    maxDepth: 1,
    maxParallel: 2,
  },
  runtimeMode: "inherit",
  interactionMode: "default",
};

const deepResearch: AgentDefinition = {
  schemaVersion: 1,
  id: AgentId.make("t3-deep-research"),
  name: "T3 Deep Research",
  description: "Plans sub-queries, fans out read-only research, and returns a cited report.",
  prompt: PENDING_PROMPT,
  delegation: {
    ...DEFAULT_AGENT_DELEGATION,
    enabled: true,
    allowedAgents: [AgentId.make("t3-researcher")],
    maxDepth: 1,
    maxParallel: 4,
  },
  runtimeMode: "approval-required",
  interactionMode: "plan",
};

export const BUILTIN_AGENTS: ReadonlyArray<AgentDefinition> = [
  techLead,
  coder,
  reviewer,
  researcher,
  debate,
  deepResearch,
];

/** Reserved ids, in list order. A user definition with one of these ids shadows it. */
export const BUILTIN_AGENT_IDS: ReadonlyArray<AgentId> = BUILTIN_AGENTS.map(
  (definition) => definition.id,
);
