// @effect-diagnostics nodeBuiltinImport:off globalProcessRuntime:off -- The standalone CLI runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadlinePromises from "node:readline/promises";
import * as NodeTls from "node:tls";

import {
  DEFAULT_CADDY_IMAGE,
  DEFAULT_FRPS_IMAGE,
  DEFAULT_NODE_IMAGE,
  DEPLOY_USAGE,
  DeployFlagError,
  normalizeDomain,
  normalizeEmail,
  parseDeployFlags,
  type DeployFlags,
} from "./flags.ts";
import { renderPrompt } from "./config.ts";
import { checkRelayDns, systemDnsResolver } from "./dns.ts";
import {
  assertComposeResult,
  composeConfig,
  composeDown,
  composeLogs,
  composePs,
  composeRun,
  composeUp,
  dockerAvailable,
  installDocker,
} from "./docker.ts";
import {
  checkPortal,
  waitForRelayHealth,
  type FetchLike,
  type HealthWaitResult,
} from "./health.ts";
import {
  backupData,
  copyAssets,
  copyTlsFiles,
  ensureInstallDir,
  pruneBackups,
  validateCertificatePair,
  writeStackFiles,
} from "./install.ts";
import {
  createState,
  readState,
  rotateAdminKey,
  stateFile,
  touchState,
  RelayStateError,
  writeState,
} from "./secrets.ts";
import { defaultNow, defaultSleep, defaultSudo } from "./runtime.ts";
import { nativeCommandRunner } from "./process.ts";
import { canBindPort, publicAddresses } from "./platform.ts";
import type {
  CommandOutput,
  CommandRunner,
  DeployLayout,
  DnsResolver,
  RelayImages,
  RelayState,
  TlsConfig,
} from "./types.ts";

const ROOT_COMMANDS = new Set(["init", "upgrade", "doctor", "status", "logs", "uninstall"]);

export class CliError extends Error {
  override name = "CliError";
}

export interface CliDependencies {
  readonly layout: DeployLayout;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => string;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly docker?: CommandRunner;
  readonly dns?: DnsResolver;
  readonly prompt?: (question: string) => Promise<string>;
  readonly sudo?: (argv: ReadonlyArray<string>) => Promise<number>;
  readonly isRoot?: () => boolean;
  readonly platform?: string;
  readonly localAddresses?: () => ReadonlyArray<string>;
  readonly portAvailable?: (port: number) => Promise<boolean>;
  readonly healthAttempts?: number;
  readonly healthIntervalMs?: number;
}

interface Runtime {
  readonly flags: DeployFlags;
  readonly layout: DeployLayout;
  readonly output: CommandOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => string;
  readonly fetchImpl: FetchLike;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly docker: CommandRunner;
  readonly dns: DnsResolver;
  readonly prompt: (question: string) => Promise<string>;
  readonly installDir: string;
  readonly stateFile: string;
  readonly interactive: boolean;
  readonly verbose: boolean;
  readonly healthAttempts: number;
  readonly healthIntervalMs: number;
  readonly isRoot: boolean;
  readonly platform: string;
  readonly localAddresses: ReadonlyArray<string>;
  readonly portAvailable: (port: number) => Promise<boolean>;
}

function defaultPrompt(question: string): Promise<string> {
  const readline = NodeReadlinePromises.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return readline.question(question).finally(() => readline.close());
}

function envValue(runtime: Runtime, name: string): string | null {
  const value = runtime.env[name]?.trim();
  return value === undefined || value === "" ? null : value;
}

function pathExists(target: string): Promise<boolean> {
  return NodeFSP.access(target).then(
    () => true,
    () => false,
  );
}

function fail(message: string): never {
  throw new CliError(message);
}

function requireDockerState(state: RelayState): void {
  if (state.mode !== "docker") {
    fail(
      "This is a native install. Use the AI-native runbook and systemctl/journalctl; the Docker CLI does not manage it.",
    );
  }
}

async function resolveDomain(runtime: Runtime): Promise<string> {
  if (runtime.flags.domain !== null) return runtime.flags.domain;
  const fromEnv = envValue(runtime, "T3RELAY_DOMAIN");
  if (fromEnv !== null) return normalizeDomain(fromEnv);
  if (!runtime.interactive) fail("--domain is required with --yes.");
  const answer = await runtime.prompt("Relay domain (for example relay.example.com): ");
  return normalizeDomain(answer);
}

async function resolveEmail(runtime: Runtime): Promise<string | null> {
  if (runtime.flags.email !== null) return runtime.flags.email;
  const fromEnv = envValue(runtime, "T3RELAY_EMAIL");
  if (fromEnv !== null) return normalizeEmail(fromEnv);
  if (!runtime.interactive) return null;
  const answer = (await runtime.prompt("ACME email (optional, blank to skip): ")).trim();
  return answer === "" ? null : normalizeEmail(answer);
}

function resolveImages(runtime: Runtime, existing: RelayState | null): RelayImages {
  return {
    caddy: runtime.flags.caddyImage ?? existing?.images.caddy ?? DEFAULT_CADDY_IMAGE,
    frps: runtime.flags.frpsImage ?? existing?.images.frps ?? DEFAULT_FRPS_IMAGE,
    node: runtime.flags.nodeImage ?? existing?.images.node ?? DEFAULT_NODE_IMAGE,
  };
}

async function prepareTls(input: {
  readonly runtime: Runtime;
  readonly domain: string;
  readonly existing: RelayState | null;
  readonly dryRun: boolean;
}): Promise<TlsConfig> {
  const { runtime, domain, existing } = input;
  if (runtime.flags.tlsCert !== null && runtime.flags.tlsKey !== null) {
    validateCertificatePair({
      certPath: runtime.flags.tlsCert,
      keyPath: runtime.flags.tlsKey,
      domain,
    });
    if (input.dryRun) {
      return {
        mode: "files",
        certPath: runtime.flags.tlsCert,
        keyPath: runtime.flags.tlsKey,
      };
    }
    await ensureInstallDir(runtime.installDir);
    const copied = await copyTlsFiles({
      installDir: runtime.installDir,
      certPath: runtime.flags.tlsCert,
      keyPath: runtime.flags.tlsKey,
    });
    return { mode: "files", ...copied };
  }
  if (existing !== null && existing.tls.mode === "files") {
    const certPath = existing.tls.certPath;
    const keyPath = existing.tls.keyPath;
    if (certPath !== undefined && keyPath !== undefined && (await pathExists(certPath))) {
      validateCertificatePair({ certPath, keyPath, domain });
      return existing.tls;
    }
    fail("The existing TLS certificate files are missing; pass --tls-cert and --tls-key again.");
  }
  return { mode: "on-demand" };
}

async function ensureDocker(runtime: Runtime): Promise<void> {
  const available = await dockerAvailable(runtime.docker);
  if (available.ok) return;
  if (runtime.flags.installDocker) {
    runtime.output.stdout("Docker is not ready; installing it with the official script.");
    await installDocker({
      runner: runtime.docker,
      output: runtime.output,
    });
    const retry = await dockerAvailable(runtime.docker);
    if (retry.ok) return;
    fail(`Docker installation finished but is not usable: ${retry.detail}`);
  }
  fail(
    `Docker is not available: ${available.detail}\nInstall Docker, or pass --install-docker to run the official script.`,
  );
}

function printDns(runtime: Runtime, result: Awaited<ReturnType<typeof checkRelayDns>>): void {
  for (const line of result.records) runtime.output.stdout(`  ${line}`);
  if (result.skipped) {
    runtime.output.stdout("DNS check skipped.");
    return;
  }
  runtime.output.stdout(`DNS: ${result.detail}`);
}

async function preflight(input: {
  readonly runtime: Runtime;
  readonly upgrade: boolean;
  readonly domain: string;
}): Promise<RelayState | null> {
  const { runtime, domain } = input;
  if (runtime.platform !== "linux") {
    fail(
      "The VPS relay installer supports Linux only. Run it on the VPS, not on Windows or macOS.",
    );
  }
  if (!runtime.isRoot) {
    fail("This command needs root. Run it with sudo, or omit --no-sudo.");
  }

  const existing = await readState(runtime.stateFile);
  if (input.upgrade) {
    if (existing === null) fail(`No relay install found at ${runtime.installDir}. Run init first.`);
    if (existing.mode !== "docker") {
      fail(
        "This directory contains a native install. Use the AI-native runbook, not the Docker CLI.",
      );
    }
    if (existing.domain !== domain) {
      fail(
        `This relay is installed for ${existing.domain}; it cannot be changed to ${domain}. Uninstall and init again.`,
      );
    }
  } else if (existing !== null) {
    if (existing.mode !== "docker") {
      fail(
        "This directory contains a native install. Use the AI-native runbook, not the Docker CLI.",
      );
    }
    fail(`A relay is already installed at ${runtime.installDir}. Run upgrade instead.`);
  }

  await ensureDocker(runtime);

  if (!input.upgrade) {
    for (const port of [80, 443, 7001]) {
      if (!(await runtime.portAvailable(port))) {
        fail(
          `Port ${port} is already in use. This installer expects a fresh VPS with 80, 443 and 7001 free.`,
        );
      }
    }
  }

  if (!input.upgrade) {
    const dns = await checkRelayDns({
      domain,
      publicIp: runtime.flags.publicIp,
      skip: runtime.flags.skipDnsCheck,
      resolver: runtime.dns,
      localAddresses: runtime.localAddresses,
    });
    printDns(runtime, dns);
    if (!dns.ok) fail(dns.detail);
  }

  return existing;
}

function printSummary(input: {
  readonly runtime: Runtime;
  readonly state: RelayState;
  readonly showAdminKey: boolean;
}): void {
  const { runtime, state } = input;
  runtime.output.stdout("");
  runtime.output.stdout("Relay is ready.");
  runtime.output.stdout("");
  runtime.output.stdout(`  Relay URL:       ${state.portalUrl}`);
  runtime.output.stdout(`  Admin console:   ${state.portalUrl}/`);
  runtime.output.stdout(
    `  Admin key:       ${input.showAdminKey ? state.adminKey : "(unchanged; see deploy.json)"}`,
  );
  runtime.output.stdout(`  Host URL rule:   https://<hostId>.${state.domain}`);
  runtime.output.stdout(`  Install dir:     ${runtime.installDir}`);
  runtime.output.stdout(`  State file:      ${runtime.stateFile}`);
  runtime.output.stdout("");
  runtime.output.stdout("Next steps:");
  runtime.output.stdout("  1. Open the admin console and enter the admin key.");
  runtime.output.stdout(
    `  2. On the host, open Settings > Personal Network and enter ${state.portalUrl}.`,
  );
  runtime.output.stdout("  3. Guests add the host with the relay URL and the host key.");
  runtime.output.stdout("");
  runtime.output.stdout("The host needs frpc on PATH, or set T3CODE_FRPC_PATH.");
  runtime.output.stdout(
    `Back up ${runtime.installDir}/deploy.json and ${runtime.installDir}/data; losing the secret key breaks host-key reveal.`,
  );
}

function printPlan(input: { readonly runtime: Runtime; readonly state: RelayState }): void {
  const { runtime, state } = input;
  runtime.output.stdout("");
  runtime.output.stdout("Dry run. Nothing was changed.");
  runtime.output.stdout("");
  runtime.output.stdout(`  Relay URL:       ${state.portalUrl}`);
  runtime.output.stdout(`  Host URL rule:   https://<hostId>.${state.domain}`);
  runtime.output.stdout(`  Install dir:     ${runtime.installDir}`);
  runtime.output.stdout(
    `  Images:          caddy=${state.images.caddy} frps=${state.images.frps} node=${state.images.node}`,
  );
  runtime.output.stdout("");
  for (const file of ["compose.yaml", "Caddyfile", "frps.toml", "relay.env"]) {
    runtime.output.stdout(`Would write ${NodePath.join(runtime.installDir, file)}.`);
  }
  runtime.output.stdout("Would copy the bundled registry and admin console.");
  runtime.output.stdout("Would run docker compose up -d and wait for /v1/health.");
}

async function waitForStateHealth(
  runtime: Runtime,
  state: RelayState,
  attempts = runtime.healthAttempts,
): Promise<HealthWaitResult> {
  return waitForRelayHealth({
    relayUrl: state.portalUrl,
    fetchImpl: runtime.fetchImpl,
    sleep: runtime.sleep,
    attempts,
    intervalMs: runtime.healthIntervalMs,
  });
}

async function runInit(runtime: Runtime): Promise<number> {
  const domain = await resolveDomain(runtime);
  const email = await resolveEmail(runtime);
  await preflight({ runtime, upgrade: false, domain });

  const tls = await prepareTls({ runtime, domain, existing: null, dryRun: runtime.flags.dryRun });
  const state = createState({
    domain,
    email,
    tls,
    images: resolveImages(runtime, null),
    now: runtime.now(),
  });

  if (runtime.flags.dryRun) {
    printPlan({ runtime, state });
    return 0;
  }

  await ensureInstallDir(runtime.installDir);
  await writeStackFiles(runtime.installDir, state);
  await copyAssets({
    installDir: runtime.installDir,
    registrySource: runtime.layout.registrySource,
    portalSource: runtime.layout.portalSource,
  });
  await NodeFSP.chmod(runtime.installDir, 0o755).catch(() => {});
  await NodeFSP.mkdir(NodePath.join(runtime.installDir, "data"), { recursive: true });

  assertComposeResult(
    await composeConfig(runtime.docker, runtime.installDir),
    "docker compose config",
  );
  await writeState(runtime.stateFile, state);
  try {
    assertComposeResult(await composeUp(runtime.docker, runtime.installDir), "docker compose up");
  } catch (cause) {
    throw new CliError(
      `${(cause as Error).message}\nThe install state is at ${runtime.stateFile}; run \`t3relay upgrade\` to retry or \`t3relay uninstall\`.`,
    );
  }
  runtime.output.stdout("Started the relay containers.");

  const health = await waitForStateHealth(runtime, state);
  if (!health.ok) {
    runtime.output.stderr(`Health check failed: ${health.detail}`);
    runtime.output.stderr("Check the logs with `t3relay logs`.");
    return 1;
  }
  const portal = await checkPortal({ relayUrl: state.portalUrl, fetchImpl: runtime.fetchImpl });
  if (!portal.ok) runtime.output.stderr(`warning: ${portal.detail}`);
  printSummary({ runtime, state, showAdminKey: true });
  return 0;
}

async function runUpgrade(runtime: Runtime): Promise<number> {
  const current = await readState(runtime.stateFile);
  if (current === null) fail(`No relay install found at ${runtime.installDir}. Run init first.`);
  const domain = runtime.flags.domain ?? current.domain;
  if (domain !== current.domain) {
    fail(
      `This relay is installed for ${current.domain}; it cannot be changed to ${domain}. Uninstall and init again.`,
    );
  }
  await preflight({ runtime, upgrade: true, domain });

  const email = runtime.flags.email ?? current.email;
  const tls = await prepareTls({
    runtime,
    domain,
    existing: current,
    dryRun: runtime.flags.dryRun,
  });
  const images = resolveImages(runtime, current);
  let next = touchState({ ...current, email, tls, images }, runtime.now());
  if (runtime.flags.rotateAdminKey) next = rotateAdminKey(next, runtime.now());

  if (runtime.flags.dryRun) {
    printPlan({ runtime, state: next });
    return 0;
  }

  const stopped = await composeRun(runtime.docker, runtime.installDir, ["stop", "registry"]);
  if (stopped.code !== 0) {
    runtime.output.stdout("Registry was not running; backing up the data directory anyway.");
  }
  const backup = await backupData({ installDir: runtime.installDir, timestamp: runtime.now() });
  await pruneBackups(runtime.installDir);
  runtime.output.stdout(`Backed up the current relay to ${backup}.`);

  await writeStackFiles(runtime.installDir, next);
  await copyAssets({
    installDir: runtime.installDir,
    registrySource: runtime.layout.registrySource,
    portalSource: runtime.layout.portalSource,
  });

  try {
    assertComposeResult(
      await composeConfig(runtime.docker, runtime.installDir),
      "docker compose config",
    );
    await writeState(runtime.stateFile, next);

    const pull = await composeRun(runtime.docker, runtime.installDir, ["pull", "--quiet"]);
    if (pull.code !== 0) {
      runtime.output.stdout(
        "Image pull failed; continuing with the images already on this host. Check the image overrides.",
      );
    }
    assertComposeResult(
      await composeUp(runtime.docker, runtime.installDir, { forceRecreate: true }),
      "docker compose up",
    );
  } catch (cause) {
    throw new CliError(
      `${(cause as Error).message}\nThe previous files are in ${backup}. Restore them and run \`docker compose up -d\` to roll back.`,
    );
  }
  runtime.output.stdout("Upgraded the relay containers.");

  const health = await waitForStateHealth(runtime, next);
  if (!health.ok) {
    runtime.output.stderr(`Health check failed: ${health.detail}`);
    runtime.output.stderr(
      `The previous state is in ${backup}. Check the logs with \`t3relay logs\`.`,
    );
    return 1;
  }
  printSummary({ runtime, state: next, showAdminKey: runtime.flags.rotateAdminKey });
  return 0;
}

async function runStatus(runtime: Runtime): Promise<number> {
  const state = await readState(runtime.stateFile);
  if (state === null) {
    runtime.output.stdout(`No relay install found at ${runtime.installDir}.`);
    return 1;
  }
  requireDockerState(state);
  runtime.output.stdout(`Relay:   ${state.portalUrl}`);
  runtime.output.stdout(`Domain:  ${state.domain}`);
  runtime.output.stdout(`Mode:    ${state.mode}`);
  runtime.output.stdout(
    `Images:  caddy=${state.images.caddy} frps=${state.images.frps} node=${state.images.node}`,
  );
  runtime.output.stdout("");
  const docker = await dockerAvailable(runtime.docker);
  if (docker.ok) {
    const ps = await composePs(runtime.docker, runtime.installDir);
    runtime.output.stdout(
      ps.stdout.trim() || ps.stderr.trim() || "docker compose ps returned no output.",
    );
  } else {
    runtime.output.stdout(`Docker: ${docker.detail}`);
  }
  const health = await waitForStateHealth(runtime, state, 3);
  runtime.output.stdout(`Health: ${health.detail}`);
  return health.ok ? 0 : 1;
}

interface DoctorCheck {
  readonly label: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

async function checkCertificate(domain: string): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const socket = NodeTls.connect(
      { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
      () => {
        const certificate = socket.getPeerCertificate();
        const validTo = certificate.valid_to;
        const expiry = validTo === undefined ? null : new Date(validTo);
        socket.end();
        if (expiry === null || Number.isNaN(expiry.getTime())) {
          resolve({ label: "certificate", status: "warn", detail: "no certificate metadata" });
          return;
        }
        // @effect-diagnostics-next-line globalDate:off -- Standalone certificate status check.
        const days = Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
        resolve({
          label: "certificate",
          status: days > 7 ? "ok" : days > 0 ? "warn" : "fail",
          detail: `expires ${expiry.toISOString()} (${days} days)`,
        });
      },
    );
    socket.setTimeout(10_000, () => {
      socket.destroy();
      resolve({ label: "certificate", status: "fail", detail: `could not reach ${domain}:443` });
    });
    socket.once("error", (cause) => {
      socket.destroy();
      resolve({ label: "certificate", status: "fail", detail: cause.message });
    });
  });
}

async function runDoctor(runtime: Runtime): Promise<number> {
  const checks: Array<DoctorCheck> = [];
  const state = await readState(runtime.stateFile);
  if (state === null) {
    runtime.output.stdout(`No relay install found at ${runtime.installDir}.`);
    return 1;
  }
  requireDockerState(state);
  runtime.output.stdout(`T3 Code personal relay doctor (${state.domain})`);

  const docker = await dockerAvailable(runtime.docker);
  checks.push({
    label: "docker",
    status: docker.ok ? "ok" : "fail",
    detail: docker.detail,
  });
  checks.push({
    label: "state",
    status: "ok",
    detail: `${runtime.stateFile} (${state.mode})`,
  });

  const ps = docker.ok
    ? await composePs(runtime.docker, runtime.installDir)
    : { code: 1, stdout: "", stderr: docker.detail };
  checks.push({
    label: "containers",
    status: ps.code === 0 ? "ok" : "fail",
    detail:
      ps.code === 0 ? "docker compose ps answered" : ps.stderr.trim() || "docker compose ps failed",
  });

  const health = await waitForStateHealth(runtime, state, 3);
  checks.push({ label: "health", status: health.ok ? "ok" : "fail", detail: health.detail });

  const portal = await checkPortal({ relayUrl: state.portalUrl, fetchImpl: runtime.fetchImpl });
  checks.push({ label: "portal", status: portal.ok ? "ok" : "fail", detail: portal.detail });

  const dns = await checkRelayDns({
    domain: state.domain,
    publicIp: runtime.flags.publicIp,
    skip: runtime.flags.skipDnsCheck,
    resolver: runtime.dns,
    localAddresses: runtime.localAddresses,
  });
  checks.push({
    label: "dns",
    status: dns.ok ? (dns.skipped || dns.detail.includes("not both") ? "warn" : "ok") : "fail",
    detail: dns.detail,
  });

  checks.push(await checkCertificate(state.domain));

  runtime.output.stdout("");
  for (const check of checks)
    runtime.output.stdout(`  [${check.status}] ${check.label}: ${check.detail}`);
  runtime.output.stdout("");
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  runtime.output.stdout(
    failures === 0
      ? `Ready${warnings === 0 ? "." : ` with ${warnings} warning(s).`}`
      : `${failures} problem(s) need fixing.`,
  );
  return failures === 0 ? 0 : 1;
}

async function runLogs(runtime: Runtime): Promise<number> {
  const state = await readState(runtime.stateFile);
  if (state === null) {
    runtime.output.stdout(`No relay install found at ${runtime.installDir}.`);
    return 1;
  }
  requireDockerState(state);
  const result = await composeLogs(runtime.docker, runtime.installDir, runtime.flags.tail);
  return result.code;
}

async function runUninstall(runtime: Runtime): Promise<number> {
  const state = await readState(runtime.stateFile);
  if (state === null && !(await pathExists(NodePath.join(runtime.installDir, "compose.yaml")))) {
    runtime.output.stdout(`No relay install found at ${runtime.installDir}.`);
    return 0;
  }
  if (state !== null) requireDockerState(state);
  const down = await composeDown(runtime.docker, runtime.installDir).catch((cause: unknown) => {
    runtime.output.stderr(`docker compose down could not run: ${(cause as Error).message}`);
    return { code: 1, stdout: "", stderr: "" };
  });
  if (down.code !== 0) {
    runtime.output.stderr(
      down.stderr.trim() || "docker compose down failed; continuing with files.",
    );
  } else {
    runtime.output.stdout("Stopped the relay containers.");
  }
  if (runtime.flags.purge) {
    await NodeFSP.rm(runtime.installDir, { recursive: true, force: true });
    runtime.output.stdout(`Removed ${runtime.installDir}.`);
  } else {
    runtime.output.stdout(
      `Kept ${runtime.installDir}. Back up deploy.json and data before removing it; use --purge to delete.`,
    );
  }
  return 0;
}

async function runPrompt(runtime: Runtime): Promise<number> {
  const promptPath = NodePath.join(runtime.layout.nativeDirectory, "PROMPT.md");
  let prompt: string;
  try {
    prompt = await NodeFSP.readFile(promptPath, "utf8");
  } catch {
    prompt = renderPrompt({
      version: runtime.layout.packageVersion,
      releaseUrl: runtime.layout.releaseUrl,
      packageName: runtime.layout.packageName,
    });
  }
  runtime.output.stdout(
    prompt
      .replaceAll("{{VERSION}}", runtime.layout.packageVersion)
      .replaceAll("{{RELEASE_URL}}", runtime.layout.releaseUrl)
      .replaceAll("{{PACKAGE_NAME}}", runtime.layout.packageName)
      .trimEnd(),
  );
  return 0;
}

export async function runDeployCli(
  argv: ReadonlyArray<string>,
  dependencies: CliDependencies,
): Promise<number> {
  let flags: DeployFlags;
  try {
    flags = parseDeployFlags(argv);
  } catch (cause) {
    if (cause instanceof DeployFlagError) {
      dependencies.stderr(cause.message);
      dependencies.stderr("Run with --help for the options.");
      return 2;
    }
    throw cause;
  }

  if (flags.command === "help" || flags.help) {
    dependencies.stdout(DEPLOY_USAGE.trimEnd());
    return 0;
  }
  if (flags.command === "version") {
    dependencies.stdout(dependencies.layout.packageVersion);
    return 0;
  }

  const isRoot =
    dependencies.isRoot ?? (() => typeof process.getuid === "function" && process.getuid() === 0);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The standalone CLI needs the host platform.
  const platform = dependencies.platform ?? process.platform;
  const installDir = NodePath.resolve(flags.installDir);
  const runtime: Runtime = {
    flags,
    layout: dependencies.layout,
    output: { stdout: dependencies.stdout, stderr: dependencies.stderr },
    env: dependencies.env ?? process.env,
    now: dependencies.now ?? defaultNow,
    fetchImpl: dependencies.fetchImpl ?? defaultFetch,
    sleep: dependencies.sleep ?? defaultSleep,
    docker: dependencies.docker ?? defaultDockerRunner(flags.verbose, dependencies.stdout),
    dns: dependencies.dns ?? systemDnsResolver,
    prompt: dependencies.prompt ?? defaultPrompt,
    installDir,
    stateFile: stateFile(installDir),
    interactive: !flags.yes,
    verbose: flags.verbose,
    healthAttempts: dependencies.healthAttempts ?? 30,
    healthIntervalMs: dependencies.healthIntervalMs ?? 2_000,
    isRoot: isRoot(),
    platform,
    localAddresses: dependencies.localAddresses?.() ?? publicAddresses(),
    portAvailable: dependencies.portAvailable ?? canBindPort,
  };

  if (flags.command === "prompt") return runPrompt(runtime);

  if (
    ROOT_COMMANDS.has(flags.command) &&
    !runtime.isRoot &&
    !flags.noSudo &&
    platform === "linux"
  ) {
    try {
      return await (dependencies.sudo ?? defaultSudo)(argv);
    } catch (cause) {
      dependencies.stderr(
        `Could not re-run with sudo: ${(cause as Error).message}\nRun this command as root, or pass --no-sudo.`,
      );
      return 1;
    }
  }

  try {
    switch (flags.command) {
      case "init":
        return await runInit(runtime);
      case "upgrade":
        return await runUpgrade(runtime);
      case "doctor":
        return await runDoctor(runtime);
      case "status":
        return await runStatus(runtime);
      case "logs":
        return await runLogs(runtime);
      case "uninstall":
        return await runUninstall(runtime);
      default:
        return 0;
    }
  } catch (cause) {
    if (
      cause instanceof CliError ||
      cause instanceof RelayStateError ||
      cause instanceof DeployFlagError
    ) {
      dependencies.stderr(`error: ${cause.message}`);
      return 1;
    }
    dependencies.stderr(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  // @effect-diagnostics-next-line globalFetch:off -- The standalone CLI is not Effect code.
  return globalThis.fetch(input, init);
}

function defaultDockerRunner(verbose: boolean, stdout: (line: string) => void): CommandRunner {
  return {
    async run(command, args, options) {
      if (verbose) stdout(`$ ${command} ${args.join(" ")}`);
      return nativeCommandRunner.run(command, args, options);
    },
  };
}
