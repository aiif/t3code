import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import { formatContextWindowTokens } from "../../lib/contextWindow";

export type GaugeSnapshot = Pick<
  ContextWindowSnapshot,
  "usedTokens" | "maxTokens" | "usedPercentage"
>;

export const CONTEXT_GAUGE_RADIUS = 5.75;
export const CONTEXT_GAUGE_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_GAUGE_RADIUS;

/** The label the gauge shows for a snapshot: the share of the window, or the used tokens alone. */
export function composerContextGaugeValue(usage: GaugeSnapshot): string | null {
  if (usage.usedPercentage !== null) {
    return `${Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))}%`;
  }
  if (usage.usedTokens > 0) return formatContextWindowTokens(usage.usedTokens);
  return null;
}

export function composerContextGaugeFill(usage: GaugeSnapshot): number | null {
  return usage.usedPercentage === null
    ? null
    : Math.round(Math.max(0, Math.min(100, usage.usedPercentage)));
}

/** Dash offset for the circular progress arc: 0 is completely filled, circumference is empty. */
export function deriveContextGaugeDashOffset(fill: number | null): number {
  if (fill === null || fill <= 0) return CONTEXT_GAUGE_CIRCUMFERENCE;
  const clamped = Math.max(0, Math.min(100, fill));
  return CONTEXT_GAUGE_CIRCUMFERENCE * (1 - clamped / 100);
}

/**
 * Computes radial line endpoints for a tick mark at the threshold percentage on the circular gauge.
 * Angles start at 12 o'clock (-90 deg) and proceed clockwise.
 */
export function deriveThresholdTickCoordinates(
  tick: number | null,
  center = 8,
  rInner = 4.2,
  rOuter = 7.3,
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (tick === null || tick <= 0 || tick >= 100) return null;
  const rad = (((tick / 100) * 360 - 90) * Math.PI) / 180;
  return {
    x1: Math.round((center + rInner * Math.cos(rad)) * 100) / 100,
    y1: Math.round((center + rInner * Math.sin(rad)) * 100) / 100,
    x2: Math.round((center + rOuter * Math.cos(rad)) * 100) / 100,
    y2: Math.round((center + rOuter * Math.sin(rad)) * 100) / 100,
  };
}
