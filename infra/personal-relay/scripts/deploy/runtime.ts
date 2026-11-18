// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";

export function defaultNow(): string {
  // @effect-diagnostics-next-line globalDate:off -- The standalone CLI timestamps files outside Effect.
  return new Date().toISOString();
}

export function defaultSleep(milliseconds: number): Promise<void> {
  return NodeTimersPromises.setTimeout(milliseconds);
}

export function defaultSudo(argv: ReadonlyArray<string>): Promise<number> {
  const script = process.argv[1];
  if (script === undefined) throw new Error("Could not resolve the CLI entry point.");
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("sudo", ["-E", process.execPath, script, ...argv], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
