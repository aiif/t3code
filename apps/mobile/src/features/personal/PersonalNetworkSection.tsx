import type { EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { m } from "../../i18n/messages";
import { cn } from "../../lib/cn";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { environmentStatusText } from "../connection/environmentStatusText";
import { buildPairingUrl } from "../connection/pairing";
import { SettingsSection } from "../settings/components/SettingsSection";
import { configuredPersonalRelayUrl } from "./mode";
import {
  addPersonalNetworkHost,
  currentPersonalNetworkRelayUrl,
  personalNetworkComputers,
  readPersonalNetworkHosts,
} from "./personalNetwork";

type PersonalPairOutcome = {
  readonly ok: boolean;
  readonly error: string | null;
};

type PersonalPair = (
  pairingUrl: string,
  expectedEnvironmentId?: EnvironmentId,
) => Promise<PersonalPairOutcome>;

function personalAddErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : m(msg("Could not add this computer."));
}

function personalAddedMessage(host: { readonly label: string | null; readonly publicUrl: string }) {
  return m(msg("Added {host}.", { host: host.label ?? host.publicUrl }));
}

export function PersonalNetworkSection(props: { readonly onPair: PersonalPair }) {
  const gt = useGT();
  const m = useMessages();
  const environments = useWorkspaceEnvironments();
  const [hosts, setHosts] = useState(readPersonalNetworkHosts);
  const [relayUrl, setRelayUrl] = useState(
    () =>
      currentPersonalNetworkRelayUrl(readPersonalNetworkHosts()) ??
      configuredPersonalRelayUrl() ??
      "",
  );
  const [hostKey, setHostKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const clearFeedback = () => {
    setError(null);
    setMessage(null);
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const host = await addPersonalNetworkHost({
        relayUrl,
        hostKey,
        pair: async ({ host: publicUrl, pairingCode, expectedEnvironmentId }) => {
          const outcome = await props.onPair(
            buildPairingUrl(publicUrl, pairingCode),
            expectedEnvironmentId,
          );
          return outcome;
        },
      });
      setHosts(readPersonalNetworkHosts());
      setHostKey("");
      setMessage(personalAddedMessage(host));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (cause) {
      setError(personalAddErrorMessage(cause));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
    setBusy(false);
  };

  const environmentsById = new Map<string, (typeof environments)[number]>(
    environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const computers = personalNetworkComputers(hosts);

  return (
    <SettingsSection
      title={gt("Personal network")}
      footer={gt(
        "Each host key reaches exactly one computer. Several can run at once; manage them in Settings → Environments.",
      )}
    >
      <View collapsable={false} className="gap-3.5 bg-grouped-card p-4">
        <ConnectionFormField
          label={gt("Relay")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://t3.example.com"
          value={relayUrl}
          onChangeText={(value) => {
            setRelayUrl(value);
            clearFeedback();
          }}
        />
        <ConnectionFormField
          label={gt("Host key")}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          placeholder={gt("The key this computer shares")}
          value={hostKey}
          onChangeText={(value) => {
            setHostKey(value);
            clearFeedback();
          }}
        />

        <View className="flex-row flex-wrap items-center gap-2">
          <Button
            label={gt("Add computer")}
            size="compact"
            loading={busy}
            disabled={relayUrl.trim().length === 0 || hostKey.trim().length === 0}
            onPress={() => {
              void add();
            }}
          />
        </View>

        {error ? (
          <Text
            accessibilityLiveRegion="polite"
            className="text-sm leading-normal text-danger-foreground"
          >
            {error}
          </Text>
        ) : message ? (
          <View className="flex-row items-center gap-2 rounded-[14px] border border-border-subtle bg-subtle px-3.5 py-2.5">
            <SymbolView
              name="checkmark.circle.fill"
              size={16}
              tintColorClassName="accent-primary-text"
              type="monochrome"
            />
            <Text
              accessibilityLiveRegion="polite"
              className="min-w-0 flex-1 text-sm leading-normal text-foreground"
            >
              {message}
            </Text>
          </View>
        ) : null}

        {computers.length > 0 ? (
          <View className="gap-2 border-t border-border-subtle pt-3.5">
            <Text className="text-2xs font-t3-bold uppercase tracking-[0.8px] text-foreground-muted">
              <T>Computers</T>
            </Text>
            {computers.map((host) => {
              const environment = environmentsById.get(host.environmentId);
              const state =
                environment === undefined
                  ? host.paused
                    ? "available"
                    : host.online
                      ? "connected"
                      : "offline"
                  : environment.isEnabled
                    ? environment.connectionState
                    : "available";
              const status =
                environment === undefined
                  ? host.paused
                    ? gt("Paused")
                    : host.online
                      ? gt("Online")
                      : gt("Offline")
                  : environment.isEnabled
                    ? environmentStatusText(
                        { phase: environment.connectionState, error: null, traceId: null },
                        m,
                      )
                    : gt("Off", { $context: "environment is switched off" });
              const failed =
                environment === undefined
                  ? !host.online && !host.paused
                  : environment.isEnabled &&
                    (environment.connectionState === "offline" ||
                      environment.connectionState === "error");

              return (
                <View key={host.environmentId} className="flex-row items-center gap-2.5">
                  <ConnectionStatusDot
                    state={state}
                    pulse={state === "connecting" || state === "reconnecting"}
                    size={8}
                  />
                  <Text
                    className="min-w-0 flex-1 text-sm leading-normal text-foreground"
                    numberOfLines={1}
                  >
                    {host.label ?? host.publicUrl}
                  </Text>
                  <Text
                    className={cn(
                      "shrink-0 text-xs",
                      failed ? "text-danger-foreground" : "text-foreground-muted",
                    )}
                    numberOfLines={1}
                  >
                    {status}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}
