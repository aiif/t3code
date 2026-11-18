// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI runs outside the Effect runtime.
import * as NodePath from "node:path";

import { CommandError, runCommand } from "./process.ts";
import type { CommandOutput, CommandResult, CommandRunner } from "./types.ts";

export function composeArgs(
  installDir: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    "compose",
    "--project-directory",
    installDir,
    "-f",
    NodePath.join(installDir, "compose.yaml"),
    ...args,
  ];
}

export async function dockerAvailable(runner: CommandRunner): Promise<{
  readonly ok: boolean;
  readonly detail: string;
}> {
  let version: CommandResult;
  try {
    version = await runner.run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch (cause) {
    return {
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (version.code !== 0) {
    const detail = version.stderr.trim() || version.stdout.trim();
    return { ok: false, detail: detail === "" ? "docker is not runnable." : detail };
  }
  let compose: CommandResult;
  try {
    compose = await runner.run("docker", ["compose", "version", "--short"]);
  } catch (cause) {
    return {
      ok: false,
      detail: `docker compose v2 is not available: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (compose.code !== 0) {
    const detail = compose.stderr.trim() || compose.stdout.trim();
    return {
      ok: false,
      detail:
        detail === ""
          ? "docker compose v2 is not available."
          : `docker compose v2 is not available: ${detail}`,
    };
  }
  return { ok: true, detail: compose.stdout.trim() || "docker compose is available." };
}

export async function installDocker(input: {
  readonly runner: CommandRunner;
  readonly output: CommandOutput;
}): Promise<void> {
  await runCommand(
    input.runner,
    input.output,
    "sh",
    ["-c", "curl -fsSL https://get.docker.com | sh"],
    { inheritStdio: true },
  );
}

export async function composeRun(
  runner: CommandRunner,
  installDir: string,
  args: ReadonlyArray<string>,
  options: { readonly inheritStdio?: boolean | undefined } = {},
): Promise<CommandResult> {
  return runner.run(
    "docker",
    composeArgs(installDir, args),
    options.inheritStdio === true ? { inheritStdio: true } : {},
  );
}

export async function composeConfig(
  runner: CommandRunner,
  installDir: string,
): Promise<CommandResult> {
  return composeRun(runner, installDir, ["config", "--quiet"]);
}

export async function composeUp(
  runner: CommandRunner,
  installDir: string,
  options: {
    readonly pull?: boolean | undefined;
    readonly forceRecreate?: boolean | undefined;
  } = {},
): Promise<CommandResult> {
  if (options.pull === true) {
    const pull = await composeRun(runner, installDir, ["pull", "--quiet"]);
    if (pull.code !== 0) return pull;
  }
  const args = ["up", "-d", "--remove-orphans"];
  if (options.forceRecreate === true) args.push("--force-recreate");
  return composeRun(runner, installDir, args);
}

export async function composeDown(
  runner: CommandRunner,
  installDir: string,
): Promise<CommandResult> {
  return composeRun(runner, installDir, ["down", "--remove-orphans"]);
}

export async function composePs(runner: CommandRunner, installDir: string): Promise<CommandResult> {
  return composeRun(runner, installDir, ["ps"]);
}

export async function composeLogs(
  runner: CommandRunner,
  installDir: string,
  tail: number,
): Promise<CommandResult> {
  return composeRun(
    runner,
    installDir,
    ["logs", "--follow", `--tail=${tail}`, "caddy", "frps", "registry"],
    { inheritStdio: true },
  );
}

export function assertComposeResult(result: CommandResult, action: string): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new CommandError(`${action} failed.${detail === "" ? "" : `\n${detail}`}`, result.code);
  }
}
