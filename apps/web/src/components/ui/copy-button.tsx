import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useRef, type ReactNode } from "react";

import { type ClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";

import { showAnchoredCopyErrorToast } from "./anchoredCopyToast";
import { Button, InlineButton, type ButtonSize, type ButtonVariant } from "./button";
import { CopyAnnouncement } from "./copyAnnouncement";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

export const COPY_FEEDBACK_TIMEOUT_MS = 1600;

type CopyActionProps = {
  readonly value: string;
  readonly target?: ClipboardTarget;
  readonly extraFlavors?: Readonly<Record<string, string>>;
  readonly requireHtml?: boolean;
  readonly timeout?: number;
  readonly onCopied?: () => void;
  readonly onError?: (error: Error) => void;
  readonly disabled?: boolean;
};

function useCopyAction({
  value,
  target,
  extraFlavors,
  requireHtml,
  timeout = COPY_FEEDBACK_TIMEOUT_MS,
  onCopied,
  onError,
}: CopyActionProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    timeout,
    ...(target ? { target } : {}),
    ...(extraFlavors ? { extraFlavors } : {}),
    ...(onCopied ? { onCopy: onCopied } : {}),
    onError: (error) => {
      onError?.(error);
      showAnchoredCopyErrorToast(ref, error);
    },
  });

  return {
    ref,
    isCopied,
    copy: () =>
      copyToClipboard(
        value,
        undefined,
        extraFlavors,
        requireHtml ? { requireHtml: true } : undefined,
      ),
  };
}

export function CopyButton({
  value,
  label: labelProp,
  copiedLabel: copiedLabelProp,
  icon: Icon = CopyIcon,
  copiedIcon: CopiedIcon = CheckIcon,
  iconClassName,
  copiedIconClassName = "text-success",
  size = "icon-xs",
  variant = "ghost-muted",
  className,
  tooltipSide = "top",
  showTooltip = true,
  disabled,
  ...copyProps
}: CopyActionProps & {
  readonly label?: string;
  readonly copiedLabel?: string;
  readonly icon?: LucideIcon;
  readonly copiedIcon?: LucideIcon;
  readonly iconClassName?: string;
  readonly copiedIconClassName?: string;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
  readonly className?: string;
  readonly tooltipSide?: "top" | "right" | "bottom" | "left";
  readonly showTooltip?: boolean;
}) {
  const gt = useGT();
  const label = labelProp ?? gt("Copy");
  const copiedLabel = copiedLabelProp ?? gt("Copied");
  const { ref, isCopied, copy } = useCopyAction({ value, ...copyProps });
  const currentLabel = isCopied ? copiedLabel : label;

  const button = (
    <Button
      aria-label={currentLabel}
      className={className}
      disabled={disabled}
      onClick={copy}
      ref={ref}
      size={size}
      type="button"
      variant={variant}
    >
      {isCopied ? (
        <CopiedIcon aria-hidden className={copiedIconClassName} />
      ) : (
        <Icon aria-hidden className={iconClassName} />
      )}
    </Button>
  );

  return (
    <>
      {showTooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup side={tooltipSide}>{currentLabel}</TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
      <CopyAnnouncement copied={isCopied} label={copiedLabel} />
    </>
  );
}

export function CopyLabelButton({
  value,
  label,
  copiedLabel: copiedLabelProp,
  ariaLabel,
  icon: Icon = CopyIcon,
  copiedIcon: CopiedIcon = CheckIcon,
  showIcon = true,
  iconClassName,
  copiedIconClassName = "text-success",
  size = "sm",
  variant = "outline",
  className,
  disabled,
  ...copyProps
}: CopyActionProps & {
  readonly label: string;
  readonly copiedLabel?: string;
  /** Use when the visible label alone is not the action's name, such as an identifier. */
  readonly ariaLabel?: string;
  readonly icon?: LucideIcon;
  readonly copiedIcon?: LucideIcon;
  readonly showIcon?: boolean;
  readonly iconClassName?: string;
  readonly copiedIconClassName?: string;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
  readonly className?: string;
}) {
  const gt = useGT();
  const copiedLabel = copiedLabelProp ?? gt("Copied");
  const { ref, isCopied, copy } = useCopyAction({ value, ...copyProps });
  const currentLabel = isCopied ? copiedLabel : label;

  return (
    <>
      <Button
        aria-label={isCopied ? copiedLabel : (ariaLabel ?? label)}
        className={className}
        disabled={disabled}
        onClick={copy}
        ref={ref}
        size={size}
        type="button"
        variant={variant}
      >
        {showIcon ? (
          isCopied ? (
            <CopiedIcon aria-hidden className={copiedIconClassName} />
          ) : (
            <Icon aria-hidden className={iconClassName} />
          )
        ) : null}
        <span className={cn("truncate", !showIcon && "min-w-0")}>{currentLabel}</span>
      </Button>
      <CopyAnnouncement copied={isCopied} label={copiedLabel} />
    </>
  );
}

export function CopyInlineButton({
  value,
  label,
  copiedLabel: copiedLabelProp,
  tooltipLabel,
  tone = "muted",
  touchTarget,
  className,
  children,
  disabled,
  showTooltip = false,
  tooltipSide = "bottom",
  ...copyProps
}: CopyActionProps & {
  readonly label: string;
  readonly copiedLabel?: string;
  readonly tooltipLabel?: string;
  readonly tone?: "default" | "muted" | "destructive" | "picker";
  readonly touchTarget?: "padded";
  readonly className?: string;
  readonly children?: ReactNode;
  readonly showTooltip?: boolean;
  readonly tooltipSide?: "top" | "right" | "bottom" | "left";
}) {
  const gt = useGT();
  const copiedLabel = copiedLabelProp ?? gt("Copied");
  const { ref, isCopied, copy } = useCopyAction({ value, ...copyProps });
  const currentLabel = isCopied ? copiedLabel : label;

  const button = (
    <InlineButton
      aria-label={currentLabel}
      className={className}
      disabled={disabled}
      onClick={copy}
      ref={ref}
      tone={tone}
      touchTarget={touchTarget}
      type="button"
    >
      {isCopied ? copiedLabel : (children ?? label)}
    </InlineButton>
  );

  return (
    <>
      {showTooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup side={tooltipSide}>
            {isCopied ? copiedLabel : (tooltipLabel ?? label)}
          </TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
      <CopyAnnouncement copied={isCopied} label={copiedLabel} />
    </>
  );
}
