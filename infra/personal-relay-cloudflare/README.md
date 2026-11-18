# Cloudflare Tunnel relay

Optional personal-network relay for T3 Code. A Worker with one SQLite-backed
Durable Object stores host metadata, resolves host keys, and provisions
Cloudflare Tunnels. Guest traffic goes through Cloudflare's edge and the tunnel
directly to the host; it never passes through the Worker.

- `named` mode: one remotely-managed tunnel per host at
  `https://<hostId>.<zone>`. Production path.
- `quick` mode: `cloudflared tunnel --url`, temporary `trycloudflare.com`
  addresses. Trial path only.

The VPS relay remains the default. This package is additive and does not change
VPS behavior.

## Quick start

From this checkout:

```sh
vp run cf-relay:dev            # wrangler dev with .dev.vars
vp run cf-relay:deploy         # repo-local deploy; prints relay URL and keys
vp run cf-relay:pack           # build the npm t3cf / create-t3cf packages
```

`cf-relay:dev` serves the admin console from `apps/web/dist`; build it with
`VITE_PERSONAL_ADMIN_CONSOLE=1 vp run --filter @t3tools/web build` first.

Without a checkout:

```sh
npx t3cf@latest init
npm create t3cf@latest
```

Both paths run the same deploy module. The npm package ships a prebuilt admin
console and a prebundled Worker, needs Node 20.19 or newer, and has no
`postinstall`.

## Operation logs

The Worker emits structured JSON events for the operations that usually need
debugging:

```sh
pnpm --filter @t3tools/personal-relay-cloudflare exec wrangler tail t3cf --format pretty
```

or open **Workers & Pages → the Worker → Observability** in Cloudflare.

Registration events include `hostId`, `environmentId`, connector mode,
`publicUrl`, and `hostKeyReused`. Tunnel events cover `tunnel_created`,
`tunnel_reused`, ingress, token fetch, DNS, `tunnel_ensure_failed`, and
`tunnel_provision_failed`. API failures log `api_rejected`/`api_error` with the
same error text returned to the caller. The host server logs relay starts,
relay switches, registration, host-key changes, and start failures.

Logs never include the admin key, enrollment key, host key, host token, tunnel
token, Cloudflare API token, authorization header, or request body. Do not add
them.

## Layout

- `src/worker.ts`, `src/registry.ts`, `src/api.ts` — Worker entry, Durable
  Object, and `/v1/*` routes.
- `src/store.ts`, `src/crypto.ts`, `src/config.ts` — registry storage, key
  encryption, and env validation.
- `src/tunnel/` — Cloudflare tunnel, DNS, and token provisioning behind the
  frozen interface, plus a fake for tests.
- `scripts/deploy.mjs`, `scripts/deploy/` — shared deploy CLI used by the
  repository wrapper and the npm package.
- `scripts/build-npm-package.mjs` — assembles `dist/npm` and `dist/create`.
- `wrangler.jsonc` — Worker, Durable Object, and Workers Assets config.

## Docs

- [Personal network](../../docs/user/personal-mode.md) — relay choice, keys, and
  quick/named caveats.
- [Cloudflare Tunnel relay operations](../../docs/operations/personal-relay-cloudflare.md)
  — prerequisites, deploy flags, secrets, limits, troubleshooting, and E2E
  checklists.
