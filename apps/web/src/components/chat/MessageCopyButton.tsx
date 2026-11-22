import { useGT } from "gt-react";
import { memo } from "react";
import type { LucideIcon } from "lucide-react";

import type { ButtonSize, ButtonVariant } from "../ui/button";
import { CopyButton } from "../ui/copy-button";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label: labelProp,
  icon,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  label?: string;
  icon?: LucideIcon;
  extraFlavors?: Readonly<Record<string, string>>;
  size?: Extract<ButtonSize, "xs" | "icon-xs">;
  variant?: Extract<ButtonVariant, "outline" | "ghost">;
  className?: string;
}) {
  const gt = useGT();
  const label = labelProp ?? gt("Copy message");

  return (
    <CopyButton
      value={text}
      label={label}
      {...(icon ? { icon } : {})}
      {...(extraFlavors ? { extraFlavors } : {})}
      size={size}
      variant={variant === "ghost" ? "ghost-muted" : variant}
      {...(className ? { className } : {})}
      iconClassName="size-3"
    />
  );
});
