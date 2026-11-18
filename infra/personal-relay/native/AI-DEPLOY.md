# T3 Code personal relay �?native VPS runbook (for an AI agent)

This runbook installs the T3 Code personal relay directly on a dedicated Linux
VPS with systemd and Caddy. It does not use Docker. The relay registry, admin
console, Caddy configuration, and keys are the same as the Docker installation,
so `/opt/t3-relay/deploy.json` and `/opt/t3-relay/data` are interchangeable
between the two paths.

Read this whole file before changing the VPS. If any check fails, stop and report
the failure instead of improvising a different architecture.

The packaged and native bundle copies replace `{{PACKAGE_NAME}}` with the
published package name; this repository copy keeps the placeholder.

## What this installs

| Piece          | Where                                             | Exposure                               |
| -------------- | ------------------------------------------------- | -------------------------------------- |
| Caddy          | `/opt/t3-relay/bin/caddy`                         | `80`, `443`                            |
| frps           | `/opt/t3-relay/bin/frps`                          | `7001`                                 |
| registry       | `/opt/t3-relay/registry/registry.mjs` under Node  | `127.0.0.1:8787`                       |
| admin console  | `/opt/t3-relay/portal`                            | served by Caddy at `https://<domain>/` |
| state and data | `/opt/t3-relay/deploy.json`, `/opt/t3-relay/data` | root / `t3relay`                       |

The only public ports are `80`, `443`, and `7001`. Port `8080` (frps vhost) and
`8787` (registry) stay on loopback.

Caddy obtains the certificate for `https://<domain>` with ACME HTTP-01. Host
subdomains use Caddy on-demand TLS: before issuing a certificate for
`<hostId>.<domain>`, Caddy asks the registry at
`http://127.0.0.1:8787/internal/tls/ask?domain=...`. That endpoint returns 200
only for a registered, non-revoked host.

## Inputs

Ask the user for these before changing anything, then show the plan:

- `DOMAIN`: the relay origin hostname, for example `relay.example.com`. Host
  URLs will be `https://<hostId>.relay.example.com`.
- `EMAIL`: the ACME account email. Optional; blank is allowed.
- `VERSION` and `RELEASE_URL`: from the prompt that started this runbook.

Set these in the shell for the rest of the runbook:

```bash
set -euo pipefail
umask 077

DOMAIN="<relay.example.com>"
EMAIL="<you@example.com or empty>"
VERSION="<from the prompt>"
RELEASE_URL="<from the prompt>"
INSTALL_DIR="/opt/t3-relay"

export DOMAIN EMAIL VERSION RELEASE_URL INSTALL_DIR
```

Keep the same shell session for the whole runbook; later blocks use the
variables exported above. If you run blocks separately, re-export them first.

The native bundle layout is:

```text
native/AI-DEPLOY.md
native/PROMPT.md
native/templates/...
registry/registry.mjs
portal/
manifest.json
LICENSE
```

## Stop conditions

Stop and report instead of continuing when any of these is true:

- `uname -s` is not `Linux`, or systemd is not available.
- `id -u` is not `0`.
- Port `80`, `443`, or `7001` is already listening on the host.
- `/opt/t3-relay/deploy.json` exists. If its `mode` is `docker`, stop and use
  `npx @aiif/t3relay@latest upgrade`; this runbook only upgrades a `native`
  install. If its `mode` is `native`, use the upgrade section and do not
  generate new keys.
- The base domain or a random `*.${DOMAIN}` probe does not resolve to this VPS.
- A downloaded archive fails its SHA256 check.
- `caddy validate` or `frps verify` fails.
- The local or public `/v1/health` check fails after starting the services.

Do not install Docker, do not use OpenResty, and do not modify unrelated vhosts
or services.

## 1. Preflight

```bash
test "$(uname -s)" = "Linux"
command -v systemctl >/dev/null
test "$(id -u)" = "0"
command -v curl >/dev/null
command -v tar >/dev/null
command -v sha256sum >/dev/null
command -v useradd >/dev/null
command -v ss >/dev/null

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac

ss -H -ltnp | grep -E ':(80|443|7001) ' && {
  echo "One of 80, 443, or 7001 is already listening. Stop and report."
  exit 1
} || true
```

If `ss` is unavailable, install `iproute2` or use `netstat -ltnp`; do not skip the
check silently.

Check DNS:

```bash
getent ahostsv4 "$DOMAIN" || true
getent ahostsv4 "t3check-00000000.${DOMAIN}" || true
getent ahostsv6 "$DOMAIN" || true
getent ahostsv6 "t3check-00000000.${DOMAIN}" || true
```

Both must resolve to the VPS. If they do not, print the required records and
stop:

```text
A     <domain>        <VPS IPv4>
A     *.<domain>      <VPS IPv4>
AAAA  <domain>        <VPS IPv6, optional>
AAAA  *.<domain>      <VPS IPv6, optional>
```

The records must be DNS-only. If the user proxies them through Cloudflare
(orange cloud), HTTP-01 and the frps Host routing break. Do not continue until
the records are direct.

If `/opt/t3-relay/deploy.json` exists, stop here. If `mode` is `docker`, use the
Docker CLI; if `mode` is `native`, use the upgrade section.

## 2. Fetch and verify the native bundle

If the prompt did not include a URL, set `RELEASE_URL=""` first; the npm
fallback below will run.

```bash
rm -rf /tmp/t3relay-native /tmp/t3relay-native.tar.gz
mkdir -p /tmp/t3relay-native

if [ -n "$RELEASE_URL" ]; then
  curl -fsSL "$RELEASE_URL" -o /tmp/t3relay-native.tar.gz
  # If the release publishes SHA256SUMS next to the bundle, verify it here:
  # curl -fsSL "${RELEASE_URL%/*}/SHA256SUMS" -o /tmp/t3relay-SHA256SUMS
  # (cd /tmp && grep "$(basename "$RELEASE_URL")" t3relay-SHA256SUMS | sha256sum -c -)
  tar -xzf /tmp/t3relay-native.tar.gz -C /tmp/t3relay-native
else
  cd /tmp/t3relay-native
  npm pack "{{PACKAGE_NAME}}@${VERSION}"
  tar -xzf ./*.tgz
  cp -a package/native native
  cp -a package/dist/registry registry
  cp -a package/dist/portal portal
  cd /
fi

test -f /tmp/t3relay-native/native/AI-DEPLOY.md
test -f /tmp/t3relay-native/registry/registry.mjs
test -f /tmp/t3relay-native/portal/index.html
```

## 3. Install the pinned runtimes

Use the versions in this table. They are the versions the native bundle was
tested with.

| Piece | Version   |
| ----- | --------- |
| Node  | `24.22.3` |
| Caddy | `2.10.2`  |
| frps  | `0.61.1`  |

Install Caddy and frps from their official GitHub releases and verify the
published checksum files:

```bash
install -d -m 0755 "$INSTALL_DIR" "$INSTALL_DIR/bin" "$INSTALL_DIR/runtime"
cd /tmp

CADDY_VERSION="2.10.2"
CADDY_ARCHIVE="caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
curl -fsSL -o "$CADDY_ARCHIVE" \
  "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${CADDY_ARCHIVE}"
curl -fsSL -o caddy-checksums.txt \
  "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt"
grep " ${CADDY_ARCHIVE}$" caddy-checksums.txt | sha256sum -c -
rm -rf /tmp/caddy-unpack && mkdir -p /tmp/caddy-unpack
tar -xzf "$CADDY_ARCHIVE" -C /tmp/caddy-unpack
install -m 0755 /tmp/caddy-unpack/caddy "$INSTALL_DIR/bin/caddy"
"$INSTALL_DIR/bin/caddy" version

FRPS_VERSION="0.61.1"
FRPS_ARCHIVE="frp_${FRPS_VERSION}_linux_${ARCH}.tar.gz"
curl -fsSL -o "$FRPS_ARCHIVE" \
  "https://github.com/fatedier/frp/releases/download/v${FRPS_VERSION}/${FRPS_ARCHIVE}"
curl -fsSL -o frp-checksums.txt \
  "https://github.com/fatedier/frp/releases/download/v${FRPS_VERSION}/frp_sha256_checksums.txt"
grep " ${FRPS_ARCHIVE}$" frp-checksums.txt | sha256sum -c -
rm -rf /tmp/frps-unpack && mkdir -p /tmp/frps-unpack
tar -xzf "$FRPS_ARCHIVE" -C /tmp/frps-unpack
install -m 0755 "/tmp/frps-unpack/frp_${FRPS_VERSION}_linux_${ARCH}/frps" "$INSTALL_DIR/bin/frps"
"$INSTALL_DIR/bin/frps" -v
```

The checksum grep must match. If the release changes its checksum filename,
stop and report rather than skipping verification.

Install the official Node runtime so the systemd unit does not depend on the
agent's Node installation:

```bash
NODE_VERSION="24.22.3"
case "$ARCH" in
  amd64) NODE_ARCH="x64" ;;
  arm64) NODE_ARCH="arm64" ;;
esac
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
cd /tmp
curl -fsSL -o "$NODE_ARCHIVE" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
curl -fsSL -o node-SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " ${NODE_ARCHIVE}$" node-SHASUMS256.txt | sha256sum -c -
rm -rf /tmp/node-unpack && mkdir -p /tmp/node-unpack
tar -xJf "$NODE_ARCHIVE" -C /tmp/node-unpack
install -m 0755 "/tmp/node-unpack/node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node" \
  "$INSTALL_DIR/runtime/node"
"$INSTALL_DIR/runtime/node" --version
```

If the network blocks GitHub or nodejs.org, ask the user for a mirror. Download
the same filenames from the mirror and use the same published checksums. Do not
skip checksum verification.

## 4. Create the service user and directories

```bash
if ! id -u t3relay >/dev/null 2>&1; then
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --home-dir "$INSTALL_DIR" --shell "$NOLOGIN" t3relay
fi

install -d -m 0755 "$INSTALL_DIR/registry" "$INSTALL_DIR/portal"
install -d -m 0750 "$INSTALL_DIR/data"
install -d -m 0700 "$INSTALL_DIR/caddy/data" "$INSTALL_DIR/caddy/config"
install -d -m 0755 /etc/systemd/system

cp -a /tmp/t3relay-native/registry/. "$INSTALL_DIR/registry/"
cp -a /tmp/t3relay-native/portal/. "$INSTALL_DIR/portal/"
chmod -R a+rX "$INSTALL_DIR/registry" "$INSTALL_DIR/portal"
chown -R t3relay:t3relay "$INSTALL_DIR/data" "$INSTALL_DIR/caddy"
```

## 5. Generate the relay state

Generate the keys and write `deploy.json` with the pinned Node runtime. This
script never prints the secrets:

```bash
"$INSTALL_DIR/runtime/node" --input-type=module - <<'NODE'
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const domain = process.env.DOMAIN;
const email = process.env.EMAIL?.trim() || null;
const now = new Date().toISOString();
const state = {
  version: 1,
  mode: "native",
  domain,
  portalUrl: `https://${domain}`,
  email,
  adminKey: randomBytes(32).toString("base64url"),
  secretKey: randomBytes(32).toString("hex"),
  frpAuthToken: randomBytes(32).toString("base64url"),
  tls: { mode: "on-demand" },
  images: {
    caddy: "caddy:2.10-alpine",
    frps: "fatedier/frps:v0.61.1",
    node: "node:24-alpine",
  },
  createdAt: now,
  updatedAt: now,
};
writeFileSync(
  "/opt/t3-relay/deploy.json",
  `${JSON.stringify(state, null, 2)}\n`,
  { mode: 0o600 },
);
NODE

chmod 0600 "$INSTALL_DIR/deploy.json"
chown root:root "$INSTALL_DIR/deploy.json"
```

Read the keys into shell variables for the config files. Do not echo them:

```bash
ADMIN_KEY="$("$INSTALL_DIR/runtime/node" -p "require('/opt/t3-relay/deploy.json').adminKey")"
SECRET_KEY="$("$INSTALL_DIR/runtime/node" -p "require('/opt/t3-relay/deploy.json').secretKey")"
FRP_AUTH_TOKEN="$("$INSTALL_DIR/runtime/node" -p "require('/opt/t3-relay/deploy.json').frpAuthToken")"
if [ -n "$EMAIL" ]; then VAPID_SUBJECT="mailto:$EMAIL"; else VAPID_SUBJECT="https://$DOMAIN"; fi
```

Write the registry environment:

```bash
cat > "$INSTALL_DIR/relay.env" <<EOF
T3CODE_ADMIN_KEY=$ADMIN_KEY
T3CODE_SECRET_KEY=$SECRET_KEY
T3CODE_PORTAL_URL=https://$DOMAIN
FRP_SERVER_ADDR=$DOMAIN
FRP_SERVER_PORT=7001
FRP_AUTH_TOKEN=$FRP_AUTH_TOKEN
VAPID_SUBJECT=$VAPID_SUBJECT
REGISTRY_HOST=127.0.0.1
REGISTRY_PORT=8787
REGISTRY_DATA_DIR=$INSTALL_DIR/data
EOF
chmod 0600 "$INSTALL_DIR/relay.env"
chown root:root "$INSTALL_DIR/relay.env"
```

Write the frps config:

```bash
cat > "$INSTALL_DIR/frps.toml" <<EOF
bindPort = 7001
vhostHTTPPort = 8080
proxyBindAddr = "127.0.0.1"

auth.method = "token"
auth.token = "$FRP_AUTH_TOKEN"

allowPorts = []

transport.maxPoolCount = 10
userConnTimeout = 10
EOF
chmod 0640 "$INSTALL_DIR/frps.toml"
chown root:t3relay "$INSTALL_DIR/frps.toml"
```

Write the Caddyfile. This is the same configuration as
`native/templates/Caddyfile` after substitution:

```bash
if [ -n "$EMAIL" ]; then EMAIL_LINE="	email $EMAIL"; else EMAIL_LINE=""; fi
cat > "$INSTALL_DIR/Caddyfile" <<EOF
{
	admin off
$EMAIL_LINE
	on_demand_tls {
		ask http://127.0.0.1:8787/internal/tls/ask
	}
}

https://$DOMAIN {
	encode zstd gzip

	handle /v1/* {
		reverse_proxy 127.0.0.1:8787 {
			header_up X-Real-IP {remote_host}
			header_up X-Forwarded-For {remote_host}
		}
	}

	handle /assets/* {
		root * $INSTALL_DIR/portal
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}

	handle /.well-known/* {
		root * $INSTALL_DIR/portal
		file_server
	}

	handle {
		root * $INSTALL_DIR/portal
		try_files {path} /index.html
		header Cache-Control "no-cache"
		file_server
	}
}

https://*.$DOMAIN {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8080 {
		header_up Host {host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
		flush_interval -1
	}
}
EOF
chmod 0644 "$INSTALL_DIR/Caddyfile"
chown root:root "$INSTALL_DIR/Caddyfile"
```

## 6. Install the systemd units

Copy the unit templates from the bundle:

```bash
install -m 0644 /tmp/t3relay-native/native/templates/t3-relay-registry.service \
  /etc/systemd/system/t3-relay-registry.service
install -m 0644 /tmp/t3relay-native/native/templates/t3-relay-frps.service \
  /etc/systemd/system/t3-relay-frps.service
install -m 0644 /tmp/t3relay-native/native/templates/t3-relay-caddy.service \
  /etc/systemd/system/t3-relay-caddy.service
```

The units assume `/opt/t3-relay`. If the user insisted on another directory,
update the paths in all three units and in `Caddyfile` consistently. Do not
continue with a half-renamed installation.

Validate everything before starting:

```bash
"$INSTALL_DIR/bin/caddy" validate --config "$INSTALL_DIR/Caddyfile" --adapter caddyfile
"$INSTALL_DIR/bin/frps" verify -c "$INSTALL_DIR/frps.toml"
systemd-analyze verify /etc/systemd/system/t3-relay-registry.service \
  /etc/systemd/system/t3-relay-frps.service \
  /etc/systemd/system/t3-relay-caddy.service || true
```

`systemd-analyze verify` may print warnings about paths that do not exist until a
service is started; if it reports a real unit syntax error, stop and fix it.

## 7. Start and verify

```bash
systemctl daemon-reload
systemctl enable --now t3-relay-registry t3-relay-frps t3-relay-caddy
systemctl --no-pager --full status t3-relay-registry t3-relay-frps t3-relay-caddy || true
```

Check loopback and public health with retries:

```bash
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8787/v1/health >/dev/null; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:8787/v1/health

for attempt in $(seq 1 60); do
  if curl -fsS "https://${DOMAIN}/v1/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "https://${DOMAIN}/v1/health"
curl -fsS -o /dev/null -w '%{http_code}\n' "https://${DOMAIN}/"
```

Expected: the health body contains `"ok": true` and `"version": 2`; the portal
returns `200` with HTML. The first public request can take a few seconds while
Caddy obtains the base-domain certificate.

Check that only the intended ports are public and the internal ports are loopback:

```bash
ss -H -ltnp | grep -E ':(80|443|7001|8080|8787) '
```

`8080` and `8787` must show `127.0.0.1`, not `0.0.0.0` or `[::]`.

## 8. Print the handoff

Read the admin key once and show it to the user exactly once:

```bash
ADMIN_KEY="$("$INSTALL_DIR/runtime/node" -p "require('/opt/t3-relay/deploy.json').adminKey")"
echo "$ADMIN_KEY"
```

Print this summary:

```text
Relay URL:     https://<domain>
Admin console: https://<domain>/
Admin key:     <shown once above>
Host URL rule: https://<hostId>.<domain>
Install dir:   /opt/t3-relay
State file:    /opt/t3-relay/deploy.json
Data:          /opt/t3-relay/data
Services:      t3-relay-registry, t3-relay-frps, t3-relay-caddy
Logs:          journalctl -u t3-relay-registry -u t3-relay-frps -u t3-relay-caddy -f
```

Next steps for the user:

1. Open the admin console and enter the admin key.
2. On the host, open **Settings �?Personal Network** and enter the relay URL.
3. Register the host, copy its host key, and give it to guests.
4. Guests add the relay URL and the host key.

The host needs `frpc` on `PATH`, or `T3CODE_FRPC_PATH` pointing at it.

The admin console warns that losing `T3CODE_SECRET_KEY` breaks host-key reveal.
Tell the user to back up `/opt/t3-relay/deploy.json` and `/opt/t3-relay/data`
before the first host registers.

## Upgrade

An upgrade preserves `deploy.json`, `relay.env`, the admin key, the host keys,
and the registry database. Do not generate new keys unless the user explicitly
asks for rotation.

First confirm `deploy.json` has `"mode": "native"`. If it says `"docker"`, stop
and use `npx @aiif/t3relay@latest upgrade` instead.

1. Download and verify the new native bundle exactly as in step 2.
2. Stop the services:
   ```bash
   systemctl stop t3-relay-caddy t3-relay-frps t3-relay-registry
   ```
3. Back up the state:
   ```bash
   BACKUP="/opt/t3-relay/backups/$(date -u +%Y%m%dT%H%M%SZ)"
   install -d -m 0700 "$BACKUP"
   cp -a /opt/t3-relay/deploy.json /opt/t3-relay/relay.env /opt/t3-relay/data "$BACKUP/"
   ```
4. Replace the runtime assets from the new bundle:
   ```bash
   cp -a /tmp/t3relay-native/registry/. /opt/t3-relay/registry/
   cp -a /tmp/t3relay-native/portal/. /opt/t3-relay/portal/
   chmod -R a+rX /opt/t3-relay/registry /opt/t3-relay/portal
   ```
   Replace `bin/caddy`, `bin/frps`, and `runtime/node` only when the new runbook
   pins different versions. Keep `deploy.json`, `relay.env`, `Caddyfile`, and
   `frps.toml` unless the new runbook changes their format; if it does, show the
   user a diff before replacing them.
5. Validate and start:
   ```bash
   /opt/t3-relay/bin/caddy validate --config /opt/t3-relay/Caddyfile --adapter caddyfile
   /opt/t3-relay/bin/frps verify -c /opt/t3-relay/frps.toml
   systemctl daemon-reload
   systemctl start t3-relay-registry t3-relay-frps t3-relay-caddy
   ```
6. Repeat the health checks from step 7. If they fail, restore `$BACKUP` over
   `/opt/t3-relay`, restart the services, and report the failure.

## Uninstall

```bash
systemctl disable --now t3-relay-caddy t3-relay-frps t3-relay-registry
rm -f /etc/systemd/system/t3-relay-caddy.service \
      /etc/systemd/system/t3-relay-frps.service \
      /etc/systemd/system/t3-relay-registry.service
systemctl daemon-reload
```

Keep `/opt/t3-relay` by default so the user can back up `deploy.json` and
`data/`. Only remove it when the user explicitly asks to purge:

```bash
rm -rf /opt/t3-relay
userdel t3relay 2>/dev/null || true
```

Do not remove unrelated firewall rules, packages, or the `t3relay` user if
another installation still uses it.

## Troubleshooting

- `caddy validate` fails: read the line number in the error. The Caddyfile in
  step 5 is the source of truth; do not replace it with a guessed config.
- `journalctl -u t3-relay-caddy` shows ACME failures: check the base and
  wildcard DNS records, port 80 reachability, and that the records are not
  proxied.
- A host subdomain shows a certificate error: confirm the host is registered and
  `curl -i "http://127.0.0.1:8787/internal/tls/ask?domain=<hostId>.<domain>"`
  returns 200. Check `journalctl -u t3-relay-caddy`.
- A host subdomain returns 502: `frpc` on the host is not connected, or the host
  server is not running. Check `journalctl -u t3-relay-frps`.
- A host subdomain returns 404 from frps: the host's `customDomains` does not
  match `<hostId>.<domain>`.
- Registry health fails: `journalctl -u t3-relay-registry`; verify
  `/opt/t3-relay/relay.env` is readable by systemd and contains the same keys as
  `deploy.json`.
- `8080` or `8787` is reachable from outside: stop and fix the listener/firewall
  before handing the relay to the user.
