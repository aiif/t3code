import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { APP_VERSION } from "../../branding";
import { AnchoredToastProvider } from "../ui/toast";
import { AboutVersionTitle } from "./AboutVersionTitle";

it("copies the version and confirms inline", async () => {
  await using screen = await render(
    <AnchoredToastProvider>
      <AboutVersionTitle />
    </AnchoredToastProvider>,
  );
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

  await screen.getByRole("button", { name: `Copy version ${APP_VERSION}` }).click();

  expect(write).toHaveBeenCalledWith(APP_VERSION);
  await expect.element(screen.getByRole("button", { name: "Copied" })).toBeVisible();
});
