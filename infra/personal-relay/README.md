# Personal relay

Self-hosted relay for personal-mode T3 Code. One VPS runs OpenResty, `frps`, and
a small registry. Hosts stay behind NAT and dial out; phones install one PWA from
the portal origin and reach every host through the wildcard domain.

```text
phone / other desktop
        | https://t3.example.com
   OpenResty (80/443)
        +-- /              -> /srv/t3-portal (PWA)
        +-- /v1/*          -> 127.0.0.1:8787 (registry)
        +-- *.t3.example.com -> 127.0.0.1:8080 (frps vhost)
                                  ^ frp control 7001
                             frpc on each host -> 127.0.0.1:3773
```

## What runs here

| Piece            | Purpose                                       | Exposure           |
| ---------------- | --------------------------------------------- | ------------------ |
| `frps`           | Carries each host's HTTP + WebSocket traffic  | public `7001` only |
| `registry`       | Host discovery, host tokens, Web Push fan-out | loopback `8787`    |
| OpenResty vhosts | TLS for the portal and host wildcard          | public `80`/`443`  |

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
# Fill in T3CODE_PERSONAL_KEY, T3CODE_PORTAL_URL, FRP_SERVER_ADDR, FRP_AUTH_TOKEN.
# Generate values with: openssl rand -base64 32   and   openssl rand -hex 24
# Put the same FRP_AUTH_TOKEN into frps.toml.
openssl rand -base64 32 # T3CODE_PERSONAL_KEY
openssl rand -hex 24    # FRP_AUTH_TOKEN
docker compose up -d --build
docker compose logs -f registry
```

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

Base: `https://t3.example.com/v1`. Every endpoint except `GET /health` and
`GET /push/public-key` needs `Authorization: Bearer <personal key>`; host routes
take the host token returned by registration.

| Method | Path                | Credential   | Purpose                                                     |
| ------ | ------------------- | ------------ | ----------------------------------------------------------- |
| GET    | `/health`           | none         | Liveness                                                    |
| POST   | `/hosts/register`   | personal key | Register/re-register; returns host id, token, URL, frp info |
| POST   | `/hosts/heartbeat`  | host token   | Refresh liveness and label                                  |
| POST   | `/hosts/unregister` | host token   | Remove the host                                             |
| GET    | `/hosts`            | personal key | List hosts with online state                                |
| POST   | `/push/subscribe`   | personal key | Store a Web Push subscription                               |
| POST   | `/push/unsubscribe` | personal key | Remove one                                                  |
| GET    | `/push/public-key`  | none         | VAPID public key                                            |
| POST   | `/notify`           | personal key | Fan out a notification                                      |

Behavior worth knowing:

- The database stores `sha256(personal key)` only. Changing the key starts a new
  key space.
- Host tokens are derived from the personal key and host id, so they are never
  stored and rotate with the key.
- Heartbeats expire after 90 seconds (`HEARTBEAT_TTL_MS`).
- Re-registering the same `environmentId` keeps the host id and token.
- Notifications deduplicate per `hostId:threadId:phase` for 30 seconds
  (`NOTIFY_DEDUPE_MS`) and never carry command output, prompts, or file content.
- Subscriptions the push service answers `404`/`410` for are deleted.

## Rotating the personal key

1. Update `T3CODE_PERSONAL_KEY` in `.env`, restart the registry.
2. Update `T3CODE_PERSONAL_KEY` on every host, restart the host server.
3. Each host revokes its old `personal-key` sessions at startup.
4. Re-enter the key in the portal. Hosts re-register and keep their host ids only
   if the registry's database survives; a new key space starts empty.

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
