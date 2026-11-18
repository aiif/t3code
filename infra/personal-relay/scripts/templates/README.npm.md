# {{PACKAGE_NAME}}

Deploy the [T3 Code](https://github.com/aiif/t3code) personal network relay on
your own VPS. The relay is a registry and management plane; project traffic goes
from a guest through Caddy and frps directly to the host.

## Two ways to deploy

**Docker (recommended).** One command on a fresh VPS:

```sh
npx {{PACKAGE_NAME}}@latest init --domain relay.example.com --email you@example.com
```

It installs or checks Docker Compose, writes a stack under `/opt/t3-relay`,
starts Caddy, frps and the registry, and prints the admin key once.

**AI-native (no Docker).** Ask your VPS agent to follow the pinned runbook:

```sh
npx {{PACKAGE_NAME}}@latest prompt
```

Paste the printed prompt into the agent. It downloads the native bundle,
installs systemd services and Caddy, and verifies the relay. The runbook is
reviewable at `native/AI-DEPLOY.md` in this package.

## Before you start

- A fresh Linux VPS with `80`, `443` and `7001` free.
- Node.js 20.19 or newer to run the CLI. The native path downloads Node 24 for
  the registry.
- Docker with Compose v2 for the one-command path. `--install-docker` explicitly
  allows the official Docker install script; it is never run implicitly.
- Two DNS-only records (no Cloudflare orange cloud):

  ```text
  A     relay.example.com      <VPS IPv4>
  A     *.relay.example.com    <VPS IPv4>
  ```

  Add `AAAA` records when the VPS has IPv6. `init` prints and checks these
  records; it does not create them.

- A wildcard certificate is optional. Without one, Caddy issues per-host
  certificates on demand after the registry confirms the host exists.
- Each host needs `frpc` on `PATH`, or `T3CODE_FRPC_PATH` pointing at it.

## Commands

```sh
npx {{PACKAGE_NAME}}@latest init --domain relay.example.com
npx {{PACKAGE_NAME}}@latest init --domain relay.example.com --dry-run
npx {{PACKAGE_NAME}}@latest upgrade
npx {{PACKAGE_NAME}}@latest doctor
npx {{PACKAGE_NAME}}@latest status
npx {{PACKAGE_NAME}}@latest logs
npx {{PACKAGE_NAME}}@latest uninstall [--purge]
npx {{PACKAGE_NAME}}@latest prompt
```

After a global install, use `t3relay` instead of `npx {{PACKAGE_NAME}}`.
`npm create {{CREATE_ALIAS}}@latest` runs the same deploy CLI.

Run `npx {{PACKAGE_NAME}}@latest --help` for every flag, including image
overrides for Docker Hub mirrors and `--tls-cert` / `--tls-key`.

## What it installs

```text
/opt/t3-relay/
  compose.yaml       # Caddy, frps, registry
  Caddyfile
  frps.toml
  relay.env          # owner-only registry environment
  deploy.json        # owner-only keys and deployment state
  registry/          # bundled registry
  portal/            # prebuilt admin console
  data/              # registry SQLite and VAPID keys
  caddy/             # certificates and Caddy state
```

Only `80`, `443` and `7001` are published. The frps vhost and the registry are
internal to the Compose network.

## Secrets and backups

Back up `/opt/t3-relay/deploy.json` and `/opt/t3-relay/data` before the first
host registers. `T3CODE_SECRET_KEY` encrypts host keys at rest; losing it breaks
host-key reveal and forces hosts to re-register. `--rotate-admin-key` replaces
only the admin key.

`upgrade` stops the registry, copies a timestamped backup under
`/opt/t3-relay/backups`, keeps the last three, and reuses the existing keys.
`uninstall` keeps the directory by default; `--purge` removes it.

## Package size

The prebuilt admin console dominates the tarball: about {{PACKAGE_SIZE}} unpacked.
The package has no `postinstall` script and never needs the T3 Code source.

## Documentation

- Self-hosted relay operations:
  https://github.com/aiif/t3code/blob/main/docs/operations/personal-relay.md
- Personal network usage:
  https://github.com/aiif/t3code/blob/main/docs/user/personal-mode.md

## License

MIT. The T3 Code source is at https://github.com/aiif/t3code.
