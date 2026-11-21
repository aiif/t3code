import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import Constants from "expo-constants";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useDeadlinePassed } from "../../lib/clock";
import { formatBytes } from "../../lib/formatBytes";
import {
  type AppUpdateCheckState,
  type MobileDownloadProgress,
  cancelMobileAppUpdateDownload,
  getActiveMobileDownloadProgress,
  isAppUpdateCheckAvailable,
  runAppUpdateCheck,
  subscribeMobileDownloadProgress,
} from "../updates/app-updates";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAboutRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="About">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const [checkState, setCheckState] = useState<{
    readonly state: AppUpdateCheckState;
    // "Up to date" is a confirmation that fades back to idle.
    readonly settledUntil: number | null;
  }>({ state: "idle", settledUntil: null });
  const confirmationExpired = useDeadlinePassed(checkState.settledUntil);
  const updateState =
    checkState.state === "current" && confirmationExpired ? "idle" : checkState.state;
  const updateInFlight = useRef(false);

  const [downloadProgress, setDownloadProgress] = useState<MobileDownloadProgress | null>(
    getActiveMobileDownloadProgress(),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes active mobile update download progress with the UI
  useEffect(() => {
    return subscribeMobileDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });
  }, []);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Match app.config.ts's production fallback to avoid mislabeling builds as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  function handleCancelDownload() {
    cancelMobileAppUpdateDownload();
    setCheckState({ state: "idle", settledUntil: null });
    setDownloadProgress(null);
    updateInFlight.current = false;
  }

  async function checkForUpdate() {
    // disabled updates next render; the ref blocks same-frame double taps.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    // Failures arrive through onFailure; the settled result only matters for unlocking.
    await settlePromise(() =>
      runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Dialog.alert("Update failed", message),
        onProgress: (progress) => setDownloadProgress(progress),
        onStateChange: (state) => {
          setCheckState({
            state,
            settledUntil: state === "current" ? Date.now() + 3000 : null,
          });
          if (state !== "downloading") {
            setDownloadProgress(null);
          }
        },
      }),
    );
    updateInFlight.current = false;
  }

  function handleVersionPress() {
    if (!updateCheckAvailable || updateInFlight.current) return;
    if (updateState === "downloading") {
      Dialog.confirm({
        title: "Cancel download?",
        message: "Do you want to cancel the active update download?",
        confirmText: "Cancel download",
        destructive: true,
        cancelText: "Continue",
        onConfirm: handleCancelDownload,
      });
      return;
    }
    void checkForUpdate();
  }

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? downloadProgress && downloadProgress.percent > 0
          ? `Downloading… ${downloadProgress.percent}%`
          : "Downloading…"
        : updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="stethoscope" label="Diagnostics" target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label="Open source licenses"
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <SettingsRow
          icon="arrow.clockwise"
          label={updateState === "downloading" ? "Downloading update…" : "Check for updates"}
          value={statusLabel ?? undefined}
          disabled={updateState === "checking" || updateState === "restarting"}
          onPress={() => {
            if (updateState === "downloading") {
              Dialog.confirm({
                title: "Cancel download?",
                message: "Do you want to cancel the active update download?",
                confirmText: "Cancel download",
                destructive: true,
                cancelText: "Continue",
                onConfirm: handleCancelDownload,
              });
            } else {
              void checkForUpdate();
            }
          }}
        />
      ) : null}
      {updateState === "downloading" ? (
        <View className="rounded-2xl border border-border bg-card p-4 gap-3 mx-1">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text className="text-base font-semibold text-foreground">Downloading update…</Text>
              <Text className="text-sm text-foreground-muted mt-0.5">
                {downloadProgress && downloadProgress.totalBytes > 0
                  ? `${downloadProgress.percent}% · ${formatBytes(downloadProgress.bytesWritten)} / ${formatBytes(downloadProgress.totalBytes)}`
                  : "Connecting…"}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel update download"
              className="rounded-full bg-surface-muted px-4 py-1.5 active:opacity-70"
              onPress={handleCancelDownload}
            >
              <Text className="text-sm font-medium text-destructive">Cancel</Text>
            </Pressable>
          </View>
          <View className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
            <View
              className="h-full bg-accent rounded-full"
              style={{ width: `${Math.max(2, downloadProgress?.percent ?? 0)}%` }}
            />
          </View>
        </View>
      ) : null}
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={`Version ${versionLabel}`}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
