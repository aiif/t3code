import type { RefObject } from "react";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { anchoredToastManager, toastManager } from "./toast";

export const ANCHORED_COPY_TOAST_TIMEOUT_MS = 1600;

export function showAnchoredCopyErrorToast(ref: RefObject<HTMLButtonElement | null>, error: Error) {
  if (!ref.current) {
    toastManager.add({
      type: "error",
      title: m(msg("Failed to copy")),
      description: error.message,
    });
    return;
  }
  anchoredToastManager.add({
    type: "error",
    positionerProps: {
      anchor: ref.current,
    },
    title: m(msg("Failed to copy")),
    description: error.message,
  });
}
