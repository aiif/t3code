# Personal network

Personal network connects your own machines through a relay you control,
without a T3 account. Each host registers directly with your relay and gets a
**host key**. A guest — the desktop app or the native Android APK — enters that
host key and operates that one machine. Each host key is independent: one key
never reaches another host.

The admin console at the relay's root origin manages hosts, host keys, and guest
sessions. It uses a separate **admin key** and cannot open projects by itself.

## Choose a relay

The relay URL you enter selects the relay. Clients have no separate relay-type
setting, and one host uses one relay at a time.

- **Self-hosted relay** — the relay you deploy, for example
  `https://relay.example.com`. No enrollment key.
- **Cloudflare Tunnel relay** — optional, deployed in your own Cloudflare
  account. Hosts also need the deployment's enrollment key.

Both use the same host keys, the same admin console, and the same guest flow.
The rest of this page applies to either relay; see
[Cloudflare Tunnel relay](#cloudflare-tunnel-relay) for what differs.

## Deploy a relay

A self-hosted relay needs a fresh Linux VPS with `80`, `443`, and `7001` free,
and two DNS-only records:

```text
A     relay.example.com      <VPS IPv4>
A     *.relay.example.com    <VPS IPv4>
```

Add `AAAA` records when the VPS has IPv6. Do not proxy these records through
Cloudflare.

On the VPS, either use the Docker installer:

```sh
npx @aiif/t3relay@latest init --domain relay.example.com --email you@example.com
```

or let an agent install it natively without Docker:

```sh
npx @aiif/t3relay@latest prompt
```

Paste the printed prompt into your agent. Both paths print the relay URL, the
admin key once, and the host URL rule. Open the relay URL and enter the admin
key to reach the admin console. See
[self-hosted relay operations](../operations/personal-relay.md) for upgrades,
backups, and troubleshooting.

## Sharing a computer

1. Open **Settings → Connections → Personal network**.
2. Pick a saved relay or choose **New relay...**, then enter its URL (for
   example `https://relay.example.com`) and a label such as "Home PC".
3. For a Cloudflare relay, paste the **enrollment key** the deployment printed.
   A self-hosted relay does not use one.
4. Choose **Register**. The relay returns this computer's host key.
5. **Reveal** or **Copy** the key and give it to the devices that should reach
   this computer.

The panel remembers each relay URL and enrollment key. **Save relay** stores one
without switching, and **Switch** moves this computer to another relay without
asking guests to enter anything again: the relay keeps the host registered, so
switching back reuses the same host id, host key, and address. The relay you
switch away from goes offline but stays registered; **Stop sharing** unregisters
the current relay and invalidates its key. **Forget relay** removes the selected
saved relay and its stored enrollment key; the relay keeps this host's
registration until you remove the host in its admin console.

While the desktop app is running — window or tray — and sharing is on, the host
stays registered, heartbeats, and keeps its connector running, so guests can
find and use it. Closing the window hides it to the tray; sharing keeps running.
Only tray **Quit** stops the server and makes the host offline.

**Pause sharing** hides the host from guests without quitting; the host key stays
valid, so **Resume sharing** needs no new key. **Stop sharing** unregisters the
host and invalidates its key.

**Rotate key** replaces the host key. Guests using the old key get rejected and
must enter the new one. The relay also offers rotation from the admin console.

The connector binary depends on the relay: `frpc` for a self-hosted relay,
`cloudflared` for a Cloudflare relay. `frpc` must be on `PATH` or at
`T3CODE_FRPC_PATH`. The Windows and macOS release builds include `cloudflared`;
a command-line host needs it on `PATH` or at `T3CODE_CLOUDFLARED_PATH`. A missing
or crashed connector shows an error in the panel and retries.

Headless machines can share from the CLI:

```sh
t3 personal join --relay https://relay.example.com --label "Studio PC"
t3 personal join --relay https://relay.example.com --relay-key "<enrollment key>" --label "Studio PC"
t3 personal status
t3 personal disable
```

The CLI registers directly and stores the host key in the server's state
directory. Open the desktop app's settings to copy it.

## Cloudflare Tunnel relay

The Cloudflare Tunnel relay deploys into your own Cloudflare account and needs
no VPS. Run the deployment from a terminal:

```sh
npx t3cf@latest init
```

It prints the relay URL, admin key, and enrollment key once. Open the relay URL
to reach the admin console. Run `npx t3cf@latest init --help` for the deployment
flags, and back up the secrets file the deployment writes: losing its secret key
breaks host-key reveal and forces hosts to register again.

The rest of this section covers using a deployed relay.

### Quick and named addresses

A deployment runs in one mode for every host it serves. `auto` picks **named**
when the deployment has a Cloudflare zone and runtime token, and **quick**
otherwise.

|            | Quick                                                                     | Named                                                 |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Setup      | Nothing beyond the relay                                                  | Cloudflare-managed zone and a Zero Trust organization |
| Address    | `https://<random>.trycloudflare.com`                                      | `https://<hostId>.<zone>`                             |
| Lifetime   | Changes when the tunnel restarts                                          | Stable across restarts                                |
| Use it for | A trial or a quick look                                                   | Everyday sharing                                      |
| Limits     | About 200 in-flight requests, no server-sent events (guest links), no SLA | Normal Cloudflare edge limits                         |

**Quick tunnels are temporary and not for everyday use.** The address changes
when the host app restarts, when sharing is paused and resumed, and when the
connector restarts. The host key does not change, but guests must **Refresh**
the host to resolve the new address.

**Named tunnels need a Cloudflare-managed zone and a Zero Trust organization.**
Cloudflare asks for payment details when you create the Zero Trust organization,
even on the Free plan. The deployment cannot skip that step; use quick mode if
you do not want a zone or Zero Trust.

### Hostnames and TLS

Named hosts get one label under the zone: `https://<hostId>.example.com`.
Cloudflare's free Universal SSL covers that one level. For a `t3.` prefix, add
`t3.example.com` to Cloudflare as its own zone; hosts then become
`https://<hostId>.t3.example.com`. The relay does not create deeper names by
default, and deeper names need a paid certificate setup.

The zone must be active in Cloudflare before you deploy. The relay creates and
removes the proxied DNS record for each host.

### Keys

- **Enrollment key** — proves a host may register with this relay. The
  deployment prints it, and the host stores it. It is not the admin key, and
  guests never need it. Registration fails with 401 without the current key.
- **Host key** — returned at registration and shown in the host's panel. This is
  the key a guest enters; there is no separate guest key. The host panel and the
  admin console can reveal it.
- **Admin key** — opens the admin console and nothing else.

### Managing a Cloudflare host

Pause, resume, rotate, and stop work as they do on a self-hosted relay. Pausing
stops the tunnel; resuming a quick tunnel gets a new address, while a named
tunnel keeps its hostname. Rotating invalidates the old host key and disconnects
its guests; they must enter the new key.

**Remove** in the admin console revokes the host and stops its connector. Its
key stops working and it moves to **Removed hosts**. **Restore** keeps the host
id and key, so after you restore it, register from the host again and guests can
re-pair with the same key.

To move a host between relays, pick the other saved relay (or enter its URL and
enrollment key on a Cloudflare relay) and choose **Switch**. **Save relay** first
when guests have never used that relay: saving registers it, and paired guests
pull its key within a minute. The previous relay keeps the host registered but
offline, so switching back reuses the same host key and guests do not re-enter
it. A relay this computer has never used still issues its own key; paired guests
receive it automatically the next time they sync with the host.

### Limits

- Push notifications are not delivered through a Cloudflare relay in this
  version. Web Push subscriptions through the relay do not deliver.
- Cloudflare's proxy times out a single HTTP request after about 100 seconds
  (error 524). WebSocket traffic is unaffected; retry a long upload or download,
  or use a smaller file.
- The registry stores metadata only. Project traffic goes through Cloudflare's
  edge and the tunnel directly to the host.

### Troubleshooting

| Problem                                              | What to do                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| The relay URL does not answer                        | Confirm the URL from the deployment, with no path or trailing slash. Open it in a browser for the admin console, or check `<relay>/v1/health`. |
| Registration returns 401                             | The enrollment key is missing, wrong, or rotated. Copy the current key from the deployment owner, paste it again, and register.                |
| Registration returns 410 or "removed"                | An admin removed this host. Restore it in **Removed hosts**, then register from the host again.                                                |
| Host is offline or paused                            | Resume sharing, make sure the app is running, and check the panel for a connector error. Guests cannot reach a host while its tunnel is down.  |
| Connector will not start                             | `cloudflared` is missing or crashed. Windows and macOS release builds include it; on a CLI host, install it or set `T3CODE_CLOUDFLARED_PATH`.  |
| The tunnel will not connect on a restrictive network | Allow outbound UDP 7844 for QUIC, or outbound TCP 443 so `cloudflared` can fall back to HTTP/2. A network that blocks both cannot tunnel.      |
| A quick address stopped working                      | The tunnel restarted. The host key is unchanged; add the computer again with the same key to resolve the new address.                          |
| A long request fails with 524                        | The request passed Cloudflare's ~100-second HTTP timeout. Retry, or split the file. WebSocket sessions are not affected.                       |
| No notifications from a Cloudflare host              | Relay push is not part of this version. The desktop app still shows activity in the thread.                                                    |

## Adding a computer

1. In **Personal network → Add a computer**, paste a host key from the other
   machine.
2. The app resolves the key through the relay, pairs with that host, and saves
   it as another environment.

A Cloudflare relay changes nothing here: set its relay URL and the host key.

A paired guest also pulls the host's other saved relays. Once a host saves a
relay, each guest adds that relay as another route automatically on its next
sync, so switching the host between saved relays needs no new key on any guest.
The relay must be online when the guest pairs with it; a relay saved while the
host is offline stays pending and is retried.

One host can end up with two entries when it is saved through two relay URLs —
a Cloudflare relay's workers.dev address and its custom domain, for example,
which are the same relay. Each entry shows the relay it resolves through, and
**Remove** drops just that route; the entry through the other URL keeps
working.

Each host is a separate environment. Several can be connected and used at the
same time; there is no single active host. The existing Connections list shows
their online state and lets you remove one.

On Android, open **Add environment → Personal network**, enter the relay URL and
the host key, then **Add computer**. The form stays focused on adding: it does
not list existing computers. Manage them from **Settings → Environments**;
removing one there also forgets its saved host keys.

## What a guest can do

A host-key session is a **guest** session. It can:

- see every project and thread on that host;
- read messages, reasoning, tool output, diffs, files, and attachments;
- launch threads, send messages, queue and steer;
- approve agent requests and answer questions;
- stop or interrupt runs;
- fork, archive, unarchive, settle, snooze, pin, and tag threads;
- open terminals and run commands as the host's user, including from the phone.

It cannot:

- delete threads (owner-only safety default);
- create, rename, or delete projects;
- change server settings or manage providers and authentication;
- edit files from the app's file browser (its terminal can still change them);
- use the app's Git and pull-request controls;
- manage access, pairing links, scheduled tasks, browser previews, or devices;
- use `/mcp` or peer links.

The sidebar shows a **Guest** badge for a host-key session. The owner's local
desktop and browser keep full access.

## Admin console

Open the relay origin in a browser and enter the admin key. The console lists:

- every registered host, its label, online/paused state, last heartbeat, and
  public URL;
- that host's host key (reveal/copy only on request);
- the guest sessions the host reported;
- **Rotate key** and **Remove**.
- **Remove** revokes the host and moves it to **Removed hosts**. Its key stops
  working and it cannot register again until **Restore** puts it back. Restore
  keeps the host id and key, so guests can re-pair with the same key.

The admin key is stored under `t3.admin.key`, separately from any guest key. It
is rejected by every host's `/oauth/token` and cannot operate a project as a
guest. To use a host, enter that host's key in a guest client.

A Cloudflare relay answers on its workers.dev address and on its custom domain.
The console's saved key belongs to the browser origin it was entered on, so the
two addresses are separate consoles with their own saved key, each listing the
same hosts. **Forget relay** clears the saved relay URL and key for the origin
you are on; the relay and its hosts are untouched.

## Notifications

The desktop app receives notifications for the hosts it is connected to. Web
Push subscriptions are scoped to a host or to the admin console. Notifications
carry a host label, thread title, and project title only — never prompts,
command output, or file content.

A Cloudflare relay does not deliver Web Push in this version. The console lists
hosts and guests without it, and the desktop app still shows activity in the
thread.

## Security model

- A host key is fully trusted for that one host, including every project on it
  and a shell as its user. Give it only to people who should operate that
  machine.
- A paired guest can ask the host for its other saved relay keys. That only adds
  routes back to the same host, so it grants nothing the guest did not already
  have.
- The admin key is the relay's root credential. Keep it off hosts and guests.
- Host keys are random 32-byte values, encrypted at rest on the relay, and
  revocable.
- A self-hosted relay terminates TLS and stores metadata only; project traffic
  goes through `frps` to the host. A Cloudflare relay stores metadata in
  Cloudflare and project traffic goes through Cloudflare's edge and the tunnel.
- Removing a guest means rotating the host key. The host applies the rotation and
  revokes old guest sessions.
