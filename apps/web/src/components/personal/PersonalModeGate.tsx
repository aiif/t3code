import type { EnvironmentId, PersonalAdminHost, PersonalGuestClient } from "@t3tools/contracts";
import {
  detectAndConnectPersonalKey,
  forgetPersonalAdminConfig,
  getAdminHost,
  isPersonalAdminError,
  listAdminHosts,
  personalHostRecord,
  readPersonalAdminConfig,
  readPersonalHosts,
  removeAdminHost,
  removePersonalHost,
  restoreAdminHost,
  revokeAdminClient,
  rotateAdminHostKey,
  upsertPersonalHost,
  type DetectedPersonalKeyOutcome,
  type PairPersonalHost,
  type PersonalAdminConfig,
} from "@t3tools/client-runtime/personal/portal";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const PERSONAL_OPEN_ADMIN_EVENT = "t3:open-personal-admin";
const PERSONAL_HOSTS_CHANGED_EVENT = "t3:personal-hosts-changed";

function hasAdminQueryOrHash(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("admin")) return true;
    if (window.location.hash.toLowerCase().includes("admin")) return true;
  } catch {
    // ignore
  }
  return false;
}

export function openPersonalAdminConsole(): void {
  if (typeof window !== "undefined") {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("admin", "1");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch {
      // ignore
    }
  }
  window.dispatchEvent(new CustomEvent(PERSONAL_OPEN_ADMIN_EVENT));
}

export function notifyPersonalHostsChanged(): void {
  window.dispatchEvent(new CustomEvent(PERSONAL_HOSTS_CHANGED_EVENT));
}

const pairHostWithRuntime: PairPersonalHost = async (input) => {
  const paired = await runAtomCommand(appAtomRegistry, connectPairing, input, {
    reportFailure: false,
  });
  if (paired._tag === "Success") return { ok: true };
  const cause = squashAtomCommandFailure(paired);
  return {
    ok: false,
    error: cause instanceof Error ? cause.message : "The host refused the key.",
  };
};

export function PersonalModeGate({
  hosted,
  children,
}: {
  hosted: boolean;
  children: React.ReactNode;
}) {
  const [config, setConfig] = useState(readPersonalAdminConfig);
  const [hosts, setHosts] = useState(readPersonalHosts);
  const [showAdmin, setShowAdmin] = useState(hasAdminQueryOrHash);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to global window events to switch between workspace and admin console or update host records
  useEffect(() => {
    const onOpenAdmin = () => setShowAdmin(true);
    const onHostsChanged = () => setHosts(readPersonalHosts());
    const onPopState = () => {
      if (hasAdminQueryOrHash()) {
        setShowAdmin(true);
      }
    };
    window.addEventListener(PERSONAL_OPEN_ADMIN_EVENT, onOpenAdmin);
    window.addEventListener(PERSONAL_HOSTS_CHANGED_EVENT, onHostsChanged);
    window.addEventListener("storage", onHostsChanged);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener(PERSONAL_OPEN_ADMIN_EVENT, onOpenAdmin);
      window.removeEventListener(PERSONAL_HOSTS_CHANGED_EVENT, onHostsChanged);
      window.removeEventListener("storage", onHostsChanged);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  if (!hosted) return <>{children}</>;

  if (showAdmin || (config !== null && hosts.length === 0)) {
    if (config !== null) {
      return (
        <AdminConsole
          canGoToWorkspace={hosts.length > 0}
          config={config}
          onForget={() => {
            const currentRelay = config.relayUrl;
            forgetPersonalAdminConfig();
            for (const h of readPersonalHosts()) {
              if (h.relayUrl === currentRelay) {
                removePersonalHost({ hostId: h.hostId, relayUrl: h.relayUrl });
              }
            }
            setConfig(null);
            setHosts(readPersonalHosts());
            setShowAdmin(false);
          }}
          onGoToWorkspace={() => {
            if (typeof window !== "undefined") {
              try {
                const url = new URL(window.location.href);
                if (url.searchParams.has("admin")) {
                  url.searchParams.delete("admin");
                  window.history.replaceState(
                    null,
                    "",
                    url.pathname + (url.search ? url.search : "") + url.hash,
                  );
                }
              } catch {
                // ignore
              }
            }
            setShowAdmin(false);
          }}
        />
      );
    }
  }

  if (hosts.length > 0) {
    return (
      <>
        {children}
        {config !== null ? (
          <div className="fixed bottom-3 right-3 z-40 hidden sm:flex">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                openPersonalAdminConsole();
                setShowAdmin(true);
              }}
            >
              Admin console
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <UnifiedPersonalKeySurface
      onConnected={(outcome) => {
        if (outcome.kind === "host") {
          setHosts(readPersonalHosts());
          setShowAdmin(false);
        } else {
          setConfig(outcome.config);
          setHosts(readPersonalHosts());
          setShowAdmin(true);
        }
      }}
    />
  );
}

function errorMessage(cause: unknown): string {
  return isPersonalAdminError(cause)
    ? cause.message
    : cause instanceof Error
      ? cause.message
      : "The relay request failed.";
}

function UnifiedPersonalKeySurface({
  onConnected,
}: {
  readonly onConnected: (outcome: DetectedPersonalKeyOutcome) => void;
}) {
  const [relayUrl, setRelayUrl] = useState(() => window.location.origin);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (key.trim().length === 0) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await detectAndConnectPersonalKey({
        relayUrl: relayUrl.trim(),
        key: key.trim(),
        pairHost: pairHostWithRuntime,
      });
      onConnected(outcome);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        description="Enter your relay and key to connect. A host key opens its computer; an admin key connects all computers registered on the relay."
        title="Connect to personal network"
      />
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="personal-relay">
            Relay
          </label>
          <Input
            autoCapitalize="none"
            autoCorrect="off"
            disabled={busy}
            id="personal-relay"
            nativeInput
            onChange={(event) => setRelayUrl(event.currentTarget.value)}
            placeholder="https://t3.example.com"
            spellCheck={false}
            value={relayUrl}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="personal-key">
            Key
          </label>
          <Input
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={busy}
            id="personal-key"
            nativeInput
            onChange={(event) => setKey(event.currentTarget.value)}
            placeholder="Paste your host or admin key"
            spellCheck={false}
            type="password"
            value={key}
          />
        </div>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button disabled={busy || key.trim().length === 0} size="sm" type="submit">
          {busy ? "Connecting..." : "Connect"}
        </Button>
      </form>
      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        The key stays in this browser. A host key connects directly to that computer; an admin key
        manages the relay and unlocks every active host on it.
      </div>
    </StandalonePage>
  );
}

function AdminConsole({
  config,
  canGoToWorkspace,
  onGoToWorkspace,
  onForget,
}: {
  readonly config: PersonalAdminConfig;
  readonly canGoToWorkspace?: boolean;
  readonly onGoToWorkspace?: () => void;
  readonly onForget: () => void;
}) {
  const [hosts, setHosts] = useState<ReadonlyArray<PersonalAdminHost>>([]);
  const [clients, setClients] = useState<Record<string, ReadonlyArray<PersonalGuestClient>>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setError("");
    try {
      setHosts(await listAdminHosts({ config }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  /* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync -- loads the relay's host catalog when the admin console opens */
  useEffect(() => {
    void refresh();
  }, [config.relayUrl, config.adminKey]);
  /* oxlint-enable react/set-state-in-effect, react/exhaustive-effect-dependencies, t3code/no-unreasoned-state-sync */

  const toggleClients = async (host: PersonalAdminHost) => {
    if (expanded === host.hostId) {
      setExpanded(null);
      return;
    }
    setExpanded(host.hostId);
    if (clients[host.hostId] !== undefined) return;
    setBusy(host.hostId);
    try {
      const detail = await getAdminHost({ config, hostId: host.hostId });
      setClients((current) => ({ ...current, [host.hostId]: detail.clients }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const connectHost = async (host: PersonalAdminHost) => {
    setBusy(host.hostId);
    setError("");
    try {
      const record = personalHostRecord({
        relayUrl: config.relayUrl,
        hostKey: host.hostKey,
        resolved: {
          hostId: host.hostId,
          environmentId: host.environmentId as EnvironmentId,
          label: host.label,
          publicUrl: host.publicUrl,
          online: host.online,
          paused: host.paused,
        },
      });
      upsertPersonalHost(record);
      const paired = await pairHostWithRuntime({
        host: host.publicUrl,
        pairingCode: host.hostKey,
        expectedEnvironmentId: host.environmentId as EnvironmentId,
      });
      if (!paired.ok) {
        setError(paired.error ?? "The host refused the key.");
        return;
      }
      notifyPersonalHostsChanged();
      onGoToWorkspace?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (host: PersonalAdminHost) => {
    if (
      !window.confirm(
        `Rotate ${host.label ?? host.hostId}'s host key? Old guest sessions stop working.`,
      )
    ) {
      return;
    }
    setBusy(host.hostId);
    setError("");
    try {
      await rotateAdminHostKey({ config, hostId: host.hostId });
      await refresh();
      setRevealed((current) => new Set(current).add(host.hostId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (host: PersonalAdminHost) => {
    if (
      !window.confirm(
        `Remove ${host.label ?? host.hostId}? Its host key stops working and it cannot register again until you restore it.`,
      )
    ) {
      return;
    }
    setBusy(host.hostId);
    setError("");
    try {
      await removeAdminHost({ config, hostId: host.hostId });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (host: PersonalAdminHost) => {
    setBusy(host.hostId);
    setError("");
    try {
      await restoreAdminHost({ config, hostId: host.hostId });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (host: PersonalAdminHost) => {
    await navigator.clipboard.writeText(host.hostKey);
  };

  const revokeClient = async (host: PersonalAdminHost, client: PersonalGuestClient) => {
    setBusy(host.hostId);
    setError("");
    try {
      await revokeAdminClient({
        config,
        hostId: host.hostId,
        sessionId: client.sessionId,
      });
      setClients((current) => ({
        ...current,
        [host.hostId]: (current[host.hostId] ?? []).map((entry) =>
          entry.sessionId === client.sessionId
            ? { ...entry, revokedAt: new Date().toISOString() }
            : entry,
        ),
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const activeHosts = hosts.filter((host) => host.revokedAt == null);
  const removedHosts = hosts.filter((host) => host.revokedAt != null);

  return (
    <StandalonePage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <StandalonePageHeader
            description="Hosts registered with this relay, their host keys, and the guest clients they reported."
            title="Personal network admin"
          />
          <p className="mt-2 truncate text-xs text-muted-foreground">{config.relayUrl}</p>
        </div>
        <div className="flex gap-2">
          {canGoToWorkspace && onGoToWorkspace ? (
            <Button size="sm" onClick={onGoToWorkspace}>
              Go to workspace
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={onForget}>
            Forget relay
          </Button>
        </div>
      </div>

      {error ? (
        <Alert className="mt-4" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {activeHosts.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          {removedHosts.length === 0
            ? "No hosts yet. Open T3 Code on a computer and use Settings → Personal Network → Share this computer."
            : "No active hosts. Restore a removed host below to let it register again."}
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {activeHosts.map((host) => {
            const isRevealed = revealed.has(host.hostId);
            const hostClients = clients[host.hostId];
            return (
              <div key={host.hostId} className="rounded-lg border border-border/70 bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{host.label ?? host.hostId}</p>
                      <span className="text-xs text-muted-foreground">
                        {host.paused ? "Paused" : host.online ? "Online" : "Offline"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {host.hostId} · {host.platform ?? "unknown"} · {host.clientsCount} guest
                      {host.clientsCount === 1 ? "" : "s"} · last seen {host.lastSeenAt}
                    </p>
                    <a
                      className="mt-1 block truncate text-xs text-primary underline-offset-2 hover:underline"
                      href={host.publicUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {host.publicUrl}
                    </a>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <code className="rounded bg-muted px-2 py-1 text-xs">
                        {isRevealed ? host.hostKey : "••••••••••••••••"}
                      </code>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setRevealed((current) => {
                            const next = new Set(current);
                            if (next.has(host.hostId)) next.delete(host.hostId);
                            else next.add(host.hostId);
                            return next;
                          })
                        }
                      >
                        {isRevealed ? "Hide" : "Reveal"}
                      </Button>
                      <Button size="xs" variant="outline" onClick={() => void copy(host)}>
                        Copy
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {host.online && !host.paused ? (
                      <Button
                        disabled={busy !== null}
                        size="xs"
                        onClick={() => void connectHost(host)}
                      >
                        Open workspace
                      </Button>
                    ) : null}
                    <Button
                      disabled={busy !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => void toggleClients(host)}
                    >
                      {expanded === host.hostId ? "Hide guests" : "Guests"}
                    </Button>
                    <Button
                      disabled={busy !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => void rotate(host)}
                    >
                      Rotate key
                    </Button>
                    <Button
                      disabled={busy !== null}
                      size="xs"
                      variant="destructive"
                      onClick={() => void remove(host)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                {expanded === host.hostId ? (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    {busy === host.hostId && hostClients === undefined ? (
                      <p className="text-xs text-muted-foreground">Loading guests...</p>
                    ) : hostClients === undefined || hostClients.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No guest sessions reported.</p>
                    ) : (
                      <ul className="space-y-1 text-xs">
                        {hostClients.map((client) => (
                          <li key={client.sessionId} className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{client.clientLabel ?? "Guest"}</span>
                            <span className="text-muted-foreground">
                              {client.platform ?? "unknown"} · last seen {client.lastSeenAt}
                              {client.revokedAt ? " · revoked" : ""}
                            </span>
                            {client.revokedAt ? null : (
                              <Button
                                disabled={busy !== null}
                                size="xs"
                                variant="ghost-destructive"
                                onClick={() => void revokeClient(host, client)}
                              >
                                Revoke
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {removedHosts.length > 0 ? (
        <div className="mt-8">
          <h2 className="text-sm font-medium">Removed hosts</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A removed host cannot register again. Restore it to keep the same host id and key, then
            register again from T3 Code on that computer.
          </p>
          <div className="mt-3 space-y-3">
            {removedHosts.map((host) => (
              <div key={host.hostId} className="rounded-lg border border-border/70 bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{host.label ?? host.hostId}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {host.hostId} · removed {host.revokedAt}
                    </p>
                    <a
                      className="mt-1 block truncate text-xs text-primary underline-offset-2 hover:underline"
                      href={host.publicUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {host.publicUrl}
                    </a>
                  </div>
                  <Button
                    disabled={busy !== null}
                    size="xs"
                    variant="outline"
                    onClick={() => void restore(host)}
                  >
                    Restore
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </StandalonePage>
  );
}
