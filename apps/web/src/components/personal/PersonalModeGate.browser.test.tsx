import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import {
  detectAndConnectPersonalKey,
  restoreAdminHost,
  type DetectedPersonalKeyOutcome,
} from "@t3tools/client-runtime/personal/portal";

import { render } from "../../../test/render";
import { openPersonalAdminConsole, PersonalModeGate } from "./PersonalModeGate";

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
    detectAndConnectPersonalKey: vi.fn(),
  };
});

it("asks for the key before rendering the app", async () => {
  localStorage.clear();
  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );
  await expect.element(page.getByLabelText("Key")).toBeVisible();
  expect(document.body.textContent).not.toContain("app content");
});

it("lists hosts and reveals their host keys without pairing as a guest", async () => {
  localStorage.clear();
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
  await expect.element(page.getByText("https://t3.example.test")).toBeVisible();
  expect(document.body.textContent).not.toContain("app content");
  expect(document.body.textContent).toContain("••••••••••••••••");
});

it("lists removed hosts and restores them", async () => {
  localStorage.clear();
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

it("forgets the saved relay and asks for credentials again", async () => {
  localStorage.clear();
  localStorage.setItem("t3.admin.key", "admin-key-for-tests-0123456789abcdef");
  localStorage.setItem("t3.admin.relay", "https://t3.example.test");
  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );
  await page.getByRole("button", { name: "Forget relay" }).click();
  await expect.element(page.getByLabelText("Key")).toBeVisible();
  expect(localStorage.getItem("t3.admin.key")).toBeNull();
  expect(localStorage.getItem("t3.admin.relay")).toBeNull();
});

it("renders workspace directly when personal hosts exist", async () => {
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
  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );
  expect(document.body.textContent).toContain("app content");
});

it("allows opening admin console from workspace and switching back", async () => {
  localStorage.clear();
  localStorage.setItem("t3.admin.key", "admin-key-for-tests-0123456789abcdef");
  localStorage.setItem("t3.admin.relay", "https://t3.example.test");
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
  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );
  expect(document.body.textContent).toContain("app content");

  openPersonalAdminConsole();
  await expect.element(page.getByText("Personal network admin")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Go to workspace" })).toBeVisible();

  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(document.body.textContent).toContain("app content");
});

it("submits key and connects as host", async () => {
  localStorage.clear();
  vi.mocked(detectAndConnectPersonalKey).mockImplementationOnce(async () => {
    localStorage.setItem(
      "t3.personal.hosts",
      JSON.stringify([
        {
          relayUrl: "https://t3.example.test",
          hostKey: "test-host-key",
          hostId: "h1",
          environmentId: "env-1",
          label: "My Host",
          publicUrl: "https://h1.example.test",
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
        hostId: "h1",
        environmentId: "env-1",
        label: "My Host",
        publicUrl: "https://h1.example.test",
        online: true,
        paused: false,
      },
      record: {
        relayUrl: "https://t3.example.test",
        hostKey: "test-host-key",
        hostId: "h1",
        environmentId: "env-1",
        label: "My Host",
        publicUrl: "https://h1.example.test",
        online: true,
        paused: false,
        lastError: null,
        updatedAt: "2026-11-20T00:00:00.000Z",
      },
    } as DetectedPersonalKeyOutcome;
  });

  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );

  await page.getByLabelText("Key").fill("test-host-key");
  await page.getByRole("button", { name: "Connect" }).click();

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("app content");
  });
});

it("shows error when key detection fails", async () => {
  localStorage.clear();
  vi.mocked(detectAndConnectPersonalKey).mockRejectedValueOnce(
    new Error("Key was rejected by the relay"),
  );

  await using _screen = await render(
    <PersonalModeGate hosted>
      <div>app content</div>
    </PersonalModeGate>,
    { router: false },
  );

  await page.getByLabelText("Key").fill("bad-key");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect.element(page.getByText("Key was rejected by the relay")).toBeVisible();
  expect(document.body.textContent).not.toContain("app content");
});
