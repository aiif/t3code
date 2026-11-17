// @effect-diagnostics nodeBuiltinImport:off -- The deploy CLI runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";

export interface CommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandOutput {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CommandError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export function runCommandCapture(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      reject(new CommandError(`Could not run ${spec.command}: ${cause.message}`, null));
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function runCommand(spec: CommandSpec, output: CommandOutput): Promise<void> {
  const result = await runCommandCapture(spec);
  if (result.stdout.trim() !== "") output.stdout(result.stdout.trimEnd());
  if (result.stderr.trim() !== "") output.stderr(result.stderr.trimEnd());
  if (result.code !== 0) {
    throw new CommandError(`${spec.command} exited with code ${result.code}.`, result.code);
  }
}
