# Personal network

Personal network connects your own machines without a cloud account. Each host
registers directly with your relay and gets a **host key**. A guest — the
desktop app or the native Android APK — enters that host key and operates that
one machine. Each host key is independent: one key never reaches another host.

The admin console at the relay's root origin manages hosts, host keys, and guest
sessions. It uses a separate **admin key** and cannot open projects by itself.

## Sharing a computer

1. Open **Settings → Connections → Personal network**.
2. Set the relay URL (default `https://relay.example.com`) and a label such as
   "Home PC".
3. Choose **Register**. The relay returns this computer's host key.
4. **Reveal** or **Copy** the key and give it to the devices that should reach
   this computer.

While the desktop app is running — window or tray — and sharing is on, the host
stays registered, heartbeats, and keeps `frpc` connected, so guests can find and
use it. Closing the window hides it to the tray; sharing keeps running. Only
tray **Quit** stops the server and makes the host offline.

**Pause sharing** hides the host from guests without quitting; the host key stays
valid, so **Resume sharing** needs no new key. **Stop sharing** unregisters the
host and invalidates its key.

**Rotate key** replaces the host key. Guests using the old key get rejected and
must enter the new one. The relay also offers rotation from the admin console.

`frpc` must be on `PATH` or at `T3CODE_FRPC_PATH`. A missing or crashed `frpc`
shows an error in the panel and retries.

Headless machines can share from the CLI:

```sh
t3 personal join --relay https://relay.example.com --label "Studio PC"
t3 personal status
t3 personal disable
```

The CLI registers directly and stores the host key in the server's state
directory. Open the desktop app's settings to copy it.

## Adding a computer

1. In **Personal network → Add a computer**, paste a host key from the other
   machine.
2. The app resolves the key through the relay, pairs with that host, and saves
   it as another environment.

Each host is a separate environment. Several can be connected and used at the
same time; there is no single active host. The existing Connections list shows
their online state and lets you remove one.

On Android, open **Add environment → Personal network**, enter the relay URL and
the host key, then **Add computer**. The same list supports several hosts,
refresh, and remove.

## What a guest can do

A host-key session is a **guest** session. It can:

- see every project and thread on that host;
- read messages, reasoning, tool output, diffs, files, and attachments;
- launch threads, send messages, queue and steer;
- approve agent requests and answer questions;
- stop or interrupt runs;
- fork, archive, unarchive, settle, snooze, pin, and tag threads.

It cannot:

- delete threads (owner-only safety default);
- create, rename, or delete projects;
- change server settings or manage providers and authentication;
- open a terminal or write files;
- use the direct Git UI, branch, push, or open pull requests;
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

## Notifications

The desktop app receives notifications for the hosts it is connected to. Web
Push subscriptions are scoped to a host or to the admin console. Notifications
carry a host label, thread title, and project title only — never prompts,
command output, or file content.

## Security model

- A host key is fully trusted for that one host, including every project on it.
  Give it only to people who should operate that machine.
- The admin key is the relay's root credential. Keep it off hosts and guests.
- Host keys are random 32-byte values, encrypted at rest on the relay, and
  revocable.
- The relay terminates TLS and stores metadata only; project traffic goes
  through `frps` to the host.
- Removing a guest means rotating the host key. The host applies the rotation and
  revokes old guest sessions.
