import { describe, expect, it } from "vite-plus/test";

import {
  TOKEN_RATE_WINDOW_MS,
  deriveOutputTokensPerSecond,
  formatTokensPerSecond,
  pushTokenRateSample,
  tokenUsageSample,
  type TokenRateWindow,
} from "./tokenRate.ts";

const T0 = Date.parse("2026-11-20T10:00:00.000Z");

function pushAll(
  key: string,
  samples: ReadonlyArray<{ outputTokens: number; at: number }>,
): TokenRateWindow {
  let window: TokenRateWindow | null = null;
  for (const sample of samples) {
    window = pushTokenRateSample(window, key, {
      outputTokens: sample.outputTokens,
      updatedAtMs: sample.at,
    });
  }
  return window!;
}

describe("tokenUsageSample", () => {
  it("reads the cumulative output count and timestamp", () => {
    expect(tokenUsageSample({ outputTokens: 120, updatedAt: "2026-11-20T10:00:00.000Z" })).toEqual({
      outputTokens: 120,
      updatedAtMs: T0,
    });
  });

  it("drops snapshots without output tokens or a parseable timestamp", () => {
    expect(tokenUsageSample({ updatedAt: "2026-11-20T10:00:00.000Z" })).toBeNull();
    expect(tokenUsageSample({ outputTokens: 10, updatedAt: "not-a-date" })).toBeNull();
  });
});

describe("pushTokenRateSample", () => {
  it("keeps only samples inside the rolling window", () => {
    const window = pushAll("turn", [
      { outputTokens: 0, at: T0 },
      { outputTokens: 50, at: T0 + 3_000 },
      { outputTokens: 100, at: T0 + 10_000 },
    ]);
    expect(window.samples.map((sample) => sample.outputTokens)).toEqual([50, 100]);
  });

  it("starts over when the key changes", () => {
    let window: TokenRateWindow | null = pushAll("turn-a", [{ outputTokens: 500, at: T0 }]);
    window = pushTokenRateSample(window, "turn-b", { outputTokens: 10, updatedAtMs: T0 + 500 });
    expect(window.key).toBe("turn-b");
    expect(window.samples.map((sample) => sample.outputTokens)).toEqual([10]);
  });

  it("ignores replayed or older snapshots", () => {
    let window: TokenRateWindow | null = pushAll("turn", [
      { outputTokens: 20, at: T0 },
      { outputTokens: 40, at: T0 + 1_000 },
    ]);
    const unchanged = pushTokenRateSample(window, "turn", {
      outputTokens: 40,
      updatedAtMs: T0 + 1_000,
    });
    expect(unchanged).toBe(window);
    const older = pushTokenRateSample(window, "turn", { outputTokens: 99, updatedAtMs: T0 });
    expect(older).toBe(window);
  });
});

describe("deriveOutputTokensPerSecond", () => {
  it("divides the token delta by the sample span", () => {
    const window = pushAll("turn", [
      { outputTokens: 100, at: T0 },
      { outputTokens: 150, at: T0 + 2_000 },
      { outputTokens: 220, at: T0 + 4_000 },
    ]);
    expect(deriveOutputTokensPerSecond(window, T0 + 4_000)).toBe(30);
  });

  it("returns null for a single sample", () => {
    const window = pushAll("turn", [{ outputTokens: 10, at: T0 }]);
    expect(deriveOutputTokensPerSecond(window, T0)).toBeNull();
  });

  it("returns null while the span is under the noise floor", () => {
    const window = pushAll("turn", [
      { outputTokens: 10, at: T0 },
      { outputTokens: 40, at: T0 + 900 },
    ]);
    expect(deriveOutputTokensPerSecond(window, T0 + 900)).toBeNull();
  });

  it("returns null once the newest sample is stale", () => {
    const window = pushAll("turn", [
      { outputTokens: 10, at: T0 },
      { outputTokens: 100, at: T0 + 2_000 },
    ]);
    expect(deriveOutputTokensPerSecond(window, T0 + 2_000 + TOKEN_RATE_WINDOW_MS + 1)).toBeNull();
  });

  it("returns null when counts went backwards", () => {
    const window = pushAll("turn", [
      { outputTokens: 200, at: T0 },
      { outputTokens: 100, at: T0 + 2_000 },
    ]);
    expect(deriveOutputTokensPerSecond(window, T0 + 2_000)).toBeNull();
  });
});

describe("formatTokensPerSecond", () => {
  it("keeps one decimal below a hundred and rounds above it", () => {
    expect(formatTokensPerSecond(23.456)).toBe("23.5 tok/s");
    expect(formatTokensPerSecond(123.6)).toBe("124 tok/s");
  });
});
