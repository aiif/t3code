import { T, useGT } from "gt-react";

import { APP_VERSION } from "../../branding";
import { CopyInlineButton } from "../ui/copy-button";

export function AboutVersionTitle() {
  const gt = useGT();

  return (
    <span className="inline-flex items-baseline gap-2">
      <span>
        <T>Version</T>
      </span>
      <code className="text-2xs font-medium">
        <CopyInlineButton
          value={APP_VERSION}
          label={gt("Copy version {version}", { version: APP_VERSION })}
          tooltipLabel={gt("Copy version {version}", { version: APP_VERSION })}
          showTooltip
          tone="muted"
        >
          {APP_VERSION}
        </CopyInlineButton>
      </code>
    </span>
  );
}
