import type { AgentSummary } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

/** A lead plans and delegates; a specialist runs the one task it was given. */
export function groupAgentChoices(agents: ReadonlyArray<AgentSummary>): {
  readonly teamLeads: ReadonlyArray<AgentSummary>;
  readonly specialists: ReadonlyArray<AgentSummary>;
} {
  return {
    teamLeads: agents.filter((agent) => agent.delegationEnabled),
    specialists: agents.filter((agent) => !agent.delegationEnabled),
  };
}

export function agentDelegationLabel(
  agent: AgentSummary,
  agents: ReadonlyArray<AgentSummary>,
): string {
  if (!agent.delegationEnabled) return m(msg("Runs one scoped task · cannot delegate"));
  const targets =
    agent.allowedAgents === null
      ? [m(msg("any agent"))]
      : agent.allowedAgents.length === 0
        ? [m(msg("no agents"))]
        : agent.allowedAgents.map(
            (id) => agents.find((candidate) => candidate.id === id)?.name ?? id,
          );
  return m(
    msg("Delegates to {targets} · {parallel} at once", {
      targets: targets.join(", "),
      parallel: agent.maxParallel,
    }),
  );
}

export function agentSourceLabel(agent: AgentSummary): string {
  const source =
    agent.source === "project"
      ? m(msg("Project"))
      : agent.source === "global"
        ? m(msg("Global"))
        : m(msg("Built-in"));
  const provider =
    agent.providerInstanceId !== null
      ? agent.model === null
        ? agent.providerInstanceId
        : `${agent.providerInstanceId} · ${agent.model}`
      : agent.model;
  return provider === null ? source : `${source} · ${provider}`;
}
