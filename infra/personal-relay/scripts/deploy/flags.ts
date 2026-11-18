import * as NodeNet from "node:net";

export type CommandName =
  | "init"
  | "upgrade"
  | "doctor"
  | "status"
  | "logs"
  | "uninstall"
  | "prompt"
  | "help"
  | "version";

export interface DeployFlags {
  readonly command: CommandName;
  readonly domain: string | null;
  readonly email: string | null;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly noSudo: boolean;
  readonly skipDnsCheck: boolean;
  readonly publicIp: string | null;
  readonly installDocker: boolean;
  readonly installDir: string;
  readonly tlsCert: string | null;
  readonly tlsKey: string | null;
  readonly rotateAdminKey: boolean;
  readonly caddyImage: string | null;
  readonly frpsImage: string | null;
  readonly nodeImage: string | null;
  readonly purge: boolean;
  readonly tail: number;
  readonly verbose: boolean;
  readonly help: boolean;
}

export class DeployFlagError extends Error {
  override name = "DeployFlagError";
}

export const DEFAULT_INSTALL_DIR = "/opt/t3-relay";
export const DEFAULT_CADDY_IMAGE = "caddy:2.10-alpine";
export const DEFAULT_FRPS_IMAGE = "fatedier/frps:v0.61.1";
export const DEFAULT_NODE_IMAGE = "node:24-alpine";

const COMMANDS = new Set<CommandName>([
  "init",
  "upgrade",
  "doctor",
  "status",
  "logs",
  "uninstall",
  "prompt",
  "help",
  "version",
]);

const BOOLEAN_FLAGS = new Set([
  "yes",
  "dry-run",
  "no-sudo",
  "skip-dns-check",
  "install-docker",
  "rotate-admin-key",
  "purge",
  "verbose",
  "help",
]);

const VALUE_FLAGS = new Set([
  "domain",
  "email",
  "public-ip",
  "install-dir",
  "tls-cert",
  "tls-key",
  "caddy-image",
  "frps-image",
  "node-image",
  "tail",
]);

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u;

export const DEPLOY_USAGE = `Deploy the T3 Code personal network relay on a VPS.

Usage: t3relay <command> [options]

Commands:
  init        Install Docker Compose, Caddy, frps and the registry
  upgrade     Replace the relay code and images, reusing the keys
  doctor      Check Docker, DNS, ports, services, certificates and health
  status      Show the installed relay and container status
  logs        Follow the relay container logs
  uninstall   Stop the relay; --purge also removes /opt/t3-relay
  prompt      Print the AI-native install prompt for this release
  version     Print the CLI version

Options:
  --domain <hostname>      Relay origin, for example relay.example.com
  --email <address>        ACME account email (optional)
  --yes                    Never prompt; fail when input is required
  --dry-run                Print the plan without changing anything
  --no-sudo                Do not re-exec through sudo
  --skip-dns-check         Skip the A/AAAA preflight check
  --public-ip <address>    Expected VPS address for the DNS check
  --install-docker         Allow the official Docker install script
  --install-dir <path>     Install directory (default ${DEFAULT_INSTALL_DIR})
  --tls-cert <path>        Wildcard certificate for the relay and host names
  --tls-key <path>         Private key for --tls-cert
  --rotate-admin-key       Replace the admin key during init/upgrade
  --caddy-image <image>    Caddy image (default ${DEFAULT_CADDY_IMAGE})
  --frps-image <image>     frps image (default ${DEFAULT_FRPS_IMAGE})
  --node-image <image>     Registry Node image (default ${DEFAULT_NODE_IMAGE})
  --purge                  With uninstall, delete the install directory
  --tail <n>               With logs, lines of history (default 200)
  --verbose                Print every command the CLI runs
  --help                   Show this message

Environment:
  T3RELAY_DOMAIN           Default for --domain
  T3RELAY_EMAIL            Default for --email
`;

function fail(message: string): never {
  throw new DeployFlagError(message);
}

function requiredValue(name: string, raw: string | null): string {
  const value = raw?.trim() ?? "";
  if (value === "") fail(`--${name} needs a value.`);
  return value;
}

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!HOSTNAME.test(domain)) {
    fail(`--domain must be a DNS hostname such as relay.example.com, got "${value}".`);
  }
  return domain;
}

export function normalizeEmail(value: string): string {
  const email = value.trim();
  if (!EMAIL.test(email)) fail(`--email must be an email address, got "${value}".`);
  return email;
}

function normalizeImage(name: string, value: string): string {
  const image = value.trim();
  if (!IMAGE.test(image)) fail(`--${name} is not a container image reference: "${value}".`);
  return image;
}

function positiveInteger(name: string, value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) fail(`--${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`--${name} is too large.`);
  return parsed;
}

export function parseDeployFlags(argv: ReadonlyArray<string>): DeployFlags {
  let command: CommandName = "help";
  let commandSeen = false;
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") break;
    if (!arg.startsWith("--")) {
      if (commandSeen) fail(`Unexpected argument: ${arg}`);
      if (!COMMANDS.has(arg as CommandName)) fail(`Unknown command: ${arg}`);
      command = arg as CommandName;
      commandSeen = true;
      continue;
    }
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
      value = argv[index] ?? null;
    }
    values.set(name, requiredValue(name, value));
  }

  if (booleans.has("help")) command = "help";

  const tlsCert = values.get("tls-cert") ?? null;
  const tlsKey = values.get("tls-key") ?? null;
  if ((tlsCert === null) !== (tlsKey === null)) {
    fail("--tls-cert and --tls-key must be provided together.");
  }

  const publicIp = values.get("public-ip") ?? null;
  if (publicIp !== null && NodeNet.isIP(publicIp) === 0) {
    fail(`--public-ip must be an IPv4 or IPv6 address, got "${publicIp}".`);
  }

  return {
    command,
    domain: values.has("domain") ? normalizeDomain(values.get("domain") ?? "") : null,
    email: values.has("email") ? normalizeEmail(values.get("email") ?? "") : null,
    yes: booleans.has("yes"),
    dryRun: booleans.has("dry-run"),
    noSudo: booleans.has("no-sudo"),
    skipDnsCheck: booleans.has("skip-dns-check"),
    publicIp,
    installDocker: booleans.has("install-docker"),
    installDir: values.get("install-dir")?.trim() || DEFAULT_INSTALL_DIR,
    tlsCert,
    tlsKey,
    rotateAdminKey: booleans.has("rotate-admin-key"),
    caddyImage: values.has("caddy-image")
      ? normalizeImage("caddy-image", values.get("caddy-image") ?? "")
      : null,
    frpsImage: values.has("frps-image")
      ? normalizeImage("frps-image", values.get("frps-image") ?? "")
      : null,
    nodeImage: values.has("node-image")
      ? normalizeImage("node-image", values.get("node-image") ?? "")
      : null,
    purge: booleans.has("purge"),
    tail: positiveInteger("tail", values.get("tail") ?? "200"),
    verbose: booleans.has("verbose"),
    help: command === "help",
  };
}
