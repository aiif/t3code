#!/usr/bin/env node
// @effect-diagnostics no-global-process-runtime:off globalProcessRuntime:off nodeBuiltinImport:off -- Standalone build script outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { build as viteBuild } from "vite-plus";

import { buildRepoPortal } from "./deploy/portal.ts";
import { runCommandCapture } from "./deploy/process.ts";
import {
  assembleNpmPackages,
  assertTarballSize,
  megabytes,
  tarballSizeWarning,
} from "./npm/packages.ts";

const packageRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.resolve(packageRoot, "..", "..");
const output = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `Build the @aiif/t3relay npm packages and the native VPS bundle.

Usage: node infra/personal-relay/scripts/build-npm-package.mjs [options]

Options:
  --version <x.y.z>            Package version (default T3RELAY_VERSION or package.json)
  --package-name <name>        Main npm package (default T3RELAY_PACKAGE_NAME or @aiif/t3relay)
  --create-package-name <name> Wrapper package (default T3RELAY_CREATE_PACKAGE_NAME or @aiif/create-t3relay)
  --no-portal-build            Reuse apps/web/dist
  --no-pack                    Assemble the directories without npm pack or the native tarball
  --help                       Show this message
`;

function parseArgs(argv) {
  const options = {
    version: process.env.T3RELAY_VERSION ?? null,
    packageName: process.env.T3RELAY_PACKAGE_NAME ?? null,
    createPackageName: process.env.T3RELAY_CREATE_PACKAGE_NAME ?? null,
    portalBuild: true,
    pack: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-portal-build") options.portalBuild = false;
    else if (arg === "--no-pack") options.pack = false;
    else if (arg === "--version") {
      options.version = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--package-name") {
      options.packageName = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--package-name=")) {
      options.packageName = arg.slice("--package-name=".length);
    } else if (arg === "--create-package-name") {
      options.createPackageName = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--create-package-name=")) {
      options.createPackageName = arg.slice("--create-package-name=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function normalizeVersion(raw) {
  const version = String(raw ?? "")
    .trim()
    .replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid package version: ${raw}`);
  }
  return version;
}

function normalizePackageName(raw, fallback, label) {
  const name = String(raw ?? fallback).trim();
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new Error(`Invalid ${label} package name: ${name}`);
  }
  return name;
}

async function pathExists(target) {
  try {
    await NodeFSP.access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertPortalBuild() {
  const index = NodePath.join(repoRoot, "apps", "web", "dist", "index.html");
  if (!(await pathExists(index))) {
    throw new Error("apps/web/dist/index.html is missing; run without --no-portal-build.");
  }
  output.stdout("Reusing the existing portal build.");
}

async function bundle(input) {
  const outDir = NodePath.join(packageRoot, "dist", input.directory);
  await NodeFSP.rm(outDir, { recursive: true, force: true });
  await viteBuild({
    configFile: false,
    root: packageRoot,
    logLevel: "warn",
    build: {
      ssr: input.entry,
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: false,
      target: "node20",
      rollupOptions: { output: { entryFileNames: input.fileName, format: "es" } },
    },
  });
  const result = NodePath.join(outDir, input.fileName);
  if (!(await pathExists(result))) throw new Error(`The bundle did not produce ${result}.`);
  return result;
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    NodePath.join(NodePath.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    NodePath.join(
      NodePath.dirname(process.execPath),
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter((candidate) => typeof candidate === "string" && candidate.endsWith(".js"));
  for (const candidate of candidates) {
    if (NodePath.isAbsolute(candidate) && NodeFS.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find npm-cli.js next to this Node.js install.");
}

async function packPackage(directory, tarballDirectory) {
  await NodeFSP.mkdir(tarballDirectory, { recursive: true });
  const result = await runCommandCapture(
    process.execPath,
    [npmCliPath(), "pack", "--json", "--pack-destination", tarballDirectory, "--loglevel", "error"],
    { cwd: directory, env: { npm_config_update_notifier: "false" } },
  );
  if (result.code !== 0) {
    throw new Error(`npm pack failed in ${directory}.\n${result.stderr || result.stdout}`);
  }
  const packed = JSON.parse(result.stdout);
  const entry = Array.isArray(packed) ? packed[0] : packed;
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`npm pack printed an unexpected result: ${result.stdout}`);
  }
  assertTarballSize(entry.name, entry.size);
  return {
    name: entry.name,
    version: entry.version,
    tarball: NodePath.join(tarballDirectory, entry.filename),
    size: entry.size,
    unpackedSize: entry.unpackedSize,
    files: Array.isArray(entry.files) ? entry.files.length : 0,
  };
}

async function nativeTarball(input) {
  const directory = NodePath.join(packageRoot, "dist", "native");
  const fileName = `t3relay-native-${input.version}.tar.gz`;
  const tarball = NodePath.join(directory, fileName);
  const result = await runCommandCapture(
    "tar",
    ["-czf", fileName, "-C", ".", "native", "registry", "portal", "manifest.json", "LICENSE"],
    { cwd: directory },
  );
  if (result.code !== 0) {
    throw new Error(`tar failed.\n${result.stderr || result.stdout}`);
  }
  const bytes = await NodeFSP.readFile(tarball);
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  await NodeFSP.writeFile(
    NodePath.join(directory, "SHA256SUMS"),
    `${hash}  ${NodePath.basename(tarball)}\n`,
  );
  assertTarballSize("t3relay-native", bytes.byteLength);
  return {
    tarball,
    size: bytes.byteLength,
    sha256: hash,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    output.stdout(USAGE.trimEnd());
    return 0;
  }
  const packageJson = JSON.parse(
    await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
  );
  const version = normalizeVersion(options.version ?? packageJson.version);
  const packageName = normalizePackageName(options.packageName, "@aiif/t3relay", "main");
  const createPackageName = normalizePackageName(
    options.createPackageName,
    "@aiif/create-t3relay",
    "create",
  );

  if (options.portalBuild) {
    output.stdout("Building the admin console portal...");
    await buildRepoPortal({ repoRoot, output });
  } else {
    await assertPortalBuild();
  }

  output.stdout("Bundling the registry...");
  const registryBundle = await bundle({
    directory: "registry",
    entry: NodePath.join(packageRoot, "registry", "src", "main.ts"),
    fileName: "registry.mjs",
  });

  output.stdout("Bundling the deploy CLI...");
  const cliBundle = await bundle({
    directory: "cli",
    entry: NodePath.join(packageRoot, "scripts", "deploy", "npm-entry.ts"),
    fileName: "cli.mjs",
  });

  const releaseUrl = `https://github.com/aiif/t3code/releases/download/vps-relay-v${version}/t3relay-native-${version}.tar.gz`;
  const assembled = await assembleNpmPackages({
    outputRoot: NodePath.join(packageRoot, "dist"),
    version,
    cliBundlePath: cliBundle,
    registryBundlePath: registryBundle,
    portalDirectory: NodePath.join(repoRoot, "apps", "web", "dist"),
    nativeDirectory: NodePath.join(packageRoot, "native"),
    licensePath: NodePath.join(repoRoot, "LICENSE"),
    readmeDirectory: NodePath.join(packageRoot, "scripts", "templates"),
    mainPackageName: packageName,
    createPackageName,
    releaseUrl,
  });

  output.stdout(`Assembled ${assembled.main.files.length} files in ${assembled.main.directory}.`);
  output.stdout(
    `Assembled ${assembled.create.files.length} files in ${assembled.create.directory}.`,
  );
  output.stdout(
    `Assembled ${assembled.native.files.length} files in ${assembled.native.directory}.`,
  );

  if (!options.pack) {
    output.stdout("Skipped npm pack and the native tarball (--no-pack).");
    return 0;
  }

  const tarballDirectory = NodePath.join(packageRoot, "dist", "tarballs");
  await NodeFSP.rm(tarballDirectory, { recursive: true, force: true });
  const mainPack = await packPackage(assembled.main.directory, tarballDirectory);
  const createPack = await packPackage(assembled.create.directory, tarballDirectory);
  const nativePack = await nativeTarball({ version });

  const report = {
    version,
    tarballTargetBytes: 50 * 1024 * 1024,
    packages: [mainPack, createPack],
    native: {
      tarball: nativePack.tarball,
      size: nativePack.size,
      sha256: nativePack.sha256,
    },
  };
  await NodeFSP.writeFile(
    NodePath.join(packageRoot, "dist", "npm-pack-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  output.stdout("");
  for (const entry of [mainPack, createPack]) {
    output.stdout(
      `${entry.name}@${entry.version}: ${megabytes(entry.size)} tarball, ${megabytes(
        entry.unpackedSize,
      )} unpacked, ${entry.files} files`,
    );
    output.stdout(`  ${entry.tarball}`);
    const warning = tarballSizeWarning(entry.name, entry.size);
    if (warning !== null) output.stdout(`  Warning: ${warning}`);
  }
  output.stdout(
    `native bundle: ${megabytes(nativePack.size)} tarball, sha256 ${nativePack.sha256}`,
  );
  output.stdout(`  ${nativePack.tarball}`);
  output.stdout("");
  output.stdout(`Wrote ${NodePath.join(packageRoot, "dist", "npm-pack-report.json")}.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
