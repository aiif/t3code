# Personal relay operations

Runbook for the self-hosted relay behind [personal network](../user/personal-mode.md).
The deployment files live in [`infra/personal-relay`](../../infra/personal-relay/README.md);
that README owns the step-by-step VPS procedure. This page covers what to check
after it is running and how to recover.

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

1. Generate a new key (`openssl rand -base64 32`).
2. Update `T3CODE_ADMIN_KEY` in `infra/personal-relay/.env`, restart the
   registry.
3. Re-enter it in the admin console. Guests and host keys are unaffected.

The admin key must never be copied to a host or a guest client. Hosts do not
read it and their `/oauth/token` does not accept it.

## Rotating a host key

Use **Rotate key** in the host's Personal Network settings, or the admin console.
The relay stores the new encrypted key, increments its version, and returns it on
the host's next heartbeat. The host replaces its guest grant and revokes sessions
created with the old key. Guests get 401 and must enter the new key.

Removing a host from the admin console deletes its record, invalidates the key,
and the host's next heartbeat stops its connector.

## Backup and migration

- Back up the registry SQLite file (`registry-data` volume or
  `/var/lib/t3-registry`) and `.env` before upgrading.
- Registry v2 migrates the v1 key-space schema in place: host ids and environment
  ids survive, each host gets a new encrypted host key, and hosts stay offline
  until their new version re-registers.
- Keep the old `/root/t3-personal-key.txt` value as `T3CODE_ADMIN_KEY`. Generate
  `T3CODE_SECRET_KEY`; losing it makes stored host keys unrecoverable and requires
  rotating every host key.
- Rollback: restore the SQLite file and the previous container image. Hosts that
  already migrated keep local state; they re-register when the v1 relay returns
  only if their environment ids match the restored rows.

## Guest visibility

The host reports guest sessions (session id, label, platform, first/last seen)
on its heartbeat. Rows are unique by `(hostId, sessionId)`; a session missing
from a fresh snapshot is marked revoked and old revoked rows are pruned. No
project content, prompts, command output, or file data reaches the registry.

## Web Push

- VAPID keys persist in the registry data volume (`vapid.json`). Deleting them
  invalidates every subscription.
- Subscriptions are scoped to `admin` or one host.
- Host notifications use the host token; the admin subscription receives every
  host's notifications.
- The registry deletes subscriptions a push service answers `404`/`410` for.

## Known failure modes

| Symptom                              | Check                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Host subdomain returns 502           | `frpc` is not connected: host relay status, `docker compose logs frps`                              |
| Host subdomain returns 404 from frps | `customDomains` does not match the host id                                                          |
| Admin console lists no hosts         | Hosts have not registered yet, or the admin key is wrong                                            |
| Guest resolve returns 401            | The host key is invalid or rotated                                                                  |
| Guest resolve says offline/paused    | Sharing is off, paused, the app quit, or `frpc` is down                                             |
| Guest pairing fails                  | Host rejected the key: confirm the host state file has the key and sharing is enabled               |
| Guests cannot approve                | Check the session has `orchestration:operate`; the guest allowlist covers `runtime-request.respond` |
| Notifications stop                   | Re-subscribe; confirm the portal's VAPID key matches the registry                                   |
| Other domain broke                   | `openresty -t` and the include file; the relay needs its own `server` blocks, not a default change  |
