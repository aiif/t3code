import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable } from "react-native";

import * as Dialog from "../components/ui/Dialog";
import { SymbolView } from "../components/ui/AppSymbol";
import { useDeadlinePassed } from "../lib/clock";
import { tryCopyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

const COPY_FEEDBACK_DURATION_MS = 1_200;

/** The code block header's copy icon, with the same check state the web block shows. */
export function CodeBlockCopyButton(props: {
  readonly code: string;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const gt = useGT();
  const [copiedAtMs, setCopiedAtMs] = useState<number | null>(null);
  const feedbackEnded = useDeadlinePassed(
    copiedAtMs === null ? null : copiedAtMs + COPY_FEEDBACK_DURATION_MS,
  );
  const copied = copiedAtMs !== null && !feedbackEnded;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? gt("Copied") : gt("Copy code")}
      hitSlop={10}
      onPress={async () => {
        if (await tryCopyTextWithHaptic(props.code)) {
          setCopiedAtMs(Date.now());
          return;
        }
        Dialog.alert(gt("Could not copy"), gt("Try again."));
      }}
    >
      <SymbolView
        name={
          copied
            ? { ios: "checkmark", android: "check" }
            : { ios: "doc.on.doc", android: "content_copy" }
        }
        size={14}
        tintColor={
          copied ? props.textStyle.codeColor : themeColorWithAlpha(props.textStyle.codeColor, 0.6)
        }
        type="monochrome"
      />
    </Pressable>
  );
}
