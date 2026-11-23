import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { buildPairingUrl } from "../connection/pairing";
import { SettingsSection } from "../settings/components/SettingsSection";
import { configuredPersonalRelayUrl } from "./mode";
import {
  addPersonalNetworkHost,
  currentPersonalNetworkRelayUrl,
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
  return cause instanceof Error ? cause.message : "Could not add this computer.";
}

function personalAddedMessage(host: { readonly label: string | null; readonly publicUrl: string }) {
  return `Added ${host.label ?? host.publicUrl}.`;
}

export function PersonalNetworkSection(props: { readonly onPair: PersonalPair }) {
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
      setHostKey("");
      setMessage(personalAddedMessage(host));
    } catch (cause) {
      setError(personalAddErrorMessage(cause));
    }
    setBusy(false);
  };

  return (
    <SettingsSection
      title="Personal network"
      footer="Each host key reaches exactly one computer. Multiple keys are independent and can run at the same time."
    >
      <View collapsable={false} className="gap-3.5 bg-grouped-card p-4">
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
        </View>
      </View>
    </SettingsSection>
  );
}
