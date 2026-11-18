# Cloudflare Tunnel relay operations

> For maintainers. Using T3 Code? See [personal network](../user/personal-mode.md).

Runbook for the optional Cloudflare Tunnel relay. It deploys a Worker with one
SQLite-backed Durable Object, serves the admin console from Workers Assets, and
provisions one Cloudflare Tunnel per named host. Quick mode skips provisioning
and takes the `trycloudflare.com` address the host reports. The Worker is a
registry and management plane only; guest traffic goes through Cloudflare's edge
and the tunnel directly to the host.

The [self-hosted relay](./personal-relay.md) stays the default. This relay is
additive: it does not change VPS behavior, and one host uses one relay at a time.

This runbook describes the frozen interface. The E2E checklists at the end are
the gate evidence; a dry run or a fake wrangler run is not a pass.

## Validation status (2026-11-17)

- Quick mode passed against a real `wrangler dev` relay, a real cloudflared
  quick tunnel, a host, the admin console (including a foreign origin), and a
  guest paired over the tunnel.
- Named mode passed against a live Cloudflare zone: a remotely-managed tunnel,
  proxied CNAME, healthy tunnel, `https://<hostId>.<zone>` returning 200, guest
  pairing over that hostname, and a host restart that kept the same host ID and
  URL.
- The npm packages were built and installed from the tarball; `t3cf --help`,
  `init --dry-run`, `--upgrade` secret reuse, a real quick-mode deploy, the
  deployed admin console, and `--destroy` passed. The `t3cf` tarball measured
  74.6 MB, above the 50 MB target; it still ships the prebuilt portal per the
  locked decision.
- The packages are **not published to npm yet**. Publishing remains the manual
  or `cf-relay-v*` workflow in `.github/workflows/publish-t3cf.yml`.
- The full desktop/Android G5 pass has not been recorded; the named and quick
  guest checks used the web client against the same host protocol.

## Prerequisites

- A Cloudflare account. Quick mode needs nothing else in Cloudflare.
- For named mode: a zone whose nameservers point at Cloudflare, and a Zero Trust
  organization. Cloudflare asks for payment details when the organization is
  created, even on the Free plan; the deploy cannot skip that.
- Node.js 20.19 or newer for the npm CLI. A repository checkout already has its
  own Node requirement.
- A Cloudflare API token, or an existing `wrangler login` session.

Create the token in the Cloudflare dashboard under **My Profile → API Tokens**.
Scope it to the account and the host zone; do not use a global API key.

| Use                      | Variable                                    | Permissions                                                                                          |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deploy                   | `CLOUDFLARE_API_TOKEN`, or `wrangler login` | Account: Workers Scripts Edit, Workers Durable Objects Edit, Account Settings Read. Zone: Zone Read. |
| Runtime in named mode    | `T3CODE_CF_API_TOKEN`                       | Account: Cloudflare Tunnel Edit. Zone: DNS Edit for the host zone.                                   |
| Publish the npm packages | `NPM_TOKEN`                                 | Publishing only. Never use it to deploy a relay.                                                     |

The runtime token is stored as a Worker secret and can create and delete tunnels
and DNS records in that zone. Use a separate, zone-scoped token from the deploy
token where possible, and rotate it if it leaks. Quick mode does not need a
runtime token.

`CLOUDFLARE_ACCOUNT_ID` is optional; the deploy resolves the account from the
token or `wrangler whoami`.

## Deploy from this repository

```sh
vp run cf-relay:deploy --mode named --hosts-domain example.com
```

With a relay custom domain, add `--relay-domain relay.example.com`. Without a
zone, or with `--mode quick`, it deploys the quick path.

| Flag                        | Default   | Purpose                                                                                        |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `--mode auto\|named\|quick` | `auto`    | `auto` picks named only when the account, zone, suffix, and runtime token are all present.     |
| `--hosts-domain <zone>`     | none      | Zone or dedicated sub-zone for `<hostId>.<zone>` hostnames.                                    |
| `--relay-domain <hostname>` | none      | Optional Worker custom domain. Disables the `workers.dev` route so the console has one origin. |
| `--worker-name <name>`      | `t3cf`    | Worker name; the tunnel prefix derives from it.                                                |
| `--max-hosts <n>`           | `20`      | Registration cap for the deployment.                                                           |
| `--secrets-file <path>`     | see below | Store or read the keys somewhere else.                                                         |
| `--dry-run`                 | off       | Validate inputs and print the plan without deploying.                                          |
| `--upgrade`                 | off       | Redeploy with the stored secrets.                                                              |
| `--doctor`                  | off       | Check token permissions, zone, Zero Trust, and relay health; changes nothing.                  |
| `--destroy`                 | off       | Delete tunnels and DNS records with this prefix, then the Worker.                              |
| `--no-portal-build`         | off       | Reuse `apps/web/dist` instead of building the portal.                                          |
| `--allow-multi-level`       | off       | Permit a deeper hostname suffix. Requires ACM or Total TLS; not the default.                   |
| `--rotate-keys`             | off       | Generate new admin, enrollment, and secret keys. Never implicit.                               |
| `--yes`                     | off       | Accept prompts for non-interactive runs.                                                       |

The repository path builds the admin console from `apps/web` with
`VITE_PERSONAL_ADMIN_CONSOLE=1` and `VITE_T3CODE_PERSONAL_ONLY=1`, so the portal
works at the deployed origin without a baked-in URL. It uses the package's
pinned `wrangler`, validates the token and zone, generates missing secrets,
deploys the Worker and its Durable Object, puts the secrets, and polls
`/v1/health` until the relay answers.

The deploy prints, once:

- the relay URL and admin console URL;
- the admin key and enrollment key;
- the host URL rule, for example `https://<hostId>.example.com`;
- the desktop and mobile next steps.

No D1 database is created. The Durable Object namespace is created by the Worker
migration, so there is no `database_id` to paste.

`--hosts-domain` must be the zone apex or a dedicated sub-zone. A suffix such as
`t3.example.com` is fine when that name is its own Cloudflare zone; deeper names
need `--allow-multi-level` and a paid certificate covering them.

## Deploy without a checkout

```sh
npx t3cf@latest init
npm create t3cf@latest
```

The `@latest` suffix avoids a stale `npx` cache. `npm create t3cf@latest` runs
the same CLI as `npx t3cf init`. Neither needs this repository: the package
ships a prebundled Worker and the prebuilt admin console, and has no
`postinstall`.

The package requires Node 20.19 or newer. It writes deployment secrets to
`~/.t3/personal-relay/<worker-name>.json` by default (under the user profile on
Windows), owner-only; `--secrets-file` overrides that. `--upgrade` reuses the
file, and `--destroy` operates on the deployment named by `--worker-name`.

## Secrets and backups

Repository deployments store secrets in
`infra/personal-relay-cloudflare/.wrangler/relay-secrets.json`; the `.wrangler`
directory is gitignored. The npm path stores them in
`~/.t3/personal-relay/<worker-name>.json`. Both files are owner-only and contain
the admin key, the secret key, the enrollment key, and optionally the Cloudflare
runtime token.

Back the file up outside the repository before an upgrade, and keep it in a
password manager or an encrypted disk. It is the only copy of these values. The
admin and enrollment keys must each be at least 32 characters; the secret key
must decode to exactly 32 bytes.

- **Secret key** (`T3CODE_SECRET_KEY`) encrypts host keys at rest. Losing it
  breaks host-key reveal in the admin console and forces hosts to re-register.
  Cloudflare cannot recover it.
- **Admin key** (`T3CODE_ADMIN_KEY`) opens the admin console. `--rotate-keys`
  replaces it, and everyone must enter the new one.
- **Enrollment key** (`T3CODE_ENROLL_KEY`) is required by host registration and
  must differ from the admin key. `--rotate-keys` generates a new one; new
  registrations need the current value.
- **Cloudflare API token** (`T3CODE_CF_API_TOKEN`) is the runtime credential for
  tunnels and DNS. It is not needed for quick mode.

`--rotate-keys` is a full rotation: it generates a new admin, enrollment, and
secret key. Back up the old file first. After it, hosts must register again
before admin host-key reveal works, and the admin console needs the new key.

On `--upgrade`, a missing secrets file prompts for the existing keys when the
Worker already exists. The deploy never silently rotates keys or the secret key;
use `--rotate-keys` explicitly. Never commit the file, paste it into an issue, or
include it in a support bundle. The npm package excludes it, `.dev.vars`, and
`cloudflared`.

## Day-two operations

Check health and the console first:

```sh
curl -sS https://<relay>/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' https://<relay>/
```

The health body is `{ "ok": true, "service": "t3-personal-registry",
"version": 2, "mode": "named" | "quick" }`. The root returns the admin console
shell. A named host should answer on `https://<hostId>.<zone>` with a valid
certificate; during provisioning that name may answer Cloudflare error 1033 until
`cloudflared` connects.

- `--doctor` checks the deploy and runtime tokens, the account, the zone, Zero
  Trust, and the relay health. Run it before a deploy and after a failure.
- `--upgrade` redeploys with the stored secrets and the current code. Pass the
  same `--worker-name` and, in named mode, `--hosts-domain` you deployed with.
- `--no-portal-build` redeploys quickly from an existing `apps/web/dist`. Rebuild
  the portal for anything user-visible.
- `--destroy` deletes tunnels and DNS records with this deployment's prefix,
  then deletes the Worker. The registry and host records go with it, so guests
  must add hosts again. Tunnels belonging to another prefix are left alone.
- Worker logs: `npx wrangler tail <worker-name>` from the package directory.
  Structured events cover host registration, key rotation, admin actions,
  tunnel provisioning steps, and API errors; never keys, tokens, or bodies.
- Cloudflare dashboard checks: **Workers & Pages** for the Worker and its
  deployment, **Durable Objects** for the registry class, **Zero Trust →
  Networks → Tunnels** for named tunnels, and **DNS** for the proxied CNAMEs.

The admin console is static and public; the API is the security boundary. The
admin key is accepted only on `/v1/admin/*`, the enrollment key only on
`POST /v1/hosts/register`, host tokens on the host endpoints, and host keys on
resolve. Rate limits default to 10 registrations, 120 resolves, and 300 admin
requests per minute per IP, and `--max-hosts` caps registrations. CORS allows the
relay's own origin plus any `T3CODE_ALLOWED_ORIGINS` entries; `*` is rejected.

## Operation logs

Both sides emit structured events for the operations that usually need
debugging. They never contain the admin key, enrollment key, host key, host
token, tunnel token, Cloudflare API token, authorization header, or request
body.

Worker (live):

```sh
pnpm --filter @t3tools/personal-relay-cloudflare exec wrangler tail t3cf --format pretty
```

Or open **Workers & Pages → the Worker → Observability** in Cloudflare. Key
events:

| Event                                                                                                             | What it records                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `host_registered`, `host_reregistered`                                                                            | `hostId`, `environmentId`, `mode`, connector kind, `publicUrl`, and whether the host key was reused |
| `host_unregistered`, `host_key_rotated`, `host_key_rotation_announced`                                            | Host lifecycle and key changes                                                                      |
| `admin_host_action`                                                                                               | Admin rotate/remove/restore/revoke actions                                                          |
| `tunnel_created`, `tunnel_reused`, `tunnel_ingress_configured`, `tunnel_token_fetched`, `tunnel_ensure_succeeded` | Named tunnel provisioning steps                                                                     |
| `tunnel_ensure_failed`, `tunnel_provision_failed`, `tunnel_cleanup_failed`                                        | The failing tunnel step and the Cloudflare error detail                                             |
| `api_rejected`, `api_error`                                                                                       | HTTP status and the same error text returned to the caller                                          |

Host/server: `personal relay starting`, `registered`, `start failed`,
`stopping`, `pausing`, `resuming`, and `host key rotated`. Registration logs
include the relay origin, whether the relay switched, the connector kind/mode,
the public URL, and whether the host key changed. The host log goes to the
server log stream and the app's `userdata/logs` directory.

The client surfaces the relay's `{ "error": "..." }` text in the UI, so a
provisioning 502 names the failed step instead of only `The relay answered 502`.

## Limits and costs

The stack targets the Workers and Durable Objects Free plan. On Free, usage
above a limit fails requests or rejects a deploy rather than billing; on a paid
plan, Cloudflare bills it. A Zero Trust organization requires payment details
even on Free.

| Area            | Limit                                                                  | Effect                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker requests | 100,000 per day on Free                                                | 20 hosts at 60-second heartbeats use about 29,000 requests a day before guest resolves. Guest project traffic does not pass through the Worker.            |
| Workers Assets  | 20,000 files, 25 MiB per file                                          | The admin console build must fit. Check the portal output after a web change.                                                                              |
| Durable Objects | One registry object with SQLite                                        | No D1 database and no manual `database_id`. The registry is not user-exportable; losing it means hosts must register again and guests must add them again. |
| Quick tunnels   | About 200 in-flight requests per tunnel, no server-sent events, no SLA | Temporary addresses and a trial path only. SSE-based guest links fail.                                                                                     |
| Named tunnels   | Normal Cloudflare edge                                                 | WebSocket and SSE work; the address is stable across host restarts.                                                                                        |
| HTTP timeout    | About 100 seconds through Cloudflare's proxy                           | Long single requests return 524. WebSocket sessions are unaffected; retry or reduce the file.                                                              |
| QUIC            | UDP 7844                                                               | `cloudflared` falls back to HTTP/2 over TCP 443 when QUIC is blocked. Allow both on restrictive networks.                                                  |
| TLS             | Universal SSL covers one label                                         | `https://<hostId>.<zone>` works. Deeper names need ACM or Total TLS and `--allow-multi-level`.                                                             |
| Push            | None in v1                                                             | `/v1/push/*` and `/v1/notify` return 501 or a no-op success. The admin console does not use them.                                                          |
| VPS relay       | Unchanged                                                              | Separate deployment and data; switching a host back re-registers it and invalidates the Cloudflare host key.                                               |

The Free plan's terms also restrict proxying very large files or video. Test
attachment sizes before relying on this relay for them.

## Troubleshooting

| Symptom                                         | Check                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/health` reports a config error             | A required secret or var is missing or invalid. The message names it; re-run `--upgrade`, which reuses the secrets file.                                    |
| Register returns 401                            | Enrollment key missing, wrong, or rotated. The admin key is deliberately rejected on the host path.                                                         |
| Register returns 400                            | The host is older than `apiVersion: 2`. Update T3 Code on that host.                                                                                        |
| Register returns 429                            | The per-IP registration limit, or `--max-hosts` was reached. Remove an unused host or raise the cap.                                                        |
| Named provisioning returns 502                  | The runtime token lacks Cloudflare Tunnel Edit or DNS Edit, the zone id is wrong, or Cloudflare rate-limited the API. Run `--doctor`; provisioning retries. |
| A hostname already has a conflicting DNS record | The relay returns 409 when the name is not a CNAME to `*.cfargotunnel.com`. Remove the record or use a dedicated sub-zone.                                  |
| Quick host never reports an address             | `cloudflared` is missing, crashed, or timed out after about 30 seconds. The host panel shows the stderr tail; check the binary path.                        |
| Named host returns 1033 or 502                  | The tunnel exists but `cloudflared` is not connected, or the local origin port is wrong. Check the host connector status and the tunnel in Zero Trust.      |
| A long request returns 524                      | Cloudflare's ~100-second HTTP timeout. Retry, or use a WebSocket path.                                                                                      |
| Guest links show no live updates                | Quick mode does not support SSE. Use named mode.                                                                                                            |
| Admin reveal fails                              | The secret key changed or was lost. Hosts must re-register before reveal works again.                                                                       |
| `npx t3cf init` runs an old version             | Use `npx t3cf@latest init` or `npm create t3cf@latest`.                                                                                                     |
| `--destroy` leaves a tunnel                     | The runtime token was unavailable, so tunnel cleanup was skipped. Delete it in Zero Trust or rerun with a token that has Cloudflare Tunnel Edit.            |

## E2E checklists

These are the gate evidence for G2–G5. Run them after the gate's lanes merge; a
fake wrangler, a dry run, or a unit test does not count. The G3–G5 sections need
the owner's Cloudflare account, a proxied zone, and a Zero Trust organization.
No run is recorded here yet. Shell snippets are POSIX; adapt paths and variables
on Windows.

### G2 — quick mode on a local Worker

Needs this checkout, its dependencies, a real `cloudflared` on `PATH`, and
internet access. It needs no Cloudflare domain, zone, or Zero Trust
organization.

**1. Build the admin console.**

```sh
VITE_PERSONAL_ADMIN_CONSOLE=1 VITE_T3CODE_PERSONAL_ONLY=1 \
  vp run --filter @t3tools/web build
```

Expect `apps/web/dist/index.html`.

**2. Create local secrets.**

Copy `infra/personal-relay-cloudflare/.env.example` to `.dev.vars`, set
`T3CODE_TUNNEL_MODE=quick`, and fill the admin, secret, and enrollment keys.
Generate values with `openssl rand -base64 32` (admin and enrollment) and
`openssl rand -hex 32` (secret). Expect `.dev.vars` to be ignored by Git.

**3. Start the Worker.**

```sh
vp run cf-relay:dev
```

Expect `wrangler dev` to listen on `http://localhost:8787` and report no config
error.

**4. Check health.**

```sh
curl -sS http://127.0.0.1:8787/v1/health
```

Expect `ok: true`, `version: 2`, and `mode: "quick"`.

**5. Open the admin console.**

Open `http://localhost:8787` and enter the admin key. Expect the console to load
from the same origin, skip pairing, and show no hosts. This checks the local
origin only; G4 checks a foreign deployed origin.

**6. Register a host.**

Use the desktop app's **Settings → Connections → Personal network**, or:

```sh
t3 personal join --relay http://127.0.0.1:8787 --relay-key "<enrollment key>" --label "G2 host"
```

Expect a host key, a `cloudflared` connector, `temporary address` in the status,
and a `https://<random>.trycloudflare.com` public URL. The admin console should
list the host as online with that URL.

**7. Confirm the quick address is temporary.**

Pause and resume sharing, or restart the host app, then wait for the connector.
Expect a different `trycloudflare.com` hostname with the same host key. The guest
list must be refreshed to pick up the new address.

**8. Add a desktop guest.**

On another computer or a second app profile, use **Add a computer** with the
same relay URL and the host key. Expect resolve to report online, pairing to
succeed, and the host's projects and threads to load. Open a thread and send one
message; expect streaming output.

**9. Stop the host.**

Quit the host app or stop its server. Expect the guest to report offline and the
admin console to mark the host offline after the 180 second heartbeat TTL.

### G3 — named mode with a real zone

**Owner account.** Needs a Cloudflare-managed zone, a runtime token scoped to it,
and a Zero Trust organization with payment details on file.

**1. Check the account and tokens.**

```sh
vp run cf-relay:deploy --doctor --mode named --hosts-domain example.com
```

Expect every check to pass: token, account, zone, Zero Trust, and `cloudflared`
provisioning permissions.

**2. Deploy named mode.**

```sh
vp run cf-relay:deploy --mode named --hosts-domain example.com
```

Add `--relay-domain relay.example.com` if the relay has its own hostname. Expect
the printed relay URL, admin key, enrollment key, and
`https://<hostId>.example.com` rule, and `/v1/health` to report `mode: "named"`.

**3. Check the Cloudflare resources.**

In the dashboard, expect one Worker with the assets binding, the
`RegistryDurableObject` class, and no D1 database. The admin console should load
at the relay origin and accept the admin key.

**4. Register a host.**

Enter the relay URL and enrollment key, then register. Expect a stable
`https://<hostId>.example.com` URL, a connector running, and a proxied CNAME in
DNS from the hostname to `<tunnelId>.cfargotunnel.com`. The certificate should be
trusted without a warning.

**5. Operate through the internet.**

Add the host from a desktop guest on another network. Expect projects, threads,
live output, and file reads to work. Open a guest link in a browser and confirm
live updates over SSE; this is the named-mode path that quick cannot serve.

**6. Restart the host.**

Quit and reopen the host app, or restart the machine. Expect the same hostname,
the guest to reconnect, and the admin console to show it online again.

**7. Remove and restore.**

Choose **Remove** in the admin console. Expect the host to stop its connector,
the key to stop resolving, and the tunnel and DNS record to be deleted or queued
for the sweep. Choose **Restore**, then register from the host again. Expect the
same host id and hostname, and guests to re-pair with the same key.

**8. Destroy the deployment.**

```sh
vp run cf-relay:deploy --destroy --worker-name t3cf
```

Expect the Worker, its registry, and every tunnel and DNS record with the
deployment's prefix to be gone; other prefixes and the VPS relay stay untouched.
The relay URL should no longer serve the console.

### G4 — npm package and prebuilt portal

**1. Build the packages.**

```sh
vp run cf-relay:pack
```

Expect `dist/npm` and `dist/create` with matching versions.

**2. Inspect the tarballs.**

```sh
cd infra/personal-relay-cloudflare/dist/npm && npm pack && tar -tzf t3cf-*.tgz
cd ../create && npm pack && tar -tzf create-t3cf-*.tgz
```

Expect the prebundled Worker, the prebuilt portal, the wrangler template, the
README, and the license. Expect no `.dev.vars`, no `relay-secrets.json`, no
`cloudflared` binary, and no `postinstall`. The 2026-11-17 build measured
`t3cf` at 74.6 MB; it keeps the portal in the package per the locked product
decision. Re-measure on every release and revisit the release-asset fallback if
the size becomes a distribution blocker.

**3. Install and deploy from a temp directory.**

```sh
mkdir /tmp/t3cf-g4 && cd /tmp/t3cf-g4
npm init -y
npm install /path/to/t3cf-<version>.tgz
npx t3cf init --mode quick
```

Expect a complete deployment without a T3 checkout or a TypeScript build, and
the same printed URL and keys as the repository path.

**4. Open the prebuilt portal at a foreign origin.**

Open the deployed `https://t3cf.<subdomain>.workers.dev` URL and enter the admin
key. Expect the console to load and default its relay URL to
`window.location.origin`, with no `VITE_HOSTED_APP_URL` in the build. Register a
host and list it.

**5. Upgrade without rotating keys.**

Register a host, note its key and the admin key, then run `npx t3cf init
--upgrade`. Expect the same secrets file, the same admin key, and the host still
resolving with the key it had. The host should stay online or reconnect without
re-registering.

**6. Recover a missing secrets file.**

Move the secrets file aside and run `npx t3cf init --upgrade` again. Expect a
prompt for the existing admin and enrollment keys, or a refusal that names
`--rotate-keys`. Expect no silent rotation.

**7. Run the create wrapper.**

**Owner account / published package.** After publishing, run
`npm create t3cf@latest` in another empty directory. Expect the same CLI and
deployment flow as `npx t3cf init`.

### G5 — full end-to-end

**Owner account.** Needs a named deployment, a host, a desktop guest, an Android
guest, and the desktop installers. Run the whole list against one deployment
unless a step says otherwise.

**1. Two guests at once.**

Add the same host key on desktop and Android. Expect both guests to list
projects, open threads, and send messages concurrently, with live updates on
both.

**2. Pause and resume.**

Pause on the host. Expect both guests to see paused or offline and new requests
to fail without losing the key. Resume. Expect named mode to keep the hostname
and both guests to recover.

**3. Rotate the key.**

Rotate from the host panel. Expect old guest sessions to be rejected, the panel
to show the new key, and a guest that enters it to pair again. Confirm the admin
console shows the new key.

**4. Remove and restore.**

Remove the host in the admin console. Expect the host connector to stop and
guests to fail resolve. Restore, register from the host, and expect the same host
id and hostname. Guests re-pair with the same key.

**5. Host restart.**

Restart the host app and the machine. Expect the named hostname to stay stable
and guests to reconnect without re-adding the host.

**6. Thirty-minute WebSocket.**

Keep a desktop guest thread open for 30 minutes, then send a message. Expect the
connection to stay healthy, the message to stream, and no reconnect that loses
the thread's place. Repeat with the Android guest foregrounded.

**7. Files.**

Upload an attachment from a guest and read it back from another guest. Expect
the file to transfer through the tunnel and render or download correctly.

**8. Windows and macOS installers.**

Install each artifact on a machine without `cloudflared` on `PATH`. Expect the
bundled binary to run, a quick or named tunnel to start, and the host to register
without a manual `T3CODE_CLOUDFLARED_PATH`.

**9. VPS regression.**

Register a host against the self-hosted relay with the same build and its
existing configuration. Expect registration, guest resolve, and project traffic
to behave as before. Confirm the Cloudflare deployment did not alter VPS data.

**10. Relay switching.**

Move a host from the VPS relay to the Cloudflare relay and back. Expect the host
to register with the new relay before leaving the old one, the old key to stop
working after the switch, and a wrong or missing enrollment key to leave the
existing relay working.

**11. Quick-mode limits.**

On a quick deployment, confirm a guest link's SSE stream does not work and that
a temporary address change is recovered with **Refresh**. Do not treat quick
mode as production after this run.

**12. Admin console at the deployed origin.**

Open the console from a network other than the host's. Expect host keys, guest
sessions, rotate, remove, and restore to work with the admin key only, and no
host key or token to appear in Worker logs.
