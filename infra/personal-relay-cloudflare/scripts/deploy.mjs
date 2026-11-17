#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { runDeployCli } from "./deploy/cli.ts";
import { buildRepoPortal } from "./deploy/portal.ts";
import { createWranglerRunner } from "./deploy/wrangler.ts";

const packageRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.resolve(packageRoot, "../..");
const packageJson = JSON.parse(
  await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
);

const code = await runDeployCli(process.argv.slice(2), {
  wrangler: createWranglerRunner(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  layout: {
    root: packageRoot,
    workerScript: NodePath.join(packageRoot, "src", "worker.ts"),
    configTemplatePath: NodePath.join(packageRoot, "wrangler.jsonc"),
    generatedConfigPath: () => NodePath.join(packageRoot, "wrangler.generated.jsonc"),
    portalDirectory: NodePath.join(repoRoot, "apps", "web", "dist"),
    defaultSecretsFile: () => NodePath.join(packageRoot, ".wrangler", "relay-secrets.json"),
    buildPortal: (output) => buildRepoPortal({ repoRoot, output }),
    packageVersion: packageJson.version,
  },
});
process.exitCode = code;
