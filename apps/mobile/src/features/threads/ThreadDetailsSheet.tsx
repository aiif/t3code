import { Modal, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import {
  deriveOutputTokensPerSecond,
  formatTokensPerSecond,
} from "@t3tools/client-runtime/state/token-rate";
import type {
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { collectProviderUsageLimits, remainingPercent } from "@t3tools/shared/usageLimits";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ROW_MIN_HEIGHT } from "../../components/ui/listMetrics";
import { cn } from "../../lib/cn";
import { useOutputTokenRate } from "./useOutputTokenRate";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { useThreadGitMenuDefinition, type ThreadGitControlsProps } from "./ThreadGitControls";

const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`;
  return String(tokens);
}

function SectionTitle(props: { readonly children: string }) {
  return (
    <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">
      {props.children}
    </Text>
  );
}

function ActionRow(props: {
  readonly icon?: string | undefined;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly disabled?: boolean;
  readonly isLast?: boolean;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-3 bg-grouped-card px-4 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      style={{ minHeight: ROW_MIN_HEIGHT.item }}
    >
      {props.icon !== undefined ? (
        // Git menu icons are SF symbol names; android falls back to nothing for unmapped ones.
        <SymbolView
          name={props.icon as AppSymbolName}
          size={16}
          tintColorClassName="accent-icon-subtle"
        />
      ) : null}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className={cn(
            "text-sm font-t3-medium",
            props.disabled ? "text-foreground-muted" : "text-foreground",
          )}
        >
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {props.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function useContextWindowReadout(projection: ThreadStructure | null) {
  const providerThread =
    projection === null
      ? null
      : (projection.providerThreads.find(
          (thread) => thread.id === projection.thread.activeProviderThreadId,
        ) ?? null);
  const liveUsage =
    projection === null
      ? null
      : latestProviderTurnTokenUsage(projection.providerTurns, projection, providerThread);
  const contextWindow =
    projection === null
      ? null
      : deriveLatestContextWindowSnapshot(projection.visibleTurnItems, liveUsage, providerThread);
  const rateWindow = useOutputTokenRate(
    liveUsage,
    liveUsage === null ? null : (providerThread?.id ?? "thread"),
  );
  return { contextWindow, rateWindow };
}

/**
 * The thread's details sheet: context window and usage limits by default, plus the git controls
 * and files entry the header used to carry as separate icons. Mirrors the desktop details card.
 */
export function ThreadDetailsSheet(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly structure: ThreadStructure | null;
  /** Whether the thread is streaming; the output rate only reads while it is. */
  readonly threadActive: boolean;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly serverConfig: ServerConfig | null;
  readonly gitControls: ThreadGitControlsProps;
  readonly hasThreadCwd: boolean;
  readonly onOpenFilesInspector: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const nowMs = useVisibleSecondClock(props.visible);
  const { contextWindow, rateWindow } = useContextWindowReadout(props.structure);
  const outputRate =
    props.threadActive && rateWindow !== null
      ? deriveOutputTokensPerSecond(rateWindow, nowMs)
      : null;
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const gitRows = gitMenu?.items.filter(
    (item): item is Extract<typeof item, { readonly onPress: () => void }> => "onPress" in item,
  );
  const limits = (() => {
    if (props.providerInstanceId === null || props.serverConfig === null) return null;
    const providers = props.serverConfig.providers ?? EMPTY_PROVIDERS;
    const report = collectProviderUsageLimits(
      props.providerInstanceId,
      providers,
      props.serverConfig.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES,
      nowMs,
    );
    return (
      report?.accounts.find((entry) => entry.instanceId === props.providerInstanceId)?.limits ??
      providers.find((provider) => provider.instanceId === props.providerInstanceId)?.usageLimits ??
      null
    );
  })();
  if (!props.visible) return null;
  const fill =
    contextWindow?.usedPercentage == null
      ? null
      : Math.round(Math.max(0, Math.min(100, contextWindow.usedPercentage)));
  return (
    <Modal visible animationType="slide" onRequestClose={props.onClose}>
      <View className="flex-1 bg-sheet">
        <SheetHeader
          presentation="inline"
          title="Thread details"
          onClose={props.onClose}
          accessibilityLabel="Close thread details"
        />
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          showsVerticalScrollIndicator={false}
        >
          <SectionTitle>Context window</SectionTitle>
          <View className="mx-4 gap-1 rounded-2xl bg-grouped-card px-4 py-3">
            {contextWindow === null ? (
              <Text className="text-sm text-foreground-muted">
                This provider has not reported context usage yet.
              </Text>
            ) : (
              <>
                <View className="flex-row items-baseline justify-between gap-3">
                  <Text className="text-sm font-t3-medium text-foreground">Context</Text>
                  <Text className="text-sm text-foreground-muted tabular-nums">
                    {fill !== null
                      ? `${fill}% · ${formatTokens(contextWindow.usedTokens)}${
                          contextWindow.maxTokens != null
                            ? ` / ${formatTokens(contextWindow.maxTokens)}`
                            : ""
                        }`
                      : `${formatTokens(contextWindow.usedTokens)} tokens`}
                  </Text>
                </View>
                {fill !== null ? (
                  <View className="h-1.5 overflow-hidden rounded-full bg-subtle-strong">
                    <View
                      className="h-full rounded-full bg-foreground-muted"
                      style={{ width: `${Math.max(fill, 2)}%` }}
                    />
                  </View>
                ) : null}
                {outputRate !== null ? (
                  <Text className="text-xs text-foreground-muted tabular-nums">
                    Output {formatTokensPerSecond(outputRate)}
                  </Text>
                ) : null}
              </>
            )}
          </View>

          <SectionTitle>Usage limits</SectionTitle>
          <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
            {limits === null ? (
              <Text className="px-4 py-3 text-sm text-foreground-muted">
                No usage limits reported for this provider.
              </Text>
            ) : (
              limits.windows.map((limitWindow, index) => (
                <View
                  key={limitWindow.id}
                  className={cn(
                    "flex-row items-center justify-between gap-3 px-4",
                    index < limits.windows.length - 1 && "border-b border-border-subtle",
                  )}
                  style={{ minHeight: ROW_MIN_HEIGHT.control }}
                >
                  <Text className="text-sm font-t3-medium text-foreground">
                    {limitWindow.label}
                  </Text>
                  <Text className="text-sm text-foreground-muted tabular-nums">
                    {remainingPercent(limitWindow)}% left
                  </Text>
                </View>
              ))
            )}
          </View>

          {gitRows !== undefined && gitRows.length > 0 ? (
            <>
              <SectionTitle>Git</SectionTitle>
              <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
                {gitRows.map((item, index) => (
                  <ActionRow
                    key={item.id}
                    icon={item.icon}
                    title={item.title}
                    subtitle={item.subtitle}
                    disabled={item.disabled}
                    isLast={index === gitRows.length - 1}
                    onPress={item.onPress}
                  />
                ))}
              </View>
            </>
          ) : null}

          {props.gitControls.canOpenFiles ? (
            <>
              <SectionTitle>Files</SectionTitle>
              <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
                <ActionRow
                  icon="folder"
                  title="Open files inspector"
                  subtitle="Browse this thread's workspace"
                  isLast
                  onPress={props.onOpenFilesInspector}
                />
              </View>
            </>
          ) : null}
          <View style={{ minHeight: Math.max(0, (height - insets.top - insets.bottom) * 0.2) }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

/** The always-on context readout above the composer: window share, and the output rate while streaming. */
export function ThreadContextStatusRow(props: {
  readonly structure: ThreadStructure | null;
  readonly threadActive: boolean;
}) {
  const { contextWindow, rateWindow } = useContextWindowReadout(props.structure);
  const nowMs = useVisibleSecondClock(props.threadActive);
  if (contextWindow === null) return null;
  const fill =
    contextWindow.usedPercentage == null
      ? null
      : Math.round(Math.max(0, Math.min(100, contextWindow.usedPercentage)));
  const rate =
    props.threadActive && rateWindow !== null
      ? deriveOutputTokensPerSecond(rateWindow, nowMs)
      : null;
  return (
    <Text className="self-center px-3 pb-0.5 text-2xs text-foreground-muted tabular-nums">
      {fill !== null
        ? `Context ${fill}% · ${formatTokens(contextWindow.usedTokens)}${
            contextWindow.maxTokens != null ? ` / ${formatTokens(contextWindow.maxTokens)}` : ""
          }`
        : `Context ${formatTokens(contextWindow.usedTokens)} tokens`}
      {rate === null ? "" : ` · ${formatTokensPerSecond(rate)}`}
    </Text>
  );
}
