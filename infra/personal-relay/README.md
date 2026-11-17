# Personal relay

Self-hosted relay for the personal-network T3 Code fork. One VPS runs OpenResty,
`frps`, and a small registry. Hosts stay behind NAT and dial out; guests use the
desktop app or the Android APK with a host key. The portal at the root origin is
the **admin console**, not a guest client.

```text
admin PWA (admin key)
        | https://t3.example.com
   OpenResty (80/443)
        +-- /              -> /srv/t3-portal (admin console + app shell)
        +-- /v1/*          -> 127.0.0.1:8787 (registry)
        +-- *.t3.example.com -> 127.0.0.1:8080 (frps vhost)
                                  ^ frp control 7001
                             frpc on each host -> 127.0.0.1:3773

guest desktop / Android APK
   host key -> POST /v1/hosts/resolve -> https://<hostId>.t3.example.com
   -> host /oauth/token (host key) -> bearer session -> operate that host
```

## What runs here

| Piece            | Purpose                                            | Exposure           |
| ---------------- | -------------------------------------------------- | ------------------ |
| `frps`           | Carries each host's HTTP + WebSocket traffic       | public `7001` only |
| `registry`       | Host registry, host keys, guest metadata, Web Push | loopback `8787`    |
| OpenResty vhosts | TLS for the portal and host wildcard               | public `80`/`443`  |

`8080` (frps vhost port) and `8787` (registry) are published on loopback only.
The T3 server on each host keeps binding loopback; `frpc` is the only way in.

## Deploying

These steps change a live VPS. Run them yourself; nothing in this repository
applies them automatically.

### 1. DNS and TLS

- Create DNS-only (grey cloud) records: `t3.example.com` and `*.t3.example.com`
  -> VPS address. Do not enable the Cloudflare proxy for either name.
- Issue one certificate covering **both** names. A `*.example.com` certificate is
  not enough.

```sh
# example with acme.sh and Cloudflare DNS-01
export CF_Token=...
acme.sh --issue --dns dns_cf \
  -d t3.example.com -d '*.t3.example.com' \
  --keylength ec-256

install -d -m 700 /etc/openresty/certs/t3.example.com
acme.sh --install-cert -d t3.example.com --ecc \
  --key-file       /etc/openresty/certs/t3.example.com/privkey.pem \
  --fullchain-file /etc/openresty/certs/t3.example.com/fullchain.pem \
  --reloadcmd      "openresty -t && openresty -s reload"
```

### 2. Relay containers

```sh
cd infra/personal-relay
cp .env.example .env
# Fill in T3CODE_ADMIN_KEY, T3CODE_SECRET_KEY, T3CODE_PORTAL_URL,
# FRP_SERVER_ADDR, FRP_AUTH_TOKEN.
# Generate values with: openssl rand -base64 32   and   openssl rand -hex 24
# Put the same FRP_AUTH_TOKEN into frps.toml.
openssl rand -base64 32 # T3CODE_ADMIN_KEY (the old personal key value)
openssl rand -base64 32 # T3CODE_SECRET_KEY
openssl rand -hex 24    # FRP_AUTH_TOKEN
docker compose up -d --build
docker compose logs -f registry
```

Back up `/var/lib/t3-registry` (or the `registry-data` volume) and `.env`
before the first v2 start. The v1 database is migrated in place: host ids and
environment ids survive, each host gets a new encrypted host key, and hosts
re-register on their next start.

If the existing OpenResty runs on the host rather than in Compose, the published
loopback ports (`127.0.0.1:8080`, `127.0.0.1:8787`) are what it proxies to.

### 3. OpenResty

1. Read the existing config first: include path, `map` names, TLS paths.
2. Copy `openresty/t3.conf.example` to the include directory, e.g.
   `/etc/openresty/conf.d/t3.conf`, and fix the cert paths and domain.
3. Keep the other domain's vhosts untouched. Only add this file.
4. Validate, then reload gracefully:

```sh
openresty -t
openresty -s reload
```

### 4. Firewall

Open only `7001` in addition to the existing `80`/`443`. Keep `8080` and `8787`
closed to the internet.

```sh
ufw allow 7001/tcp
ss -H -ltnp | grep -E ':(80|443|7001|8080|8787) '
```

### 5. Verify coexistence

Capture the other domain before and after the reload; the reload must not change
its status, headers, certificate, or content.

```sh
curl -sSI https://other.example.com | head -20
curl -sSI https://t3.example.com/v1/health
curl -sS  https://t3.example.com/v1/push/public-key
curl -sS -o /dev/null -w '%{http_code}\n' https://t3.example.com/
```

From outside the VPS, `http://<vps>:8080` and `http://<vps>:8787` must time out.

### 6. Portal

Build the web client with `VITE_HOSTED_APP_URL=https://t3.example.com`, then copy
the build to the portal root:

```sh
pnpm --filter @t3tools/web build
rsync -a --delete apps/web/dist/ /srv/t3-portal/
```

## Registry API

Base: `https://t3.example.com/v1`. `POST /hosts/register` is unauthenticated and
rate-limited; the relay returns that host's key. Every other route needs
`Authorization: Bearer <admin key | host key | host token>`.

| Method | Path                             | Credential | Purpose                                                     |
| ------ | -------------------------------- | ---------- | ----------------------------------------------------------- |
| GET    | `/health`                        | none       | Liveness                                                    |
| POST   | `/hosts/register`                | none       | Register/re-register; returns host id, host key, token, frp |
| POST   | `/hosts/heartbeat`               | host token | Refresh liveness/pause; returns a rotated host key if any   |
| POST   | `/hosts/unregister`              | host token | Remove the host                                             |
| POST   | `/hosts/clients`                 | host token | Replace the guest-session snapshot                          |
| POST   | `/hosts/rotate-key`              | host token | Owner-initiated key rotation                                |
| POST   | `/hosts/resolve`                 | host key   | Turn a host key into the host URL + online/paused state     |
| GET    | `/admin/hosts`                   | admin key  | List hosts with host keys and guest counts                  |
| GET    | `/admin/hosts/:id`               | admin key  | One host                                                    |
| GET    | `/admin/hosts/:id/clients`       | admin key  | One host and its guest sessions                             |
| POST   | `/admin/hosts/:id/rotate-key`    | admin key  | Rotate and return the new key                               |
| POST   | `/admin/hosts/:id/remove`        | admin key  | Remove the host and invalidate its key                      |
| POST   | `/admin/hosts/:id/restore`       | admin key  | Restore a removed host so it can register again             |
| POST   | `/admin/hosts/:id/revoke-client` | admin key  | Queue a guest-session revoke for the host                   |
| POST   | `/push/subscribe`                | admin/host | Store a Web Push subscription for that scope                |
| POST   | `/push/unsubscribe`              | admin/host | Remove one                                                  |
| GET    | `/push/public-key`               | none       | VAPID public key                                            |
| POST   | `/notify`                        | host token | Fan out a notification scoped to that host                  |

Behavior worth knowing:

- Host keys are random 32-byte values, encrypted at rest with
  `T3CODE_SECRET_KEY`; the admin console decrypts them only through an
  authenticated admin request.
- Host tokens are random and stored as SHA-256 hashes. Re-registering returns a
  fresh token.
- The admin key is accepted only under `/v1/admin/*` and push subscribe; a host
  `/oauth/token` never accepts it.
- Heartbeats expire after 90 seconds (`HEARTBEAT_TTL_MS`). A paused host stays in
  the registry and keeps its key but reports `online: false`.
- Re-registering the same `environmentId` keeps the host id and host key.
- Removing a host keeps the row revoked: it disappears from guest resolution and
  cannot register again until an admin restores it. Restore keeps the host id
  and key, then the host registers again normally.
- Notifications deduplicate per `hostId:threadId:phase` for 30 seconds
  (`NOTIFY_DEDUPE_MS`) and never carry command output, prompts, or file content.
- Subscriptions the push service answers `404`/`410` for are deleted.

## Rotating keys

**Host key (owner or admin).** Rotation writes a new encrypted key, increments
its version, and returns it. The host receives the new key on its next heartbeat,
replaces its guest grant, and revokes guest sessions created with the old key.

**Admin key.** Replace `T3CODE_ADMIN_KEY`, restart the registry, and re-enter it
in the admin console. Hosts and guest sessions are unaffected.

## Migrating from v1

1. Back up the registry SQLite file and `.env`.
2. Rename `/root/t3-personal-key.txt`'s value to `T3CODE_ADMIN_KEY`; generate
   `T3CODE_SECRET_KEY` and keep the old value out of host environments.
3. Start registry v2. It migrates `spaces`/`hosts` in place, keeps each
   hostId/environmentId, generates an encrypted host key, and marks hosts
   offline until they re-register.
4. Update each host. Its server revokes legacy `personal-key` guest sessions at
   startup and seeds the host-key grant.
5. Old portal `t3.personal.portal` storage is ignored. The admin console uses
   `t3.admin.key` and asks for the admin key once.

## Troubleshooting

- `openresty -t` fails on `$t3_connection_upgrade`: the `map` must live in the
  `http` block. The include file already declares it; remove a duplicate if the
  existing config has one.
- Host subdomain returns 502: `frpc` is not connected. Check the host's relay
  status, then `docker compose logs frps`.
- Host subdomain returns 404 from frps: the proxy's `customDomains` does not
  match the host id, usually after re-registering under a new key space.
- Notifications stop but hosts work: check `GET /v1/push/public-key` matches the
  portal build, then re-subscribe in portal settings.
