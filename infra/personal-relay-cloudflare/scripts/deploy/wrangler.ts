/* oxlint-disable t3code/no-global-process-runtime -- Standalone deploy CLI runs outside the Effect runtime. */
import * as NodeChildProcess from "node:child_process";

import type { WranglerRunOptions, WranglerRunResult, WranglerRunner } from "./types.ts";

/** Runs the pinned local wrangler. Never passes secrets through argv. */
export function createWranglerRunner(): WranglerRunner {
  return {
    run(args: ReadonlyArray<string>, options?: WranglerRunOptions): Promise<WranglerRunResult> {
      return new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn("wrangler", [...args], {
          cwd: options?.cwd,
          env: { ...process.env, ...options?.env },
          shell: process.platform === "win32",
          stdio: ["pipe", "pipe", "pipe"],
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
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code: code ?? 1, stdout, stderr });
        });
        if (options?.input !== undefined) child.stdin.end(options.input);
        else child.stdin.end();
      });
    },
  };
}
