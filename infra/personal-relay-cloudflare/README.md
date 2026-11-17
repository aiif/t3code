# Cloudflare Tunnel relay

Optional personal-network relay for T3 Code. The Worker and its single SQLite
Durable Object store host metadata, resolve host keys and provision Cloudflare
Tunnels. Guest traffic goes through Cloudflare's edge and the tunnel directly to
the host; it never passes through the Worker.

- `named` mode: one remotely-managed tunnel per host at
  `https://<hostId>.<zone>`. Production path.
- `quick` mode: `cloudflared tunnel --url`, temporary `trycloudflare.com`
  addresses. Trial path only.

The VPS relay remains the default. This package is additive and does not change
VPS behavior.

```sh
vp run cf-relay:dev            # wrangler dev with .dev.vars
vp run cf-relay:deploy         # repo-local deploy; prints relay URL and keys
vp run cf-relay:pack           # build the npm t3cf / create-t3cf packages
```

See `docs/operations/personal-relay-cloudflare.md` for prerequisites and
deployment. The admin console is the same web build with
`VITE_PERSONAL_ADMIN_CONSOLE=1`.
