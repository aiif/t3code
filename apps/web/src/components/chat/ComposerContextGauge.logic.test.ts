import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import {
  CONTEXT_GAUGE_CIRCUMFERENCE,
  composerContextGaugeFill,
  composerContextGaugeValue,
  deriveContextGaugeDashOffset,
  deriveThresholdTickCoordinates,
} from "./ComposerContextGauge.logic";

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

describe("deriveContextGaugeDashOffset", () => {
  it("calculates stroke dash offset matching percentage", () => {
    expect(deriveContextGaugeDashOffset(0)).toBe(CONTEXT_GAUGE_CIRCUMFERENCE);
    expect(deriveContextGaugeDashOffset(null)).toBe(CONTEXT_GAUGE_CIRCUMFERENCE);
    expect(deriveContextGaugeDashOffset(50)).toBeCloseTo(CONTEXT_GAUGE_CIRCUMFERENCE * 0.5, 4);
    expect(deriveContextGaugeDashOffset(100)).toBe(0);
  });
});

describe("deriveThresholdTickCoordinates", () => {
  it("returns null when tick is outside 0-100 exclusive", () => {
    expect(deriveThresholdTickCoordinates(null)).toBeNull();
    expect(deriveThresholdTickCoordinates(0)).toBeNull();
    expect(deriveThresholdTickCoordinates(100)).toBeNull();
  });

  it("computes radial endpoints starting at 12 o'clock", () => {
    // 25% is at 3 o'clock (angle 0 rad relative to +X axis)
    const tick25 = deriveThresholdTickCoordinates(25, 8, 4, 7);
    expect(tick25).toEqual({ x1: 12, y1: 8, x2: 15, y2: 8 });

    // 50% is at 6 o'clock (angle PI/2 rad)
    const tick50 = deriveThresholdTickCoordinates(50, 8, 4, 7);
    expect(tick50).toEqual({ x1: 8, y1: 12, x2: 8, y2: 15 });
  });
});
