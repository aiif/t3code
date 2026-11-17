import type { DeployDependencies } from "./types.ts";

/** Lane D owns the implementation; this keeps the wrappers runnable meanwhile. */
export async function runDeployCli(
  _argv: ReadonlyArray<string>,
  _dependencies: DeployDependencies,
): Promise<number> {
  throw new Error("The Cloudflare relay deploy CLI is not implemented yet.");
}
