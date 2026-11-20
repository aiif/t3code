import type { AgentId, AgentSummary, EnvironmentId } from "@t3tools/contracts";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { BrainCircuitIcon, ChevronDownIcon, CheckIcon } from "lucide-react";
import { useRef } from "react";

import { useAgentList } from "../../state/agents";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const SOURCE_LABELS = {
  project: "Project",
  global: "Global",
  builtin: "Built-in",
} as const;

function agentSubtitle(agent: AgentSummary): string {
  const provider =
    agent.providerInstanceId !== null
      ? agent.model === null
        ? agent.providerInstanceId
        : `${agent.providerInstanceId} · ${agent.model}`
      : agent.model;
  return provider === null
    ? SOURCE_LABELS[agent.source]
    : `${SOURCE_LABELS[agent.source]} · ${provider}`;
}

/**
 * The agent for a new thread. The server composes the agent's prompt and applies its defaults,
 * so this control only picks an id.
 */
export function ComposerAgentPicker(props: {
  environmentId: EnvironmentId;
  projectRoot: string | null;
  enabled: boolean;
  selectedAgentId: AgentId | null;
  size: ComposerControlSize;
  disabled?: boolean;
  onSelect: (agent: AgentSummary | null) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(!props.enabled);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const list = useAgentList({
    environmentId: props.environmentId,
    projectRoot: props.projectRoot,
    enabled: props.enabled,
  });
  const agents = list.data?.agents ?? [];
  const selected = agents.find((agent) => agent.id === props.selectedAgentId) ?? null;
  if (!props.enabled) return null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={props.size}
            disabled={props.disabled}
            data-composer-shortcut="composer.agent"
            aria-label={selected === null ? "Choose an agent" : `Agent: ${selected.name}`}
          />
        }
      >
        <ComposerControlIcon icon={BrainCircuitIcon} size={props.size} />
        <span data-composer-control-label className="max-w-32 truncate">
          {selected?.name ?? "Agent"}
        </span>
        <ChevronDownIcon data-composer-control-chevron className="opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-80" {...composerFloatingLayerProps}>
        <div className="px-2 pt-1.5 pb-1">
          <div className="font-medium text-sm">Agent</div>
          <p className="text-xs text-muted-foreground">
            Its prompt and defaults apply to this thread's first turn.
          </p>
        </div>
        {list.isPending && agents.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            Loading agents…
          </div>
        ) : (
          <MenuPrimitive.RadioGroup
            aria-label="Agent"
            value={props.selectedAgentId ?? ""}
            onValueChange={(value: string) => {
              props.onSelect(agents.find((agent) => agent.id === value) ?? null);
            }}
          >
            <MenuPrimitive.RadioItem
              value=""
              closeOnClick
              className="flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent"
            >
              <span className="flex items-center gap-2 text-sm">
                {props.selectedAgentId === null ? <CheckIcon className="size-3.5" /> : null}
                No agent
              </span>
              <span className="text-xs text-muted-foreground">
                A plain thread with no agent prompt.
              </span>
            </MenuPrimitive.RadioItem>
            {agents.map((agent) => (
              <MenuPrimitive.RadioItem
                key={agent.id}
                value={agent.id}
                closeOnClick
                className="flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  {props.selectedAgentId === agent.id ? (
                    <CheckIcon className="size-3.5 shrink-0" />
                  ) : null}
                  <span className="truncate font-medium">{agent.name}</span>
                  <span className="ms-auto shrink-0 font-mono text-2xs text-muted-foreground">
                    {agent.id}
                  </span>
                </span>
                <span className="truncate ps-5.5 text-xs text-muted-foreground">
                  {agentSubtitle(agent)}
                </span>
              </MenuPrimitive.RadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
        )}
        {list.error === null ? null : (
          <p className="px-2 py-1.5 text-xs text-destructive">{list.error}</p>
        )}
      </MenuPopup>
    </Menu>
  );
}
