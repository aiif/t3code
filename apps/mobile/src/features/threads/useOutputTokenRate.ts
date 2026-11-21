import { useState } from "react";

import type { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import {
  pushTokenRateSample,
  tokenUsageSample,
  type TokenRateWindow,
} from "@t3tools/client-runtime/state/token-rate";

type UsageSampleSource = Pick<OrchestrationV2ProviderTurnTokenUsage, "outputTokens" | "updatedAt">;

type RateState = {
  readonly usage: UsageSampleSource;
  readonly key: string;
  readonly window: TokenRateWindow | null;
} | null;

/**
 * The rolling window of streamed usage snapshots for one provider turn; the derivation is shared
 * with web through client-runtime, only the React glue lives per surface. Derived while rendering,
 * the way the repo derives state from props.
 */
export function useOutputTokenRate(
  usage: UsageSampleSource | null,
  key: string | null,
): TokenRateWindow | null {
  const [state, setState] = useState<RateState>(null);
  if (usage == null || key === null) {
    if (state !== null) setState(null);
    return null;
  }
  if (state === null || state.usage !== usage || state.key !== key) {
    const sample = tokenUsageSample(usage);
    const window =
      sample === null
        ? state?.key === key
          ? state.window
          : null
        : pushTokenRateSample(state?.key === key ? state.window : null, key, sample);
    setState({ usage, key, window });
    return window;
  }
  return state.window;
}
