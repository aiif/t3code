# Personal mode

Personal mode turns a set of machines into one private network behind a single
key. A phone or another computer installs one web app from your relay and sees
every host registered with that key. Each host keeps running its own T3 Code
server: projects, agents, terminals, files, and checkpoints stay on that machine.

This is for a deployment where you are the only owner. Every device that has the
key is fully trusted: it can read every project on every host and drive any
agent. Project visibility is not a security boundary.

## Joining a host

Run this once on each machine that should be reachable, then restart its T3 Code
server if it does not restart automatically:

```sh
t3 personal join \
  --relay https://t3.example.com \
  --key "<your personal key>" \
  --label "Home PC"
```

It writes the relay URL, key, and label into the machine's `service.env` and
restarts the background service. `t3 personal status` shows what the host last
reported to the relay. `t3 personal disable` stops the connector; the relay
reports the host offline once its heartbeat expires.

The T3 server still listens only on loopback. A small `frpc` process connects
out to the relay and carries HTTP and WebSocket traffic for the host's
subdomain; the relay never reaches into your network.

## Entering the key on a phone

1. Open the portal origin (`https://t3.example.com`) and install it as an app, or
   install the native Android APK from the release page.
2. Enter the key once. The portal or app fetches the host list from the relay and
   pairs every host in that key space.
3. Hosts added later appear the next time the portal or app is foregrounded or
   comes back online. The key stays on that device so it can pair them without
   asking again.

The Android app is the native React Native client, not a WebView. In **Add
environment**, the **Personal network** section takes the relay URL and key and
discovers hosts the same way the portal does. Personal-key sessions show a
**Guest** badge in the environment list.

Each host gets a stable subdomain (`https://<hostId>.t3.example.com`). Direct
links to a host work too: opening `/pair#token=<key>` on that subdomain sets a
session cookie for that host in the browser.

## What a personal-key session can do

A session created from the key is a **guest** session. It can:

- see every project and thread on the host;
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
- use the direct Git UI, branch, push, or open pull requests (agents on the host
  can still run Git);
- manage access, pairing links, scheduled tasks, browser previews, or devices;
- answer MCP or peer-link connections.

The sidebar shows a **Guest** badge when the current session came from the
personal key.

## Notifications

Enable notifications from the prompt the portal shows; it disappears once you
answer or the browser has already granted permission. Turn them off from the
portal's site permissions in the browser. The portal registers a Web Push
subscription with the relay, and each host posts a notification when an agent:

- needs approval;
- needs input;
- finishes;
- fails.

Notifications carry a host label, thread title, and project title only. They
never include prompts, command output, or file content. A click opens the thread
on that host. Notifications are deduplicated and rate-limited per thread and
phase.

Web Push belongs to the portal PWA. The native Android app does not register for
these background notifications; install the portal PWA alongside it if you want
alerts while the app is closed.

## Rotating the key

1. Change the key in the relay's environment and restart the relay.
2. Change `T3CODE_PERSONAL_KEY` on every host and restart it. Each host detects
   the new key at startup and revokes the guest sessions the old key created.
3. Re-enter the key in every portal and app. Devices that lost the key stop
   working immediately.

Registering under a new key starts a new key space, so hosts get new subdomains.

## Limits worth knowing

- The relay terminates TLS; traffic is not end-to-end encrypted.
- Removing a device from the network means rotating the key. There is no
  per-device approval.
- The owner's local browser and desktop app keep the startup token and full
  access. Personal mode does not narrow them.
