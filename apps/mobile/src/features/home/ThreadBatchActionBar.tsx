import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

export interface ThreadBatchActionBarProps {
  readonly bottomInset: number;
  readonly selectedCount: number;
  readonly canSettleCount: number;
  readonly allSelected: boolean;
  readonly onSelectAll: () => void;
  readonly onDeselectAll: () => void;
  readonly onSettle: () => void;
  readonly onDelete: () => void;
  readonly onExit: () => void;
}

export function ThreadBatchActionBar(props: ThreadBatchActionBarProps) {
  const {
    bottomInset,
    selectedCount,
    canSettleCount,
    allSelected,
    onSelectAll,
    onDeselectAll,
    onSettle,
    onDelete,
    onExit,
  } = props;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 16,
        right: 16,
        bottom: Math.max(bottomInset, 12) + 12,
        zIndex: 50,
      }}
    >
      <View className="rounded-2xl border border-border bg-popover/95 p-3 shadow-lg">
        {/* Top row: Status & Select All / Cancel */}
        <View className="mb-2 flex-row items-center justify-between border-b border-border/50 pb-2">
          <View className="flex-row items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Exit selection"
              className="-ml-1 rounded-full p-1 active:opacity-60"
              onPress={onExit}
            >
              <SymbolView name="xmark" size={16} tintColorClassName="accent-muted-foreground" />
            </Pressable>
            <Text className="text-sm font-t3-bold text-foreground">
              {selectedCount === 0 ? "Select threads" : `${selectedCount} selected`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={allSelected ? "Deselect all" : "Select all"}
            onPress={allSelected ? onDeselectAll : onSelectAll}
            className="rounded px-2 py-1 active:opacity-60"
          >
            <Text className="text-xs font-t3-medium text-primary">
              {allSelected ? "Deselect all" : "Select all"}
            </Text>
          </Pressable>
        </View>

        {/* Bottom row: Action Buttons */}
        <View className="flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Settle ${canSettleCount} threads`}
            disabled={canSettleCount === 0}
            onPress={onSettle}
            className={cn(
              "h-10 flex-1 flex-row items-center justify-center gap-1.5 rounded-xl bg-primary px-3 active:opacity-80",
              canSettleCount === 0 && "opacity-40",
            )}
          >
            <SymbolView name="checkmark" size={14} tintColorClassName="accent-primary-foreground" />
            <Text className="text-sm font-t3-medium text-primary-foreground">
              Settle {canSettleCount > 0 ? `(${canSettleCount})` : ""}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${selectedCount} threads`}
            disabled={selectedCount === 0}
            onPress={onDelete}
            className={cn(
              "h-10 flex-1 flex-row items-center justify-center gap-1.5 rounded-xl bg-danger px-3 active:opacity-80",
              selectedCount === 0 && "opacity-40",
            )}
          >
            <SymbolView name="trash" size={14} tintColorClassName="accent-danger-foreground" />
            <Text className="text-sm font-t3-medium text-danger-foreground">
              Delete {selectedCount > 0 ? `(${selectedCount})` : ""}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
