// @effect-diagnostics nodeBuiltinImport:off -- The package build runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const MAIN_PACKAGE_NAME = "t3cf";
export const CREATE_PACKAGE_NAME = "create-t3cf";
export const TARBALL_TARGET_BYTES = 50 * 1024 * 1024;
export const TARBALL_HARD_LIMIT_BYTES = 100 * 1024 * 1024;
const MAX_SCANNED_FILE_BYTES = 8 * 1024 * 1024;

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
  ".env",
  ".dev.vars",
  ".relay-secrets.json",
  "relay-secrets.json",
  "wrangler.generated.jsonc",
]);

const SECRET_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  {
    pattern: /T3CODE_(?:ADMIN|SECRET|ENROLL)_KEY\s*[:=]\s*["'][^"'\s]{16,}["']/u,
    label: "a T3 Code key value",
  },
  {
    pattern: /CLOUDFLARE_API_TOKEN\s*[:=]\s*["'][^"'\s]{20,}["']/u,
    label: "a Cloudflare API token",
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, label: "a private key" },
];

export class NpmPackageError extends Error {
  override name = "NpmPackageError";
}

export interface NpmAssemblyInput {
  readonly outputRoot: string;
  readonly version: string;
  readonly wranglerVersion: string;
  readonly workerBundlePath: string;
  readonly cliBundlePath: string;
  readonly portalDirectory: string;
  readonly templatePath: string;
  readonly licensePath: string;
  readonly readmeDirectory: string;
  readonly secretValues?: ReadonlyArray<string>;
}

export interface PackageReport {
  readonly directory: string;
  readonly files: ReadonlyArray<string>;
}

export interface NpmAssemblyResult {
  readonly main: PackageReport;
  readonly create: PackageReport;
}

export interface InspectionReport extends PackageReport {
  readonly problems: ReadonlyArray<string>;
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
  const files = await listFiles(directory);
  let total = 0;
  for (const file of files) {
    const stats = await NodeFSP.stat(NodePath.join(directory, file));
    total += stats.size;
  }
  return total;
}

export function forbiddenPackageFileReason(relativePath: string): string | null {
  for (const segment of relativePath.split("/")) {
    const lower = segment.toLowerCase();
    if (lower === "node_modules") return "a node_modules directory";
    if (lower.startsWith(".dev.vars")) return "a .dev.vars file";
    if (lower.includes("cloudflared")) return "a cloudflared binary";
    if (FORBIDDEN_NAMES.has(lower)) return segment;
    if (lower.endsWith(".tgz")) return "a tarball";
    if (lower.endsWith(".map")) return "a source map";
  }
  return null;
}

export function parseSecretValues(raw: unknown): ReadonlyArray<string> {
  if (typeof raw !== "object" || raw === null) return [];
  const record = raw as Record<string, unknown>;
  return ["adminKey", "secretKey", "enrollKey", "cfApiToken"].flatMap((name) => {
    const value = record[name];
    return typeof value === "string" && value.trim().length >= 20 ? [value.trim()] : [];
  });
}

export async function inspectPackage(
  directory: string,
  secretValues: ReadonlyArray<string> = [],
): Promise<InspectionReport> {
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
    const stats = await NodeFSP.stat(absolute);
    if (stats.size > MAX_SCANNED_FILE_BYTES) continue;
    const text = await NodeFSP.readFile(absolute, "utf8");
    for (const secret of secretValues) {
      if (text.includes(secret)) problems.push(`${file} contains a deployment secret`);
    }
    for (const { pattern, label } of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${file} contains ${label}`);
    }
  }

  const manifestPath = NodePath.join(directory, "package.json");
  if (!files.includes("package.json")) {
    problems.push("package.json is missing");
  } else {
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

function mainManifest(version: string, wranglerVersion: string): Record<string, unknown> {
  return {
    name: MAIN_PACKAGE_NAME,
    version,
    description: "Deploy the T3 Code personal network relay to your own Cloudflare account.",
    type: "module",
    bin: { t3cf: "bin/init.mjs" },
    exports: { "./cli": "./dist/cli.mjs" },
    files: [
      "bin",
      "dist/cli.mjs",
      "dist/worker",
      "dist/portal",
      "templates",
      "README.md",
      "LICENSE",
    ],
    engines: { node: ">=20.19" },
    dependencies: { wrangler: wranglerVersion },
    publishConfig: { access: "public" },
    keywords: ["t3-code", "cloudflare", "tunnel", "relay", "workers"],
    license: "MIT",
    homepage: "https://github.com/pingdotgg/t3code/tree/main/infra/personal-relay-cloudflare",
    repository: {
      type: "git",
      url: "https://github.com/pingdotgg/t3code",
      directory: "infra/personal-relay-cloudflare",
    },
  };
}

function createManifest(version: string): Record<string, unknown> {
  return {
    name: CREATE_PACKAGE_NAME,
    version,
    description: "Create a T3 Code personal network relay on Cloudflare.",
    type: "module",
    bin: { "create-t3cf": "bin/create.mjs" },
    files: ["bin", "README.md", "LICENSE"],
    engines: { node: ">=20.19" },
    dependencies: { [MAIN_PACKAGE_NAME]: version },
    publishConfig: { access: "public" },
    keywords: ["t3-code", "cloudflare", "tunnel", "relay", "create"],
    license: "MIT",
    homepage: "https://github.com/pingdotgg/t3code/tree/main/infra/personal-relay-cloudflare",
    repository: {
      type: "git",
      url: "https://github.com/pingdotgg/t3code",
      directory: "infra/personal-relay-cloudflare",
    },
  };
}

const MAIN_BIN = `#!/usr/bin/env node
import { runInstalledCli } from "../dist/cli.mjs";

process.exitCode = await runInstalledCli(process.argv.slice(2));
`;

const CREATE_BIN = `#!/usr/bin/env node
import { runInstalledCli } from "t3cf/cli";

process.exitCode = await runInstalledCli(process.argv.slice(2));
`;

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

export async function assembleNpmPackages(input: NpmAssemblyInput): Promise<NpmAssemblyResult> {
  const mainDirectory = NodePath.join(input.outputRoot, "npm");
  const createDirectory = NodePath.join(input.outputRoot, "create");
  const secretValues = input.secretValues ?? [];

  await NodeFSP.rm(mainDirectory, { recursive: true, force: true });
  await NodeFSP.rm(createDirectory, { recursive: true, force: true });

  await copyFile(input.workerBundlePath, NodePath.join(mainDirectory, "dist/worker/worker.js"));
  await copyFile(input.cliBundlePath, NodePath.join(mainDirectory, "dist/cli.mjs"));
  await copyDirectory(input.portalDirectory, NodePath.join(mainDirectory, "dist/portal"));
  await copyFile(input.templatePath, NodePath.join(mainDirectory, "templates/wrangler.jsonc"));
  await copyFile(input.licensePath, NodePath.join(mainDirectory, "LICENSE"));
  await copyFile(
    NodePath.join(input.readmeDirectory, "README.npm.md"),
    NodePath.join(mainDirectory, "README.md"),
  );

  const readmePath = NodePath.join(mainDirectory, "README.md");
  const readme = await NodeFSP.readFile(readmePath, "utf8");
  const sizeMb = (await directorySize(mainDirectory)) / 1024 / 1024;
  await NodeFSP.writeFile(
    readmePath,
    readme.replaceAll("{{PACKAGE_SIZE}}", `${sizeMb.toFixed(0)} MB`),
  );
  await writeJson(
    NodePath.join(mainDirectory, "package.json"),
    mainManifest(input.version, input.wranglerVersion),
  );
  await writeBin(NodePath.join(mainDirectory, "bin/init.mjs"), MAIN_BIN);

  await copyFile(input.licensePath, NodePath.join(createDirectory, "LICENSE"));
  await copyFile(
    NodePath.join(input.readmeDirectory, "README.create.md"),
    NodePath.join(createDirectory, "README.md"),
  );
  await writeJson(NodePath.join(createDirectory, "package.json"), createManifest(input.version));
  await writeBin(NodePath.join(createDirectory, "bin/create.mjs"), CREATE_BIN);

  const main = await assertPackage(mainDirectory, {
    required: [
      "package.json",
      "bin/init.mjs",
      "dist/cli.mjs",
      "dist/worker/worker.js",
      "dist/portal/index.html",
      "templates/wrangler.jsonc",
      "README.md",
      "LICENSE",
    ],
    secretValues,
  });
  const create = await assertPackage(createDirectory, {
    required: ["package.json", "bin/create.mjs", "README.md", "LICENSE"],
    secretValues,
  });

  return { main, create };
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The prebuilt admin console dominates the tarball. Over the target the goal's
 * fallback is a portal release asset, so warn instead of shipping silently.
 */
export function tarballSizeWarning(name: string, bytes: number): string | null {
  if (bytes <= TARBALL_TARGET_BYTES) return null;
  return `${name} is ${megabytes(bytes)}, above the ${megabytes(
    TARBALL_TARGET_BYTES,
  )} target. Move the portal to a GitHub release asset before the next major publish.`;
}

export function assertTarballSize(name: string, bytes: number): void {
  if (bytes > TARBALL_HARD_LIMIT_BYTES) {
    throw new NpmPackageError(
      `${name} is ${megabytes(bytes)}, above the ${megabytes(
        TARBALL_HARD_LIMIT_BYTES,
      )} hard limit. Check for stray build output.`,
    );
  }
}
