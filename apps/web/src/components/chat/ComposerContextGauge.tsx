import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  deriveOutputTokensPerSecond,
  formatTokensPerSecond,
  type TokenRateWindow,
} from "@t3tools/client-runtime/state/token-rate";
import type { ReactNode } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { tickTextContent } from "../../lib/tickTextContent";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { composerContextGaugeFill, composerContextGaugeValue } from "./ComposerContextGauge.logic";
import type { ComposerControlSize } from "./ComposerControl";

export interface ComposerContextGaugeInput {
  readonly usage: ContextWindowSnapshot;
  readonly rateWindow: TokenRateWindow | null;
  /** Whether the thread is streaming; the rate label ticks only while it is. */
  readonly running: boolean;
  readonly size?: ComposerControlSize;
}

/** The composer's always-on context readout: window fill, and the output rate while streaming. */
export function ComposerContextGauge(props: ComposerContextGaugeInput) {
  const value = composerContextGaugeValue(props.usage);
  if (value === null) return null;
  const fill = composerContextGaugeFill(props.usage);
  const threshold = props.usage.autoCompactThreshold ?? null;
  const maxTokens = props.usage.maxTokens;
  const tick =
    fill !== null &&
    maxTokens != null &&
    threshold !== null &&
    threshold > 0 &&
    threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const tone =
    fill !== null && fill >= 90 ? "error" : fill !== null && fill >= 80 ? "warning" : null;
  const size = props.size ?? "sm";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={`Context: ${value} used`}
            className={cn(
              "flex shrink-0 cursor-default items-center gap-1.5 whitespace-nowrap text-base outline-none sm:text-sm",
              size === "xs"
                ? "h-6 px-1.75 text-muted-foreground text-xs"
                : "h-7 px-2 text-foreground/80",
              tone === "error" && "text-error-foreground",
              tone === "warning" && "text-warning-foreground",
            )}
          >
            {fill !== null ? (
              <span className="relative h-[3px] w-8 shrink-0 rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
                {fill > 0 ? (
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full",
                      tone === "error"
                        ? "bg-error"
                        : tone === "warning"
                          ? "bg-warning"
                          : "bg-foreground/70",
                    )}
                    style={{ width: `max(${fill}%, 3px)` }}
                  />
                ) : null}
                {tick !== null ? (
                  <span
                    aria-hidden
                    className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                    style={{ left: `${tick}%` }}
                  />
                ) : null}
              </span>
            ) : null}
            <span className="font-medium tabular-nums">{value}</span>
            <span
              ref={tickTextContent((nowMs) => {
                const rate = deriveOutputTokensPerSecond(props.rateWindow, nowMs);
                return rate === null ? "" : formatTokensPerSecond(rate);
              }, props.running)}
              className="text-muted-foreground tabular-nums"
            />
          </div>
        }
      />
      <TooltipPopup side="top">
        <ContextGaugeTooltip usage={props.usage} fill={fill} />
      </TooltipPopup>
    </Tooltip>
  );
}

function ContextGaugeTooltip({
  usage,
  fill,
}: {
  readonly usage: ContextWindowSnapshot;
  readonly fill: number | null;
}) {
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  const maxTokens = usage.maxTokens;
  const threshold = usage.autoCompactThreshold ?? null;
  const lines: ReactNode[] = [
    <span key="headline" className="text-foreground">
      {fill !== null ? `Context: ${fill}% used` : `Context: ${usedTokens} tokens used`}
    </span>,
  ];
  if (maxTokens != null && maxTokens > 0) {
    lines.push(
      <span key="counts" className="text-muted-foreground">
        {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")} tokens
      </span>,
    );
  }
  if (threshold !== null && threshold > 0) {
    lines.push(
      <span key="compaction" className="text-muted-foreground">
        {formatContextWindowCompactionMessage(threshold)}
      </span>,
    );
  }
  return <div className="flex flex-col gap-0.5">{lines}</div>;
}
