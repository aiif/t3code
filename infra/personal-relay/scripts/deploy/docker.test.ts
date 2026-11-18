import { expect, it } from "vite-plus/test";
import * as NodePath from "node:path";

import { composeArgs, composeDown, composeUp, dockerAvailable } from "./docker.ts";
import type { CommandResult, CommandRunner } from "./types.ts";

function fakeRunner(results: ReadonlyArray<CommandResult>): {
  readonly runner: CommandRunner;
  readonly calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
} {
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  let index = 0;
  return {
    calls,
    runner: {
      async run(command, args) {
        calls.push({ command, args });
        return results[index++] ?? { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

it("builds compose commands against the install directory", () => {
  expect(composeArgs("/opt/t3-relay", ["up", "-d"])).toEqual([
    "compose",
    "--project-directory",
    "/opt/t3-relay",
    "-f",
    NodePath.join("/opt/t3-relay", "compose.yaml"),
    "up",
    "-d",
  ]);
});

it("checks docker and compose v2", async () => {
  const ok = fakeRunner([
    { code: 0, stdout: "27.0.0\n", stderr: "" },
    { code: 0, stdout: "2.39.0\n", stderr: "" },
  ]);
  expect(await dockerAvailable(ok.runner)).toEqual({
    ok: true,
    detail: "2.39.0",
  });

  const noCompose = fakeRunner([
    { code: 0, stdout: "27.0.0\n", stderr: "" },
    { code: 1, stdout: "", stderr: "compose is not installed" },
  ]);
  expect(await dockerAvailable(noCompose.runner)).toEqual({
    ok: false,
    detail: "docker compose v2 is not available: compose is not installed",
  });

  const missing = {
    async run(): Promise<CommandResult> {
      throw new Error("spawn docker ENOENT");
    },
  };
  expect(await dockerAvailable(missing)).toEqual({
    ok: false,
    detail: "spawn docker ENOENT",
  });
});

it("pulls and recreates on upgrade, and removes orphans on down", async () => {
  const up = fakeRunner([
    { code: 0, stdout: "pulled", stderr: "" },
    { code: 0, stdout: "started", stderr: "" },
  ]);
  const result = await composeUp(up.runner, "/opt/t3-relay", {
    pull: true,
    forceRecreate: true,
  });
  expect(result.code).toBe(0);
  expect(up.calls[0]?.args).toContain("pull");
  expect(up.calls[1]?.args).toContain("--force-recreate");

  const down = fakeRunner([{ code: 0, stdout: "", stderr: "" }]);
  await composeDown(down.runner, "/opt/t3-relay");
  expect(down.calls[0]?.args).toContain("--remove-orphans");
});
