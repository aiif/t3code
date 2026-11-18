import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assembleNpmPackages,
  assertPackage,
  forbiddenPackageFileReason,
  inspectPackage,
  parseSecretValues,
  type NpmAssemblyInput,
} from "./packages.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Sources {
  readonly root: string;
  readonly worker: string;
  readonly cli: string;
  readonly portal: string;
  readonly template: string;
  readonly license: string;
  readonly readmes: string;
}

async function write(file: string, contents: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  await NodeFSP.writeFile(file, contents);
}

async function createSources(): Promise<Sources> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3cf-npm-"));
  cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const sources: Sources = {
    root,
    worker: NodePath.join(root, "src", "worker.js"),
    cli: NodePath.join(root, "src", "cli.mjs"),
    portal: NodePath.join(root, "src", "portal"),
    template: NodePath.join(root, "src", "wrangler.jsonc"),
    license: NodePath.join(root, "LICENSE"),
    readmes: NodePath.join(root, "readmes"),
  };
  await write(sources.worker, "export default { fetch() { return new Response('ok'); } };\n");
  await write(sources.cli, "export function runInstalledCli() { return Promise.resolve(0); }\n");
  await write(NodePath.join(sources.portal, "index.html"), "<html></html>\n");
  await write(NodePath.join(sources.portal, "assets", "app.js"), "console.log('portal');\n");
  await write(sources.template, "{}\n");
  await write(sources.license, "MIT License\n");
  await write(
    NodePath.join(sources.readmes, "README.npm.md"),
    "# t3cf\n\nAbout {{PACKAGE_SIZE}} unpacked.\n",
  );
  await write(NodePath.join(sources.readmes, "README.create.md"), "# create-t3cf\n");
  return sources;
}

function input(sources: Sources, overrides: Partial<NpmAssemblyInput> = {}): NpmAssemblyInput {
  return {
    outputRoot: NodePath.join(sources.root, "dist"),
    version: "0.1.9",
    wranglerVersion: "4.163.0",
    workerBundlePath: sources.worker,
    cliBundlePath: sources.cli,
    portalDirectory: sources.portal,
    templatePath: sources.template,
    licensePath: sources.license,
    readmeDirectory: sources.readmes,
    ...overrides,
  };
}

async function readManifest(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("npm package build", () => {
  it("assembles t3cf and create-t3cf with matching versions", async () => {
    const sources = await createSources();
    const assembled = await assembleNpmPackages(
      input(sources, { repositoryUrl: "https://github.com/example/t3code" }),
    );

    expect(assembled.main.files).toEqual(
      expect.arrayContaining([
        "package.json",
        "bin/init.mjs",
        "dist/cli.mjs",
        "dist/worker/worker.js",
        "dist/portal/index.html",
        "templates/wrangler.jsonc",
        "README.md",
        "LICENSE",
      ]),
    );

    const main = await readManifest(assembled.main.directory);
    expect(main.name).toBe("t3cf");
    expect(main.version).toBe("0.1.9");
    expect(main.bin).toEqual({ t3cf: "bin/init.mjs" });
    expect(main.engines).toEqual({ node: ">=20.19" });
    expect(main.dependencies).toEqual({ wrangler: "4.163.0" });
    expect(main.scripts).toBeUndefined();
    expect(main.repository).toEqual({
      type: "git",
      url: "https://github.com/example/t3code",
      directory: "infra/personal-relay-cloudflare",
    });

    const create = await readManifest(assembled.create.directory);
    expect(create.name).toBe("create-t3cf");
    expect(create.version).toBe(main.version);
    expect(create.bin).toEqual({ "create-t3cf": "bin/create.mjs" });
    expect(create.dependencies).toEqual({ t3cf: "0.1.9" });
    expect(create.scripts).toBeUndefined();

    const init = await NodeFSP.readFile(
      NodePath.join(assembled.main.directory, "bin", "init.mjs"),
      "utf8",
    );
    expect(init.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(init).toContain('from "../dist/cli.mjs"');

    const createBin = await NodeFSP.readFile(
      NodePath.join(assembled.create.directory, "bin", "create.mjs"),
      "utf8",
    );
    expect(createBin).toContain('from "t3cf/cli"');

    const readme = await NodeFSP.readFile(
      NodePath.join(assembled.main.directory, "README.md"),
      "utf8",
    );
    expect(readme).toContain("About 0 MB unpacked.");
    expect(readme.includes("{{PACKAGE_SIZE}}")).toBe(false);
  });

  it("carries an owner-controlled main package name through both packages", async () => {
    const sources = await createSources();
    await write(
      NodePath.join(sources.readmes, "README.npm.md"),
      "# {{PACKAGE_NAME}}\n\nnpx {{PACKAGE_NAME}}@latest init\n",
    );
    await write(
      NodePath.join(sources.readmes, "README.create.md"),
      "# {{CREATE_PACKAGE_NAME}}\n\nnpm create {{CREATE_ALIAS}}@latest\naround {{MAIN_PACKAGE_NAME}}\n",
    );

    const assembled = await assembleNpmPackages(
      input(sources, { mainPackageName: "@scope/t3cf", createPackageName: "create-t3cf" }),
    );

    const main = await readManifest(assembled.main.directory);
    expect(main.name).toBe("@scope/t3cf");

    const create = await readManifest(assembled.create.directory);
    expect(create.dependencies).toEqual({ "@scope/t3cf": "0.1.9" });

    const createBin = await NodeFSP.readFile(
      NodePath.join(assembled.create.directory, "bin", "create.mjs"),
      "utf8",
    );
    expect(createBin).toContain('from "@scope/t3cf/cli"');

    const mainReadme = await NodeFSP.readFile(
      NodePath.join(assembled.main.directory, "README.md"),
      "utf8",
    );
    expect(mainReadme).toContain("npx @scope/t3cf@latest init");

    const createReadme = await NodeFSP.readFile(
      NodePath.join(assembled.create.directory, "README.md"),
      "utf8",
    );
    expect(createReadme).toContain("npm create t3cf@latest");
    expect(createReadme).toContain("around @scope/t3cf");
  });

  it("fails when a deployment secret reaches the package", async () => {
    const sources = await createSources();
    const secret = "s".repeat(43);
    await write(NodePath.join(sources.portal, "assets", "app.js"), `const leaked = "${secret}";\n`);

    await expect(assembleNpmPackages(input(sources, { secretValues: [secret] }))).rejects.toThrow(
      /deployment secret/u,
    );
  });

  it("fails when the portal carries a forbidden file", async () => {
    const sources = await createSources();
    await write(NodePath.join(sources.portal, ".dev.vars"), "T3CODE_ADMIN_KEY=secret\n");

    await expect(assembleNpmPackages(input(sources))).rejects.toThrow(/\.dev\.vars/u);
  });

  it("fails when a cloudflared binary or source map is copied in", async () => {
    const sources = await createSources();
    await write(NodePath.join(sources.portal, "cloudflared-linux-amd64"), "binary\n");

    await expect(assembleNpmPackages(input(sources))).rejects.toThrow(/cloudflared/u);
    expect(forbiddenPackageFileReason("dist/portal/assets/app.js.map")).toContain("source map");
  });

  it("reports an install script in an inspected package", async () => {
    const sources = await createSources();
    const directory = NodePath.join(sources.root, "suspicious");
    await write(
      NodePath.join(directory, "package.json"),
      JSON.stringify({ name: "t3cf", version: "0.0.0", scripts: { postinstall: "node x.js" } }),
    );

    const report = await inspectPackage(directory);
    expect(report.problems).toContain("package.json must not define the postinstall script");
  });

  it("reads only long credential values from a secrets file", () => {
    expect(
      parseSecretValues({
        adminKey: "a".repeat(43),
        enrollKey: "short",
        secretKey: "c".repeat(64),
        workerName: "t3cf",
      }),
    ).toEqual(["a".repeat(43), "c".repeat(64)]);
  });

  it("names every missing required file", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3cf-empty-"));
    cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));

    await expect(
      assertPackage(directory, { required: ["package.json", "bin/init.mjs"] }),
    ).rejects.toThrow(/package\.json is missing[\s\S]*bin\/init\.mjs is missing/u);
  });
});
