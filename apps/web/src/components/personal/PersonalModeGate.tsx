import type { EnvironmentId } from "@t3tools/contracts";

import type { ReactNode } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import {
  enablePersonalNotifications,
  personalNotificationPermission,
} from "../../personal/notifications";
import {
  type PersonalPortalRecord,
  isPersonalPortalError,
  readPersonalPortalRecord,
  recordPairedEnvironments,
  savePersonalPortalConfig,
  syncPersonalPortal,
} from "../../personal/portal";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

/**
 * The portal's personal key gate. A hosted build without a saved key shows the
 * one-time setup screen; once the key is saved, host discovery refreshes when
 * the page becomes visible or the network returns.
 */
export function PersonalModeGate({ hosted, children }: { hosted: boolean; children: ReactNode }) {
  const [record, setRecord] = useState(readPersonalPortalRecord);
  if (!hosted) return <>{children}</>;
  if (record === null) return <PersonalSetupSurface onSaved={setRecord} />;
  return (
    <>
      <PersonalHostSync record={record} />
      <PersonalNotificationPrompt record={record} />
      {children}
    </>
  );
}

function PersonalSetupSurface({ onSaved }: { onSaved: (record: PersonalPortalRecord) => void }) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [relayUrl, setRelayUrl] = useState(() => window.location.origin);
  const [key, setKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const pair = (input: {
    readonly host: string;
    readonly pairingCode: string;
    readonly expectedEnvironmentId: EnvironmentId;
  }) =>
    connectPairingEnvironment(input).then((result) => {
      if (result._tag !== "Success") {
        throw new Error("This host refused the key.");
      }
      return result.value;
    });

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      const saved = savePersonalPortalConfig({ relayUrl, key });
      const result = await syncPersonalPortal({ config: saved, record: saved, pair });
      onSaved(recordPairedEnvironments(saved, result.paired.map(String)));
      if (result.hosts.length === 0) {
        setErrorMessage(
          "The key is valid, but no hosts are registered yet. Start a host and reopen this page.",
        );
      }
    } catch (cause) {
      setErrorMessage(
        isPersonalPortalError(cause)
          ? cause.message
          : "Could not set up this portal. Check the relay URL and key.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Personal network"
        description="Enter the key once. Every host registered with it appears here, and this device stays paired until you forget it."
      />
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="personal-relay">
            Relay
          </label>
          <Input
            id="personal-relay"
            autoCapitalize="none"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setRelayUrl(event.currentTarget.value)}
            placeholder="https://t3.example.com"
            spellCheck={false}
            value={relayUrl}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="personal-key">
            Personal key
          </label>
          <Input
            id="personal-key"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setKey(event.currentTarget.value)}
            placeholder="The key shared with every host"
            spellCheck={false}
            type="password"
            value={key}
          />
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <Button disabled={isSubmitting || key.trim().length === 0} size="sm" type="submit">
          {isSubmitting ? "Connecting..." : "Connect this device"}
        </Button>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        The key stays in this browser. Anyone who has it can operate the agents on every host, so
        losing a device means rotating the key on the relay and each host.
      </div>
    </StandalonePage>
  );
}

function PersonalHostSync({ record }: { record: PersonalPortalRecord }) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const runningRef = useRef(false);
  // Paired ids are bookkeeping for the next sync, not rendered; a ref keeps the
  // effect from re-firing on its own write.
  const recordRef = useRef(record);

  const sync = useEffectEvent(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const pair = (input: {
        readonly host: string;
        readonly pairingCode: string;
        readonly expectedEnvironmentId: EnvironmentId;
      }) =>
        connectPairingEnvironment(input).then((result) => {
          if (result._tag !== "Success") {
            throw new Error("This host refused the key.");
          }
          return result.value;
        });
      const result = await syncPersonalPortal({
        config: record,
        record: recordRef.current,
        pair,
      });
      if (result.paired.length > 0) {
        recordRef.current = recordPairedEnvironments(recordRef.current, result.paired.map(String));
      }
    } catch {
      // A temporary relay or host failure retries on the next foreground.
    } finally {
      runningRef.current = false;
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the personal host catalog when the portal is foregrounded or reconnects
  useEffect(() => {
    void sync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const onOnline = () => void sync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}

const NOTIFICATION_DISMISSED_KEY = "t3.personal.notificationsDismissed";

function PersonalNotificationPrompt({ record }: { record: PersonalPortalRecord }) {
  const [permission, setPermission] = useState(personalNotificationPermission);
  const [dismissed, setDismissed] = useState(
    () => globalThis.sessionStorage?.getItem(NOTIFICATION_DISMISSED_KEY) === "1",
  );
  const [busy, setBusy] = useState(false);
  // The prompt is an offer, not a status light: any permission decision ends it.
  if (dismissed || permission !== "default") return null;

  const dismiss = () => {
    globalThis.sessionStorage?.setItem(NOTIFICATION_DISMISSED_KEY, "1");
    setDismissed(true);
  };

  return (
    <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-border bg-card p-3 shadow-lg">
      <div className="min-w-0 text-sm">
        <p className="font-medium">Get notified when an agent needs you</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Approvals, questions, and finished runs arrive even when this app is closed.
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          disabled={busy}
          size="sm"
          onClick={() => {
            setBusy(true);
            void enablePersonalNotifications({ relayUrl: record.relayUrl, key: record.key })
              .then((result) => setPermission(result))
              .catch(() => undefined)
              .finally(() => setBusy(false));
          }}
        >
          Enable
        </Button>
        <Button size="sm" variant="outline" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}
