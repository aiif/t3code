import Constants from "expo-constants";
import { Platform } from "react-native";
import { compareSemverVersions } from "@t3tools/shared/semver";

export const DEFAULT_MOBILE_RELEASE_REPOSITORY = "aiif/t3code";

export interface GitHubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}

export interface GitHubReleaseResponse {
  readonly tag_name: string;
  readonly name: string | null;
  readonly body: string | null;
  readonly html_url: string;
  readonly assets: ReadonlyArray<GitHubReleaseAsset>;
}

export interface MobileAppUpdateInfo {
  readonly isAvailable: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly tagName: string;
  readonly releaseName: string;
  readonly releaseNotes: string;
  readonly downloadUrl: string | null;
  readonly apkSize: number | null;
  readonly htmlUrl: string | null;
}

export function resolveCurrentMobileVersion(): string {
  try {
    // Dynamic require avoids loading expo-application eagerly in Node unit tests.
    const Application = require("expo-application");
    if (Application.nativeApplicationVersion) {
      return Application.nativeApplicationVersion;
    }
  } catch {
    // In tests or environments without native modules, fall back to expoConfig.
  }
  return Constants.expoConfig?.version ?? "0.0.0";
}

export function findApkAsset(
  assets: ReadonlyArray<GitHubReleaseAsset> | undefined,
): GitHubReleaseAsset | null {
  if (!assets || assets.length === 0) return null;
  // Match Android arm64 APK first, then any APK
  const arm64Apk = assets.find((asset) => /-android-arm64\.apk$/i.test(asset.name));
  if (arm64Apk) return arm64Apk;
  return assets.find((asset) => /\.apk$/i.test(asset.name)) ?? null;
}

export function parseMobileUpdateInfo(
  release: GitHubReleaseResponse,
  currentVersion: string,
): MobileAppUpdateInfo {
  const latestVersion = release.tag_name.replace(/^v/i, "").trim();
  const apkAsset = findApkAsset(release.assets);
  const isAvailable = compareSemverVersions(latestVersion, currentVersion) > 0;

  return {
    isAvailable,
    currentVersion,
    latestVersion,
    tagName: release.tag_name,
    releaseName: release.name || release.tag_name,
    releaseNotes: release.body?.trim() || "",
    downloadUrl: apkAsset?.browser_download_url ?? null,
    apkSize: apkAsset?.size ?? null,
    htmlUrl: release.html_url ?? null,
  };
}

export async function fetchLatestGitHubRelease(
  repository: string = DEFAULT_MOBILE_RELEASE_REPOSITORY,
  signal?: AbortSignal,
): Promise<GitHubReleaseResponse | null> {
  const url = `https://api.github.com/repos/${repository}/releases/latest`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "T3-Code-Mobile-App",
      },
      signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as GitHubReleaseResponse;
  } catch {
    return null;
  }
}

export async function checkMobileAppUpdate(options?: {
  readonly currentVersion?: string;
  readonly repository?: string;
  readonly signal?: AbortSignal;
}): Promise<MobileAppUpdateInfo | null> {
  const currentVersion = options?.currentVersion ?? resolveCurrentMobileVersion();
  const repository = options?.repository ?? DEFAULT_MOBILE_RELEASE_REPOSITORY;
  const release = await fetchLatestGitHubRelease(repository, options?.signal);
  if (!release) return null;
  return parseMobileUpdateInfo(release, currentVersion);
}

export async function downloadAndInstallMobileUpdate(
  updateInfo: MobileAppUpdateInfo,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal?.aborted) return;

  if (Platform.OS === "android") {
    if (!updateInfo.downloadUrl) {
      throw new Error("No APK download URL found in release.");
    }

    const { Directory, File, Paths } = await import("expo-file-system");
    const { requireNativeModule } = await import("expo");

    const cache = new Directory(Paths.cache, "apk-updates");
    cache.create({ idempotent: true, intermediates: true });

    const fileName = `T3-Code-${updateInfo.latestVersion}-android-arm64.apk`;
    const targetFile = new File(cache, fileName);

    // If already downloaded and size matches, install directly
    const needsDownload =
      !targetFile.exists || (updateInfo.apkSize !== null && targetFile.size !== updateInfo.apkSize);

    if (needsDownload) {
      if (options.signal?.aborted) return;
      await File.downloadFileAsync(updateInfo.downloadUrl, targetFile, {
        signal: options.signal,
      });
    }

    if (options.signal?.aborted) return;

    const nativeControls = requireNativeModule<{
      installApk?: (uri: string) => Promise<void>;
      openFile?: (uri: string, mimeType: string) => Promise<void>;
    }>("T3NativeControls");

    if (typeof nativeControls.installApk === "function") {
      await nativeControls.installApk(targetFile.uri);
    } else if (typeof nativeControls.openFile === "function") {
      await nativeControls.openFile(targetFile.uri, "application/vnd.android.package-archive");
    }
  } else {
    // For iOS / other platforms, open the release page in browser
    const { Linking } = await import("react-native");
    if (updateInfo.htmlUrl) {
      await Linking.openURL(updateInfo.htmlUrl);
    }
  }
}
