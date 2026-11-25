import type { AgentId, AgentSummary, EnvironmentId } from "@t3tools/contracts";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { BrainCircuitIcon, ChevronDownIcon, CheckIcon } from "lucide-react";
import { msg, T, useGT } from "gt-react";
import { useRef } from "react";

import { m } from "~/i18n/messages";
import { useAgentList } from "../../state/agents";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { agentDelegationLabel, groupAgentChoices } from "./ComposerAgentPicker.logic";

const ITEM_CLASS =
  "flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent";
const GROUP_LABEL_CLASS =
  "px-2 pt-2 pb-0.5 font-medium text-2xs text-muted-foreground uppercase tracking-wide";
const GROUP_HINT_CLASS = "px-2 pb-1 text-2xs text-muted-foreground/80";

function sourceLabel(source: AgentSummary["source"]): string {
  if (source === "project") return m(msg("Project"));
  if (source === "global") return m(msg("Global"));
  return m(msg("Built-in"));
}

function agentSubtitle(agent: AgentSummary): string {
  const provider =
    agent.providerInstanceId !== null
      ? agent.model === null
        ? agent.providerInstanceId
        : `${agent.providerInstanceId} · ${agent.model}`
      : agent.model;
  const source = sourceLabel(agent.source);
  return provider === null ? source : `${source} · ${provider}`;
}

function AgentChoice(props: {
  readonly agent: AgentSummary;
  readonly agents: ReadonlyArray<AgentSummary>;
  readonly selected: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem value={props.agent.id} closeOnClick className={ITEM_CLASS}>
      <span className="flex min-w-0 items-center gap-2 text-sm">
        {props.selected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
        <span className="truncate font-medium">{props.agent.name}</span>
        <span className="ms-auto shrink-0 font-mono text-2xs text-muted-foreground">
          {props.agent.id}
        </span>
      </span>
      <span className="truncate ps-5.5 text-xs text-muted-foreground">
        {agentSubtitle(props.agent)}
      </span>
      <span className="truncate ps-5.5 text-2xs text-muted-foreground/80">
        {agentDelegationLabel(props.agent, props.agents)}
      </span>
    </MenuPrimitive.RadioItem>
  );
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
  const gt = useGT();
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
  const { teamLeads, specialists } = groupAgentChoices(agents);
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
            aria-label={
              selected === null
                ? gt("Agent: Default")
                : gt("Agent: {name}", { name: selected.name })
            }
          />
        }
      >
        <ComposerControlIcon icon={BrainCircuitIcon} size={props.size} />
        <span data-composer-control-label className="max-w-32 truncate">
          {selected?.name ?? <T>Default</T>}
        </span>
        <ChevronDownIcon data-composer-control-chevron className="opacity-60" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="w-[22rem] max-w-[calc(100vw-2rem)]"
        {...composerFloatingLayerProps}
      >
        <div className="px-2 pt-1.5 pb-1">
          <div className="font-medium text-sm">
            <T>Agent</T>
          </div>
          <p className="text-xs text-muted-foreground">
            <T>Start with a team lead, a specialist, or a plain thread.</T>
          </p>
        </div>
        {list.isPending && agents.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            <T>Loading agents…</T>
          </div>
        ) : (
          <MenuPrimitive.RadioGroup
            aria-label={gt("Agent")}
            value={props.selectedAgentId ?? ""}
            onValueChange={(value: string) => {
              props.onSelect(agents.find((agent) => agent.id === value) ?? null);
            }}
          >
            <MenuPrimitive.RadioItem value="" closeOnClick className={ITEM_CLASS}>
              <span className="flex items-center gap-2 text-sm">
                {props.selectedAgentId === null ? <CheckIcon className="size-3.5" /> : null}
                <span className="font-medium">
                  <T>Default</T>
                </span>
              </span>
              <span className="ps-5.5 text-xs text-muted-foreground">
                <T>A normal thread. The provider's coding agent handles the task.</T>
              </span>
            </MenuPrimitive.RadioItem>
            {teamLeads.length > 0 ? (
              <MenuPrimitive.Group>
                <MenuPrimitive.GroupLabel className={GROUP_LABEL_CLASS}>
                  <T>Team leads</T>
                </MenuPrimitive.GroupLabel>
                <p className={GROUP_HINT_CLASS}>
                  <T>Plans the work and delegates to specialists.</T>
                </p>
                {teamLeads.map((agent) => (
                  <AgentChoice
                    key={agent.id}
                    agent={agent}
                    agents={agents}
                    selected={props.selectedAgentId === agent.id}
                  />
                ))}
              </MenuPrimitive.Group>
            ) : null}
            {specialists.length > 0 ? (
              <MenuPrimitive.Group>
                <MenuPrimitive.GroupLabel className={GROUP_LABEL_CLASS}>
                  <T>Specialists</T>
                </MenuPrimitive.GroupLabel>
                <p className={GROUP_HINT_CLASS}>
                  <T>Usually spawned by a team lead.</T>
                </p>
                {specialists.map((agent) => (
                  <AgentChoice
                    key={agent.id}
                    agent={agent}
                    agents={agents}
                    selected={props.selectedAgentId === agent.id}
                  />
                ))}
              </MenuPrimitive.Group>
            ) : null}
          </MenuPrimitive.RadioGroup>
        )}
        {list.error === null ? null : (
          <p className="px-2 py-1.5 text-xs text-destructive">{list.error}</p>
        )}
      </MenuPopup>
    </Menu>
  );
}
