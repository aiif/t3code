import { AgentId, type EnvironmentId } from "@t3tools/contracts";
import { BrainCircuitIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { agentDisplayName, useAgentList } from "../../state/agents";
import { cn } from "~/lib/utils";

/**
 * The agent prompt stored in a thread's first message, folded so it does not dominate the
 * transcript. The markers stay in the stored text for the provider; only the UI hides them.
 */
export function AgentInstructionChip(props: {
  environmentId: EnvironmentId;
  projectRoot: string | null;
  agentId: string;
  prompt: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const list = useAgentList({
    environmentId: props.environmentId,
    projectRoot: props.projectRoot,
  });
  const name = agentDisplayName(list.data?.agents ?? [], AgentId.make(props.agentId));
  return (
    <div data-slot="agent-instruction" className="mb-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background/50 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
      >
        <BrainCircuitIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate font-medium">{name ?? props.agentId}</span>
        <span className="shrink-0 opacity-70">agent instruction</span>
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <div className="mt-1.5 max-h-72 overflow-auto rounded-md border border-border/60 bg-background/40 p-2 text-xs whitespace-pre-wrap text-muted-foreground">
          {props.prompt}
        </div>
      ) : null}
    </div>
  );
}
