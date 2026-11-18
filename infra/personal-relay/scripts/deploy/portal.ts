// @effect-diagnostics nodeBuiltinImport:off -- The package build runs outside the Effect runtime.
import * as NodePath from "node:path";

import { nativeCommandRunner, runCommand } from "./process.ts";
import type { CommandOutput } from "./types.ts";

export const PORTAL_BUILD_ENV = {
  VITE_PERSONAL_ADMIN_CONSOLE: "1",
  VITE_T3CODE_PERSONAL_ONLY: "1",
  VITE_HOSTED_APP_URL: "",
  VITE_HOSTED_APP_CHANNEL: "",
  // Source maps would ship the app's source and push the tarball past its target.
  T3CODE_WEB_SOURCEMAP: "0",
} as const;

export function repoPortalBuildCommand(repoRoot: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
} {
  return {
    command: process.execPath,
    args: [
      NodePath.join(repoRoot, "node_modules", "vite-plus", "bin", "vp"),
      "run",
      "--filter",
      "@t3tools/web",
      "build",
    ],
    cwd: repoRoot,
    env: PORTAL_BUILD_ENV,
  };
}

export async function buildRepoPortal(input: {
  readonly repoRoot: string;
  readonly output: CommandOutput;
}): Promise<void> {
  const spec = repoPortalBuildCommand(input.repoRoot);
  await runCommand(nativeCommandRunner, input.output, spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
  });
}
