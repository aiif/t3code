// @effect-diagnostics nodeBuiltinImport:off -- The installed CLI runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { runDeployCli } from "./cli.ts";
import type { DeployLayout } from "./types.ts";

export interface InstalledCliOptions {
  readonly root?: string;
  readonly version?: string;
}

function repositoryUrl(value: unknown): string {
  if (typeof value !== "string") return "https://github.com/aiif/t3code";
  return value
    .replace(/^git\+/u, "")
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

async function readManifest(packageRoot: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runInstalledCli(
  argv: ReadonlyArray<string>,
  options: InstalledCliOptions = {},
): Promise<number> {
  const packageRoot =
    options.root ?? NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
  const manifest = await readManifest(packageRoot);
  const version =
    options.version ?? (typeof manifest["version"] === "string" ? manifest["version"] : "0.0.0");
  const packageName = typeof manifest["name"] === "string" ? manifest["name"] : "@aiif/t3relay";
  const repository = manifest["repository"];
  const repositoryString =
    typeof repository === "object" && repository !== null
      ? (repository as Record<string, unknown>)["url"]
      : repository;
  const releaseUrl = `${repositoryUrl(repositoryString)}/releases/download/vps-relay-v${version}/t3relay-native-${version}.tar.gz`;
  const layout: DeployLayout = {
    packageRoot,
    packageName,
    registrySource: NodePath.join(packageRoot, "dist", "registry", "registry.mjs"),
    portalSource: NodePath.join(packageRoot, "dist", "portal"),
    nativeDirectory: NodePath.join(packageRoot, "native"),
    defaultInstallDir: "/opt/t3-relay",
    releaseUrl,
    packageVersion: version,
  };
  return runDeployCli(argv, {
    layout,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}
