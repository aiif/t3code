// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";

import type { CommandOutput, CommandResult, CommandRunOptions, CommandRunner } from "./types.ts";

export class CommandError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export function runCommandCapture(
  command: string,
  args: ReadonlyArray<string>,
  options: CommandRunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.inheritStdio ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!options.inheritStdio) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.end(options.input);
    }
    child.on("error", (cause) => {
      reject(new CommandError(`Could not run ${command}: ${cause.message}`, null));
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runCommand(
  runner: CommandRunner,
  output: CommandOutput,
  command: string,
  args: ReadonlyArray<string>,
  options: CommandRunOptions = {},
): Promise<void> {
  const result = await runner.run(command, args, options);
  if (result.stdout.trim() !== "") output.stdout(result.stdout.trimEnd());
  if (result.stderr.trim() !== "") output.stderr(result.stderr.trimEnd());
  if (result.code !== 0) {
    throw new CommandError(`${command} exited with code ${result.code}.`, result.code);
  }
}

export const nativeCommandRunner: CommandRunner = {
  run: runCommandCapture,
};
