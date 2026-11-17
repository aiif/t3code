// @effect-diagnostics nodeBuiltinImport:off -- The installed CLI runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { runDeployCli } from "./cli.ts";
import { createWranglerRunner } from "./wrangler.ts";

export interface InstalledCliOptions {
  readonly root?: string;
  readonly version?: string;
}

async function readVersion(packageRoot: string): Promise<string> {
  try {
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
    ) as { readonly version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Entry compiled into the published t3cf package; the layout is fully bundled. */
export async function runInstalledCli(
  argv: ReadonlyArray<string>,
  options: InstalledCliOptions = {},
): Promise<number> {
  const packageRoot =
    options.root ?? NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
  const stateDirectory = NodePath.join(NodeOS.homedir(), ".t3", "personal-relay");
  const version = options.version ?? (await readVersion(packageRoot));

  return runDeployCli(argv, {
    wrangler: createWranglerRunner(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    layout: {
      root: packageRoot,
      workerScript: NodePath.join(packageRoot, "dist", "worker", "worker.js"),
      configTemplatePath: NodePath.join(packageRoot, "templates", "wrangler.jsonc"),
      generatedConfigPath: (workerName) =>
        NodePath.join(stateDirectory, `${workerName}.wrangler.jsonc`),
      portalDirectory: NodePath.join(packageRoot, "dist", "portal"),
      defaultSecretsFile: (workerName) => NodePath.join(stateDirectory, `${workerName}.json`),
      buildPortal: null,
      packageVersion: version,
    },
  });
}
