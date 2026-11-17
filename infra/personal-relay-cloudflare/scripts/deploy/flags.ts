import type { DeployOptions } from "./types.ts";

export interface DeployFlags extends DeployOptions {
  readonly secretsFile: string | null;
  readonly noPortalBuild: boolean;
  readonly allowMultiLevel: boolean;
  readonly rotateKeys: boolean;
  readonly help: boolean;
}

export class DeployFlagError extends Error {
  override name = "DeployFlagError";
}

const BOOLEAN_FLAGS = new Set([
  "dry-run",
  "upgrade",
  "destroy",
  "doctor",
  "no-portal-build",
  "allow-multi-level",
  "rotate-keys",
  "yes",
  "help",
]);

const VALUE_FLAGS = new Set([
  "mode",
  "hosts-domain",
  "relay-domain",
  "worker-name",
  "max-hosts",
  "secrets-file",
]);

export const DEPLOY_USAGE = `Deploy the T3 Code Cloudflare relay.

Usage: t3cf init [options]
       node infra/personal-relay-cloudflare/scripts/deploy.mjs [options]

Options:
  --mode auto|named|quick  Tunnel mode (default auto: named with a zone, else quick)
  --hosts-domain <zone>    Cloudflare zone (or its own sub-zone) for host hostnames
  --relay-domain <host>    Optional custom domain for the relay and admin console
  --worker-name <name>     Worker name and tunnel prefix (default t3cf)
  --max-hosts <n>          Maximum registered hosts (default 20)
  --secrets-file <path>    Override the local secrets file location
  --dry-run                Print the plan without changing the account
  --upgrade                Reuse existing secrets and redeploy
  --destroy                Delete tunnels, DNS records and the Worker
  --doctor                 Check wrangler, token, zone and Zero Trust access
  --no-portal-build        Reuse the existing portal build
  --allow-multi-level      Allow hostnames two labels below a Cloudflare zone
  --rotate-keys            Explicitly replace the admin and enrollment keys
  --yes                    Never prompt; fail instead when input is required
  --help                   Show this message

Environment:
  CLOUDFLARE_API_TOKEN     Deploy token or an existing wrangler login session
  CLOUDFLARE_ACCOUNT_ID    Optional account override
  T3CODE_CF_API_TOKEN      Runtime token: Cloudflare Tunnel Edit + DNS Edit
`;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

function fail(message: string): never {
  throw new DeployFlagError(message);
}

function requiredValue(name: string, raw: string | null): string {
  const value = raw?.trim() ?? "";
  if (value === "") fail(`--${name} needs a value.`);
  return value;
}

function normalizeHostname(name: string, value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!HOSTNAME.test(hostname)) fail(`--${name} must be a DNS hostname, got "${value}".`);
  return hostname;
}

function positiveInteger(name: string, value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) fail(`--${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 1000) fail(`--${name} must be 1 to 1000.`);
  return parsed;
}

export function parseDeployFlags(argv: ReadonlyArray<string>): DeployFlags {
  // `npx t3cf init` passes the subcommand through; `npm create t3cf` does not.
  const args = argv[0] === "init" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") break;
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const inline = equals === -1 ? null : arg.slice(equals + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== null) fail(`--${name} does not take a value.`);
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) fail(`Unknown option: --${name}`);
    let value = inline;
    if (value === null) {
      index += 1;
      value = args[index] ?? null;
    }
    values.set(name, requiredValue(name, value));
  }

  const workerName = (values.get("worker-name") ?? "t3cf").trim().toLowerCase();
  if (!DNS_LABEL.test(workerName)) {
    fail("--worker-name must be a lowercase DNS label of 1 to 63 characters.");
  }

  const rawMode = values.get("mode") ?? "auto";
  if (rawMode !== "auto" && rawMode !== "named" && rawMode !== "quick") {
    fail("--mode must be auto, named or quick.");
  }

  const hostsDomain =
    values.get("hosts-domain") === undefined
      ? null
      : normalizeHostname("hosts-domain", values.get("hosts-domain") ?? "");
  const relayDomain =
    values.get("relay-domain") === undefined
      ? null
      : normalizeHostname("relay-domain", values.get("relay-domain") ?? "");

  return {
    mode: rawMode,
    workerName,
    hostsDomain,
    relayDomain,
    maxHosts: positiveInteger("max-hosts", values.get("max-hosts") ?? "20"),
    dryRun: booleans.has("dry-run"),
    upgrade: booleans.has("upgrade"),
    destroy: booleans.has("destroy"),
    doctor: booleans.has("doctor"),
    yes: booleans.has("yes"),
    secretsFile: values.get("secrets-file") ?? null,
    noPortalBuild: booleans.has("no-portal-build"),
    allowMultiLevel: booleans.has("allow-multi-level"),
    rotateKeys: booleans.has("rotate-keys"),
    help: booleans.has("help"),
  };
}
