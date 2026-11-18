import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { backupData, copyAssets, pruneBackups, writeStackFiles } from "./install.ts";
import { isWindows } from "./platform.ts";
import { createState, stateFile, writeState } from "./secrets.ts";

const IMAGES = {
  caddy: "caddy:2.10-alpine",
  frps: "fatedier/frps:v0.61.1",
  node: "node:24-alpine",
};

async function tempDirectory(): Promise<string> {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-install-"));
}

function state() {
  return createState({
    domain: "relay.example.com",
    email: null,
    tls: { mode: "on-demand" },
    images: IMAGES,
    now: "2026-11-18T00:00:00.000Z",
  });
}

it("writes the compose stack with the expected modes", async () => {
  const installDir = await tempDirectory();
  try {
    await writeStackFiles(installDir, state());
    for (const file of ["compose.yaml", "Caddyfile", "frps.toml", "relay.env"]) {
      expect(await NodeFSP.readFile(NodePath.join(installDir, file), "utf8")).not.toBe("");
    }
    if (!isWindows) {
      expect((await NodeFSP.stat(NodePath.join(installDir, "relay.env"))).mode & 0o777).toBe(0o600);
      expect((await NodeFSP.stat(NodePath.join(installDir, "frps.toml"))).mode & 0o777).toBe(0o640);
    }
  } finally {
    await NodeFSP.rm(installDir, { recursive: true, force: true });
  }
});

it("copies the registry and portal without source maps", async () => {
  const installDir = await tempDirectory();
  const source = await tempDirectory();
  try {
    await NodeFSP.mkdir(NodePath.join(source, "portal", "assets"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, "portal", "index.html"), '<div id="root"></div>');
    await NodeFSP.writeFile(NodePath.join(source, "portal", "assets", "app.js"), "console.log(1)");
    await NodeFSP.writeFile(NodePath.join(source, "portal", "assets", "app.js.map"), "{}");
    await NodeFSP.writeFile(NodePath.join(source, "registry.mjs"), "console.log('registry')");

    await copyAssets({
      installDir,
      registrySource: NodePath.join(source, "registry.mjs"),
      portalSource: NodePath.join(source, "portal"),
    });

    expect(
      await NodeFSP.readFile(NodePath.join(installDir, "registry", "registry.mjs"), "utf8"),
    ).toBe("console.log('registry')");
    expect(
      await NodeFSP.readFile(NodePath.join(installDir, "portal", "index.html"), "utf8"),
    ).toContain("root");
    await expect(
      NodeFSP.access(NodePath.join(installDir, "portal", "assets", "app.js.map")),
    ).rejects.toThrow();
    expect((await NodeFSP.stat(NodePath.join(installDir, "data"))).isDirectory()).toBe(true);
  } finally {
    await NodeFSP.rm(installDir, { recursive: true, force: true });
    await NodeFSP.rm(source, { recursive: true, force: true });
  }
});

it("backs up data and prunes old backups", async () => {
  const installDir = await tempDirectory();
  try {
    await writeStackFiles(installDir, state());
    await writeState(stateFile(installDir), state());
    await NodeFSP.mkdir(NodePath.join(installDir, "data"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(installDir, "data", "registry.sqlite"), "db");

    const first = await backupData({
      installDir,
      timestamp: "2026-11-18T00:00:00.000Z",
    });
    expect(await NodeFSP.readFile(NodePath.join(first, "data", "registry.sqlite"), "utf8")).toBe(
      "db",
    );
    expect(await NodeFSP.readFile(NodePath.join(first, "deploy.json"), "utf8")).toContain(
      "relay.example.com",
    );

    for (const timestamp of [
      "2026-11-19T00:00:00.000Z",
      "2026-11-20T00:00:00.000Z",
      "2026-11-21T00:00:00.000Z",
    ]) {
      await backupData({ installDir, timestamp });
    }
    await pruneBackups(installDir, 3);
    const remaining = await NodeFSP.readdir(NodePath.join(installDir, "backups"));
    expect(remaining).toHaveLength(3);
  } finally {
    await NodeFSP.rm(installDir, { recursive: true, force: true });
  }
});
