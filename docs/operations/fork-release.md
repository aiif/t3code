# Fork releases: Windows x64 and Android arm64 (macOS opt-in)

> Fork-only procedure. The upstream release train is [`release.md`](./release.md);
> it publishes six desktop targets, CLI archives, npm, web, and mobile store builds
> and requires upstream infrastructure.

[`.github/workflows/release-fork.yml`](../../.github/workflows/release-fork.yml) runs on a
`v*.*.*` tag push and publishes one GitHub Release with:

- Windows x64 NSIS installer (`T3-Code-<version>-x64.exe`)
- Native Android arm64 APK (`T3-Code-<version>-android-arm64.apk`) for `arm64-v8a`,
  which covers current flagship phones such as Xiaomi's Snapdragon models

macOS arm64 is opt-in. Set the repository variable `T3CODE_FORK_BUILD_MACOS=1` to
also build `T3-Code-<version>-arm64.dmg` and publish `latest-mac.yml`. With the
variable unset, the macOS job is skipped and existing macOS installs get no new
updater manifest from that release.

The release also carries the Windows updater manifest (`latest.yml`) and the
Windows blockmap so installed desktop apps can auto-update. Linux, iOS, and source
archives are not attached.

GitHub always shows its auto-generated "Source code (zip/tar.gz)" links on a
release page. The API has no switch to hide them; the workflow simply does not
upload a source archive of its own.

It also builds Linux x64 internally, but only for its CLI archive: the Windows
installer embeds that archive as the WSL runtime. Linux artifacts never reach the
release.

## Personal network

Both desktop installers and the Android APK are built in personal mode from
`GOAL.md`:

- The desktop bundle sets `VITE_T3CODE_PERSONAL_ONLY=1`, hiding T3 Connect and
  pointing copied links at the portal. The desktop app shares itself from
  **Settings → Connections → Personal network** and receives a host key directly
  from the relay. Closing the window hides to the tray; sharing keeps running.
- The Android app sets `T3CODE_PERSONAL_ONLY=1` and
  `T3CODE_PERSONAL_RELAY_URL`. It is a first-class guest client: enter a host key
  under **Add environment → Personal network**, resolve it through the relay, and
  add several independent hosts. It is the upstream React Native app, not a
  WebView or a PWA shortcut.
- The portal you deploy at your relay origin is the admin console. It uses the
  admin key and manages hosts, host keys, and guest metadata; it does not pair
  as a guest.

The portal URL comes from the repository variable `T3CODE_PERSONAL_PORTAL_URL`.
Leave it unset to ship with every relay field blank; the desktop, web, and
Android builds then ask the user for their relay.

## Repository setup

- Enable Actions for the fork.
- In **Settings > Actions > General**, allow the workflow token to write contents
  (`Read and write permissions`, or the equivalent organization policy). The release
  job uses `contents: write` to create the GitHub Release.
- Set `T3CODE_PERSONAL_PORTAL_URL` to your relay origin. Unset is valid and
  leaves the relay fields blank for the user to fill in.

## Cut a release

```sh
git tag v0.1.10
git push origin v0.1.10
```

The fork release workflow builds and packages; it does not repeat the repository's
quality checks. Let normal CI pass on the commit before tagging it. The tagged commit
must contain `release-fork.yml`, because GitHub runs the workflow file from that commit.

The tag's commit is built exactly. A version with a suffix, such as `v0.1.10-beta.1`,
is published as a GitHub prerelease. The release stays a draft until every expected
asset is uploaded, so desktop auto-update never sees a half-published version. Re-run
failed jobs from the Actions tab; the release upload steps replace existing assets.

The macOS job is disabled by default. Enable it for the next release with
`gh variable set T3CODE_FORK_BUILD_MACOS --body 1 -R <owner>/<repo>`, or from
**Settings > Secrets and variables > Actions > Variables**.

The same tag also starts the upstream `Release` workflow, but its `resolve_commit`
job requires `pingdotgg/t3code`, so that run skips every job and publishes nothing.

The workflow uses GitHub-hosted runners. Expect roughly 30-60 minutes for the
Windows job on a cold cache and 15-30 minutes each for the macOS and Android jobs.

## Personal-network host configuration

The desktop installer contains the server and web client, but it cannot contain a
host key. Register from **Settings → Connections → Personal network**; the relay
returns the key and the app stores it owner-only in the T3 state directory.
`t3 personal join --relay https://relay.example.com --label "Home PC"` does the same
for a headless service.

## Android signing

This fork is self-use. The APK is built with Gradle's template debug/local key and
is attached directly; there is no production keystore and no signing secret. Android
still requires a signature, so the APK installs by sideload. Updating an installed
app requires the same key, so keep using the same build chain for every release. Do
not add release signing secrets unless the owner asks for them.

The workflow aligns `versionName` and `versionCode` with the tag and builds only
`arm64-v8a`; that keeps the APK small and matches current flagship phones. Older
32-bit phones are not supported by these releases.

## Code signing (Windows, optional)

Without these Windows SmartScreen warns on the installer. Signing turns on
automatically when every secret exists.

- Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

## Update feed

The desktop app updates from this fork's GitHub Releases. Each release uploads
`latest.yml` and the installer blockmap. There is no Windows arm64 build. The
workflow sets the updater repository to the repository that runs it, so do not set
`T3CODE_DESKTOP_UPDATE_REPOSITORY` unless you need a different feed.

## Android

The APK is the native `apps/mobile` React Native app. It contains the personal
network guest flow and guest badge described above; it is not the hosted PWA.
Install the APK on an arm64 phone, open **Add environment → Personal network**,
enter the relay URL and a host key, and add as many hosts as needed. The portal
at your relay origin remains the admin console.

## Troubleshooting

- If the Android job fails after code changes, run it locally with
  `pnpm --filter @t3tools/mobile exec expo prebuild --clean --platform android --no-install`
  before looking at Gradle.
- The macOS job builds an unsigned arm64 DMG when Apple secrets are absent; Gatekeeper
  warns on first open.
