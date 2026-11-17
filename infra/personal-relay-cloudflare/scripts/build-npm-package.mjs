#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { build as viteBuild } from "vite-plus";

import { buildDeployConfig, parseJsonc, serializeDeployConfig } from "./deploy/config.ts";
import { PORTAL_BUILD_ENV, repoPortalBuildCommand } from "./deploy/portal.ts";
import { runCommand, runCommandCapture } from "./deploy/process.ts";
import { createWranglerRunner } from "./deploy/wrangler.ts";
import {
  assembleNpmPackages,
  assertTarballSize,
  forbiddenPackageFileReason,
  parseSecretValues,
  TARBALL_TARGET_BYTES,
  tarballSizeWarning,
} from "./npm/packages.ts";

const packageRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.resolve(packageRoot, "../..");
const output = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = `Build the t3cf and create-t3cf npm packages.

Usage: node scripts/build-npm-package.mjs [options]

Options:
  --version <x.y.z>        Package version (default T3CF_VERSION or package.json)
  --no-portal-build        Reuse apps/web/dist
  --no-pack                Assemble dist/npm and dist/create without npm pack
  --worker-bundle <path>   Reuse a Worker bundle instead of running wrangler
  --help                   Show this message
`;

function parseArgs(argv) {
  const options = {
    version: process.env.T3CF_VERSION ?? null,
    portalBuild: true,
    pack: true,
    workerBundle: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-portal-build") {
      options.portalBuild = false;
    } else if (arg === "--no-pack") {
      options.pack = false;
    } else if (arg === "--version") {
      options.version = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--worker-bundle") {
      options.workerBundle = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--worker-bundle=")) {
      options.workerBundle = arg.slice("--worker-bundle=".length);
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

async function prebundleWorker(bundleDirectory) {
  const workerOut = NodePath.join(bundleDirectory, "worker");
  await NodeFSP.rm(workerOut, { recursive: true, force: true });
  await NodeFSP.mkdir(workerOut, { recursive: true });

  const template = parseJsonc(
    await NodeFSP.readFile(
      NodePath.join(packageRoot, "scripts", "templates", "wrangler.jsonc"),
      "utf8",
    ),
    "scripts/templates/wrangler.jsonc",
  );
  const config = buildDeployConfig({
    template,
    workerName: "t3cf-bundle",
    main: NodePath.join(packageRoot, "src", "worker.ts"),
    portalDirectory: NodePath.join(repoRoot, "apps", "web", "dist"),
    vars: {},
    relayDomain: null,
  });
  const configPath = NodePath.join(bundleDirectory, "wrangler.jsonc");
  await NodeFSP.writeFile(configPath, serializeDeployConfig(config));

  const wrangler = createWranglerRunner({ cwd: packageRoot });
  const result = await wrangler.run(
    ["deploy", "--dry-run", "--config", configPath, "--outdir", workerOut],
    { cwd: packageRoot },
  );
  if (result.code !== 0) {
    throw new Error(`wrangler deploy --dry-run failed.\n${result.stderr || result.stdout}`);
  }

  const entries = await NodeFSP.readdir(workerOut, { withFileTypes: true });
  const javascript = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name);
  const bundled = javascript.includes("worker.js") ? "worker.js" : javascript[0];
  if (bundled === undefined) {
    throw new Error(`wrangler produced no Worker bundle in ${workerOut}.`);
  }
  const resultPath = NodePath.join(workerOut, "worker.js");
  if (bundled !== "worker.js") {
    await NodeFSP.rename(NodePath.join(workerOut, bundled), resultPath);
  }
  return resultPath;
}

async function bundleCli(bundleDirectory) {
  const cliOut = NodePath.join(bundleDirectory, "cli");
  await NodeFSP.rm(cliOut, { recursive: true, force: true });
  await viteBuild({
    configFile: false,
    root: packageRoot,
    logLevel: "warn",
    build: {
      ssr: NodePath.join(packageRoot, "scripts", "deploy", "npm-entry.ts"),
      outDir: cliOut,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: false,
      target: "node20",
      rollupOptions: { output: { entryFileNames: "cli.mjs", format: "es" } },
    },
  });

  const cliPath = NodePath.join(cliOut, "cli.mjs");
  if (!(await pathExists(cliPath))) {
    throw new Error(`The CLI bundle did not produce ${cliPath}.`);
  }
  return cliPath;
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
    if (NodePath.isAbsolute(candidate) && NodeFS.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Could not find npm-cli.js next to this Node.js install.");
}

async function packPackage(directory, tarballDirectory) {
  await NodeFSP.mkdir(tarballDirectory, { recursive: true });
  const result = await runCommandCapture({
    command: process.execPath,
    args: [
      npmCliPath(),
      "pack",
      "--json",
      "--pack-destination",
      tarballDirectory,
      "--loglevel",
      "error",
    ],
    cwd: directory,
    env: { npm_config_update_notifier: "false" },
  });
  if (result.code !== 0) {
    throw new Error(`npm pack failed in ${directory}.\n${result.stderr || result.stdout}`);
  }
  const packed = JSON.parse(result.stdout);
  const entry = Array.isArray(packed) ? packed[0] : packed;
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`npm pack printed an unexpected result: ${result.stdout}`);
  }
  const files = Array.isArray(entry.files) ? entry.files.map((file) => file.path) : [];
  for (const file of files) {
    const reason = forbiddenPackageFileReason(file);
    if (reason !== null) {
      throw new Error(`${entry.name} would ship ${file} (${reason}).`);
    }
  }
  assertTarballSize(entry.name, entry.size);
  return {
    name: entry.name,
    version: entry.version,
    tarball: NodePath.join(tarballDirectory, entry.filename),
    size: entry.size,
    unpackedSize: entry.unpackedSize,
    files: files.length,
  };
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  const wranglerVersion = packageJson.devDependencies.wrangler;

  if (options.portalBuild) {
    output.stdout("Building the admin console portal...");
    await runCommand(
      {
        ...repoPortalBuildCommand(repoRoot),
        env: { ...PORTAL_BUILD_ENV },
      },
      output,
    );
  } else {
    await assertPortalBuild();
  }

  const bundleDirectory = NodePath.join(packageRoot, ".wrangler", "npm-bundle");
  await NodeFSP.rm(bundleDirectory, { recursive: true, force: true });
  await NodeFSP.mkdir(bundleDirectory, { recursive: true });

  output.stdout("Prebundling the Worker...");
  const workerBundle =
    options.workerBundle === null
      ? await prebundleWorker(bundleDirectory)
      : NodePath.resolve(options.workerBundle);
  if (!(await pathExists(workerBundle))) {
    throw new Error(`The Worker bundle ${workerBundle} does not exist.`);
  }

  output.stdout("Bundling the deploy CLI...");
  const cliBundle = await bundleCli(bundleDirectory);

  const secretsFile = NodePath.join(packageRoot, ".wrangler", "relay-secrets.json");
  let secretValues = [];
  try {
    secretValues = parseSecretValues(JSON.parse(await NodeFSP.readFile(secretsFile, "utf8")));
  } catch {
    secretValues = [];
  }

  const outputRoot = NodePath.join(packageRoot, "dist");
  output.stdout(`Assembling t3cf and create-t3cf ${version}...`);
  const assembled = await assembleNpmPackages({
    outputRoot,
    version,
    wranglerVersion,
    workerBundlePath: workerBundle,
    cliBundlePath: cliBundle,
    portalDirectory: NodePath.join(repoRoot, "apps", "web", "dist"),
    templatePath: NodePath.join(packageRoot, "scripts", "templates", "wrangler.jsonc"),
    licensePath: NodePath.join(repoRoot, "LICENSE"),
    readmeDirectory: NodePath.join(packageRoot, "scripts", "templates"),
    secretValues,
  });

  output.stdout(`Assembled ${assembled.main.files.length} files in ${assembled.main.directory}.`);
  output.stdout(
    `Assembled ${assembled.create.files.length} files in ${assembled.create.directory}.`,
  );

  if (!options.pack) {
    output.stdout("Skipped npm pack (--no-pack).");
    return 0;
  }

  const tarballDirectory = NodePath.join(outputRoot, "tarballs");
  await NodeFSP.rm(tarballDirectory, { recursive: true, force: true });
  const mainPack = await packPackage(assembled.main.directory, tarballDirectory);
  const createPack = await packPackage(assembled.create.directory, tarballDirectory);

  const report = {
    version,
    tarballTargetBytes: TARBALL_TARGET_BYTES,
    packages: [mainPack, createPack],
  };
  await NodeFSP.writeFile(
    NodePath.join(outputRoot, "npm-pack-report.json"),
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
  output.stdout("");
  output.stdout(`Wrote ${NodePath.join(outputRoot, "npm-pack-report.json")}.`);
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
