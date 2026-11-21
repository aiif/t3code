import type {
  EnvironmentId,
  PersonalRelayProfileSummary,
  PersonalRelayProfiles,
  PersonalRelayState,
  PersonalResolvedHost,
} from "@t3tools/contracts";
import {
  detectAndConnectPersonalKey,
  personalHostRecord,
  readPersonalAdminConfig,
  readPersonalHosts,
  removePersonalHost,
  upsertPersonalHost,
  type PairPersonalHost,
  type PersonalAdminConfig,
  type PersonalHostRecord,
} from "@t3tools/client-runtime/personal/portal";
import * as Cause from "effect/Cause";
import { msg, T, useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { m } from "~/i18n/messages";
import { connectPairing as connectPairingCommand } from "../../connection/onboarding";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  personalForgetRelay,
  personalListRelays,
  personalPauseSharing,
  personalRelayStatus,
  personalResolveHostKey,
  personalResumeSharing,
  personalRevealSharingKey,
  personalRotateSharingKey,
  personalSaveRelay,
  personalStartSharing,
  personalStopSharing,
} from "../../state/personal";
import { useAtomCommand } from "../../state/use-atom-command";
import { notifyPersonalHostsChanged, openPersonalAdminConsole } from "../personal/PersonalModeGate";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const DEFAULT_RELAY_URL = import.meta.env.VITE_HOSTED_APP_URL?.trim() || "";
const NEW_RELAY_VALUE = "__new";

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
    : m(msg("The host did not answer."));
}

function normalizeRelayUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

export function PersonalNetworkSettings() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  if (environmentId === null) {
    return <PersonalNetworkGuestSettings />;
  }
  return <PersonalNetworkSettingsForHost environmentId={environmentId} />;
}

function PersonalNetworkGuestSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const connectPairing = useAtomCommand(connectPairingCommand, { reportFailure: false });
  const [guests, setGuests] = useState<ReadonlyArray<PersonalHostRecord>>(readPersonalHosts);
  const [adminConfig, setAdminConfig] = useState<PersonalAdminConfig | null>(
    readPersonalAdminConfig,
  );
  const [relayUrl, setRelayUrl] = useState(
    () =>
      guests[0]?.relayUrl ??
      adminConfig?.relayUrl ??
      (DEFAULT_RELAY_URL.length > 0 ? DEFAULT_RELAY_URL : window.location.origin),
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const pairHost: PairPersonalHost = async (input) => {
    const paired = (await connectPairing(input)) as CommandResult<unknown>;
    if (paired._tag === "Success") return { ok: true };
    const failure = failureMessage(paired);
    return {
      ok: false,
      error: failure ?? m(msg("The host refused the key.")),
    };
  };

  const addKey = async () => {
    const trimmedKey = key.trim();
    if (trimmedKey === "") return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await detectAndConnectPersonalKey({
        relayUrl: relayUrl.trim(),
        key: trimmedKey,
        pairHost,
      });
      setKey("");
      setGuests(readPersonalHosts());
      setAdminConfig(readPersonalAdminConfig());
      notifyPersonalHostsChanged();
      if (outcome.kind === "host") {
        setMessage(
          m(
            msg("Connected to {host}.", {
              host: outcome.host.label ?? outcome.host.publicUrl,
            }),
          ),
        );
      } else {
        setMessage(
          m(
            msg("Connected to relay as admin ({count} computers connected).", {
              count: outcome.records.length,
            }),
          ),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m(msg("Connection failed.")));
    } finally {
      setBusy(false);
    }
  };

  const removeGuest = (guest: PersonalHostRecord) => {
    setGuests(removePersonalHost({ hostId: guest.hostId, relayUrl: guest.relayUrl }));
    notifyPersonalHostsChanged();
  };

  return (
    <SettingsSection
      {...searchableSetting("personal-network")}
      id="personal-network"
      title={gt("Personal network")}
    >
      {adminConfig !== null ? (
        <SettingsRow
          description={gt(
            "Relay: {relayUrl}. Open the console to manage registered hosts and guest sessions.",
            { relayUrl: adminConfig.relayUrl },
          )}
          title={gt("Admin console")}
        >
          <Button size="sm" variant="outline" onClick={openPersonalAdminConsole}>
            <T>Open admin console</T>
          </Button>
        </SettingsRow>
      ) : null}

      <SettingsRow
        description={gt(
          "Computers available in this browser. Add a host key to open a computer, or an admin key to connect all computers on the relay.",
        )}
        title={gt("Saved computers")}
      >
        <div className="flex w-full max-w-md flex-col gap-2">
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
                      {guest.paused ? gt("Paused") : guest.online ? gt("Online") : gt("Offline")} ·{" "}
                      {guest.relayUrl}
                      {guest.lastError ? ` · ${guest.lastError}` : ""}
                    </p>
                  </div>
                  <Button size="xs" variant="ghost-destructive" onClick={() => removeGuest(guest)}>
                    <T>Remove</T>
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              <T>No computers connected yet.</T>
            </p>
          )}
        </div>
      </SettingsRow>

      <SettingsRow
        description={gt(
          "Enter a relay URL and key. A host key adds one computer; an admin key adds all computers registered on that relay.",
        )}
        title={gt("Add a computer")}
      >
        <div className="flex w-full max-w-md flex-col gap-2">
          <Input
            aria-label={gt("Relay URL")}
            disabled={busy}
            onChange={(event) => setRelayUrl(event.currentTarget.value)}
            placeholder="https://relay.example.com"
            value={relayUrl}
          />
          <div className="flex gap-2">
            <Input
              aria-label={gt("Key")}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setKey(event.currentTarget.value)}
              placeholder={gt("Paste a host or admin key")}
              type="password"
              value={key}
            />
            <Button
              disabled={busy || key.trim().length === 0}
              size="sm"
              onClick={() => void addKey()}
            >
              {busy ? <T>Connecting…</T> : <T>Add</T>}
            </Button>
          </div>
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

function PersonalNetworkSettingsForHost({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const statusCommand = useAtomCommand(personalRelayStatus, { reportFailure: false });
  const listRelays = useAtomCommand(personalListRelays, { reportFailure: false });
  const saveRelay = useAtomCommand(personalSaveRelay, { reportFailure: false });
  const forgetRelay = useAtomCommand(personalForgetRelay, { reportFailure: false });
  const start = useAtomCommand(personalStartSharing, { reportFailure: false });
  const stop = useAtomCommand(personalStopSharing, { reportFailure: false });
  const pause = useAtomCommand(personalPauseSharing, { reportFailure: false });
  const resume = useAtomCommand(personalResumeSharing, { reportFailure: false });
  const rotate = useAtomCommand(personalRotateSharingKey, { reportFailure: false });
  const reveal = useAtomCommand(personalRevealSharingKey, { reportFailure: false });
  const resolve = useAtomCommand(personalResolveHostKey, { reportFailure: false });
  const connectPairing = useAtomCommand(connectPairingCommand, { reportFailure: false });

  const relayTouched = useRef(false);
  const [status, setStatus] = useState<PersonalRelayState | null>(null);
  const [relays, setRelays] = useState<ReadonlyArray<PersonalRelayProfileSummary>>([]);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [relayKey, setRelayKey] = useState("");
  const [label, setLabel] = useState("");
  const [hostKey, setHostKey] = useState<string | null>(null);
  const [guestKey, setGuestKey] = useState("");
  const [guestRelay, setGuestRelay] = useState<string>(
    () => readPersonalHosts()[0]?.relayUrl ?? DEFAULT_RELAY_URL,
  );
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
      if (value.relayUrl !== null && !relayTouched.current) {
        setRelayUrl(value.relayUrl);
      }
    }
  };

  const refreshRelays = async () => {
    const result = await listRelays({ environmentId, input: {} });
    const value = resultValue(result as CommandResult<PersonalRelayProfiles>);
    if (value === null) return;
    setRelays(value.relays);
    if (!relayTouched.current && relayUrl.trim() === "") {
      setRelayUrl(value.relays[0]?.relayUrl ?? DEFAULT_RELAY_URL);
    }
    setGuestRelay((current) => current || value.relays[0]?.relayUrl || DEFAULT_RELAY_URL);
  };

  /* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync -- polls the host connector's live status while the panel is mounted */
  useEffect(() => {
    void refreshStatus();
    void refreshRelays();
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

  const startSharing = () => {
    const previousKey = hostKey;
    const previousRelay = normalizeRelayUrl(status?.relayUrl ?? "");
    const nextRelay = normalizeRelayUrl(relayUrl);
    const targetProfile = relays.find((relay) => relay.relayUrl === nextRelay);
    return run(async () => {
      const result = await start({
        environmentId,
        input: {
          relayUrl: nextRelay,
          ...(relayKey.trim() === "" ? {} : { relayKey: relayKey.trim() }),
          ...(label.trim() === "" ? {} : { label: label.trim() }),
        },
      });
      if (result._tag === "Success") {
        // Saving can register with a different relay and issue a new host key.
        // The start response carries relay state, not the key, so reveal it now
        // instead of leaving the previously displayed key on screen.
        const revealed = await reveal({ environmentId, input: {} });
        const nextKey =
          resultValue(revealed as CommandResult<{ hostKey: string }>)?.hostKey ?? null;
        setHostKey(nextKey);
        setRelayKey("");
        await refreshRelays();
        if (previousKey !== null && nextKey !== null && previousKey !== nextKey) {
          setMessage(
            m(
              previousRelay === nextRelay
                ? msg("Host key changed. Guests must add the new key.")
                : msg(
                    "Switched. The new relay issued a different host key; guests must add it once.",
                  ),
            ),
          );
        } else if (previousRelay !== "" && previousRelay !== nextRelay) {
          setMessage(
            m(
              targetProfile?.hostId != null
                ? msg(
                    "Switched to {relayUrl}. The previous relay stays registered, so guests keep their keys.",
                    { relayUrl: nextRelay },
                  )
                : msg(
                    "Switched to {relayUrl}. Add its host key to guests once; paired guests that synced it pick it up automatically.",
                    { relayUrl: nextRelay },
                  ),
            ),
          );
        } else {
          setMessage(m(msg("Personal network settings saved.")));
        }
      }
      return result as CommandResult<unknown>;
    });
  };

  const saveCurrentRelay = () =>
    run(async () => {
      const result = (await saveRelay({
        environmentId,
        input: {
          relayUrl: relayUrl.trim(),
          ...(relayKey.trim() === "" ? {} : { relayKey: relayKey.trim() }),
        },
      })) as CommandResult<PersonalRelayProfiles>;
      const value = resultValue(result);
      if (value !== null) {
        setRelays(value.relays);
        setRelayKey("");
        const prepared = value.relays.some(
          (relay) => relay.relayUrl === normalizeRelayUrl(relayUrl) && relay.hostId !== null,
        );
        setMessage(
          m(
            prepared
              ? msg(
                  "Relay saved. Paired guests pick up its key within a minute; switch after that.",
                )
              : msg("Relay saved. It registers when you switch to it."),
          ),
        );
      }
      return result;
    });

  const forgetCurrentRelay = async () => {
    const selected = relays.find((relay) => relay.relayUrl === normalizeRelayUrl(relayUrl));
    if (selected === undefined) return;
    if (
      status?.enabled === true &&
      normalizeRelayUrl(status.relayUrl ?? "") === selected.relayUrl
    ) {
      setError(m(msg("Stop sharing before forgetting this relay.")));
      return;
    }
    const confirmed = await requestConfirmDialog(
      m(
        msg(
          "Forget {relayUrl} on this computer? The relay still lists this host until it is removed from the relay's admin console.",
          { relayUrl: selected.relayUrl },
        ),
      ),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await run(async () => {
      const forgotten = (await forgetRelay({
        environmentId,
        input: { relayUrl: selected.relayUrl },
      })) as CommandResult<PersonalRelayProfiles>;
      const value = resultValue(forgotten);
      if (value !== null) {
        setRelays(value.relays);
        setRelayUrl(value.relays[0]?.relayUrl ?? "");
        setMessage(m(msg("Relay forgotten.")));
      }
      return forgotten;
    });
  };

  const copyHostKey = async () => {
    if (hostKey === null) return;
    await navigator.clipboard.writeText(hostKey);
    setMessage(m(msg("Host key copied.")));
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
      setMessage(m(msg("Host key rotated. Guests must enter the new key.")));
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
      setError(m(msg("That host is offline or paused. Try again when it is online.")));
      return;
    }
    const paired = await connectPairing({
      host: host.publicUrl,
      pairingCode: key,
      expectedEnvironmentId: host.environmentId as EnvironmentId,
    });
    if (paired._tag === "Failure") {
      setError(
        failureMessage(paired as CommandResult<unknown>) ?? m(msg("The host refused the key.")),
      );
      return;
    }
    const record = personalHostRecord({ relayUrl: guestRelay, hostKey: key, resolved: host });
    setGuests(upsertPersonalHost(record));
    notifyPersonalHostsChanged();
    setGuestKey("");
    setMessage(m(msg("Added {host}.", { host: host.label ?? host.publicUrl })));
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
    notifyPersonalHostsChanged();
  };

  const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
  const selectedRelay = relays.find((relay) => relay.relayUrl === normalizedRelayUrl);
  const selectedValue = selectedRelay === undefined ? NEW_RELAY_VALUE : selectedRelay.relayUrl;
  const isCurrentRelay =
    status?.enabled === true && normalizeRelayUrl(status.relayUrl ?? "") === normalizedRelayUrl;
  const actionLabel =
    status?.enabled !== true ? gt("Register") : isCurrentRelay ? gt("Save") : gt("Switch");
  const relaySuggestions = [
    ...new Set([
      ...relays.map((relay) => relay.relayUrl),
      ...guests.map((guest) => guest.relayUrl),
      ...(guestRelay.trim() === "" ? [] : [guestRelay]),
    ]),
  ];

  const submitRelay = async () => {
    if (status?.enabled === true && !isCurrentRelay) {
      const learned = selectedRelay !== undefined && selectedRelay.hostId !== null;
      const confirmed = await requestConfirmDialog(
        learned
          ? m(
              msg(
                "Switch this computer to {relayUrl}? Guests using {currentRelayUrl} go offline until you switch back; their host keys stay valid.",
                { relayUrl: normalizedRelayUrl, currentRelayUrl: status.relayUrl ?? "" },
              ),
            )
          : m(
              msg(
                "Switch this computer to {relayUrl}? Paired guests have not learned this relay yet. Save it first if you want them to add it automatically; switching now may ask each guest for its host key.",
                { relayUrl: normalizedRelayUrl },
              ),
            ),
      );
      if (confirmed === false) return;
    }
    await startSharing();
  };

  return (
    <SettingsSection
      {...searchableSetting("personal-network")}
      id="personal-network"
      title={gt("Personal network")}
    >
      <SettingsRow
        title={gt("Share this computer")}
        description={gt(
          "Guests with this computer's host key can use its projects while the app is running and sharing is on. Closing the window keeps sharing on; Quit stops it.",
        )}
      >
        <div className="flex w-full max-w-md flex-col gap-2">
          <Select
            value={selectedValue}
            onValueChange={(value) => {
              relayTouched.current = true;
              setRelayUrl(value === NEW_RELAY_VALUE ? "" : value);
              setRelayKey("");
            }}
          >
            <SelectTrigger aria-label={gt("Saved relay")} size="sm">
              <SelectValue>{selectedRelay?.relayUrl ?? gt("New relay…")}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start">
              {relays.map((relay) => (
                <SelectItem hideIndicator key={relay.relayUrl} value={relay.relayUrl}>
                  {relay.relayUrl}
                  {relay.hostId === null ? gt(" (not registered)") : ""}
                </SelectItem>
              ))}
              <SelectItem hideIndicator value={NEW_RELAY_VALUE}>
                <T>New relay…</T>
              </SelectItem>
            </SelectPopup>
          </Select>
          <Input
            aria-label={gt("Relay URL")}
            disabled={busy}
            onChange={(event) => {
              relayTouched.current = true;
              setRelayUrl(event.currentTarget.value);
            }}
            placeholder="https://relay.example.com"
            value={relayUrl}
          />
          <Input
            aria-label={gt("Relay key")}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setRelayKey(event.currentTarget.value)}
            placeholder={
              selectedRelay?.hasRelayKey === true
                ? gt("Saved enrollment key (leave blank to reuse)")
                : gt("Enrollment key (Cloudflare relays only)")
            }
            type="password"
            value={relayKey}
          />
          <div className="flex gap-2">
            <Input
              aria-label={gt("This computer's label")}
              disabled={busy}
              onChange={(event) => setLabel(event.currentTarget.value)}
              placeholder={gt("Home PC")}
              value={label}
            />
            <Button
              disabled={busy || normalizedRelayUrl.length === 0}
              size="sm"
              onClick={() => void submitRelay()}
            >
              {actionLabel}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {normalizedRelayUrl.length > 0 &&
            (selectedRelay === undefined || relayKey.trim() !== "") ? (
              <Button
                disabled={busy}
                size="xs"
                variant="outline"
                onClick={() => void saveCurrentRelay()}
              >
                <T>Save relay</T>
              </Button>
            ) : null}
            {selectedRelay !== undefined ? (
              <Button
                disabled={busy || isCurrentRelay}
                size="xs"
                variant="ghost-destructive"
                onClick={() => void forgetCurrentRelay()}
              >
                <T>Forget relay</T>
              </Button>
            ) : null}
          </div>

          {status?.enabled ? (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                {status.paused
                  ? gt("Paused: guests cannot connect.")
                  : status.online
                    ? gt("Online and discoverable.")
                    : gt("Connecting…")}
                {status.publicUrl ? ` · ${status.publicUrl}` : ""}
                {status.connectorKind
                  ? ` · ${status.connectorKind === "cloudflare-tunnel" ? gt("Cloudflare Tunnel") : "frpc"} ${status.connectorRunning ? gt("running") : gt("stopped")}`
                  : ""}
              </p>
              {status.connectorKind === "cloudflare-tunnel" && status.connectorMode === "quick" ? (
                <Alert variant="warning">
                  <AlertDescription>
                    <T>
                      Quick tunnels use a temporary trycloudflare.com address that changes whenever
                      the tunnel restarts, without SSE support or an SLA. Use a named Cloudflare
                      tunnel for a stable address.
                    </T>
                  </AlertDescription>
                </Alert>
              ) : null}
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
                  <T>Reveal</T>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || hostKey === null}
                  onClick={() => void copyHostKey()}
                >
                  <T>Copy</T>
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void rotateKey()}
                >
                  <T>Rotate key</T>
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
                    <T>Resume sharing</T>
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => pause({ environmentId, input: {} }))}
                  >
                    <T>Pause sharing</T>
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
                  <T>Stop sharing</T>
                </Button>
              </div>
              {status.lastError ? <p className="text-destructive">{status.lastError}</p> : null}
            </div>
          ) : null}
        </div>
      </SettingsRow>

      <SettingsRow
        title={gt("Add a computer")}
        description={gt(
          "Paste a host key from another computer. Each key is a separate environment, and several can run at the same time.",
        )}
      >
        <div className="flex w-full max-w-md flex-col gap-2">
          <Input
            aria-label={gt("Guest relay URL")}
            disabled={busy}
            list="personal-relay-urls"
            onChange={(event) => setGuestRelay(event.currentTarget.value)}
            placeholder="https://relay.example.com"
            value={guestRelay}
          />
          <datalist id="personal-relay-urls">
            {relaySuggestions.map((relayUrl) => (
              <option key={relayUrl} value={relayUrl} />
            ))}
          </datalist>
          <div className="flex gap-2">
            <Input
              aria-label={gt("Host key")}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setGuestKey(event.currentTarget.value)}
              placeholder={gt("Paste a host key")}
              type="password"
              value={guestKey}
            />
            <Button
              disabled={busy || guestKey.trim().length === 0}
              size="sm"
              onClick={() => void addGuest()}
            >
              <T>Add</T>
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
                      {guest.paused ? gt("Paused") : guest.online ? gt("Online") : gt("Offline")} ·{" "}
                      {guest.relayUrl}
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
                      <T>Refresh</T>
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-destructive"
                      onClick={() => removeGuest(guest)}
                    >
                      <T>Remove</T>
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
