import type { AgentSummary } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

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
