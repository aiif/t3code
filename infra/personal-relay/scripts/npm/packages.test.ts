import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { assembleNpmPackages, createAlias, forbiddenPackageFileReason } from "./packages.ts";

it("recognizes forbidden package files but allows the env template", () => {
  expect(forbiddenPackageFileReason("deploy.json")).toBe("deploy.json");
  expect(forbiddenPackageFileReason("relay.env")).toBe("relay.env");
  expect(forbiddenPackageFileReason(".env")).toBe(".env");
  expect(forbiddenPackageFileReason("dist/portal/app.js.map")).toBe("a source map");
  expect(forbiddenPackageFileReason("node_modules/x.js")).toBe("a node_modules directory");
  expect(forbiddenPackageFileReason("native/templates/relay.env.example")).toBeNull();
  expect(forbiddenPackageFileReason("native/AI-DEPLOY.md")).toBeNull();
});

it("derives the create alias for scoped and unscoped packages", () => {
  expect(createAlias("@aiif/create-t3relay")).toBe("@aiif/t3relay");
  expect(createAlias("create-t3relay")).toBe("t3relay");
});

it("assembles the npm packages and the native bundle", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-pack-"));
  try {
    const source = NodePath.join(root, "source");
    await NodeFSP.mkdir(NodePath.join(source, "portal"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(source, "native", "templates"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "portal", "index.html"), '<div id="root"></div>');
    await NodeFSP.writeFile(NodePath.join(source, "cli.mjs"), "export const cli = true;");
    await NodeFSP.writeFile(NodePath.join(source, "registry.mjs"), "export const registry = true;");
    await NodeFSP.writeFile(NodePath.join(source, "LICENSE"), "MIT");
    await NodeFSP.writeFile(
      NodePath.join(source, "native", "PROMPT.md"),
      "Follow {{RELEASE_URL}} for {{VERSION}} using {{PACKAGE_NAME}}",
    );
    await NodeFSP.writeFile(
      NodePath.join(source, "native", "AI-DEPLOY.md"),
      "Native runbook for {{VERSION}}",
    );
    await NodeFSP.writeFile(NodePath.join(source, "native", "templates", "Caddyfile"), "admin off");
    const readmeDirectory = NodePath.join(source, "readmes");
    await NodeFSP.mkdir(readmeDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(readmeDirectory, "README.npm.md"),
      "# {{PACKAGE_NAME}}\n\n{{PACKAGE_SIZE}}\n\n{{CREATE_PACKAGE_NAME}}\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(readmeDirectory, "README.create.md"),
      "# {{CREATE_PACKAGE_NAME}}\n\n{{CREATE_ALIAS}}\n\n{{MAIN_PACKAGE_NAME}}\n",
    );

    const result = await assembleNpmPackages({
      outputRoot: NodePath.join(root, "dist"),
      version: "0.1.0",
      cliBundlePath: NodePath.join(source, "cli.mjs"),
      registryBundlePath: NodePath.join(source, "registry.mjs"),
      portalDirectory: NodePath.join(source, "portal"),
      nativeDirectory: NodePath.join(source, "native"),
      licensePath: NodePath.join(source, "LICENSE"),
      readmeDirectory,
      mainPackageName: "@aiif/t3relay",
      createPackageName: "@aiif/create-t3relay",
      releaseUrl: "https://example.com/t3relay-native-0.1.0.tar.gz",
      repositoryUrl: "https://github.com/example/t3code",
    });

    const mainManifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.main.directory, "package.json"), "utf8"),
    ) as {
      name: string;
      bin: Record<string, string>;
      repository: { url: string; directory: string };
    };
    expect(mainManifest.name).toBe("@aiif/t3relay");
    expect(mainManifest.bin["t3relay"]).toBe("bin/init.mjs");
    expect(mainManifest.repository).toEqual({
      type: "git",
      url: "https://github.com/example/t3code",
      directory: "infra/personal-relay",
    });
    expect(
      await NodeFSP.readFile(NodePath.join(result.main.directory, "native", "PROMPT.md"), "utf8"),
    ).toContain("https://example.com/t3relay-native-0.1.0.tar.gz");
    expect(
      await NodeFSP.readFile(NodePath.join(result.main.directory, "native", "PROMPT.md"), "utf8"),
    ).toContain("@aiif/t3relay");
    expect(
      await NodeFSP.readFile(
        NodePath.join(result.main.directory, "native", "AI-DEPLOY.md"),
        "utf8",
      ),
    ).toContain("0.1.0");

    const createManifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.create.directory, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(createManifest.dependencies["@aiif/t3relay"]).toBe("0.1.0");

    const nativeManifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.native.directory, "manifest.json"), "utf8"),
    ) as {
      kind: string;
      nodeVersion: string;
      caddyVersion: string;
      frpsVersion: string;
    };
    expect(nativeManifest.kind).toBe("native");
    expect(nativeManifest.nodeVersion).toBe("24.22.3");
    expect(nativeManifest.caddyVersion).toBe("2.10.2");
    expect(nativeManifest.frpsVersion).toBe("0.61.1");
    expect(
      await NodeFSP.readFile(
        NodePath.join(result.native.directory, "registry", "registry.mjs"),
        "utf8",
      ),
    ).toContain("registry");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
