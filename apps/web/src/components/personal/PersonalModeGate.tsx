import type { PersonalAdminHost, PersonalGuestClient } from "@t3tools/contracts";
import {
  forgetPersonalAdminConfig,
  getAdminHost,
  isPersonalAdminError,
  listAdminHosts,
  readPersonalAdminConfig,
  removeAdminHost,
  revokeAdminClient,
  rotateAdminHostKey,
  savePersonalAdminConfig,
  type PersonalAdminConfig,
} from "@t3tools/client-runtime/personal/portal";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export function PersonalModeGate({
  hosted,
  children,
}: {
  hosted: boolean;
  children: React.ReactNode;
}) {
  const [config, setConfig] = useState(readPersonalAdminConfig);
  if (!hosted) return <>{children}</>;
  if (config === null) {
    return <AdminSetupSurface onSaved={setConfig} />;
  }
  return (
    <AdminConsole
      config={config}
      onForget={() => {
        forgetPersonalAdminConfig();
        setConfig(null);
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

function AdminSetupSurface({ onSaved }: { onSaved: (config: PersonalAdminConfig) => void }) {
  const [relayUrl, setRelayUrl] = useState(() => window.location.origin);
  const [adminKey, setAdminKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = savePersonalAdminConfig({ relayUrl, adminKey });
      await listAdminHosts({ config: saved });
      onSaved(saved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Personal network admin"
        description="This console manages hosts and guest access. It cannot open projects; use a host key in a client to do that."
      />
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="admin-relay">
            Relay
          </label>
          <Input
            id="admin-relay"
            autoCapitalize="none"
            autoCorrect="off"
            disabled={busy}
            nativeInput
            onChange={(event) => setRelayUrl(event.currentTarget.value)}
            placeholder="https://t3.example.com"
            spellCheck={false}
            value={relayUrl}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="admin-key">
            Admin key
          </label>
          <Input
            id="admin-key"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={busy}
            nativeInput
            onChange={(event) => setAdminKey(event.currentTarget.value)}
            placeholder="The relay's admin key"
            spellCheck={false}
            type="password"
            value={adminKey}
          />
        </div>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button disabled={busy || adminKey.trim().length === 0} size="sm" type="submit">
          {busy ? "Checking..." : "Open admin console"}
        </Button>
      </form>
      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        The admin key stays in this browser under a separate storage key. It lists hosts and guest
        sessions, and can rotate or remove host keys. It never authenticates as a guest.
      </div>
    </StandalonePage>
  );
}

function AdminConsole({
  config,
  onForget,
}: {
  readonly config: PersonalAdminConfig;
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
    if (!window.confirm(`Remove ${host.label ?? host.hostId}? Its host key stops working.`)) {
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

  return (
    <StandalonePage>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <StandalonePageHeader
          title="Personal network admin"
          description="Hosts registered with this relay, their host keys, and the guest clients they reported."
        />
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={onForget}>
            Forget key
          </Button>
        </div>
      </div>

      {error ? (
        <Alert className="mt-4" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {hosts.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No hosts yet. Open T3 Code on a computer and use Settings → Personal Network → Share this
          computer.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {hosts.map((host) => {
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
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void toggleClients(host)}
                    >
                      {expanded === host.hostId ? "Hide guests" : "Guests"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void rotate(host)}
                    >
                      Rotate key
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={busy !== null}
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
                                size="xs"
                                variant="ghost-destructive"
                                disabled={busy !== null}
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
    </StandalonePage>
  );
}
