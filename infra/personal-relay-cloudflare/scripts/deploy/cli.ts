// @effect-diagnostics nodeBuiltinImport:off -- The deploy CLI runs outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadlinePromises from "node:readline/promises";
import * as NodeTimersPromises from "node:timers/promises";

import type { CloudflareZone, DeployFetch } from "./cloudflare.ts";
import { CloudflareApiError, CloudflareClient } from "./cloudflare.ts";
import { buildDeployConfig, parseJsonc, serializeDeployConfig } from "./config.ts";
import { hostZoneCandidates, validateHostsDomain } from "./domain.ts";
import { DeployFlagError, parseDeployFlags, type DeployFlags, DEPLOY_USAGE } from "./flags.ts";
import { waitForRelayHealth } from "./health.ts";
import type { CommandOutput } from "./process.ts";
import type { SecretMode, StoredSecrets } from "./secrets.ts";
import {
  DeploySecretsError,
  readSecretsFile,
  resolveDeploySecrets,
  writeSecretsFile,
} from "./secrets.ts";
import type { DeployDependencies, DeploySecrets, WranglerRunner } from "./types.ts";

const WORKERS_DEV_URL = /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev\b/iu;
const TAIL_LINES = 6;

export interface DeployLayout {
  readonly root: string;
  readonly workerScript: string;
  readonly configTemplatePath: string;
  readonly generatedConfigPath: (workerName: string) => string;
  readonly portalDirectory: string;
  readonly defaultSecretsFile: (workerName: string) => string;
  /** Null when the package ships a prebuilt portal and there is nothing to build. */
  readonly buildPortal: ((output: CommandOutput) => Promise<void>) | null;
  readonly packageVersion: string;
}

export interface DeployCliDependencies extends DeployDependencies {
  readonly layout: DeployLayout;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: DeployFetch;
  readonly now?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly prompt?: (question: string) => Promise<string>;
  readonly cwd?: string;
  readonly healthAttempts?: number;
  readonly healthIntervalMs?: number;
}

export class DeployCliError extends Error {
  override name = "DeployCliError";
}

interface Runtime {
  readonly flags: DeployFlags;
  readonly layout: DeployLayout;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: DeployFetch;
  readonly now: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly prompt: (question: string) => Promise<string>;
  readonly wrangler: WranglerRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly cwd: string;
  readonly secretsFile: string;
  readonly interactive: boolean;
  readonly healthAttempts: number;
  readonly healthIntervalMs: number;
}

interface ResolvedMode {
  readonly mode: SecretMode;
  readonly zone: CloudflareZone | null;
  readonly hostsSuffix: string | null;
  readonly multiLevel: boolean;
}

function defaultNow(): string {
  // @effect-diagnostics-next-line globalDate:off -- The standalone CLI timestamps files outside Effect.
  return new Date().toISOString();
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  // @effect-diagnostics-next-line globalFetch:off -- The standalone CLI is not Effect code.
  return globalThis.fetch(input, init);
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

function tail(text: string): string {
  return text.trim().split(/\r?\n/u).slice(-TAIL_LINES).join("\n");
}

function fail(message: string): never {
  throw new DeployCliError(message);
}

function deployToken(runtime: Runtime): string | null {
  return envValue(runtime, "CLOUDFLARE_API_TOKEN");
}

function runtimeToken(runtime: Runtime): string | null {
  return envValue(runtime, "T3CODE_CF_API_TOKEN") ?? deployToken(runtime);
}

function apiFor(runtime: Runtime, token: string): CloudflareClient {
  return new CloudflareClient({ token, fetchImpl: runtime.fetchImpl });
}

async function runWrangler(
  runtime: Runtime,
  args: ReadonlyArray<string>,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  const result = await runtime.wrangler.run(args, { cwd: runtime.layout.root });
  return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
}

async function readConfigTemplate(runtime: Runtime): Promise<Record<string, unknown>> {
  try {
    return parseJsonc(
      await NodeFSP.readFile(runtime.layout.configTemplatePath, "utf8"),
      runtime.layout.configTemplatePath,
    );
  } catch (cause) {
    fail(`Could not read the Worker template: ${(cause as Error).message}`);
  }
}

async function requireWrangler(
  runtime: Runtime,
  args: ReadonlyArray<string>,
  label: string,
): Promise<string> {
  const result = await runWrangler(runtime, args);
  if (!result.ok) {
    const detail = tail(result.stderr || result.stdout);
    fail(`${label} failed.${detail === "" ? "" : `\n${detail}`}`);
  }
  return result.stdout;
}

interface WhoAmI {
  readonly accountId: string;
  readonly accounts: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
}

function parseWhoAmI(stdout: string): WhoAmI | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) parsed = { accounts: parsed };
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const rawAccounts = Array.isArray(record.accounts) ? record.accounts : [];
  const accounts = rawAccounts.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const account = entry as Record<string, unknown>;
    if (typeof account.id !== "string" || account.id.trim() === "") return [];
    return [
      {
        id: account.id.trim(),
        ...(typeof account.name === "string" ? { name: account.name } : {}),
      },
    ];
  });
  const direct =
    typeof record.account === "object" && record.account !== null
      ? (record.account as Record<string, unknown>).id
      : undefined;
  const accountId =
    typeof direct === "string" && direct.trim() !== ""
      ? direct.trim()
      : accounts.length === 1
        ? (accounts[0]?.id ?? "")
        : "";
  return { accountId, accounts };
}

async function resolveAccount(runtime: Runtime): Promise<WhoAmI> {
  const fromEnv = envValue(runtime, "CLOUDFLARE_ACCOUNT_ID");
  const whoami = await runWrangler(runtime, ["whoami", "--json"]);
  if (!whoami.ok && fromEnv === null) {
    const detail = tail(whoami.stderr || whoami.stdout);
    fail(
      `Wrangler is not authenticated. Run \`wrangler login\` or set CLOUDFLARE_API_TOKEN.${detail === "" ? "" : `\n${detail}`}`,
    );
  }
  const parsed = whoami.ok ? parseWhoAmI(whoami.stdout) : null;
  if (fromEnv !== null) {
    return { accountId: fromEnv, accounts: parsed?.accounts ?? [] };
  }
  if (parsed === null || parsed.accountId === "") {
    fail(
      parsed !== null && parsed.accounts.length > 1
        ? `This token can reach ${parsed.accounts.length} accounts. Set CLOUDFLARE_ACCOUNT_ID to one of: ${parsed.accounts
            .map((account) => account.id)
            .join(", ")}`
        : "Could not resolve a Cloudflare account. Set CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  return parsed;
}

async function ensurePortal(runtime: Runtime): Promise<void> {
  const indexHtml = `${runtime.layout.portalDirectory}/index.html`;
  const build = runtime.layout.buildPortal;
  if (runtime.flags.noPortalBuild || build === null) {
    try {
      await NodeFSP.access(indexHtml);
    } catch {
      fail(
        `The portal build is missing at ${runtime.layout.portalDirectory}. Rebuild it without --no-portal-build.`,
      );
    }
    return;
  }
  runtime.stdout("Building the admin console portal...");
  await build({ stdout: runtime.stdout, stderr: runtime.stderr });
  try {
    await NodeFSP.access(indexHtml);
  } catch {
    fail(`The portal build did not produce ${indexHtml}.`);
  }
}

async function resolveMode(runtime: Runtime, accountId: string): Promise<ResolvedMode> {
  const flags = runtime.flags;
  const wantsNamed =
    flags.mode === "named" || (flags.mode === "auto" && flags.hostsDomain !== null);

  if (!wantsNamed) {
    if (flags.mode === "quick" && flags.hostsDomain !== null) {
      runtime.stdout("Quick mode ignores --hosts-domain; host URLs come from trycloudflare.com.");
    }
    return { mode: "quick", zone: null, hostsSuffix: null, multiLevel: false };
  }

  const hostsDomain = flags.hostsDomain;
  if (hostsDomain === null) {
    fail("Named mode needs --hosts-domain <zone>, for example --hosts-domain example.com.");
  }
  const token = deployToken(runtime);
  if (token === null) {
    fail(
      "Named mode needs CLOUDFLARE_API_TOKEN with Zone Read (and Tunnel Edit for cleanup). Quick mode works with only a wrangler login.",
    );
  }

  const api = apiFor(runtime, token);
  const zones: Array<CloudflareZone> = [];
  for (const candidate of hostZoneCandidates(hostsDomain)) {
    const zone = await api.findZone({ name: candidate, accountId });
    if (zone !== null) zones.push(zone);
  }
  const check = validateHostsDomain({
    hostsDomain,
    zoneNames: zones.map((zone) => zone.name),
    allowMultiLevel: flags.allowMultiLevel,
  });
  const zone = zones.find((entry) => entry.name === check.zoneName) ?? null;
  if (zone === null) fail(`Could not read the ${check.zoneName} zone.`);

  if (check.multiLevel) {
    runtime.stdout(
      `Warning: ${hostsDomain} sits below the ${zone.name} zone. Hostnames need ACM/Total TLS enabled.`,
    );
  }

  const zeroTrust = await api.zeroTrustOrganization(accountId);
  if (zeroTrust.status === "disabled") {
    fail(
      "Zero Trust is not enabled for this account. Named tunnels need a Zero Trust organization (the Free plan still asks for payment details). Enable it in the Cloudflare dashboard, or use --mode quick.",
    );
  }
  if (zeroTrust.status === "unknown") {
    runtime.stdout(
      `Warning: could not confirm Zero Trust access (${zeroTrust.detail}). Named tunnels fail until it is enabled.`,
    );
  }

  return { mode: "named", zone, hostsSuffix: check.hostsDomain, multiLevel: check.multiLevel };
}

function deployVars(
  runtime: Runtime,
  accountId: string,
  mode: ResolvedMode,
): Record<string, string> {
  const vars: Record<string, string> = {
    T3CODE_TUNNEL_MODE: mode.mode,
    TUNNEL_PREFIX: runtime.flags.workerName,
    T3CODE_MAX_HOSTS: String(runtime.flags.maxHosts),
    T3CODE_HEARTBEAT_INTERVAL_MS: "60000",
    T3CODE_HEARTBEAT_TTL_MS: "180000",
  };
  if (mode.mode === "named" && mode.zone !== null && mode.hostsSuffix !== null) {
    vars.T3CODE_CF_ACCOUNT_ID = accountId;
    vars.T3CODE_CF_ZONE_ID = mode.zone.id;
    vars.T3CODE_HOSTS_SUFFIX = mode.hostsSuffix;
  }
  return vars;
}

async function relayUrlBeforeDeploy(runtime: Runtime, accountId: string): Promise<string | null> {
  if (runtime.flags.relayDomain !== null) return `https://${runtime.flags.relayDomain}`;
  const token = deployToken(runtime);
  if (token === null) return null;
  try {
    const subdomain = await apiFor(runtime, token).workersSubdomain(accountId);
    return subdomain === null
      ? null
      : `https://${runtime.flags.workerName}.${subdomain}.workers.dev`;
  } catch {
    return null;
  }
}

async function putSecret(
  runtime: Runtime,
  configPath: string,
  name: string,
  value: string,
): Promise<void> {
  if (runtime.flags.dryRun) {
    runtime.stdout(`Would set the Worker secret ${name}.`);
    return;
  }
  const result = await runtime.wrangler.run(["secret", "put", name, "--config", configPath], {
    cwd: runtime.layout.root,
    input: `${value}\n`,
  });
  if (result.code !== 0) {
    fail(
      `Could not set ${name}.${tail(result.stderr || result.stdout) === "" ? "" : `\n${tail(result.stderr || result.stdout)}`}`,
    );
  }
  runtime.stdout(`Set the Worker secret ${name}.`);
}

function printSummary(input: {
  readonly runtime: Runtime;
  readonly relayUrl: string | null;
  readonly mode: ResolvedMode;
  readonly secrets: StoredSecrets | null;
  readonly secretsFile: string;
}): void {
  const { runtime, relayUrl, mode, secrets } = input;
  const consoleUrl = relayUrl ?? "(resolved after deploy)";
  const hostRule =
    mode.mode === "named" && mode.hostsSuffix !== null
      ? `https://<hostId>.${mode.hostsSuffix}`
      : "https://<random>.trycloudflare.com (temporary, reported by the host)";

  runtime.stdout("");
  runtime.stdout(
    runtime.flags.dryRun ? "Dry run complete. Nothing was changed." : "Deploy complete.",
  );
  runtime.stdout("");
  runtime.stdout(`  Relay URL:       ${consoleUrl}`);
  runtime.stdout(`  Admin console:   ${relayUrl === null ? consoleUrl : `${consoleUrl}/`}`);
  runtime.stdout(
    `  Admin key:       ${runtime.flags.dryRun ? "(not generated in a dry run)" : (secrets?.adminKey ?? "(see the secrets file)")}`,
  );
  runtime.stdout(
    `  Enrollment key:  ${runtime.flags.dryRun ? "(not generated in a dry run)" : (secrets?.enrollKey ?? "(see the secrets file)")}`,
  );
  runtime.stdout(`  Host URL rule:   ${hostRule}`);
  runtime.stdout(`  Secrets file:    ${input.secretsFile}`);
  runtime.stdout("");
  runtime.stdout("Next steps:");
  runtime.stdout("  1. Open the admin console and enter the admin key.");
  runtime.stdout(
    "  2. On the host, open Settings > Personal Network and enter the relay URL and the enrollment key.",
  );
  runtime.stdout("  3. Guests add the host with the relay URL and the host key.");
  runtime.stdout("");
  runtime.stdout("Hosts only ever receive the enrollment key. Keep the admin key off hosts.");
  if (mode.mode === "quick") {
    runtime.stdout(
      "Quick tunnels are temporary. Use --mode named with a domain for stable host URLs.",
    );
  }
  runtime.stdout(`Back up ${input.secretsFile}; losing the secret key breaks host-key reveal.`);
}

async function runDeploy(runtime: Runtime): Promise<number> {
  const flags = runtime.flags;
  runtime.stdout(
    `T3 Code Cloudflare relay ${runtime.layout.packageVersion} (${flags.dryRun ? "dry run" : "deploy"})`,
  );

  const template = await readConfigTemplate(runtime);
  const account = await resolveAccount(runtime);
  const mode = await resolveMode(runtime, account.accountId);
  await ensurePortal(runtime);

  const existing = await readSecretsFile(runtime.secretsFile);
  const initialRelayUrl = await relayUrlBeforeDeploy(runtime, account.accountId);
  const metadata = {
    workerName: flags.workerName,
    tunnelPrefix: flags.workerName,
    mode: mode.mode,
    hostsSuffix: mode.hostsSuffix,
    zoneId: mode.zone?.id ?? null,
    accountId: account.accountId,
    relayUrl: existing?.relayUrl ?? initialRelayUrl,
  } satisfies Omit<StoredSecrets, keyof DeploySecrets | "updatedAt">;

  let resolved;
  try {
    resolved = await resolveDeploySecrets(
      {
        existing,
        upgrade: flags.upgrade,
        rotateKeys: flags.rotateKeys,
        interactive: runtime.interactive,
        prompt: runtime.prompt,
        metadata,
      },
      runtime.now(),
    );
  } catch (cause) {
    if (cause instanceof DeploySecretsError) fail(cause.message);
    throw cause;
  }

  const secrets = resolved.secrets;
  if (resolved.action === "created") {
    runtime.stdout(
      flags.dryRun
        ? "Would generate a new admin key, secret key and enrollment key."
        : "Generated a new admin key, secret key and enrollment key.",
    );
  } else if (resolved.action === "reused") {
    runtime.stdout(`Reusing the keys in ${runtime.secretsFile}.`);
    if (!flags.upgrade) {
      runtime.stdout("Pass --rotate-keys to replace the admin and enrollment keys.");
    }
  } else if (resolved.action === "rotated") {
    runtime.stdout("Rotated the admin and enrollment keys. The secret key is unchanged.");
  } else {
    runtime.stdout("Using the keys you entered.");
    if (resolved.secretKeyReplaced) {
      runtime.stdout(
        "Warning: a new secret key means host keys registered with the old one can no longer be revealed.",
      );
    }
  }

  if (!flags.dryRun) {
    await writeSecretsFile(runtime.secretsFile, secrets);
    runtime.stdout(`Wrote ${runtime.secretsFile}. Keep it out of version control.`);
  } else {
    runtime.stdout(`Would write ${runtime.secretsFile}.`);
  }

  const config = buildDeployConfig({
    template,
    workerName: flags.workerName,
    main: runtime.layout.workerScript,
    portalDirectory: runtime.layout.portalDirectory,
    vars: deployVars(runtime, account.accountId, mode),
    relayDomain: flags.relayDomain,
  });
  const configPath = runtime.layout.generatedConfigPath(flags.workerName);
  if (flags.dryRun) {
    runtime.stdout(`Would write the deploy config to ${configPath}.`);
  } else {
    await NodeFSP.mkdir(runtime.layout.root, { recursive: true });
    await NodeFSP.writeFile(
      runtime.layout.generatedConfigPath(flags.workerName),
      serializeDeployConfig(config),
    );
    runtime.stdout(`Wrote the deploy config to ${configPath}.`);
  }

  let relayUrl = initialRelayUrl;
  if (flags.dryRun) {
    runtime.stdout(`Would run wrangler deploy --config ${configPath}.`);
  } else {
    const deployed = await runWrangler(runtime, ["deploy", "--config", configPath]);
    if (!deployed.ok) {
      fail(`wrangler deploy failed.\n${tail(deployed.stderr || deployed.stdout)}`);
    }
    if (relayUrl === null) {
      relayUrl = deployed.stdout.match(WORKERS_DEV_URL)?.[0] ?? null;
    }
    runtime.stdout("Deployed the Worker and its Durable Object.");
  }

  const values: Array<[string, string]> = [
    ["T3CODE_ADMIN_KEY", secrets.adminKey],
    ["T3CODE_SECRET_KEY", secrets.secretKey],
    ["T3CODE_ENROLL_KEY", secrets.enrollKey],
  ];
  const cfToken = runtimeToken(runtime);
  if (cfToken !== null) values.push(["T3CODE_CF_API_TOKEN", cfToken]);
  for (const [name, value] of values) {
    await putSecret(runtime, configPath, name, value);
  }
  if (mode.mode === "named" && cfToken === null) {
    runtime.stdout(
      "Warning: named mode needs T3CODE_CF_API_TOKEN at runtime. Set CLOUDFLARE_API_TOKEN or T3CODE_CF_API_TOKEN and redeploy.",
    );
  }

  if (relayUrl === null) {
    runtime.stdout(
      "Could not resolve the relay URL. Read it from the wrangler deploy output or the dashboard.",
    );
  } else if (!flags.dryRun) {
    const finalSecrets: StoredSecrets = {
      ...secrets,
      relayUrl,
      mode: mode.mode,
      hostsSuffix: mode.hostsSuffix,
      zoneId: mode.zone?.id ?? null,
      accountId: account.accountId,
      updatedAt: runtime.now(),
    };
    await writeSecretsFile(runtime.secretsFile, finalSecrets);
  }

  let healthOk = true;
  if (relayUrl !== null && flags.dryRun) {
    runtime.stdout(`Would wait for ${relayUrl}/v1/health.`);
  } else if (relayUrl !== null) {
    runtime.stdout(`Waiting for ${relayUrl}/v1/health ...`);
    const health = await waitForRelayHealth({
      relayUrl,
      fetchImpl: runtime.fetchImpl,
      sleep: runtime.sleep,
      attempts: runtime.healthAttempts,
      intervalMs: runtime.healthIntervalMs,
    });
    healthOk = health.ok;
    runtime.stdout(
      health.ok ? "The relay reports healthy." : `Health check failed: ${health.detail}`,
    );
  }

  printSummary({ runtime, relayUrl, mode, secrets, secretsFile: runtime.secretsFile });
  return healthOk ? 0 : 1;
}

async function runDestroy(runtime: Runtime): Promise<number> {
  const flags = runtime.flags;
  runtime.stdout(
    `Destroying the T3 Code Cloudflare relay ${flags.workerName}${flags.dryRun ? " (dry run)" : ""}.`,
  );

  const existing = await readSecretsFile(runtime.secretsFile);
  if (existing === null) {
    runtime.stdout(`No secrets file at ${runtime.secretsFile}; continuing.`);
  }
  const account = await resolveAccount(runtime);
  const token = runtimeToken(runtime);
  const prefix = existing?.tunnelPrefix ?? flags.workerName;

  if (token === null) {
    runtime.stdout(
      "No Cloudflare API token. Skipping tunnel and DNS cleanup; only the Worker is removed.",
    );
  } else {
    const api = apiFor(runtime, token);
    let zoneId = existing?.zoneId ?? null;
    if (zoneId === null && existing?.hostsSuffix != null) {
      const zone = await api.findZone({
        name: existing.hostsSuffix,
        accountId: account.accountId,
      });
      zoneId = zone?.id ?? null;
    }

    const tunnels = (await api.listTunnels(account.accountId)).filter((tunnel) =>
      tunnel.name.startsWith(`${prefix}-`),
    );
    if (tunnels.length === 0) runtime.stdout(`No tunnels with the ${prefix}- prefix.`);

    for (const tunnel of tunnels) {
      if (flags.dryRun) {
        runtime.stdout(`Would delete the tunnel ${tunnel.name}.`);
        continue;
      }
      if (zoneId !== null) {
        const target = `${tunnel.id}.cfargotunnel.com`;
        for (const record of await api.listDnsRecords(zoneId)) {
          if (record.content === target) {
            await api.deleteDnsRecord(zoneId, record.id);
            runtime.stdout(`Deleted the DNS record ${record.name}.`);
          }
        }
      }
      await api.deleteTunnel(account.accountId, tunnel.id);
      runtime.stdout(`Deleted the tunnel ${tunnel.name}.`);
    }
  }

  if (flags.dryRun) {
    runtime.stdout(`Would run wrangler delete --name ${flags.workerName}.`);
    runtime.stdout(`Would keep ${runtime.secretsFile}.`);
    return 0;
  }
  await requireWrangler(
    runtime,
    ["delete", "--name", flags.workerName, "--force"],
    "wrangler delete",
  );
  runtime.stdout(`Deleted the Worker ${flags.workerName}.`);
  runtime.stdout(`Kept ${runtime.secretsFile} so a later deploy can reuse the keys.`);
  return 0;
}

interface DoctorCheck {
  readonly label: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

async function runDoctor(runtime: Runtime): Promise<number> {
  const flags = runtime.flags;
  runtime.stdout(`T3 Code Cloudflare relay doctor ${runtime.layout.packageVersion}`);
  const checks: Array<DoctorCheck> = [];

  const version = await runWrangler(runtime, ["--version"]);
  checks.push({
    label: "wrangler",
    status: version.ok ? "ok" : "fail",
    detail: version.ok ? tail(version.stdout) : "wrangler is not runnable",
  });

  let accountId: string | null = null;
  const whoami = await runWrangler(runtime, ["whoami", "--json"]);
  if (whoami.ok) {
    const parsed = parseWhoAmI(whoami.stdout);
    accountId = envValue(runtime, "CLOUDFLARE_ACCOUNT_ID") ?? parsed?.accountId ?? null;
    checks.push({
      label: "authentication",
      status: accountId === null ? "warn" : "ok",
      detail:
        accountId === null
          ? "authenticated, but no account was resolved; set CLOUDFLARE_ACCOUNT_ID"
          : `account ${accountId}`,
    });
  } else {
    checks.push({
      label: "authentication",
      status: "fail",
      detail: "run `wrangler login` or set CLOUDFLARE_API_TOKEN",
    });
  }

  const deployKey = deployToken(runtime);
  const runtimeKey = runtimeToken(runtime);
  if (deployKey === null) {
    checks.push({
      label: "deploy token",
      status: "warn",
      detail:
        "not set; only a wrangler login session is available, so named mode cannot read zones",
    });
  } else {
    const verified = await apiFor(runtime, deployKey).verifyToken();
    checks.push({
      label: "deploy token",
      status: verified.ok ? "ok" : "warn",
      detail: verified.detail,
    });
  }
  checks.push({
    label: "runtime token",
    status:
      runtimeKey === null
        ? flags.mode === "quick" || (flags.mode === "auto" && flags.hostsDomain === null)
          ? "warn"
          : "fail"
        : "ok",
    detail:
      runtimeKey === null
        ? "T3CODE_CF_API_TOKEN is not set; named mode needs Cloudflare Tunnel Edit and DNS Edit"
        : "Cloudflare Tunnel Edit and DNS Edit are required",
  });

  if (deployKey !== null && accountId !== null) {
    const api = apiFor(runtime, deployKey);
    const zeroTrust = await api.zeroTrustOrganization(accountId);
    checks.push({
      label: "Zero Trust",
      status:
        zeroTrust.status === "enabled" ? "ok" : zeroTrust.status === "disabled" ? "fail" : "warn",
      detail: zeroTrust.status === "enabled" ? "organization is reachable" : zeroTrust.detail,
    });

    if (flags.hostsDomain !== null) {
      const zones: Array<CloudflareZone> = [];
      for (const candidate of hostZoneCandidates(flags.hostsDomain)) {
        const zone = await api.findZone({ name: candidate, accountId });
        if (zone !== null) zones.push(zone);
      }
      try {
        const check = validateHostsDomain({
          hostsDomain: flags.hostsDomain,
          zoneNames: zones.map((zone) => zone.name),
          allowMultiLevel: flags.allowMultiLevel,
        });
        checks.push({
          label: "hosts domain",
          status: check.multiLevel ? "warn" : "ok",
          detail: check.multiLevel
            ? `${check.hostsDomain} is below ${check.zoneName}; ACM/Total TLS is required`
            : `${check.hostsDomain} is the ${check.zoneName} zone apex`,
        });
      } catch (cause) {
        checks.push({
          label: "hosts domain",
          status: "fail",
          detail: cause instanceof Error ? cause.message : "hosts domain is not usable",
        });
      }
    }
  }

  runtime.stdout("");
  for (const check of checks) {
    runtime.stdout(`  [${check.status}] ${check.label}: ${check.detail}`);
  }
  runtime.stdout("");

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  runtime.stdout(
    failures === 0
      ? `Ready${warnings === 0 ? "." : ` with ${warnings} warning(s).`}`
      : `${failures} problem(s) need fixing before a named deploy.`,
  );
  return failures === 0 ? 0 : 1;
}

export async function runDeployCli(
  argv: ReadonlyArray<string>,
  dependencies: DeployCliDependencies,
): Promise<number> {
  const stderr = dependencies.stderr;
  let flags: DeployFlags;
  try {
    flags = parseDeployFlags(argv);
  } catch (cause) {
    if (cause instanceof DeployFlagError) {
      stderr(cause.message);
      stderr("Run with --help for the options.");
      return 2;
    }
    throw cause;
  }

  if (flags.help) {
    dependencies.stdout(DEPLOY_USAGE);
    return 0;
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const runtime: Runtime = {
    flags,
    layout: dependencies.layout,
    env: dependencies.env ?? process.env,
    fetchImpl: dependencies.fetchImpl ?? defaultFetch,
    now: dependencies.now ?? defaultNow,
    sleep: dependencies.sleep ?? ((milliseconds) => NodeTimersPromises.setTimeout(milliseconds)),
    prompt: dependencies.prompt ?? defaultPrompt,
    wrangler: dependencies.wrangler,
    stdout: dependencies.stdout,
    stderr,
    cwd,
    secretsFile:
      flags.secretsFile === null
        ? dependencies.layout.defaultSecretsFile(flags.workerName)
        : NodePath.resolve(cwd, flags.secretsFile),
    interactive: !flags.yes,
    healthAttempts: dependencies.healthAttempts ?? 30,
    healthIntervalMs: dependencies.healthIntervalMs ?? 2_000,
  };

  try {
    if (flags.doctor) return await runDoctor(runtime);
    if (flags.destroy) return await runDestroy(runtime);
    return await runDeploy(runtime);
  } catch (cause) {
    if (cause instanceof DeployCliError) {
      stderr(`error: ${cause.message}`);
      return 1;
    }
    if (cause instanceof CloudflareApiError) {
      stderr(`error: Cloudflare API: ${cause.message}`);
      return 1;
    }
    if (cause instanceof DeploySecretsError) {
      stderr(`error: ${cause.message}`);
      return 1;
    }
    stderr(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
}
