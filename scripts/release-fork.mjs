#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalProcessRuntime:off no-global-process-runtime:off globalConsole:off -- Standalone release helper outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";

const USAGE = `Cut a fork release and start its GitHub Actions build.

Usage: node scripts/release-fork.mjs --version <x.y.z> [options]

Options:
  --version <x.y.z>   Version to tag, without the leading v
  --tag <vX.Y.Z>      Tag to create; overrides --version
  --macos             Build the macOS arm64 DMG for this release
  --no-macos          Skip the macOS arm64 DMG for this release
  --dry-run           Print the steps without changing anything
  --repo <owner/name> GitHub repository (default aiif/t3code)
  --help              Show this message

The script refuses to run with a dirty worktree and never reuses a tag.
`;

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function parseArgs(argv) {
  const options = {
    version: argValue(argv, "version"),
    tag: argValue(argv, "tag"),
    macos: argv.includes("--macos") ? "1" : argv.includes("--no-macos") ? "0" : undefined,
    dryRun: argv.includes("--dry-run"),
    repo: argValue(argv, "repo") ?? "aiif/t3code",
    help: argv.includes("--help") || argv.includes("-h"),
  };
  const tag = options.tag ?? (options.version === undefined ? undefined : `v${options.version}`);
  if (tag !== undefined && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  return { ...options, tag };
}

function run(command, args, options = {}) {
  if (options.dryRun) {
    console.log(`[dry run] ${command} ${args.join(" ")}`);
    return "";
  }
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}.`);
  }
  return result.stdout ?? "";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.tag === undefined) {
    throw new Error("Pass --version <x.y.z> or --tag <vX.Y.Z>.");
  }

  const dirty = run("git", ["status", "--porcelain"], { capture: true }).trim();
  if (dirty.length > 0) {
    throw new Error("The worktree is not clean; commit or stash first.");
  }

  if (!options.dryRun) {
    const localTag = NodeChildProcess.spawnSync("git", [
      "rev-parse",
      "--verify",
      `refs/tags/${options.tag}`,
    ]);
    if (localTag.status === 0) throw new Error(`Tag ${options.tag} already exists.`);
    const remoteTags = run("git", ["ls-remote", "--tags", "origin", options.tag], {
      capture: true,
    });
    if (remoteTags.trim().length > 0)
      throw new Error(`Tag ${options.tag} already exists on origin.`);
  }

  console.log(`Releasing ${options.tag} from ${options.repo}.`);
  run("git", ["tag", options.tag], options);
  run("git", ["push", "origin", options.tag], options);
  // Enabling is best effort: a workflow that is already enabled can still make
  // `gh workflow enable` exit non-zero, and the dispatch below is what matters.
  for (const workflow of ["Fork release", "Release desktop build"]) {
    try {
      run("gh", ["workflow", "enable", workflow, "-R", options.repo], options);
    } catch (cause) {
      console.warn(
        `Could not enable ${workflow}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  if (options.macos !== undefined) {
    run(
      "gh",
      ["variable", "set", "T3CODE_FORK_BUILD_MACOS", "--body", options.macos, "-R", options.repo],
      options,
    );
  }
  run("gh", ["workflow", "run", "Fork release", "--ref", options.tag, "-R", options.repo], options);

  if (options.dryRun) {
    console.log("[dry run] Nothing was tagged or dispatched.");
    return;
  }

  const runs = run(
    "gh",
    [
      "run",
      "list",
      "-R",
      options.repo,
      "--workflow",
      "Fork release",
      "--limit",
      "1",
      "--json",
      "databaseId,url",
    ],
    { capture: true },
  );
  const [latest] = JSON.parse(runs);
  if (latest?.url) console.log(`Workflow run: ${latest.url}`);
}

try {
  main();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
