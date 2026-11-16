# Personal relay operations

Runbook for the self-hosted relay behind [personal mode](../user/personal-mode.md).
The deployment files live in [`infra/personal-relay`](../../infra/personal-relay/README.md);
that README owns the step-by-step VPS procedure. This page covers what to check
after it is running and how to recover.

## Components

| Piece     | Binds                            | Notes                                               |
| --------- | -------------------------------- | --------------------------------------------------- |
| OpenResty | `80`, `443`                      | Existing vhosts plus `t3.<domain>` and `*.<domain>` |
| `frps`    | `7001`, vhost `8080` on loopback | Only `7001` is public                               |
| Registry  | `127.0.0.1:8787`                 | Host discovery, Web Push fan-out                    |
| `frpc`    | outbound from each host          | Spawned by the host's server                        |

T3 servers keep binding loopback. A host is reachable only through its
`frpc` connection, and `frpc` is supervised by the T3 server process that owns
it: stopping the server stops the child, and the relay marks the host offline
when heartbeats expire (90 seconds by default).

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

## Rotating the personal key

1. Generate a new key (`openssl rand -base64 32`).
2. Update `T3CODE_PERSONAL_KEY` in `infra/personal-relay/.env`, restart the
   registry. The old key space stops answering.
3. Update every host's `service.env` (or run `t3 personal join ... --key ...`)
   and restart it. At startup a host compares the key fingerprint stored in
   `auth_personal_key_state`; when it differs it revokes every session with
   subject `personal-key`.
4. Re-enter the key in each portal and app.

Host tokens are derived from the key, so hosts must re-register after rotation.
A new key space lists no hosts until they do.

## Pausing or removing a host

- `t3 personal disable` stops the connector and restarts the service. The
  registry TTL marks it offline; its row stays until re-registered or removed.
- `POST /v1/hosts/unregister` with the host token removes it immediately. The
  fleet CLI does not call it yet; a stale row is harmless because the portal
  reports it offline and pairing fails.

## Web Push

- VAPID keys persist in the registry data volume (`vapid.json`). Deleting them
  invalidates every subscription.
- `GET /v1/push/public-key` must match what the portal used when it subscribed.
- The registry deletes subscriptions a push service answers `404`/`410` for.
- The host posts notifications with the personal key; the registry deduplicates
  per `hostId:threadId:phase` for 30 seconds and the host applies a two-minute
  cooldown per thread and phase before that.

## Known failure modes

| Symptom                              | Check                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Host subdomain returns 502           | `frpc` is not connected: host relay status, `docker compose logs frps`                                    |
| Host subdomain returns 404 from frps | `customDomains` no longer matches the host id (new key space)                                             |
| Portal lists no hosts                | The key differs from the registry's, or hosts have not re-registered                                      |
| Pairing fails on every host          | Host server rejected the key: check it started with `T3CODE_PERSONAL_KEY` and `T3CODE_PERSONAL_MODE=1`    |
| Guests cannot approve                | Check the session has `orchestration:operate`; the guest allowlist covers `runtime-request.respond`       |
| Notifications stop                   | Re-subscribe in the portal; confirm the portal's VAPID key matches the registry                           |
| Other domain broke                   | `openresty -t` and the include file; the relay needs its own `server` blocks, not a default server change |
