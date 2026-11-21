import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      version: "0.1.9",
    },
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "android",
  },
}));

import {
  findApkAsset,
  parseMobileUpdateInfo,
  type GitHubReleaseResponse,
} from "./github-apk-updates";

describe("findApkAsset", () => {
  it("prefers android-arm64 APK over generic APK", () => {
    const assets = [
      {
        name: "T3-Code-0.1.10-x64.exe",
        browser_download_url: "https://example.com/exe",
        size: 100,
      },
      {
        name: "T3-Code-0.1.10.apk",
        browser_download_url: "https://example.com/generic.apk",
        size: 200,
      },
      {
        name: "T3-Code-0.1.10-android-arm64.apk",
        browser_download_url: "https://example.com/arm64.apk",
        size: 300,
      },
    ];
    const asset = findApkAsset(assets);
    expect(asset?.name).toBe("T3-Code-0.1.10-android-arm64.apk");
    expect(asset?.browser_download_url).toBe("https://example.com/arm64.apk");
  });

  it("falls back to generic APK if no arm64 APK is present", () => {
    const assets = [
      {
        name: "T3-Code-0.1.10-x64.exe",
        browser_download_url: "https://example.com/exe",
        size: 100,
      },
      { name: "app-release.apk", browser_download_url: "https://example.com/app.apk", size: 200 },
    ];
    const asset = findApkAsset(assets);
    expect(asset?.name).toBe("app-release.apk");
  });

  it("returns null if no APK asset is present", () => {
    const assets = [
      {
        name: "T3-Code-0.1.10-x64.exe",
        browser_download_url: "https://example.com/exe",
        size: 100,
      },
    ];
    expect(findApkAsset(assets)).toBeNull();
  });
});

describe("parseMobileUpdateInfo", () => {
  const sampleRelease: GitHubReleaseResponse = {
    tag_name: "v0.1.10",
    name: "T3 Code v0.1.10",
    body: "Bug fixes and improvements",
    html_url: "https://github.com/aiif/t3code/releases/tag/v0.1.10",
    assets: [
      {
        name: "T3-Code-0.1.10-android-arm64.apk",
        browser_download_url:
          "https://github.com/aiif/t3code/releases/download/v0.1.10/T3-Code-0.1.10-android-arm64.apk",
        size: 50_000_000,
      },
    ],
  };

  it("marks update as available when release is newer", () => {
    const info = parseMobileUpdateInfo(sampleRelease, "0.1.9");
    expect(info.isAvailable).toBe(true);
    expect(info.latestVersion).toBe("0.1.10");
    expect(info.downloadUrl).toBe(
      "https://github.com/aiif/t3code/releases/download/v0.1.10/T3-Code-0.1.10-android-arm64.apk",
    );
    expect(info.releaseNotes).toBe("Bug fixes and improvements");
  });

  it("marks update as unavailable when release is equal or older", () => {
    const same = parseMobileUpdateInfo(sampleRelease, "0.1.10");
    expect(same.isAvailable).toBe(false);

    const newer = parseMobileUpdateInfo(sampleRelease, "0.1.11");
    expect(newer.isAvailable).toBe(false);
  });
});
