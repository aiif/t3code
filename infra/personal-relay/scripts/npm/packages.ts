// @effect-diagnostics nodeBuiltinImport:off -- The package build runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const TARBALL_TARGET_BYTES = 50 * 1024 * 1024;
export const TARBALL_HARD_LIMIT_BYTES = 110 * 1024 * 1024;
const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024;
const CADDY_VERSION = "2.10.2";
const FRPS_VERSION = "0.61.1";
const NODE_VERSION = "24.22.3";

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".txt",
  ".webmanifest",
]);

const FORBIDDEN_NAMES = new Set([
  "deploy.json",
  "relay.env",
  "relay-secrets.json",
  ".env",
  ".dev.vars",
]);

const SECRET_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  {
    pattern: /(?:T3CODE_(?:ADMIN|SECRET|FRP)_KEY|FRP_AUTH_TOKEN)\s*[:=]\s*["'][^"'\s]{16,}["']/u,
    label: "a T3 Code key value",
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, label: "a private key" },
];

export class NpmPackageError extends Error {
  override name = "NpmPackageError";
}

export interface NpmAssemblyInput {
  readonly outputRoot: string;
  readonly version: string;
  readonly cliBundlePath: string;
  readonly registryBundlePath: string;
  readonly portalDirectory: string;
  readonly nativeDirectory: string;
  readonly licensePath: string;
  readonly readmeDirectory: string;
  readonly mainPackageName: string;
  readonly createPackageName: string;
  readonly releaseUrl: string;
  readonly repositoryUrl?: string;
  readonly secretValues?: ReadonlyArray<string>;
}

export interface PackageReport {
  readonly directory: string;
  readonly files: ReadonlyArray<string>;
}

export interface NpmAssemblyResult {
  readonly main: PackageReport;
  readonly create: PackageReport;
  readonly native: PackageReport;
}

export async function listFiles(directory: string): Promise<ReadonlyArray<string>> {
  const files: Array<string> = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await NodeFSP.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = NodePath.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        files.push(NodePath.relative(directory, absolute).split(NodePath.sep).join("/"));
      }
    }
  };
  await walk(directory);
  return files.sort();
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const file of await listFiles(directory)) {
    total += (await NodeFSP.stat(NodePath.join(directory, file))).size;
  }
  return total;
}

export function forbiddenPackageFileReason(relativePath: string): string | null {
  const segments = relativePath.split("/");
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower === "node_modules") return "a node_modules directory";
    if (lower.startsWith(".dev.vars")) return "a .dev.vars file";
    if (FORBIDDEN_NAMES.has(lower)) return segment;
    if (lower.endsWith(".tgz")) return "a tarball";
    if (lower.endsWith(".map")) return "a source map";
  }
  return null;
}

export async function inspectPackage(
  directory: string,
  secretValues: ReadonlyArray<string> = [],
): Promise<PackageReport & { readonly problems: ReadonlyArray<string> }> {
  const files = await listFiles(directory);
  const problems: Array<string> = [];

  for (const file of files) {
    const reason = forbiddenPackageFileReason(file);
    if (reason !== null) problems.push(`${file} must not ship (${reason})`);
  }

  for (const file of files) {
    const extension = NodePath.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const absolute = NodePath.join(directory, file);
    if ((await NodeFSP.stat(absolute)).size > MAX_SCANNED_FILE_BYTES) continue;
    const text = await NodeFSP.readFile(absolute, "utf8");
    for (const secret of secretValues) {
      if (text.includes(secret)) problems.push(`${file} contains a deployment secret`);
    }
    for (const { pattern, label } of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${file} contains ${label}`);
    }
  }

  const manifestPath = NodePath.join(directory, "package.json");
  if (files.includes("package.json")) {
    const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as {
      readonly scripts?: Record<string, unknown>;
    };
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      if (manifest.scripts?.[name] !== undefined) {
        problems.push(`package.json must not define the ${name} script`);
      }
    }
  }

  return { directory, files, problems };
}

export async function assertPackage(
  directory: string,
  options: {
    readonly required: ReadonlyArray<string>;
    readonly secretValues?: ReadonlyArray<string>;
  },
): Promise<PackageReport> {
  const report = await inspectPackage(directory, options.secretValues ?? []);
  const problems = [...report.problems];
  for (const required of options.required) {
    if (!report.files.includes(required)) problems.push(`${required} is missing`);
  }
  if (problems.length > 0) {
    throw new NpmPackageError(
      `Refusing to build ${NodePath.basename(directory)}:\n${problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}`,
    );
  }
  return { directory: report.directory, files: report.files };
}

function mainManifest(input: {
  readonly version: string;
  readonly packageName: string;
  readonly repositoryUrl: string;
  readonly repositoryDirectory: string;
}): Record<string, unknown> {
  return {
    name: input.packageName,
    version: input.version,
    description: "Deploy the T3 Code personal network relay on a VPS.",
    type: "module",
    bin: { t3relay: "bin/init.mjs" },
    exports: { "./cli": "./dist/cli.mjs" },
    files: [
      "bin",
      "dist/cli.mjs",
      "dist/registry",
      "dist/portal",
      "native",
      "README.md",
      "LICENSE",
    ],
    engines: { node: ">=20.19" },
    publishConfig: { access: "public" },
    keywords: ["t3-code", "personal-network", "relay", "vps", "docker", "caddy"],
    license: "MIT",
    homepage: `${input.repositoryUrl}/tree/main/${input.repositoryDirectory}`,
    repository: {
      type: "git",
      url: input.repositoryUrl,
      directory: input.repositoryDirectory,
    },
  };
}

function createManifest(input: {
  readonly version: string;
  readonly packageName: string;
  readonly mainPackageName: string;
  readonly repositoryUrl: string;
  readonly repositoryDirectory: string;
}): Record<string, unknown> {
  return {
    name: input.packageName,
    version: input.version,
    description: "Create a T3 Code personal network relay on a VPS.",
    type: "module",
    bin: { "create-t3relay": "bin/create.mjs" },
    files: ["bin", "README.md", "LICENSE"],
    engines: { node: ">=20.19" },
    dependencies: { [input.mainPackageName]: input.version },
    publishConfig: { access: "public" },
    keywords: ["t3-code", "personal-network", "relay", "vps", "create"],
    license: "MIT",
    homepage: `${input.repositoryUrl}/tree/main/${input.repositoryDirectory}`,
    repository: {
      type: "git",
      url: input.repositoryUrl,
      directory: input.repositoryDirectory,
    },
  };
}

const MAIN_BIN = `#!/usr/bin/env node
import { runInstalledCli } from "../dist/cli.mjs";

process.exitCode = await runInstalledCli(process.argv.slice(2));
`;

const createBin = (mainPackageName: string) => `#!/usr/bin/env node
import { runInstalledCli } from "${mainPackageName}/cli";

process.exitCode = await runInstalledCli(process.argv.slice(2));
`;

export function createAlias(createPackageName: string): string {
  return createPackageName.startsWith("@")
    ? createPackageName.replace(/^@([^/]+)\/create-/, "@$1/")
    : createPackageName.replace(/^create-/, "");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeBin(file: string, contents: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, contents, { mode: 0o755 });
  if (NodePath.sep !== "\\") await NodeFSP.chmod(file, 0o755);
}

async function copyFile(source: string, destination: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.copyFile(source, destination);
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await NodeFSP.cp(source, destination, {
    recursive: true,
    filter: (file) => !file.endsWith(".map"),
  });
}

async function copyNativeDirectory(input: {
  readonly source: string;
  readonly destination: string;
  readonly version: string;
  readonly releaseUrl: string;
  readonly packageName: string;
}): Promise<void> {
  await NodeFSP.cp(input.source, input.destination, { recursive: true });
  for (const name of ["PROMPT.md", "AI-DEPLOY.md"]) {
    const file = NodePath.join(input.destination, name);
    const contents = await NodeFSP.readFile(file, "utf8");
    await NodeFSP.writeFile(
      file,
      contents
        .replaceAll("{{VERSION}}", input.version)
        .replaceAll("{{RELEASE_URL}}", input.releaseUrl)
        .replaceAll("{{PACKAGE_NAME}}", input.packageName),
    );
  }
}

export async function assembleNpmPackages(input: NpmAssemblyInput): Promise<NpmAssemblyResult> {
  const mainDirectory = NodePath.join(input.outputRoot, "npm");
  const createDirectory = NodePath.join(input.outputRoot, "create");
  const nativeOutput = NodePath.join(input.outputRoot, "native");
  const secretValues = input.secretValues ?? [];
  const repositoryUrl = input.repositoryUrl ?? "https://github.com/aiif/t3code";
  const repositoryDirectory = "infra/personal-relay";

  await NodeFSP.rm(mainDirectory, { recursive: true, force: true });
  await NodeFSP.rm(createDirectory, { recursive: true, force: true });
  await NodeFSP.rm(nativeOutput, { recursive: true, force: true });

  await copyFile(input.cliBundlePath, NodePath.join(mainDirectory, "dist/cli.mjs"));
  await copyFile(
    input.registryBundlePath,
    NodePath.join(mainDirectory, "dist/registry/registry.mjs"),
  );
  await copyDirectory(input.portalDirectory, NodePath.join(mainDirectory, "dist/portal"));
  await copyNativeDirectory({
    source: input.nativeDirectory,
    destination: NodePath.join(mainDirectory, "native"),
    version: input.version,
    releaseUrl: input.releaseUrl,
    packageName: input.mainPackageName,
  });
  await copyFile(input.licensePath, NodePath.join(mainDirectory, "LICENSE"));

  const readme = await NodeFSP.readFile(
    NodePath.join(input.readmeDirectory, "README.npm.md"),
    "utf8",
  );
  const sizeMb = (await directorySize(mainDirectory)) / 1024 / 1024;
  await NodeFSP.writeFile(
    NodePath.join(mainDirectory, "README.md"),
    readme
      .replaceAll("{{PACKAGE_NAME}}", input.mainPackageName)
      .replaceAll("{{CREATE_PACKAGE_NAME}}", input.createPackageName)
      .replaceAll("{{CREATE_ALIAS}}", createAlias(input.createPackageName))
      .replaceAll("{{PACKAGE_SIZE}}", `${sizeMb.toFixed(0)} MB`)
      .replaceAll("{{RELEASE_URL}}", input.releaseUrl),
  );
  await writeJson(
    NodePath.join(mainDirectory, "package.json"),
    mainManifest({
      version: input.version,
      packageName: input.mainPackageName,
      repositoryUrl,
      repositoryDirectory,
    }),
  );
  await writeBin(NodePath.join(mainDirectory, "bin/init.mjs"), MAIN_BIN);

  await copyFile(input.licensePath, NodePath.join(createDirectory, "LICENSE"));
  const createReadme = await NodeFSP.readFile(
    NodePath.join(input.readmeDirectory, "README.create.md"),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(createDirectory, "README.md"),
    createReadme
      .replaceAll("{{CREATE_PACKAGE_NAME}}", input.createPackageName)
      .replaceAll("{{CREATE_ALIAS}}", createAlias(input.createPackageName))
      .replaceAll("{{MAIN_PACKAGE_NAME}}", input.mainPackageName),
  );
  await writeJson(
    NodePath.join(createDirectory, "package.json"),
    createManifest({
      version: input.version,
      packageName: input.createPackageName,
      mainPackageName: input.mainPackageName,
      repositoryUrl,
      repositoryDirectory,
    }),
  );
  await writeBin(
    NodePath.join(createDirectory, "bin/create.mjs"),
    createBin(input.mainPackageName),
  );

  await copyNativeDirectory({
    source: input.nativeDirectory,
    destination: NodePath.join(nativeOutput, "native"),
    version: input.version,
    releaseUrl: input.releaseUrl,
    packageName: input.mainPackageName,
  });
  await copyFile(input.registryBundlePath, NodePath.join(nativeOutput, "registry/registry.mjs"));
  await copyDirectory(input.portalDirectory, NodePath.join(nativeOutput, "portal"));
  await copyFile(input.licensePath, NodePath.join(nativeOutput, "LICENSE"));
  await writeJson(NodePath.join(nativeOutput, "manifest.json"), {
    name: input.mainPackageName,
    version: input.version,
    kind: "native",
    node: ">=24",
    nodeVersion: NODE_VERSION,
    caddyVersion: CADDY_VERSION,
    frpsVersion: FRPS_VERSION,
    registry: "registry/registry.mjs",
    portal: "portal",
    runbook: "native/AI-DEPLOY.md",
    prompt: "native/PROMPT.md",
  });

  const main = await assertPackage(mainDirectory, {
    required: [
      "package.json",
      "bin/init.mjs",
      "dist/cli.mjs",
      "dist/registry/registry.mjs",
      "dist/portal/index.html",
      "native/AI-DEPLOY.md",
      "native/PROMPT.md",
      "README.md",
      "LICENSE",
    ],
    secretValues,
  });
  const create = await assertPackage(createDirectory, {
    required: ["package.json", "bin/create.mjs", "README.md", "LICENSE"],
    secretValues,
  });
  const native = await assertPackage(nativeOutput, {
    required: [
      "native/AI-DEPLOY.md",
      "native/PROMPT.md",
      "registry/registry.mjs",
      "portal/index.html",
      "manifest.json",
      "LICENSE",
    ],
    secretValues,
  });

  return { main, create, native };
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function tarballSizeWarning(name: string, bytes: number): string | null {
  if (bytes <= TARBALL_TARGET_BYTES) return null;
  return `${name} is ${megabytes(bytes)}, above the ${megabytes(TARBALL_TARGET_BYTES)} target.`;
}

export function assertTarballSize(name: string, bytes: number): void {
  if (bytes > TARBALL_HARD_LIMIT_BYTES) {
    throw new NpmPackageError(
      `${name} is ${megabytes(bytes)}, above the ${megabytes(TARBALL_HARD_LIMIT_BYTES)} hard limit.`,
    );
  }
}
