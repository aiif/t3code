import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { useGT } from "gt-react";

import { CopyButton } from "./ui/copy-button";

export function DiffFilePathCopyButton({
  filePath,
  workspaceRoot,
}: {
  filePath: string;
  workspaceRoot: string | undefined;
}) {
  const gt = useGT();

  return (
    <CopyButton
      value={formatFilePathForClipboard(filePath, workspaceRoot)}
      label={gt("Copy file path")}
      size="icon-micro"
      variant="ghost-muted"
      iconClassName="size-3"
    />
  );
}
