import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import { composerContextGaugeFill, composerContextGaugeValue } from "./ComposerContextGauge.logic";

function snapshot(
  usedTokens: number,
  maxTokens: number | null,
): Pick<ContextWindowSnapshot, "usedTokens" | "maxTokens" | "usedPercentage"> {
  const usedPercentage =
    maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
  return { usedTokens, maxTokens, usedPercentage };
}

describe("composerContextGaugeValue", () => {
  it("rounds the window share", () => {
    expect(composerContextGaugeValue(snapshot(84_000, 200_000))).toBe("42%");
    expect(composerContextGaugeValue(snapshot(199_000, 200_000))).toBe("100%");
  });

  it("falls back to the used token count without a window size", () => {
    expect(composerContextGaugeValue(snapshot(84_000, null))).toBe("84k");
  });

  it("hides an empty report", () => {
    expect(composerContextGaugeValue(snapshot(0, null))).toBeNull();
    expect(composerContextGaugeValue(snapshot(0, 200_000))).toBe("0%");
  });
});

describe("composerContextGaugeFill", () => {
  it("follows the percentage and nulls without a denominator", () => {
    expect(composerContextGaugeFill(snapshot(84_000, 200_000))).toBe(42);
    expect(composerContextGaugeFill(snapshot(84_000, null))).toBeNull();
  });
});
