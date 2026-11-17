import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveWranglerCommand } from "./wrangler.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("wrangler resolution", () => {
  it("prefers the package's pinned wrangler over PATH", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3cf-wrangler-"));
    cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const bin = NodePath.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
    await NodeFSP.mkdir(NodePath.dirname(bin), { recursive: true });
    await NodeFSP.writeFile(bin, "console.log('wrangler');\n");

    const command = resolveWranglerCommand({ cwd: root, fromDirectory: root });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([bin]);
    expect(command.shell).toBe(false);
  });
});
