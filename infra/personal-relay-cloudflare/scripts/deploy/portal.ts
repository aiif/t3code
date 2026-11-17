// @effect-diagnostics nodeBuiltinImport:off -- The deploy CLI runs outside the Effect runtime.
import type { CommandOutput, CommandSpec } from "./process.ts";
import { runCommand } from "./process.ts";

export const PORTAL_BUILD_ENV = {
  VITE_PERSONAL_ADMIN_CONSOLE: "1",
  VITE_T3CODE_PERSONAL_ONLY: "1",
  VITE_HOSTED_APP_URL: "",
  VITE_HOSTED_APP_CHANNEL: "",
  // Source maps would ship the app's source and push the npm tarball past its target.
  T3CODE_WEB_SOURCEMAP: "0",
} as const;

/**
 * The portal must work at any deployed origin, so the admin flag replaces a
 * baked hosted URL. Both entry points build the same web app.
 */
export function repoPortalBuildCommand(repoRoot: string): CommandSpec {
  return {
    command: process.execPath,
    args: [`${repoRoot}/node_modules/vite-plus/bin/vp`, "run", "--filter", "@t3tools/web", "build"],
    cwd: repoRoot,
    env: PORTAL_BUILD_ENV,
  };
}

export async function buildRepoPortal(input: {
  readonly repoRoot: string;
  readonly output: CommandOutput;
}): Promise<void> {
  await runCommand(repoPortalBuildCommand(input.repoRoot), input.output);
}
