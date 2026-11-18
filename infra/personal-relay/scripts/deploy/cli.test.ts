import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { runDeployCli } from "./cli.ts";
import { createState, readState, stateFile, writeState } from "./secrets.ts";
import type { CommandResult, CommandRunner, DeployLayout } from "./types.ts";

function layout(root: string): DeployLayout {
  return {
    packageRoot: root,
    packageName: "@aiif/t3relay",
    registrySource: NodePath.join(root, "registry.mjs"),
    portalSource: NodePath.join(root, "portal"),
    nativeDirectory: NodePath.join(root, "native"),
    defaultInstallDir: NodePath.join(root, "install"),
    releaseUrl: "https://example.com/t3relay-native-0.1.0.tar.gz",
    packageVersion: "0.1.0",
  };
}

function fakeDocker(): CommandRunner {
  return {
    async run(): Promise<CommandResult> {
      return { code: 0, stdout: "2.39.0\n", stderr: "" };
    },
  };
}

it("prints help and version without a VPS", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-cli-"));
  try {
    const lines: Array<string> = [];
    const output = (line: string) => lines.push(line);
    expect(
      await runDeployCli(["--help"], { layout: layout(root), stdout: output, stderr: output }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("t3relay <command>");
    lines.length = 0;
    expect(
      await runDeployCli(["version"], { layout: layout(root), stdout: output, stderr: output }),
    ).toBe(0);
    expect(lines).toEqual(["0.1.0"]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("prints the native prompt from the package", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-cli-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "native"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "native", "PROMPT.md"),
      "Follow {{RELEASE_URL}} for {{VERSION}} from {{PACKAGE_NAME}}\n",
    );
    const lines: Array<string> = [];
    const output = (line: string) => lines.push(line);
    expect(
      await runDeployCli(["prompt"], {
        layout: layout(root),
        stdout: output,
        stderr: output,
      }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("https://example.com/t3relay-native-0.1.0.tar.gz");
    expect(lines.join("\n")).toContain("@aiif/t3relay");
    expect(lines.join("\n")).toContain("0.1.0");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("runs init as a dry run without touching the install directory", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-cli-"));
  try {
    const lines: Array<string> = [];
    const output = (line: string) => lines.push(line);
    const code = await runDeployCli(
      [
        "init",
        "--domain",
        "relay.example.com",
        "--yes",
        "--dry-run",
        "--skip-dns-check",
        "--no-sudo",
        "--install-dir",
        NodePath.join(root, "install"),
      ],
      {
        layout: layout(root),
        stdout: output,
        stderr: output,
        env: {},
        docker: fakeDocker(),
        isRoot: () => true,
        platform: "linux",
        localAddresses: () => ["203.0.113.10"],
        portAvailable: async () => true,
        now: () => "2026-11-18T00:00:00.000Z",
      },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Dry run. Nothing was changed.");
    expect(lines.join("\n")).toContain("https://relay.example.com");
    await expect(NodeFSP.access(NodePath.join(root, "install"))).rejects.toThrow();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses init when a relay is already installed", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-cli-"));
  try {
    const installDir = NodePath.join(root, "install");
    await NodeFSP.mkdir(installDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(installDir, "deploy.json"),
      JSON.stringify({ version: 1 }),
    );
    const lines: Array<string> = [];
    const output = (line: string) => lines.push(line);
    const code = await runDeployCli(
      [
        "init",
        "--domain",
        "relay.example.com",
        "--yes",
        "--skip-dns-check",
        "--no-sudo",
        "--install-dir",
        installDir,
      ],
      {
        layout: layout(root),
        stdout: output,
        stderr: output,
        env: {},
        docker: fakeDocker(),
        isRoot: () => true,
        platform: "linux",
        localAddresses: () => [],
        portAvailable: async () => true,
      },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("deploy.json");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("upgrades in place, reuses the keys, and backs up the previous data", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-cli-"));
  try {
    const installDir = NodePath.join(root, "install");
    await NodeFSP.mkdir(NodePath.join(root, "portal"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "registry.mjs"), "export {};");
    await NodeFSP.writeFile(NodePath.join(root, "portal", "index.html"), '<div id="root"></div>');
    await NodeFSP.mkdir(NodePath.join(installDir, "data"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(installDir, "data", "registry.sqlite"), "db");

    const state = createState({
      domain: "relay.example.com",
      email: null,
      tls: { mode: "on-demand" },
      images: {
        caddy: "caddy:2.10-alpine",
        frps: "fatedier/frps:v0.61.1",
        node: "node:24-alpine",
      },
      now: "2026-11-18T00:00:00.000Z",
    });
    await writeState(stateFile(installDir), state);

    const calls: Array<ReadonlyArray<string>> = [];
    const docker: CommandRunner = {
      async run(_command, args): Promise<CommandResult> {
        calls.push(args);
        return { code: 0, stdout: "ok", stderr: "" };
      },
    };
    const lines: Array<string> = [];
    const output = (line: string) => lines.push(line);
    const code = await runDeployCli(
      ["upgrade", "--yes", "--skip-dns-check", "--no-sudo", "--install-dir", installDir],
      {
        layout: layout(root),
        stdout: output,
        stderr: output,
        env: {},
        docker,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        isRoot: () => true,
        platform: "linux",
        localAddresses: () => [],
        portAvailable: async () => true,
        sleep: async () => {},
        now: () => "2026-11-19T00:00:00.000Z",
      },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Upgraded the relay containers");
    const upgraded = await readState(stateFile(installDir));
    expect(upgraded?.adminKey).toBe(state.adminKey);
    expect(upgraded?.updatedAt).toBe("2026-11-19T00:00:00.000Z");
    expect(calls.some((args) => args.includes("stop"))).toBe(true);
    expect(calls.some((args) => args.includes("pull"))).toBe(true);
    expect(calls.some((args) => args.includes("--force-recreate"))).toBe(true);
    const backups = await NodeFSP.readdir(NodePath.join(installDir, "backups"));
    expect(backups).toHaveLength(1);
    expect(
      await NodeFSP.readFile(
        NodePath.join(installDir, "backups", backups[0] ?? "", "data", "registry.sqlite"),
        "utf8",
      ),
    ).toBe("db");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
