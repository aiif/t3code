#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalProcessRuntime:off no-global-process-runtime:off globalConsole:off -- Standalone release helper outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");

function repoSlug() {
  const result = NodeChildProcess.spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const url = (result.stdout ?? "").trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u);
  if (result.status !== 0 || match === null) {
    throw new Error(`Cannot read a GitHub repository from origin; set GH_REPO=<owner/name>.`);
  }
  return match[1];
}

const REPO = process.env.GH_REPO ?? repoSlug();

const TARGETS = {
  relay: {
    workflow: "publish-t3relay.yml",
    packageJson: "infra/personal-relay/package.json",
  },
  "cf-relay": {
    workflow: "publish-t3cf.yml",
    packageJson: "infra/personal-relay-cloudflare/package.json",
  },
};

const USAGE = `Dispatch an npm publish workflow and follow the run.

Usage: node scripts/publish-npm-package.mjs <relay|cf-relay> [options]

Options:
  --version <x.y.z>   Version to publish (default: the package's package.json version)
  --ref <branch>      Branch that holds the workflow (default main)
  --no-watch          Return after dispatching instead of following the run
  --dry-run           Print the dispatch command without running it
  --help              Show this message

The workflow publishes with npm trusted publishing over OIDC, so no npm token
or interactive 2FA is involved. Each package needs a trusted publisher for the
workflow file:

  npm trust github <package> --file <workflow> --repo <owner/name> --env npm --allow-publish

A brand-new package needs one seed publish with a token or a local login before
npm will accept that configuration. See docs/operations/fork-release.md.
`;

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} needs a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const [targetName, ...rest] = argv;
  if (targetName === undefined || targetName === "--help" || targetName === "-h") {
    return { help: true };
  }
  if (!Object.hasOwn(TARGETS, targetName)) {
    throw new Error(`Unknown package group: ${targetName}. Expected relay or cf-relay.`);
  }
  return {
    help: rest.includes("--help") || rest.includes("-h"),
    targetName,
    version: argValue(rest, "version"),
    ref: argValue(rest, "ref") ?? "main",
    watch: !rest.includes("--no-watch"),
    dryRun: rest.includes("--dry-run"),
  };
}

function normalizeVersion(raw) {
  const version = String(raw ?? "")
    .trim()
    .replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid version: ${raw}`);
  }
  return version;
}

function packageVersion(relativePath) {
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(REPO_ROOT, relativePath), "utf8"));
  return manifest.version;
}

function gh(args, options = {}) {
  const result = NodeChildProcess.spawnSync("gh", args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    env: { ...process.env, GH_REPO: REPO },
  });
  if (result.error) {
    throw new Error(`The GitHub CLI (gh) is required; install it and run gh auth login.`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`gh ${args.join(" ")} failed.\n${(result.stderr ?? "").trim()}`);
  }
  return result;
}

function latestRunId(workflow) {
  const result = gh(
    ["run", "list", "--workflow", workflow, "--limit", "1", "--json", "databaseId"],
    { allowFailure: true },
  );
  if (result.status !== 0) return 0;
  const runs = JSON.parse(result.stdout);
  return runs[0]?.databaseId ?? 0;
}

async function waitForRun(workflow, previousRunId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = gh(
      ["run", "list", "--workflow", workflow, "--limit", "5", "--json", "databaseId,url"],
      { allowFailure: true },
    );
    if (result.status === 0) {
      const run = JSON.parse(result.stdout).find(
        (candidate) => candidate.databaseId > previousRunId,
      );
      if (run !== undefined) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`gh did not list a new ${workflow} run; open the Actions tab.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const target = TARGETS[options.targetName];
  const version = normalizeVersion(options.version ?? packageVersion(target.packageJson));
  const dispatchArgs = [
    "workflow",
    "run",
    target.workflow,
    "--ref",
    options.ref,
    "-f",
    `version=${version}`,
  ];

  if (options.dryRun) {
    console.log(`[dry run] GH_REPO=${REPO} gh ${dispatchArgs.join(" ")}`);
    return;
  }

  const previousRunId = options.watch ? latestRunId(target.workflow) : 0;
  gh(dispatchArgs, { inherit: true });
  console.log(`Dispatched ${target.workflow} for ${version} from ${options.ref} on ${REPO}.`);

  if (!options.watch) {
    console.log(`Follow it with: gh run list --workflow ${target.workflow}`);
    return;
  }

  const run = await waitForRun(target.workflow, previousRunId);
  console.log(`Watching ${run.url}`);
  const watch = gh(["run", "watch", String(run.databaseId), "--exit-status"], {
    inherit: true,
    allowFailure: true,
  });
  if (watch.status !== 0) {
    throw new Error(`Publish run ${run.url} failed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
