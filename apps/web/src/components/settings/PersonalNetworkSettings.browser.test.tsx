import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import {
  detectAndConnectPersonalKey,
  type DetectedPersonalKeyOutcome,
} from "@t3tools/client-runtime/personal/portal";

import { render } from "../../../test/render";
import { PersonalNetworkSettings } from "./PersonalNetworkSettings";

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: vi.fn(() => null),
}));

vi.mock(import("@t3tools/client-runtime/personal/portal"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    detectAndConnectPersonalKey: vi.fn(),
  };
});

it("renders guest settings when there is no primary environment", async () => {
  localStorage.clear();
  localStorage.setItem(
    "t3.personal.hosts",
    JSON.stringify([
      {
        relayUrl: "https://t3.example.test",
        hostKey: "host-key-1",
        hostId: "abcdef123456",
        environmentId: "env-home",
        label: "Home PC",
        publicUrl: "https://abcdef123456.t3.example.test",
        online: true,
        paused: false,
        lastError: null,
        updatedAt: "2026-11-20T00:00:00.000Z",
      },
    ]),
  );

  await using _screen = await render(<PersonalNetworkSettings />, { router: false });

  await expect.element(page.getByText("Home PC")).toBeVisible();
  await expect.element(page.getByText("Saved computers")).toBeVisible();
  await expect.element(page.getByText("Add a computer")).toBeVisible();
});

it("shows Open admin console button when admin config is saved", async () => {
  localStorage.clear();
  localStorage.setItem("t3.admin.key", "admin-key-test");
  localStorage.setItem("t3.admin.relay", "https://t3.example.test");

  await using _screen = await render(<PersonalNetworkSettings />, { router: false });

  await expect.element(page.getByRole("button", { name: "Open admin console" })).toBeVisible();
});

it("submits key via detectAndConnectPersonalKey and adds computer", async () => {
  localStorage.clear();
  vi.mocked(detectAndConnectPersonalKey).mockImplementationOnce(async () => {
    localStorage.setItem(
      "t3.personal.hosts",
      JSON.stringify([
        {
          relayUrl: "https://t3.example.test",
          hostKey: "host-key-new",
          hostId: "h-new",
          environmentId: "env-new",
          label: "New Machine",
          publicUrl: "https://new.example.test",
          online: true,
          paused: false,
          lastError: null,
          updatedAt: "2026-11-20T00:00:00.000Z",
        },
      ]),
    );
    return {
      kind: "host",
      host: {
        hostId: "h-new",
        environmentId: "env-new",
        label: "New Machine",
        publicUrl: "https://new.example.test",
        online: true,
        paused: false,
      },
      record: {
        relayUrl: "https://t3.example.test",
        hostKey: "host-key-new",
        hostId: "h-new",
        environmentId: "env-new",
        label: "New Machine",
        publicUrl: "https://new.example.test",
        online: true,
        paused: false,
        lastError: null,
        updatedAt: "2026-11-20T00:00:00.000Z",
      },
    } as DetectedPersonalKeyOutcome;
  });

  await using _screen = await render(<PersonalNetworkSettings />, { router: false });

  await page.getByLabelText("Key").fill("host-key-new");
  await page.getByRole("button", { name: "Add" }).click();

  await expect.element(page.getByText("Connected to New Machine.")).toBeVisible();
  await expect.element(page.getByText("New Machine")).toBeVisible();
});
