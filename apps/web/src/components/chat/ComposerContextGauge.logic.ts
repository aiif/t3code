import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import { formatContextWindowTokens } from "../../lib/contextWindow";

export type GaugeSnapshot = Pick<
  ContextWindowSnapshot,
  "usedTokens" | "maxTokens" | "usedPercentage"
>;

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
