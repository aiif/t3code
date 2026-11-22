import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { type ClipboardTarget, writeTextToClipboard } from "~/hooks/useCopyToClipboard";

import { toastManager } from "./toast";

const COPY_TOAST_TIMEOUT_MS = 1400;

export function showCopiedToast(title: string = m(msg("Copied"))): void {
  toastManager.add({
    type: "success",
    title,
    timeout: COPY_TOAST_TIMEOUT_MS,
  });
}

function showCopyFailedToast(
  error: unknown,
  failureTitle: string = m(msg("Failed to copy")),
): void {
  toastManager.add({
    type: "error",
    title: failureTitle,
    description: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Copy from a menu, command palette, or shortcut where the control disappears before a local
 * confirmation can be seen. Persistent buttons use {@link CopyButton} instead.
 */
export async function copyWithFeedback(
  value: string,
  options: {
    readonly target?: ClipboardTarget;
    readonly extraFlavors?: Readonly<Record<string, string>>;
    readonly requireHtml?: boolean;
    readonly successTitle?: string;
    readonly failureTitle?: string;
    readonly onError?: (error: Error) => void;
  } = {},
): Promise<boolean> {
  try {
    const didCopy = await writeTextToClipboard(
      value,
      options.target,
      options.extraFlavors,
      options.requireHtml ? { requireHtml: true } : undefined,
    );
    if (!didCopy) return false;
    showCopiedToast(options.successTitle);
    return true;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    options.onError?.(error);
    showCopyFailedToast(error, options.failureTitle);
    return false;
  }
}
