import type { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";

/** Samples older than this behind the newest are dropped: speed is a short-term measure. */
export const TOKEN_RATE_WINDOW_MS = 8_000;
const MAX_SAMPLES = 20;
/** Below this span between the oldest and newest kept sample a rate would only be noise. */
const MIN_SPAN_MS = 1_000;

export interface TokenRateSample {
  readonly outputTokens: number;
  readonly updatedAtMs: number;
}

/** Rate tracking scoped to one provider turn; output token counts are per-turn cumulatives. */
export interface TokenRateWindow {
  readonly key: string;
  readonly samples: ReadonlyArray<TokenRateSample>;
}

export function tokenUsageSample(
  usage: Pick<OrchestrationV2ProviderTurnTokenUsage, "outputTokens" | "updatedAt">,
): TokenRateSample | null {
  const updatedAtMs = Date.parse(usage.updatedAt);
  if (usage.outputTokens === undefined || !Number.isFinite(updatedAtMs)) return null;
  return { outputTokens: usage.outputTokens, updatedAtMs };
}

export function pushTokenRateSample(
  window: TokenRateWindow | null,
  key: string,
  sample: TokenRateSample,
): TokenRateWindow {
  if (window?.key === key) {
    const last = window.samples[window.samples.length - 1];
    // Upstream can replay or repeat a snapshot; only newer ones move the rate.
    if (last !== undefined && sample.updatedAtMs <= last.updatedAtMs) return window;
  }
  const samples = window?.key === key ? window.samples : [];
  const cutoff = sample.updatedAtMs - TOKEN_RATE_WINDOW_MS;
  const bounded = [...samples.filter((entry) => entry.updatedAtMs >= cutoff), sample].slice(
    -MAX_SAMPLES,
  );
  return { key, samples: bounded };
}

/**
 * Output tokens per second over the kept window, or null when the window cannot support one:
 * too few or too-near samples, a stalled stream, or counts that went backwards.
 */
export function deriveOutputTokensPerSecond(
  window: TokenRateWindow | null,
  nowMs: number,
): number | null {
  if (window === null || window.samples.length < 2) return null;
  const newest = window.samples[window.samples.length - 1]!;
  if (nowMs - newest.updatedAtMs > TOKEN_RATE_WINDOW_MS) return null;
  const oldest = window.samples[0]!;
  const spanMs = newest.updatedAtMs - oldest.updatedAtMs;
  if (spanMs < MIN_SPAN_MS) return null;
  const delta = newest.outputTokens - oldest.outputTokens;
  if (delta <= 0) return null;
  return delta / (spanMs / 1_000);
}

export function formatTokensPerSecond(rate: number): string {
  const value = rate >= 100 ? Math.round(rate) : Math.round(rate * 10) / 10;
  return `${value} tok/s`;
}
