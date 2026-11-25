import { AgentId, ProviderInstanceId, type AgentSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentDelegationLabel,
  agentSourceLabel,
  groupAgentChoices,
} from "./new-task-agent-options";

function agent(id: string, name: string, overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: AgentId.make(id),
    name,
    description: "",
    source: "builtin",
    providerInstanceId: null,
    driverKind: null,
    model: null,
    delegationEnabled: false,
    allowedAgents: null,
    maxDepth: 1,
    maxParallel: 2,
    ...overrides,
  };
}

const coder = agent("t3-coder", "T3 Coder");
const reviewer = agent("t3-reviewer", "T3 Reviewer");
const lead = agent("t3-tech-lead", "T3 Tech Lead", {
  delegationEnabled: true,
  allowedAgents: [coder.id, reviewer.id],
  maxDepth: 2,
  maxParallel: 4,
});

describe("groupAgentChoices", () => {
  it("keeps leads and specialists in their listed order", () => {
    const specialist = agent("t3-researcher", "T3 Researcher");
    const grouped = groupAgentChoices([lead, coder, specialist, reviewer]);

    expect(grouped.teamLeads).toEqual([lead]);
    expect(grouped.specialists).toEqual([coder, specialist, reviewer]);
  });
});

describe("agentDelegationLabel", () => {
  it("names the allowed agents and the parallel limit", () => {
    expect(agentDelegationLabel(lead, [lead, coder, reviewer])).toBe(
      "Delegates to T3 Coder, T3 Reviewer · 4 at once",
    );
  });

  it("falls back to the id for an agent outside the visible list", () => {
    expect(
      agentDelegationLabel({ ...lead, allowedAgents: [AgentId.make("missing")] }, [lead]),
    ).toBe("Delegates to missing · 4 at once");
  });

  it("describes an unrestricted or empty allowlist", () => {
    expect(agentDelegationLabel({ ...lead, allowedAgents: null }, [lead])).toContain(
      "Delegates to any agent",
    );
    expect(agentDelegationLabel({ ...lead, allowedAgents: [] }, [lead])).toContain(
      "Delegates to no agents",
    );
  });

  it("says a specialist cannot delegate", () => {
    expect(agentDelegationLabel(coder, [lead, coder])).toBe(
      "Runs one scoped task · cannot delegate",
    );
  });
});

describe("agentSourceLabel", () => {
  it("shows the definition source and inherited provider", () => {
    expect(agentSourceLabel(agent("local", "Local", { source: "project" }))).toBe("Project");
    expect(
      agentSourceLabel(
        agent("pinned", "Pinned", {
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      ),
    ).toBe("Built-in · codex · gpt-5.4");
  });
});
