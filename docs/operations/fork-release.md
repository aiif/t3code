# Fork releases: Windows x64 and Android arm64

> Fork-only procedure. The upstream release train is [`release.md`](./release.md);
> it publishes six desktop targets, CLI archives, npm, web, and mobile store builds
> and requires upstream infrastructure.

[`.github/workflows/release-fork.yml`](../../.github/workflows/release-fork.yml) runs on a
`v*.*.*` tag push and publishes one GitHub Release with exactly two installables:

- Windows x64 NSIS installer (`T3-Code-<version>-x64.exe`)
- Native Android arm64 APK (`T3-Code-<version>-android-arm64.apk`) for `arm64-v8a`,
  which covers current flagship phones such as Xiaomi's Snapdragon models

The release also carries the Windows updater manifest (`latest.yml`) and its
blockmap so installed desktop apps can auto-update. macOS, Linux, iOS, and source
archives are not attached.

GitHub always shows its auto-generated "Source code (zip/tar.gz)" links on a
release page. The API has no switch to hide them; the workflow simply does not
upload a source archive of its own.

It also builds Linux x64 internally, but only for its CLI archive: the Windows
installer embeds that archive as the WSL runtime. Linux artifacts never reach the
release.

## Personal mode

Both installables are built in personal mode from `GOAL.md`:

- The desktop bundle sets `VITE_T3CODE_PERSONAL_ONLY=1`, hiding T3 Connect and
  pointing copied links at the portal.
- The Android app sets `T3CODE_PERSONAL_ONLY=1` and
  `T3CODE_PERSONAL_RELAY_URL`. The native app shows the personal-network setup
  (relay URL plus key), discovers every host registered under the key, pairs them
  through the normal bearer flow, and shows a guest badge on those sessions. It is
  still the upstream React Native app, not a WebView or a PWA shortcut.

The portal URL defaults to `https://relay.example.com`. Override it with the repository
variable `T3CODE_PERSONAL_PORTAL_URL`; both the desktop and Android builds read it.

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
is published as a GitHub prerelease. The release stays a draft until both installers
are uploaded, so desktop auto-update never sees a half-published version. Re-run
failed jobs from the Actions tab; the release upload steps replace existing assets.

The same tag also starts the upstream `Release` workflow, but its `resolve_commit`
job requires `pingdotgg/t3code`, so that run skips every job and publishes nothing.

The workflow uses GitHub-hosted runners. Expect roughly 30-60 minutes for the
Windows job on a cold cache and 15-30 minutes for the Android job.

## Personal-mode host configuration

The desktop installer contains the server and web client, but it cannot contain your
personal key. To use an install as a host, configure the server runtime with
`T3CODE_PERSONAL_ENABLED=1`, `T3CODE_PERSONAL_KEY`, and
`T3CODE_PERSONAL_RELAY_URL`; `t3 personal join` writes the same values for a CLI
service. The portal PWA and the Android app are the clients.

## Android signing

Without a release keystore the APK is signed with the generated template debug key,
which installs but is public. Android refuses to update an installed app signed by a
different key, so keep one keystore for every release.

- Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`

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

The APK is the native `apps/mobile` React Native app. It contains the personal-mode
setup and guest badge described above; it is not the hosted PWA. Install the APK on
an arm64 phone, open **Add environment**, enter the relay URL and personal key once,
and every host in the key space appears. The portal PWA remains available at
`https://relay.example.com` for browsers and iPhones.

## Troubleshooting

- If the Android job fails after code changes, run it locally with
  `pnpm --filter @t3tools/mobile exec expo prebuild --clean --platform android --no-install`
  before looking at Gradle.
- `macos-15-intel` is no longer used by this workflow.
