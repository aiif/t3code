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
  forgetPersonalNetwork,
  readPersonalNetworkRecord,
  savePersonalNetworkConfig,
  syncPersonalNetwork,
} from "./personalNetwork";

type PersonalPairOutcome = {
  readonly ok: boolean;
  readonly error: string | null;
};

type PersonalPair = (
  pairingUrl: string,
  expectedEnvironmentId?: EnvironmentId,
) => Promise<PersonalPairOutcome>;

interface PersonalConnectOutcome {
  readonly error: string | null;
  readonly message: string | null;
}

async function connectPersonalNetwork(input: {
  readonly relayUrl: string;
  readonly key: string;
  readonly pair: PersonalPair;
}): Promise<PersonalConnectOutcome> {
  try {
    const saved = savePersonalNetworkConfig({ relayUrl: input.relayUrl, key: input.key });
    const result = await syncPersonalNetwork({
      record: saved,
      pair: async ({ host, pairingCode, expectedEnvironmentId }) => {
        const outcome = await input.pair(buildPairingUrl(host, pairingCode), expectedEnvironmentId);
        if (!outcome.ok) throw new Error(outcome.error ?? "This host refused the key.");
      },
    });
    if (result === null) return { error: null, message: null };
    if (result.hosts.length === 0) {
      return {
        error: "The key is valid, but no hosts are registered yet. Start a host and try again.",
        message: null,
      };
    }
    if (result.failures.length > 0) {
      return {
        error: `Paired ${result.paired.length} host(s). ${result.failures
          .map((failure) => `${failure.environmentId}: ${failure.message}`)
          .join(" ")}`,
        message: null,
      };
    }
    return {
      error: null,
      message:
        result.paired.length === 0
          ? "Every host is already paired."
          : `Paired ${result.paired.length} host(s).`,
    };
  } catch (cause) {
    return {
      error:
        cause instanceof Error
          ? cause.message
          : "Could not reach the relay. Check the URL and your connection.",
      message: null,
    };
  }
}

export function PersonalNetworkSection(props: { readonly onPair: PersonalPair }) {
  const [record, setRecord] = useState(readPersonalNetworkRecord);
  const [relayUrl, setRelayUrl] = useState(
    () => record?.relayUrl ?? configuredPersonalRelayUrl() ?? "",
  );
  const [key, setKey] = useState(() => record?.key ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    const outcome = await connectPersonalNetwork({
      relayUrl,
      key,
      pair: props.onPair,
    });
    setRecord(readPersonalNetworkRecord());
    setError(outcome.error);
    setMessage(outcome.message);
    setBusy(false);
  };

  const forget = () => {
    Dialog.alert(
      "Forget personal network?",
      "This removes the key from this device. Environments stay saved, but new hosts will not appear until you enter the key again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => {
            forgetPersonalNetwork();
            setRecord(null);
            setKey("");
            setError(null);
            setMessage(null);
          },
        },
      ],
    );
  };

  return (
    <SettingsSection
      title="Personal network"
      footer="Every host registered with this key appears here. Anyone with the key can operate the agents on those hosts."
    >
      <View collapsable={false} className="gap-3.5 bg-grouped-card p-4">
        {record ? (
          <Text className="text-xs leading-normal text-foreground-muted">
            Connected to {record.relayUrl}
          </Text>
        ) : null}

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
          label="Personal key"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          placeholder="The key shared with every host"
          secureTextEntry
          value={key}
          onChangeText={setKey}
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
            label={record ? "Sync now" : "Connect this device"}
            size="compact"
            loading={busy}
            disabled={relayUrl.trim().length === 0 || key.trim().length === 0}
            onPress={() => {
              void connect();
            }}
          />
          {record ? <Button label="Forget" tone="danger" size="compact" onPress={forget} /> : null}
        </View>
      </View>
    </SettingsSection>
  );
}
