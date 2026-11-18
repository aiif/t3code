# {{PACKAGE_NAME}}

Deploy the [T3 Code](https://github.com/pingdotgg/t3code) personal network relay to
your own Cloudflare account. The relay is a registry and management plane: guest
traffic goes from Cloudflare's edge through a tunnel straight to your host.

```sh
npx {{PACKAGE_NAME}}@latest init
```

`npm create t3cf@latest` runs the same deploy.

## What it deploys

- One Worker with a single SQLite-backed Durable Object for the host registry.
- Workers Assets with the prebuilt admin console. Open the relay URL and enter the
  admin key to manage hosts.
- Optionally, a Cloudflare Tunnel per host (`named` mode) at
  `https://<hostId>.<your-zone>`.

The package ships a prebundled Worker and the prebuilt portal. It has no
`postinstall` script and never needs the T3 Code source. The prebuilt admin
console dominates the download: the package is about {{PACKAGE_SIZE}} unpacked.

## Before you start

- Node.js 20.19 or newer.
- `CLOUDFLARE_API_TOKEN` with Workers Scripts Edit, Workers Durable Objects Edit,
  Account Settings Read and Zone Read, or an existing `wrangler login` session.
- Named mode only: a Cloudflare-managed zone and a Zero Trust organization. The
  Free Zero Trust plan still asks for payment details during onboarding.
- Named mode only: `T3CODE_CF_API_TOKEN` (or the deploy token) with Cloudflare
  Tunnel Edit and DNS Edit for the zone. It becomes a Worker secret.

Quick mode needs no zone and no Zero Trust. It uses `cloudflared tunnel --url`
hosts at temporary `trycloudflare.com` addresses.

## Usage

```sh
npx {{PACKAGE_NAME}}@latest init                                   # auto: named with a zone, else quick
npx {{PACKAGE_NAME}}@latest init --mode named --hosts-domain example.com
npx {{PACKAGE_NAME}}@latest init --mode quick
npx {{PACKAGE_NAME}}@latest init --upgrade                         # reuse secrets and redeploy
npx {{PACKAGE_NAME}}@latest init --doctor                          # check tokens, zone and Zero Trust
npx {{PACKAGE_NAME}}@latest init --destroy                         # delete tunnels, DNS and the Worker
```

Run `npx {{PACKAGE_NAME}}@latest init --help` for every flag. `--yes` never prompts.

## Operation logs

The Worker emits structured JSON events for host registration, key rotation,
admin actions, tunnel provisioning, and API errors. Tail them with:

```sh
npx wrangler tail <worker-name> --format pretty
```

or open **Workers & Pages → the Worker → Observability** in Cloudflare. Events
such as `host_reregistered` (including `hostKeyReused`), `tunnel_ensure_failed`,
and `api_error` carry the host and tunnel identifiers plus the Cloudflare error
detail. Logs never contain keys, host tokens, tunnel tokens, authorization
headers, or request bodies.

## Secrets

Keys and the deploy metadata live in `~/.t3/personal-relay/<worker-name>.json`,
owner-only on POSIX and under your user profile on Windows. `--secrets-file`
overrides the location. Back the file up: `T3CODE_SECRET_KEY` encrypts host keys
at rest, so losing it breaks host-key reveal in the admin console and forces
hosts to register again. Upgrades reuse the file; keys are replaced only with
`--rotate-keys`.

## License

MIT. The T3 Code source is at https://github.com/pingdotgg/t3code.
