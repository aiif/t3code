import type { EnvironmentId, PersonalRelayState, PersonalResolvedHost } from "@t3tools/contracts";
import {
  personalHostRecord,
  readPersonalHosts,
  removePersonalHost,
  upsertPersonalHost,
  type PersonalHostRecord,
} from "@t3tools/client-runtime/personal/portal";
import * as Cause from "effect/Cause";
import { useEffect, useState } from "react";

import { connectPairing as connectPairingCommand } from "../../connection/onboarding";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  personalPauseSharing,
  personalRelayStatus,
  personalResolveHostKey,
  personalResumeSharing,
  personalRevealSharingKey,
  personalRotateSharingKey,
  personalStartSharing,
  personalStopSharing,
} from "../../state/personal";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DEFAULT_RELAY_URL = import.meta.env.VITE_HOSTED_APP_URL?.trim() || "https://relay.example.com";

type CommandResult<T> =
  | { readonly _tag: "Success"; readonly value: T }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

function resultValue<T>(result: CommandResult<T>): T | null {
  return result._tag === "Success" ? result.value : null;
}

function failureMessage(result: CommandResult<unknown>): string | null {
  if (result._tag === "Success") return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The host did not answer.";
}

export function PersonalNetworkSettings() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  if (environmentId === null) return null;
  return <PersonalNetworkSettingsForHost environmentId={environmentId} />;
}

function PersonalNetworkSettingsForHost({ environmentId }: { environmentId: EnvironmentId }) {
  const statusCommand = useAtomCommand(personalRelayStatus, { reportFailure: false });
  const start = useAtomCommand(personalStartSharing, { reportFailure: false });
  const stop = useAtomCommand(personalStopSharing, { reportFailure: false });
  const pause = useAtomCommand(personalPauseSharing, { reportFailure: false });
  const resume = useAtomCommand(personalResumeSharing, { reportFailure: false });
  const rotate = useAtomCommand(personalRotateSharingKey, { reportFailure: false });
  const reveal = useAtomCommand(personalRevealSharingKey, { reportFailure: false });
  const resolve = useAtomCommand(personalResolveHostKey, { reportFailure: false });
  const connectPairing = useAtomCommand(connectPairingCommand, { reportFailure: false });

  const [status, setStatus] = useState<PersonalRelayState | null>(null);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [label, setLabel] = useState("");
  const [hostKey, setHostKey] = useState<string | null>(null);
  const [guestKey, setGuestKey] = useState("");
  const [guestRelay, setGuestRelay] = useState(DEFAULT_RELAY_URL);
  const [guests, setGuests] = useState<ReadonlyArray<PersonalHostRecord>>(readPersonalHosts);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = async () => {
    const result = await statusCommand({ environmentId, input: {} });
    const value = resultValue(result as CommandResult<PersonalRelayState>);
    if (value !== null) {
      setStatus(value);
      if (value.label !== null) setLabel((current: string) => current || value.label || "");
      if (value.relayUrl !== null)
        setRelayUrl((current: string) => current || value.relayUrl || "");
    }
  };

  /* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync -- polls the host connector's live status while the panel is mounted */
  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 5_000);
    return () => window.clearInterval(timer);
  }, [environmentId]);
  /* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync */

  const run = async (operation: () => Promise<CommandResult<unknown>>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await operation();
      const failure = failureMessage(result);
      if (failure !== null) {
        setError(failure);
        return null;
      }
      await refreshStatus();
      return result;
    } finally {
      setBusy(false);
    }
  };

  const startSharing = () =>
    run(() =>
      start({
        environmentId,
        input: {
          relayUrl: relayUrl.trim(),
          ...(label.trim() === "" ? {} : { label: label.trim() }),
        },
      }),
    );

  const copyHostKey = async () => {
    if (hostKey === null) return;
    await navigator.clipboard.writeText(hostKey);
    setMessage("Host key copied.");
  };

  const revealHostKey = async () => {
    const result = await run(() => reveal({ environmentId, input: {} }));
    const value =
      result === null ? null : resultValue(result as CommandResult<{ hostKey: string }>);
    if (value !== null) setHostKey(value.hostKey);
  };

  const rotateKey = async () => {
    const result = await run(() => rotate({ environmentId, input: {} }));
    const value =
      result === null ? null : resultValue(result as CommandResult<{ hostKey: string }>);
    if (value !== null) {
      setHostKey(value.hostKey);
      setMessage("Host key rotated. Guests must enter the new key.");
    }
  };

  const addGuest = async () => {
    const key = guestKey.trim();
    if (key === "") return;
    const resolved = await run(() =>
      resolve({ environmentId, input: { relayUrl: guestRelay, hostKey: key } }),
    );
    const host =
      resolved === null ? null : resultValue(resolved as CommandResult<PersonalResolvedHost>);
    if (host === null) return;
    if (!host.online) {
      setError("That host is offline or paused. Try again when it is online.");
      return;
    }
    const paired = await connectPairing({
      host: host.publicUrl,
      pairingCode: key,
      expectedEnvironmentId: host.environmentId as EnvironmentId,
    });
    if (paired._tag === "Failure") {
      setError(failureMessage(paired as CommandResult<unknown>) ?? "The host refused the key.");
      return;
    }
    const record = personalHostRecord({ relayUrl: guestRelay, hostKey: key, resolved: host });
    setGuests(upsertPersonalHost(record));
    setGuestKey("");
    setMessage(`Added ${host.label ?? host.publicUrl}.`);
  };

  const refreshGuests = async () => {
    setBusy(true);
    const next: Array<PersonalHostRecord> = [];
    for (const guest of readPersonalHosts()) {
      const result = await resolve({
        environmentId,
        input: { relayUrl: guest.relayUrl, hostKey: guest.hostKey },
      });
      const resolved =
        result._tag === "Success"
          ? resultValue(result as CommandResult<PersonalResolvedHost>)
          : null;
      if (resolved === null) {
        next.push({
          ...guest,
          online: false,
          lastError: failureMessage(result as CommandResult<unknown>),
        });
      } else {
        next.push({
          ...guest,
          hostId: resolved.hostId,
          environmentId: resolved.environmentId,
          label: resolved.label,
          publicUrl: resolved.publicUrl,
          online: resolved.online,
          paused: resolved.paused,
          lastError: null,
        });
      }
    }
    for (const guest of next) upsertPersonalHost(guest);
    setGuests(next);
    setBusy(false);
  };

  const removeGuest = (guest: PersonalHostRecord) => {
    setGuests(removePersonalHost({ hostId: guest.hostId, relayUrl: guest.relayUrl }));
  };

  return (
    <SettingsSection
      {...searchableSetting("personal-network")}
      id="personal-network"
      title="Personal network"
    >
      <SettingsRow
        title="Share this computer"
        description="Guests with this computer's host key can use its projects while the app is running and sharing is on. Closing the window keeps sharing on; Quit stops it."
      >
        <div className="flex w-full max-w-md flex-col gap-2">
          <Input
            aria-label="Relay URL"
            disabled={busy}
            onChange={(event) => setRelayUrl(event.currentTarget.value)}
            placeholder="https://t3.example.com"
            value={relayUrl}
          />
          <div className="flex gap-2">
            <Input
              aria-label="This computer's label"
              disabled={busy}
              onChange={(event) => setLabel(event.currentTarget.value)}
              placeholder="Home PC"
              value={label}
            />
            <Button
              disabled={busy || relayUrl.trim().length === 0}
              size="sm"
              onClick={() => void startSharing()}
            >
              {status?.enabled ? "Save" : "Register"}
            </Button>
          </div>

          {status?.enabled ? (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                {status.paused
                  ? "Paused: guests cannot connect."
                  : status.online
                    ? "Online and discoverable."
                    : "Connecting..."}
                {status.publicUrl ? ` · ${status.publicUrl}` : ""}
                {status.frpcRunning ? " · frpc running" : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted px-2 py-1">
                  {hostKey ?? (status.hostId ? "••••••••••••••••" : "")}
                </code>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void revealHostKey()}
                >
                  Reveal
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || hostKey === null}
                  onClick={() => void copyHostKey()}
                >
                  Copy
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void rotateKey()}
                >
                  Rotate key
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {status.paused ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => resume({ environmentId, input: {} }))}
                  >
                    Resume sharing
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => pause({ environmentId, input: {} }))}
                  >
                    Pause sharing
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  disabled={busy}
                  onClick={() => {
                    setHostKey(null);
                    void run(() => stop({ environmentId, input: {} }));
                  }}
                >
                  Stop sharing
                </Button>
              </div>
              {status.lastError ? <p className="text-destructive">{status.lastError}</p> : null}
            </div>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Add a computer"
        description="Paste a host key from another computer. Each key is a separate environment, and several can run at the same time."
      >
        <div className="flex w-full max-w-md flex-col gap-2">
          <Input
            aria-label="Guest relay URL"
            disabled={busy}
            onChange={(event) => setGuestRelay(event.currentTarget.value)}
            placeholder="https://t3.example.com"
            value={guestRelay}
          />
          <div className="flex gap-2">
            <Input
              aria-label="Host key"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setGuestKey(event.currentTarget.value)}
              placeholder="Paste a host key"
              type="password"
              value={guestKey}
            />
            <Button
              disabled={busy || guestKey.trim().length === 0}
              size="sm"
              onClick={() => void addGuest()}
            >
              Add
            </Button>
          </div>
          {guests.length > 0 ? (
            <div className="space-y-2">
              {guests.map((guest) => (
                <div
                  key={`${guest.relayUrl}:${guest.hostId}`}
                  className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5 text-xs"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{guest.label ?? guest.publicUrl}</p>
                    <p className="truncate text-muted-foreground">
                      {guest.paused ? "Paused" : guest.online ? "Online" : "Offline"}
                      {guest.lastError ? ` · ${guest.lastError}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void refreshGuests()}
                    >
                      Refresh
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => removeGuest(guest)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </SettingsRow>

      {error ? (
        <div className="px-4 pb-3">
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : message ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">{message}</p>
      ) : null}
    </SettingsSection>
  );
}
