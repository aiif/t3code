import { CheckIcon, Trash2Icon, XIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";

export interface SidebarBatchActionBarProps {
  readonly selectedCount: number;
  readonly canSettleCount: number;
  readonly allSelected: boolean;
  readonly onSelectAll: () => void;
  readonly onDeselectAll: () => void;
  readonly onSettle: () => void;
  readonly onDelete: () => void;
  readonly onExit: () => void;
}

export const SidebarBatchActionBar = memo(function SidebarBatchActionBar({
  selectedCount,
  canSettleCount,
  allSelected,
  onSelectAll,
  onDeselectAll,
  onSettle,
  onDelete,
  onExit,
}: SidebarBatchActionBarProps) {
  return (
    <div
      aria-label="Batch thread actions"
      className="shrink-0 border-t border-sidebar-border/70 bg-sidebar/95 p-2 backdrop-blur"
      role="region"
    >
      <div className="space-y-2 rounded-lg border border-border/70 bg-card p-2.5 shadow-sm">
        {/* Status & Select All / Deselect All / Cancel */}
        <div className="flex items-center justify-between text-xs">
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              aria-label="Exit selection"
              size="icon-micro"
              type="button"
              variant="ghost-muted"
              onClick={onExit}
            >
              <XIcon className="size-3" />
            </Button>
            <span className="truncate font-medium text-foreground">
              {selectedCount === 0 ? "Select threads" : `${selectedCount} selected`}
            </span>
          </div>
          <button
            className="ml-2 shrink-0 cursor-pointer text-xs font-medium text-primary hover:underline"
            type="button"
            onClick={allSelected ? onDeselectAll : onSelectAll}
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5">
          <Button
            className="flex-1"
            disabled={canSettleCount === 0}
            size="xs"
            type="button"
            onClick={onSettle}
          >
            <CheckIcon className="mr-1 size-3" />
            Settle {canSettleCount > 0 ? `(${canSettleCount})` : ""}
          </Button>
          <Button
            className="flex-1"
            disabled={selectedCount === 0}
            size="xs"
            type="button"
            variant="destructive"
            onClick={onDelete}
          >
            <Trash2Icon className="mr-1 size-3" />
            Delete {selectedCount > 0 ? `(${selectedCount})` : ""}
          </Button>
        </div>
      </div>
    </div>
  );
});
