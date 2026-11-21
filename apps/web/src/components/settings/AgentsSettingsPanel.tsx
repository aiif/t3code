import type { AgentSummary } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { BrainCircuitIcon, CopyIcon, FolderTreeIcon, RefreshCwIcon } from "lucide-react";

import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "../../i18n/messages";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useAgentList } from "../../state/agents";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const SOURCE_LABELS = {
  project: "Project",
  global: "Global",
  builtin: "Built-in",
} as const;

const SOURCE_ORDER: Readonly<Record<AgentSummary["source"], number>> = {
  project: 0,
  global: 1,
  builtin: 2,
};

function projectRootForScope(
  scope: ReturnType<typeof useSettingsScope>["scope"],
  environmentId: string | null,
): string | null {
  if (environmentId === null) return null;
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;
  return (
    scope.members.find((member) => member.environmentId === environmentId)?.workspaceRoot ?? null
  );
}

function providerLabel(agent: AgentSummary, resolve: MessageResolver): string {
  if (agent.providerInstanceId !== null) {
    return agent.model === null
      ? agent.providerInstanceId
      : `${agent.providerInstanceId} · ${agent.model}`;
  }
  if (agent.driverKind !== null) {
    return agent.model === null ? agent.driverKind : `${agent.driverKind} · ${agent.model}`;
  }
  return agent.model ?? resolve(msg("Inherits the thread's provider and model"));
}

function delegationLabel(agent: AgentSummary, resolve: MessageResolver): string {
  if (!agent.delegationEnabled) return resolve(msg("Does not delegate"));
  const targets =
    agent.allowedAgents === null
      ? resolve(msg("any agent"))
      : agent.allowedAgents.length === 0
        ? resolve(msg("no agents"))
        : agent.allowedAgents.join(", ");
  return resolve(
    msg("Delegates to {targets} · depth {depth} · {parallel} at once", {
      targets,
      depth: agent.maxDepth,
      parallel: agent.maxParallel,
    }),
  );
}

function AgentCard({ agent }: { readonly agent: AgentSummary }) {
  const resolve = useMessages();
  const { copyToClipboard } = useCopyToClipboard({ target: namedClipboardTarget("agent id") });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{agent.name}</span>
            <Badge variant="outline" size="sm">
              {SOURCE_LABELS[agent.source]}
            </Badge>
            {agent.fileName === undefined ? null : (
              <span className="text-xs text-muted-foreground">{agent.fileName}</span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{agent.description}</p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => copyToClipboard(agent.id, undefined)}
          aria-label={resolve(msg("Copy agent id {agentId}", { agentId: agent.id }))}
        >
          <CopyIcon className="size-3.5" />
          <span className="font-mono text-xs">{agent.id}</span>
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{providerLabel(agent, resolve)}</span>
        <span>{delegationLabel(agent, resolve)}</span>
      </div>
    </div>
  );
}

export function AgentsSettingsPanel() {
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const projectRoot = projectRootForScope(scope, environmentId);
  const supported =
    environment?.serverConfig?.environment.capabilities.threadAgentDefinitions === true;
  const agents = useAgentList({ environmentId, projectRoot, enabled: supported });

  const sorted = [...(agents.data?.agents ?? [])].sort(
    (left, right) =>
      SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name),
  );

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          <T>Connect an environment to see its agent definitions.</T>
        </p>
      </SettingsPageContainer>
    );
  }
  if (environment?.serverConfig != null && !supported) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          <T>Update this environment to a T3 Code build with agent definitions to use this page.</T>
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="agents"
        title={gt("Agents")}
        titleAction={
          <Button
            size="xs"
            variant="ghost"
            onClick={agents.refresh}
            aria-label={gt("Refresh agent definitions")}
          >
            <RefreshCwIcon className={cn("size-3.5", agents.isPending && "animate-spin")} />
            <T>Refresh</T>
          </Button>
        }
      >
        <div className="flex flex-col gap-3 p-3">
          <p className="text-sm text-muted-foreground">
            <T>
              Named definitions a thread can launch with. Built-ins ship with T3 Code; global and
              project YAML files shadow them by id. Use one from the composer,{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">t3 thread start --agent</code>,
              or <code className="rounded bg-muted px-1 py-0.5 text-xs">delegate_task</code>.
            </T>
          </p>
          {agents.error === null ? null : (
            <p className="text-sm text-destructive">
              {gt("Could not read agent definitions: {error}", { error: agents.error })}
            </p>
          )}
          {agents.isPending && agents.data === null ? (
            <p className="text-sm text-muted-foreground">
              <T>Loading agent definitions…</T>
            </p>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No agent definitions were found. The built-ins should always be available.</T>
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {sorted.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          )}
          {agents.data?.warnings === undefined || agents.data.warnings.length === 0 ? null : (
            <div className="rounded-lg border border-warning/40 bg-warning/8 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <BrainCircuitIcon className="size-4" />
                <T>Definitions that could not be loaded</T>
              </div>
              <ul className="mt-1 list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                {agents.data.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SettingsSection>
      <SettingsSection id="agent-scopes" title={gt("Where definitions live")}>
        <div className="flex flex-col gap-2 p-3 text-sm text-muted-foreground">
          <div className="flex items-start gap-2">
            <FolderTreeIcon className="mt-0.5 size-4 shrink-0" />
            <div>
              <p>
                <T>
                  Global:{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    $T3CODE_HOME/agents/*.yaml
                  </code>
                </T>
              </p>
              <p>
                <T>
                  Project:{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    &lt;project&gt;/.t3code/agents/*.yaml
                  </code>
                </T>
              </p>
            </div>
          </div>
          <p>
            <T>
              A project definition shadows a global definition with the same id, which shadows a
              built-in. Validate a file with{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">t3 agent validate</code> before
              using it.
            </T>
          </p>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
