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
import {
  CONTEXT_GAUGE_CIRCUMFERENCE,
  CONTEXT_GAUGE_RADIUS,
  composerContextGaugeFill,
  composerContextGaugeValue,
  deriveContextGaugeDashOffset,
  deriveThresholdTickCoordinates,
} from "./ComposerContextGauge.logic";
import type { ComposerControlSize } from "./ComposerControl";

export interface ComposerContextGaugeInput {
  readonly usage: ContextWindowSnapshot;
  readonly rateWindow: TokenRateWindow | null;
  /** Whether the thread is streaming; the rate label ticks only while it is. */
  readonly running: boolean;
  readonly size?: ComposerControlSize;
}

/** The composer's always-on context readout: circular progress ring, and output rate while streaming. */
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
  const strokeDashoffset = deriveContextGaugeDashOffset(fill);
  const tickCoords = deriveThresholdTickCoordinates(tick);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="status"
            aria-label={`Context: ${value} used`}
            className={cn(
              "flex shrink-0 cursor-default items-center justify-center gap-1.5 whitespace-nowrap rounded-(--control-radius) border border-transparent outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              size === "xs" ? "h-6 min-w-6 px-1 text-xs" : "h-7 min-w-7 px-1.5 text-sm",
              tone === "error" && "text-error",
              tone === "warning" && "text-warning",
            )}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className={cn("shrink-0", size === "xs" ? "size-3.5" : "size-4")}
            >
              {/* Background track circle */}
              <circle
                cx="8"
                cy="8"
                r={CONTEXT_GAUGE_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                className="text-foreground/15 dark:text-foreground/20"
              />
              {/* Foreground progress arc */}
              {fill !== null && fill > 0 ? (
                <circle
                  cx="8"
                  cy="8"
                  r={CONTEXT_GAUGE_RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeDasharray={CONTEXT_GAUGE_CIRCUMFERENCE}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  className={cn(
                    "-rotate-90 origin-center transition-[stroke-dashoffset] duration-300 ease-out",
                    tone === "error"
                      ? "text-error"
                      : tone === "warning"
                        ? "text-warning"
                        : "text-foreground/75 dark:text-foreground/70",
                  )}
                />
              ) : fill === null ? (
                <circle
                  cx="8"
                  cy="8"
                  r={CONTEXT_GAUGE_RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeDasharray="2 3"
                  className="text-foreground/50"
                />
              ) : null}
              {/* Auto-compact threshold tick */}
              {tickCoords !== null ? (
                <line
                  x1={tickCoords.x1}
                  y1={tickCoords.y1}
                  x2={tickCoords.x2}
                  y2={tickCoords.y2}
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  className="text-foreground/60 dark:text-foreground/50"
                />
              ) : null}
            </svg>
            <span
              ref={tickTextContent((nowMs) => {
                const rate = deriveOutputTokensPerSecond(props.rateWindow, nowMs);
                return rate === null ? "" : formatTokensPerSecond(rate);
              }, props.running)}
              className="text-xs text-muted-foreground tabular-nums empty:hidden font-medium"
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
