import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarBatchActionBar } from "./SidebarBatchActionBar";

it("renders selection count and triggers batch actions", async () => {
  const onSelectAll = vi.fn();
  const onDeselectAll = vi.fn();
  const onSettle = vi.fn();
  const onDelete = vi.fn();
  const onExit = vi.fn();

  await using screen = await render(
    <SidebarBatchActionBar
      selectedCount={2}
      canSettleCount={1}
      allSelected={false}
      onSelectAll={onSelectAll}
      onDeselectAll={onDeselectAll}
      onSettle={onSettle}
      onDelete={onDelete}
      onExit={onExit}
    />,
  );

  await expect.element(screen.getByText("2 selected")).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Settle (1)" })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Delete (2)" })).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "Select all" }));
  expect(onSelectAll).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole("button", { name: "Settle (1)" }));
  expect(onSettle).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
  expect(onDelete).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByRole("button", { name: "Exit selection" }));
  expect(onExit).toHaveBeenCalledTimes(1);
});

it("shows Deselect all when allSelected is true, and disables buttons when counts are zero", async () => {
  const onDeselectAll = vi.fn();

  await using screen = await render(
    <SidebarBatchActionBar
      selectedCount={0}
      canSettleCount={0}
      allSelected={true}
      onSelectAll={vi.fn()}
      onDeselectAll={onDeselectAll}
      onSettle={vi.fn()}
      onDelete={vi.fn()}
      onExit={vi.fn()}
    />,
  );

  await expect.element(screen.getByText("Select threads")).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Settle" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Delete" })).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Deselect all" }));
  expect(onDeselectAll).toHaveBeenCalledTimes(1);
});
