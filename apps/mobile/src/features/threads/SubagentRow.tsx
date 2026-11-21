import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  resolveSubagentMetadata,
  subagentCardDetail,
} from "@t3tools/client-runtime/state/subagent-display";
import {
  contextUsageFromTokenUsage,
  subagentContextUsage,
  subagentProviderTurnTokenUsage,
  type SubagentContextUsage,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentEffort } from "@t3tools/client-runtime/state/thread-execution";
import {
  deriveOutputTokensPerSecond,
  formatTokensPerSecond,
} from "@t3tools/client-runtime/state/token-rate";
import type { EnvironmentId, OrchestrationV2Subagent } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { environmentThreadDetails } from "../../state/threads";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import { resolveSubagentRowPresentation } from "./threadAgentsPresentation";
import { useOutputTokenRate } from "./useOutputTokenRate";
import { useVisibleSecondClock } from "./use-visible-second-clock";

// `id` and `providerThreadId` stay optional: timeline turn items carry neither, and without a
// provider thread the row simply shows no usage.
type SubagentRowSubagent = Omit<
  Pick<
    OrchestrationV2Subagent,
    | "id"
    | "threadId"
    | "childThreadId"
    | "model"
    | "modelSelection"
    | "driver"
    | "providerInstanceId"
    | "providerThreadId"
    | "tokenUsage"
    | "title"
    | "prompt"
    | "status"
    | "progress"
    | "result"
    | "remoteChild"
  >,
  "id" | "providerThreadId"
> & {
  readonly id?: string | undefined;
  readonly providerThreadId?: OrchestrationV2Subagent["providerThreadId"] | undefined;
};

export function SubagentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
  readonly elapsed: ReactNode;
  /** The task runs in a linked environment this app is connected to. */
  readonly canOpenRemote?: boolean;
}) {
  const presentation = resolveSubagentRowPresentation(props.subagent, props.canOpenRemote);
  const detail = subagentCardDetail(presentation.detail);
  const subagent = props.subagent;
  const parentRef = scopeThreadRef(props.environmentId, subagent.threadId);
  // Mirrored usage first (app-owned tasks), then the join over the parent's provider turns.
  const liveUsage = useAtomValue(environmentThreadDetails.threadAtom(parentRef), (thread) =>
    subagent.tokenUsage !== undefined
      ? subagent.tokenUsage
      : subagentProviderTurnTokenUsage(
          subagent.providerThreadId ?? null,
          thread?.projection.providerTurns ?? [],
        ),
  );
  const rateWindow = useOutputTokenRate(
    liveUsage,
    subagent.providerThreadId ?? (subagent.id === undefined ? null : `subagent:${subagent.id}`),
  );
  const contextUsage: SubagentContextUsage | null =
    liveUsage === null
      ? null
      : subagent.tokenUsage !== undefined
        ? subagentContextUsage({ ...subagent, providerThreadId: null }, [])
        : contextUsageFromTokenUsage(liveUsage);
  const active = ["pending", "running", "waiting"].includes(subagent.status);
  const nowMs = useVisibleSecondClock(active);
  const outputRate =
    active && rateWindow !== null ? deriveOutputTokensPerSecond(rateWindow, nowMs) : null;
  return (
    <View className="flex-row gap-3">
      <View className="h-5 justify-center">
        <SubagentStatusDot tone={presentation.tone} placement="sheet" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text
              numberOfLines={1}
              className="min-w-0 shrink font-t3-medium text-sm text-foreground"
            >
              {presentation.title}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              className="shrink-0 text-xs text-foreground-muted"
            >
              ·
            </Text>
            <Text
              className={cn(
                "shrink-0 text-xs font-t3-medium",
                SUBAGENT_TONE_TEXT_CLASS[presentation.tone],
              )}
            >
              {presentation.statusLabel}
            </Text>
            {presentation.runsOn !== null ? (
              <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
                on {presentation.runsOn}
              </Text>
            ) : null}
          </View>
          {contextUsage?.usedPercentage != null ? (
            <Text className="shrink-0 text-xs text-foreground-muted tabular-nums">
              {Math.round(Math.max(0, Math.min(100, contextUsage.usedPercentage)))}%
            </Text>
          ) : null}
          {outputRate !== null ? (
            <Text className="shrink-0 text-xs text-foreground-muted tabular-nums">
              {formatTokensPerSecond(outputRate)}
            </Text>
          ) : null}
          {props.elapsed}
          {presentation.canOpenThread ? (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          ) : null}
        </View>
        <SubagentMetadata environmentId={props.environmentId} subagent={props.subagent} />
        {detail ? (
          <Text
            numberOfLines={3}
            className={cn(
              "text-xs text-foreground-muted",
              presentation.tone === "failed" && SUBAGENT_TONE_TEXT_CLASS.failed,
            )}
          >
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function SubagentMetadata(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: SubagentRowSubagent;
}) {
  const { environmentId, subagent } = props;
  // A task in a linked environment runs a provider instance of that environment.
  const config = useEnvironmentServerConfig(subagent.remoteChild?.environmentId ?? environmentId);
  const providers = (config?.providers ?? []).map((candidate) => {
    const rawConfig = config?.settings.providerInstances[candidate.instanceId]?.config;
    const instanceConfig =
      rawConfig !== null && typeof rawConfig === "object"
        ? (rawConfig as Readonly<Record<string, unknown>>)
        : null;
    const agentId = instanceConfig?.source === "local" ? undefined : instanceConfig?.agentId;
    return {
      ...candidate,
      driverKind: candidate.driver,
      accentColor: normalizeProviderAccentColor(candidate.accentColor),
      acpRegistryAgentId: typeof agentId === "string" ? agentId.trim() || undefined : undefined,
    };
  });
  const provider = providers.find(
    (candidate) => candidate.instanceId === subagent.providerInstanceId,
  );
  const showBadge = provider !== undefined && shouldShowInstanceBadge(provider, providers);
  const parent = useThreadShell(scopeThreadRef(environmentId, subagent.threadId))?.source;
  const child = useThreadShell(
    subagent.childThreadId === null ? null : scopeThreadRef(environmentId, subagent.childThreadId),
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  const selection = subagent.modelSelection;
  const { modelLabel, modelSlug, workspace } = resolveSubagentMetadata({
    model: subagent.model,
    modelSelection: selection,
    provider,
    parentThread: parent,
    childThread: child,
    parentProject,
    childProject,
  });
  const effort = formatSubagentEffort({ modelSlug, modelSelection: selection, provider });
  return (
    <View className="min-w-0 flex-row items-center gap-1.5">
      {showBadge ? (
        <ProviderInstanceIcon
          provider={provider.driver}
          iconUrl={provider.iconUrl}
          size={12}
          displayName={resolveProviderInstanceDisplayName(provider)}
          accentColor={provider.accentColor}
          showBadge
        />
      ) : (
        <ProviderIcon
          provider={provider?.driver ?? subagent.driver}
          iconUrl={provider?.iconUrl}
          size={12}
        />
      )}
      <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
        {provider ? `${resolveProviderInstanceDisplayName(provider)} · ` : ""}
        {modelLabel}
        {effort ? ` · ${effort}` : ""}
      </Text>
      {workspace.map(({ label, value }) => (
        // Preserve the label against flattening without making it a separate accessibility stop.
        <View
          key={label}
          collapsable={false}
          accessibilityLabel={`${label}: ${value}`}
          className="min-w-0 shrink flex-row items-center gap-1.5"
        >
          <Text className="text-xs text-foreground-muted">·</Text>
          <SymbolView
            name={label === "Branch" ? "arrow.triangle.branch" : "folder"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}
