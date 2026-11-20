import { createAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/agents";
import type { AgentId, EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const agentEnvironment = createAgentEnvironmentAtoms(connectionAtomRuntime);

/** Named agent definitions for one environment, optionally including a project's YAML. */
export function useAgentList(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRoot?: string | null;
  readonly search?: string | undefined;
  readonly enabled?: boolean;
}) {
  const enabled = input.enabled ?? true;
  return useEnvironmentQuery(
    input.environmentId !== null && enabled
      ? agentEnvironment.list({
          environmentId: input.environmentId,
          input: {
            ...(input.projectRoot == null || input.projectRoot.length === 0
              ? {}
              : { projectRoot: input.projectRoot }),
            ...(input.search === undefined || input.search.trim().length === 0
              ? {}
              : { search: input.search.trim() }),
          },
        })
      : null,
  );
}

/** Display name for an agent id, falling back to the id while the list loads or misses. */
export function agentDisplayName(
  agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>,
  agentId: AgentId | null | undefined,
): string | null {
  if (agentId == null) return null;
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}
