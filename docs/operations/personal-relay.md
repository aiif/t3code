# Personal relay operations

Runbook for the self-hosted relay behind [personal network](../user/personal-mode.md).
The container deployment lives in [`infra/personal-relay`](../../infra/personal-relay/README.md);
that README owns its step-by-step procedure. This page covers health checks,
native systemd updates, and recovery.

## Deployment channels

There are two supported channels. Both use the same registry, admin console,
`deploy.json` schema, and `/opt/t3-relay` layout.

- **Docker one-command:** `npx @aiif/t3relay@latest init --domain relay.example.com`
  writes and starts a Caddy + `frps` + registry stack. Day-two commands:
  `upgrade`, `doctor`, `status`, `logs`, `uninstall`.
- **AI-native:** `npx @aiif/t3relay@latest prompt` prints a prompt for an agent
  running on the VPS. The agent follows
  [`native/AI-DEPLOY.md`](../../infra/personal-relay/native/AI-DEPLOY.md),
  installs systemd services and Caddy without Docker, and verifies the relay.

Both need two DNS-only records, `A relay.example.com` and
`A *.relay.example.com` (plus `AAAA` when the VPS has IPv6), and only public
ports `80`, `443`, and `7001`. `8080` and `8787` must stay internal (loopback on
the native path, the Compose network on Docker).

The manual Compose + OpenResty and native systemd sections below are retained
for existing hosts that need to coexist with other vhosts. New deployments
should use one of the two channels above.

## Components

| Piece     | Binds                            | Notes                                             |
| --------- | -------------------------------- | ------------------------------------------------- |
| OpenResty | `80`, `443`                      | Existing vhosts plus the portal and host wildcard |
| `frps`    | `7001`, vhost `8080` on loopback | Only `7001` is public                             |
| Registry  | `127.0.0.1:8787`                 | Hosts, host keys, guest metadata, Web Push        |
| `frpc`    | outbound from each host          | Spawned by the host's server                      |

T3 servers keep binding loopback. A host is reachable only through its `frpc`
connection, supervised by the T3 server process that owns it. Closing the
desktop window does not stop that process; tray Quit does, and the relay marks
the host offline when heartbeats expire (90 seconds by default). Pause stops
`frpc` and reports `online: false` immediately.

## Native systemd install

> The AI-native channel above is the supported no-Docker path and uses Caddy.
> The OpenResty unit layout below is retained for hosts that already run
> OpenResty and cannot give Caddy ports 80/443.

The relay can run without Docker. A native host uses three units:
`t3-registry.service`, `frps.service`, and `openresty.service`.

| Piece    | Unit                  | Files                                                                                 |
| -------- | --------------------- | ------------------------------------------------------------------------------------- |
| Registry | `t3-registry.service` | Source `/opt/t3-registry`, env `/etc/t3-relay/relay.env`, data `/var/lib/t3-registry` |
| frps     | `frps.service`        | Config `/etc/frp/frps.toml`                                                           |
| Portal   | `openresty.service`   | Static files `/srv/t3-portal`                                                         |

The registry unit runs Node directly (`ExecStart=/usr/local/bin/node src/main.ts`),
so source changes need a restart, not a build:

```sh
rsync -a --delete infra/personal-relay/registry/src/ root@<vps>:/opt/t3-registry/src/
ssh root@<vps> systemctl restart t3-registry
curl -sS http://127.0.0.1:8787/v1/health
```

The portal is a static build. Keep `.well-known` for certificate challenges and
skip source maps:

```sh
VITE_HOSTED_APP_URL=https://t3.example.com pnpm --filter @t3tools/web build
rsync -a --delete --exclude .well-known --exclude '*.map' apps/web/dist/ root@<vps>:/srv/t3-portal/
```

Portal files need no service restart. The service worker serves a cached shell,
so reload once after an update.

## Docker channel operations

The npm installer keeps everything under `/opt/t3-relay`:

| Path          | Purpose                                                 |
| ------------- | ------------------------------------------------------- |
| `deploy.json` | Admin key, secret key, frp token, domain, images (0600) |
| `relay.env`   | Registry environment (0600)                             |
| `data/`       | Registry SQLite, VAPID keys                             |
| `caddy/`      | Certificates and Caddy state                            |
| `backups/`    | Timestamped `upgrade` backups, newest three kept        |

```sh
npx @aiif/t3relay@latest doctor
npx @aiif/t3relay@latest status
npx @aiif/t3relay@latest logs
npx @aiif/t3relay@latest upgrade
```

`upgrade` reuses the keys and host registrations. It stops the registry,
copies `data/`, `deploy.json`, `relay.env`, `Caddyfile`, `frps.toml`, and
`compose.yaml` into `backups/<timestamp>/`, then recreates the containers. If
health fails, the printed backup path is the rollback point.

Back up `deploy.json` and `data/` before the first host registers. Losing the
secret key breaks host-key reveal and forces hosts to register again.

## Health checks

```sh
curl -sS https://t3.example.com/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' https://t3.example.com/
curl -sSI https://<hostId>.t3.example.com/api/environment
```

On the VPS, confirm the loopback-only ports:

```sh
ss -H -ltnp | grep -E ':(80|443|7001|8080|8787) '
```

From outside, `8080` and `8787` must time out.

## Rotating the admin key

For the Docker channel:

```sh
npx @aiif/t3relay@latest upgrade --rotate-admin-key
```

The CLI writes the new key to `/opt/t3-relay/deploy.json` and `relay.env`,
recreates the registry, and prints the key once.

For the manual Compose and native paths:

1. Generate a new key (`openssl rand -base64 32`).
2. Update `T3CODE_ADMIN_KEY` in `infra/personal-relay/.env` (Compose) or
   `/etc/t3-relay/relay.env` (native), then restart the registry
   (`docker compose restart registry` or `systemctl restart t3-registry`).
3. Re-enter it in the admin console. Guests and host keys are unaffected.

The admin key must never be copied to a host or a guest client. Hosts do not
read it and their `/oauth/token` does not accept it.

## Rotating a host key

Use **Rotate key** in the host's Personal Network settings, or the admin console.
The relay stores the new encrypted key, increments its version, and returns it on
the host's next heartbeat. The host replaces its guest grant and revokes sessions
created with the old key. Guests get 401 and must enter the new key.

Removing a host from the admin console revokes its record, invalidates the key,
and the host's next heartbeat stops its connector. The removed host stays under
**Removed hosts** in the console; **Restore** keeps its host id and key and lets
the environment register again.

## Backup and migration

For the Docker and AI-native channels, back up `/opt/t3-relay/deploy.json` and
`/opt/t3-relay/data`; the Docker channel also keeps `relay.env`, `Caddyfile`,
`frps.toml`, and `compose.yaml` there.

- Back up the registry SQLite file and the env file before upgrading. The
  database is `/var/lib/t3-registry/registry.sqlite` on a native install, or the
  `registry-data` volume under Compose; the env file is
  `/etc/t3-relay/relay.env` or `infra/personal-relay/.env`.
- On a native host, do not copy a live `registry.sqlite-wal`. Use SQLite's own
  copy and archive the source and portal:

  ```sh
  mkdir -p /root/t3-backups
  node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("/var/lib/t3-registry/registry.sqlite"); db.exec("VACUUM INTO \"/root/t3-backups/registry-" + Date.now() + ".sqlite\"");'
  tar -C /opt/t3-registry -czf /root/t3-backups/registry-src.tgz src package.json
  tar -C /srv -czf /root/t3-backups/portal.tgz t3-portal
  ```

- Registry v2 migrates the v1 key-space schema in place: host ids and environment
  ids survive, each host gets a new encrypted host key, and hosts stay offline
  until their new version re-registers.
- Keep the old `/root/t3-personal-key.txt` value as `T3CODE_ADMIN_KEY`. Generate
  `T3CODE_SECRET_KEY`; losing it makes stored host keys unrecoverable and requires
  rotating every host key.
- Rollback: restore the SQLite file plus the previous container image (Compose)
  or `src/` and portal archives (native), then restart the registry. Hosts that
  already migrated keep local state; they re-register when the v1 relay returns
  only if their environment ids match the restored rows.

## Guest visibility

The host reports guest sessions (session id, label, platform, first/last seen)
on its heartbeat. Rows are unique by `(hostId, sessionId)`; a session missing
from a fresh snapshot is marked revoked and old revoked rows are pruned. No
project content, prompts, command output, or file data reaches the registry.

## Web Push

- VAPID keys persist in the registry data directory (`vapid.json`;
  `/var/lib/t3-registry` on a native install, the `registry-data` volume under
  Compose). Deleting them invalidates every subscription.
- Subscriptions are scoped to `admin` or one host.
- Host notifications use the host token; the admin subscription receives every
  host's notifications.
- The registry deletes subscriptions a push service answers `404`/`410` for.

## Known failure modes

| Symptom                              | Check                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Host subdomain returns 502           | `frpc` is not connected: host relay status, `docker compose logs frps` or `journalctl -u frps`      |
| Host subdomain returns 404 from frps | `customDomains` does not match the host id                                                          |
| Admin console lists no hosts         | Hosts have not registered yet, or the admin key is wrong                                            |
| Guest resolve returns 401            | The host key is invalid or rotated                                                                  |
| Host register returns 410            | The environment was removed in the admin console; restore it there                                  |
| Guest resolve says offline/paused    | Sharing is off, paused, the app quit, or `frpc` is down                                             |
| Guest pairing fails                  | Host rejected the key: confirm the host state file has the key and sharing is enabled               |
| Guests cannot approve                | Check the session has `orchestration:operate`; the guest allowlist covers `runtime-request.respond` |
| Notifications stop                   | Re-subscribe; confirm the portal's VAPID key matches the registry                                   |
| Other domain broke                   | `openresty -t` and the include file; the relay needs its own `server` blocks, not a default change  |
