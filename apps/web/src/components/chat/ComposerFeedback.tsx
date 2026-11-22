import {
  codexFeedbackNotice,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { msg } from "gt-react";
import { MessageSquareIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { CopyLabelButton } from "../ui/copy-button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function feedbackBannerItem(
  submission: CodexFeedbackSubmission,
  onDismiss: () => void,
  resolve: MessageResolver = m,
): ComposerBannerStackItem | null {
  const notice = codexFeedbackNotice(submission, resolve);
  if (!notice) return null;
  return {
    id: `feedback:${submission.id}`,
    variant:
      submission.status === "failed" ? "error" : submission.status === "sent" ? "success" : "info",
    icon: <MessageSquareIcon />,
    ...notice,
    actions:
      submission.status === "sent" ? (
        <CopyLabelButton
          value={submission.feedbackId}
          label={resolve(msg("Copy ID"))}
          showIcon={false}
          size="xs"
          variant="ghost"
          target={{
            target: "Codex feedback thread ID",
            unavailableMessage: msg(
              "Clipboard API is unavailable while copying Codex feedback thread ID.",
            ),
            failureMessage: msg("Failed to copy Codex feedback thread ID to the clipboard."),
          }}
        />
      ) : undefined,
    ...(submission.status !== "uploading"
      ? { dismissLabel: resolve(msg("Dismiss feedback notice")), onDismiss }
      : {}),
  };
}
