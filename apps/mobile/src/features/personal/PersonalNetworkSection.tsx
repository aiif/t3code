import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { buildPairingUrl } from "../connection/pairing";
import { SettingsSection } from "../settings/components/SettingsSection";
import { configuredPersonalRelayUrl } from "./mode";
import {
  addPersonalNetworkHost,
  currentPersonalNetworkRelayUrl,
  personalNetworkComputers,
  readPersonalNetworkHosts,
  refreshPersonalNetworkHosts,
  removePersonalNetworkComputer,
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
  return cause instanceof Error ? cause.message : "Could not add this computer.";
}

function personalAddedMessage(host: { readonly label: string | null; readonly publicUrl: string }) {
  return `Added ${host.label ?? host.publicUrl}.`;
}

export function PersonalNetworkSection(props: {
  readonly onPair: PersonalPair;
  readonly onOpenHost?: (environmentId: EnvironmentId) => void;
}) {
  const [hosts, setHosts] = useState(readPersonalNetworkHosts);
  const [relayUrl, setRelayUrl] = useState(
    () => currentPersonalNetworkRelayUrl(hosts) ?? configuredPersonalRelayUrl() ?? "",
  );
  const [hostKey, setHostKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
    } catch (cause) {
      setError(personalAddErrorMessage(cause));
    }
    setBusy(false);
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      setHosts(await refreshPersonalNetworkHosts());
    } catch {
      setError("Could not refresh host status.");
    }
    setBusy(false);
  };

  const remove = (host: (typeof hosts)[number]) => {
    Dialog.alert("Remove this computer?", "Its host keys are forgotten on this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          setHosts(removePersonalNetworkComputer(host.environmentId));
          setMessage(null);
        },
      },
    ]);
  };

  const computers = personalNetworkComputers(hosts);

  return (
    <SettingsSection
      title="Personal network"
      footer="Each host key reaches exactly one computer. Multiple keys are independent and can run at the same time."
    >
      <View collapsable={false} className="gap-3.5 bg-grouped-card p-4">
        {computers.map((host) => (
          <View key={host.environmentId} className="gap-1.5">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">
                {host.label ?? host.publicUrl}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {host.paused ? "Paused" : host.online ? "Online" : "Offline"}
              </Text>
            </View>
            <Text className="text-xs leading-normal text-foreground-muted">{host.publicUrl}</Text>
            <Text className="text-xs leading-normal text-foreground-muted">{host.relayUrl}</Text>
            {host.lastError ? (
              <Text className="text-xs leading-normal text-danger-foreground">
                {host.lastError}
              </Text>
            ) : null}
            <View className="flex-row gap-2">
              {props.onOpenHost ? (
                <Button
                  label="Open"
                  size="compact"
                  disabled={!host.online}
                  onPress={() => props.onOpenHost?.(host.environmentId as EnvironmentId)}
                />
              ) : null}
              <Button label="Remove" tone="danger" size="compact" onPress={() => remove(host)} />
            </View>
          </View>
        ))}

        <ConnectionFormField
          label="Relay"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://t3.example.com"
          value={relayUrl}
          onChangeText={setRelayUrl}
        />
        <ConnectionFormField
          label="Host key"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          placeholder="The key this computer shares"
          secureTextEntry
          value={hostKey}
          onChangeText={setHostKey}
        />

        {error ? (
          <Text
            accessibilityLiveRegion="polite"
            className="text-sm leading-normal text-danger-foreground"
          >
            {error}
          </Text>
        ) : message ? (
          <Text
            accessibilityLiveRegion="polite"
            className="text-sm leading-normal text-foreground-muted"
          >
            {message}
          </Text>
        ) : null}

        <View className="flex-row flex-wrap items-center gap-2">
          <Button
            label="Add computer"
            size="compact"
            loading={busy}
            disabled={relayUrl.trim().length === 0 || hostKey.trim().length === 0}
            onPress={() => {
              void add();
            }}
          />
          {computers.length > 0 ? (
            <Button
              label="Refresh"
              size="compact"
              disabled={busy}
              onPress={() => {
                void refresh();
              }}
            />
          ) : null}
        </View>
      </View>
    </SettingsSection>
  );
}
