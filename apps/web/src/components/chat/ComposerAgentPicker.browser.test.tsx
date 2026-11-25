import "~/index.css";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  agents: [
    {
      id: "t3-tech-lead",
      name: "T3 Tech Lead",
      description: "Plans and delegates.",
      source: "builtin",
      providerInstanceId: null,
      driverKind: null,
      model: null,
      delegationEnabled: true,
      allowedAgents: ["t3-coder", "t3-reviewer"],
      maxDepth: 2,
      maxParallel: 4,
    },
    {
      id: "t3-coder",
      name: "T3 Coder",
      description: "Implements one task.",
      source: "builtin",
      providerInstanceId: null,
      driverKind: null,
      model: null,
      delegationEnabled: false,
      allowedAgents: null,
      maxDepth: 1,
      maxParallel: 2,
    },
    {
      id: "t3-reviewer",
      name: "T3 Reviewer",
      description: "Reviews read-only.",
      source: "builtin",
      providerInstanceId: null,
      driverKind: null,
      model: null,
      delegationEnabled: false,
      allowedAgents: null,
      maxDepth: 1,
      maxParallel: 2,
    },
  ],
}));

vi.mock(import("../../state/agents"), () => ({
  useAgentList: (() => ({
    data: { agents: state.agents },
    isPending: false,
    error: null,
  })) as never,
}));

import { render } from "../../../test/render";
import { ComposerAgentPicker } from "./ComposerAgentPicker";

const environmentId = EnvironmentId.make("environment");

it("separates team leads from specialists and defaults to a plain thread", async () => {
  const onSelect = vi.fn();
  await using screen = await render(
    <ComposerAgentPicker
      environmentId={environmentId}
      projectRoot={null}
      enabled
      selectedAgentId={null}
      size="sm"
      onSelect={onSelect}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Agent: Default" }));

  await expect.element(page.getByText("Team leads", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Specialists", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("menuitemradio", { name: /T3 Tech Lead/ })).toBeVisible();
  await expect
    .element(page.getByRole("menuitemradio", { name: /^T3 Coder t3-coder/ }))
    .toBeVisible();

  await userEvent.click(page.getByRole("menuitemradio", { name: /^T3 Coder t3-coder/ }));

  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "t3-coder" }));
});
