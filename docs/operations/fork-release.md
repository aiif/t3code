# Fork releases: Windows, Intel macOS, Android APK

> Fork-only procedure. The upstream release train is [`release.md`](./release.md);
> it publishes six desktop targets, CLI archives, npm, web, and mobile store builds
> and requires upstream infrastructure.

[`.github/workflows/release-fork.yml`](../../.github/workflows/release-fork.yml) runs on a
`v*.*.*` tag push and publishes one GitHub Release with:

- Windows x64 NSIS installer (`T3-Code-<version>-x64.exe`)
- Intel macOS x64 DMG and the update ZIP
- Android APK (`T3-Code-<version>-android.apk`)

It also builds Linux x64, but only for its CLI archive: the Windows installer embeds
that archive as the WSL runtime. Linux artifacts are not attached.

The desktop builds keep the upstream app identity (`com.t3tools.t3code`) and product
name, so they replace an installed official T3 Code app instead of installing beside
it. The Android APK uses the same package id and therefore has the same caveat.

## Repository setup

- Enable Actions for the fork.
- In **Settings > Actions > General**, allow the workflow token to write contents
  (`Read and write permissions`, or the equivalent organization policy). The release
  job uses `contents: write` to create the GitHub Release.

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
jobs and 45-120 minutes for the Android job on a cold cache.

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
traffic to that deployment; use your own if you distribute the fork widely. Google
sign-in on Android may also require a Google OAuth client registered for this APK's
package and signing certificate; other sign-in methods and local pairing still work.

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

Android. Without these Gradle signs the release APK with the React Native template
debug key. That key is stable but public, and the APK uses the production package
`com.t3tools.t3code`, so uninstall a Play Store install before sideloading it; its
signature cannot match Google's.

- Secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`

Generate a keystore once and keep it:

```sh
keytool -genkeypair -v -keystore t3code-android.keystore -alias t3code \
  -keyalg RSA -keysize 4096 -validity 10000
base64 < t3code-android.keystore | tr -d '\n'
```

Set the base64 output as `ANDROID_KEYSTORE_BASE64`, and the store password, alias, and
key password as the other three secrets. Losing this keystore means users must
uninstall the app before installing a later release.

## Update feed

The desktop app updates from this fork's GitHub Releases. Each release uploads
`latest.yml` (Windows) and `latest-mac.yml` (Intel macOS) plus blockmaps. There is no
arm64 build: Apple Silicon users run the x64 app under Rosetta, and Windows arm64 has
no installer. The workflow sets the updater repository to the repository that runs
it, so do not set `T3CODE_DESKTOP_UPDATE_REPOSITORY` unless you need a different feed.

## Mobile versioning

The APK's `versionName` follows the tag, and its `versionCode` is derived from semver
(`major * 1_000_000 + minor * 1_000 + patch`), so later tags install over earlier
ones. Expo OTA updates are disabled because the fork has no EAS project to publish
them to. Remote push notifications need a Firebase `google-services.json`, which this
workflow does not provision; local notifications still work.

## Troubleshooting

- Partial signing credentials never fail the build; the platform falls back to an
  unsigned artifact. The only exception is Android: setting
  `ANDROID_KEYSTORE_BASE64` without the other three secrets fails the signing step.
- `macos-15-intel` is available through August 2027. If GitHub retires it, switch the
  runner label to `macos-26-intel`; the artifact stays x64.
- The Windows job waits for the Linux CLI archive that it embeds as its WSL runtime.
  If that wait fails, inspect the `Build Linux x64` job first, not the Windows job.
- The Linux job also packages an AppImage this release does not attach. If it fails
  after uploading `cli-linux-x64`, the Windows build and the release still succeed;
  the run is red only because of that unused job.
- The macOS job launches the packaged app before publishing. If an unsigned local
  build fails that check, remove `launch_check: true` from `desktop_mac_x64` and
  re-run; the DMG is still produced.
- The APK contains `arm64-v8a` and `armeabi-v7a` native libraries only. An x86
  emulator needs a different `reactNativeArchitectures` value in the Android job.
