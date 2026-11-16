# Fork releases: Windows and Intel macOS

> Fork-only procedure. The upstream release train is [`release.md`](./release.md);
> it publishes six desktop targets, CLI archives, npm, web, and mobile store builds
> and requires upstream infrastructure.

[`.github/workflows/release-fork.yml`](../../.github/workflows/release-fork.yml) runs on a
`v*.*.*` tag push and publishes one GitHub Release with:

- Windows x64 NSIS installer (`T3-Code-<version>-x64.exe`)
- Intel macOS x64 DMG and the update ZIP

It also builds Linux x64, but only for its CLI archive: the Windows installer embeds
that archive as the WSL runtime. Linux artifacts are not attached.

Android is the hosted PWA, not the repository's native `apps/mobile` app. This workflow
does not build an APK. Open the portal in Chrome and use **Install app** or **Add to
Home Screen**. The desktop installers and the PWA share `apps/web` and `apps/server`;
the desktop runs the host/owner UI, while the PWA is the phone/remote client with the
personal-key gate.

The desktop bundle sets `VITE_T3CODE_PERSONAL_ONLY=1` to hide cloud UI and
`VITE_HOSTED_APP_URL` for copied links. The URL defaults to
`https://relay.example.com`; override it with the repository variable
`T3CODE_PERSONAL_PORTAL_URL`.

## Repository setup

- Enable Actions for the fork.
- In **Settings > Actions > General**, allow the workflow token to write contents
  (`Read and write permissions`, or the equivalent organization policy). The release
  job uses `contents: write` to create the GitHub Release.
- Set `T3CODE_PERSONAL_PORTAL_URL` if the portal is not `https://relay.example.com`.

## Cut a release

```sh
git tag v0.1.10
git push origin v0.1.10
```

The fork release workflow builds and packages; it does not repeat the repository's
quality checks. Let normal CI pass on the commit before tagging it. The tagged commit
must contain `release-fork.yml`, because GitHub runs the workflow file from that commit.

The tag's commit is built exactly. A version with a suffix, such as `v0.1.10-beta.1`,
is published as a GitHub prerelease. The release stays a draft until every asset is
uploaded, so desktop auto-update never sees a half-published version. Re-run failed
jobs from the Actions tab; the release upload steps replace existing assets.

The same tag also starts the upstream `Release` workflow, but its `resolve_commit`
job requires `pingdotgg/t3code`, so that run skips every job and publishes nothing.

The workflow uses GitHub-hosted runners. Expect roughly 30-60 minutes for the desktop
jobs on a cold cache.

## Personal-mode host configuration

The desktop installer contains the server and web client, but it cannot contain your
personal key. To use an install as a host, configure the server runtime with
`T3CODE_PERSONAL_ENABLED=1`, `T3CODE_PERSONAL_KEY`, and
`T3CODE_PERSONAL_RELAY_URL`; `t3 personal join` writes the same values for a CLI
service. The portal and phone PWA are the clients.

## T3 Connect (optional)

Fork builds ship with T3 Connect disabled. Local networks, SSH, and Tailscale still
work. To bake in a relay and Clerk configuration, set all four repository variables;
setting fewer than four leaves it disabled:

- `T3CODE_RELAY_URL`
- `T3CODE_CLERK_PUBLISHABLE_KEY`
- `T3CODE_CLERK_JWT_TEMPLATE`
- `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`

The values in [`.env.example`](../../.env.example) are the public identifiers used by
official builds. Pointing a fork at them sends its users' cloud sign-in and relay
traffic to that deployment; use your own if you distribute the fork widely.

## Code signing (optional)

Unsigned builds install but warn. Signing turns on automatically when the matching
secrets exist.

macOS (Intel DMG). Without these the app is unsigned or ad-hoc signed; users must
right-click the app and choose **Open** the first time, or clear the quarantine
attribute. Such apps may also fail electron-updater's signature check, so treat later
releases as manual DMG downloads.

- Secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE`
- Variables: `APPLE_TEAM_ID`, and either the T3 Connect variables or
  `CLERK_PASSKEY_RP_DOMAINS`. A signed build derives the passkey RP domain from
  one of them and refuses to package without it.

Windows. Without these Windows SmartScreen warns on the installer.

- Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

## Update feed

The desktop app updates from this fork's GitHub Releases. Each release uploads
`latest.yml` (Windows) and `latest-mac.yml` (Intel macOS) plus blockmaps. There is no
arm64 build: Apple Silicon users run the x64 app under Rosetta, and Windows arm64 has
no installer. The workflow sets the updater repository to the repository that runs
it, so do not set `T3CODE_DESKTOP_UPDATE_REPOSITORY` unless you need a different feed.

## Android

The phone surface is the PWA at the portal URL. There is no APK in this release: the
native `apps/mobile` app is a separate React Native UI and does not contain the
personal-mode portal changes. Open the portal in Chrome, use **Install app** or **Add
to Home Screen**, then enter the personal key once.

## Troubleshooting

- The Linux job also packages an AppImage this release does not attach. If it fails
  after uploading `cli-linux-x64`, the Windows build and the release still succeed;
  the run is red only because of that unused job.
- The macOS job launches the packaged app before publishing. If an unsigned local
  build fails that check, remove `launch_check: true` from `desktop_mac_x64` and
  re-run; the DMG is still produced.
- `macos-15-intel` is available through August 2027. If GitHub retires it, switch the
  runner label to `macos-26-intel`; the artifact stays x64.
- If you need the native React Native Android app, build it separately with the
  `apps/mobile` EAS/local flow. It is intentionally not part of this release.
