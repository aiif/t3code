#!/usr/bin/env node
import { runDeployCli } from "./deploy/cli.ts";
import { createWranglerRunner } from "./deploy/wrangler.ts";

const code = await runDeployCli(process.argv.slice(2), {
  wrangler: createWranglerRunner(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
