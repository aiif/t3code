import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { restoreAdminHost } from "@t3tools/client-runtime/personal/portal";

import { render } from "../../../test/render";
import { PersonalModeGate } from "./PersonalModeGate";

vi.mock("@t3tools/client-runtime/personal/portal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/personal/portal")>();
  return {
    ...actual,
    listAdminHosts: vi.fn(async () => [
      {
        hostId: "abcdef123456",
        environmentId: "env-home",
        label: "Home PC",
        platform: "win32",
        online: true,
        paused: false,
        lastSeenAt: "2026-11-16T00:00:00.000Z",
        publicUrl: "https://abcdef123456.t3.example.test",
        hostKey: "host-key-for-tests-0123456789abcdef",
        clientsCount: 0,
        createdAt: "2026-11-15T00:00:00.000Z",
        revokedAt: null,
      },
      {
        hostId: "fedcba654321",
        environmentId: "env-old",
        label: "Old PC",
        platform: "win32",
        online: false,
        paused: false,
        lastSeenAt: "2026-11-16T00:00:00.000Z",
        publicUrl: "https://fedcba654321.t3.example.test",
        hostKey: "host-key-for-tests-fedcba654321",
        clientsCount: 0,
        createdAt: "2026-11-14T00:00:00.000Z",
        revokedAt: "2026-11-16T12:00:00.000Z",
      },
    ]),
    getAdminHost: vi.fn(),
    rotateAdminHostKey: vi.fn(),
    removeAdminHost: vi.fn(),
    restoreAdminHost: vi.fn(async () => undefined),
  };
});

it("asks for the admin key before rendering the app", async () => {
  localStorage.clear();
  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );
  await expect.element(page.getByLabelText("Admin key")).toBeVisible();
  expect(document.body.textContent).not.toContain("app content");
});

it("lists hosts and reveals their host keys without pairing as a guest", async () => {
  localStorage.setItem("t3.admin.key", "admin-key-for-tests-0123456789abcdef");
  localStorage.setItem("t3.admin.relay", "https://t3.example.test");
  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );
  await expect.element(page.getByText("Home PC")).toBeVisible();
  await expect.element(page.getByText("Online")).toBeVisible();
  expect(document.body.textContent).not.toContain("app content");
  expect(document.body.textContent).toContain("••••••••••••••••");
});

it("lists removed hosts and restores them", async () => {
  localStorage.setItem("t3.admin.key", "admin-key-for-tests-0123456789abcdef");
  localStorage.setItem("t3.admin.relay", "https://t3.example.test");
  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );
  await expect.element(page.getByText("Removed hosts")).toBeVisible();
  await expect.element(page.getByText("Old PC")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await vi.waitFor(() =>
    expect(vi.mocked(restoreAdminHost)).toHaveBeenCalledWith({
      config: {
        relayUrl: "https://t3.example.test",
        adminKey: "admin-key-for-tests-0123456789abcdef",
      },
      hostId: "fedcba654321",
    }),
  );
});
