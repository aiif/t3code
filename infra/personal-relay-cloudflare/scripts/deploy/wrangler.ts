// @effect-diagnostics nodeBuiltinImport:off -- The deploy CLI runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { isWindows } from "./platform.ts";
import type { WranglerRunOptions, WranglerRunResult, WranglerRunner } from "./types.ts";

export interface WranglerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export interface WranglerRunnerOptions {
  readonly cwd?: string;
  readonly command?: WranglerCommand;
}

function searchNodeModules(start: string): WranglerCommand | null {
  let directory = NodePath.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = NodePath.join(directory, "node_modules", "wrangler", "bin", "wrangler.js");
    if (NodeFS.existsSync(candidate)) {
      return { command: process.execPath, args: [candidate], shell: false };
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Resolves the wrangler this package pins. Deliberately filesystem-based:
 * require.resolve would honor NODE_PATH and could pick another install.
 */
export function resolveWranglerCommand(input: {
  readonly cwd: string;
  readonly fromDirectory?: string;
}): WranglerCommand {
  const fromDirectory =
    input.fromDirectory ?? NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  return (
    searchNodeModules(input.cwd) ??
    searchNodeModules(fromDirectory) ?? { command: "wrangler", args: [], shell: isWindows }
  );
}

/** Runs the pinned local wrangler. Never passes secrets through argv. */
export function createWranglerRunner(options: WranglerRunnerOptions = {}): WranglerRunner {
  const resolved = new Map<string, WranglerCommand>();

  return {
    run(args: ReadonlyArray<string>, runOptions?: WranglerRunOptions): Promise<WranglerRunResult> {
      const cwd = runOptions?.cwd ?? options.cwd ?? process.cwd();
      let wrangler = options.command ?? resolved.get(cwd);
      if (wrangler === undefined) {
        wrangler = resolveWranglerCommand({ cwd });
        resolved.set(cwd, wrangler);
      }

      return new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn(wrangler.command, [...wrangler.args, ...args], {
          cwd,
          env: { ...process.env, ...runOptions?.env },
          shell: wrangler.shell,
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
        if (runOptions?.input !== undefined) child.stdin.end(runOptions.input);
        else child.stdin.end();
      });
    },
  };
}
