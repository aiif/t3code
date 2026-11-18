#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { runDeployCli } from "./deploy/cli.ts";

const packageRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.resolve(packageRoot, "../..");
const manifest = JSON.parse(
  await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
);
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
const packageName = "@aiif/t3relay";
const registrySource = NodePath.join(packageRoot, "dist", "registry", "registry.mjs");
const portalSource = NodePath.join(repoRoot, "apps", "web", "dist");

if (!NodeFS.existsSync(registrySource)) {
  process.stderr.write(
    `Missing ${registrySource}. Run \`node scripts/build-npm-package.mjs --no-portal-build --no-pack\` first.\n`,
  );
  process.exitCode = 1;
} else if (!NodeFS.existsSync(NodePath.join(portalSource, "index.html"))) {
  process.stderr.write(
    `Missing ${portalSource}/index.html. Run \`vp run --filter @t3tools/web build\` first.\n`,
  );
  process.exitCode = 1;
} else {
  const code = await runDeployCli(process.argv.slice(2), {
    layout: {
      packageRoot,
      packageName,
      registrySource,
      portalSource,
      nativeDirectory: NodePath.join(packageRoot, "native"),
      defaultInstallDir: "/opt/t3-relay",
      releaseUrl: `https://github.com/aiif/t3code/releases/download/vps-relay-v${version}/t3relay-native-${version}.tar.gz`,
      packageVersion: version,
    },
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  process.exitCode = code;
}
