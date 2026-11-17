import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { FakeWranglerRunner } from "../../src/testing/fakeWrangler.ts";
import type { DeployFetch } from "./cloudflare.ts";
import { runDeployCli, type DeployLayout } from "./cli.ts";
import { parseStoredSecrets, type StoredSecrets } from "./secrets.ts";

const FIXED_TIME = "2026-11-17T12:00:00.000Z";

const TEMPLATE = {
  name: "template",
  main: "src/worker.ts",
  compatibility_date: "2026-10-01",
  assets: {
    directory: "../../apps/web/dist",
    not_found_handling: "single-page-application",
    run_worker_first: ["/v1/*"],
  },
  durable_objects: {
    bindings: [{ name: "REGISTRY", class_name: "RegistryDurableObject" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["RegistryDurableObject"] }],
  observability: { enabled: true },
  vars: { T3CODE_TUNNEL_MODE: "auto" },
};

interface Route {
  readonly match: (url: URL) => boolean;
  readonly reply: (url: URL) => Response;
}

interface Fixture {
  readonly root: string;
  readonly layout: DeployLayout;
  readonly secretsFile: string;
  readonly builds: Array<string>;
}

const cleanups: Array<() => Promise<void>> = [];

async function createFixture(): Promise<Fixture> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3cf-cli-"));
  const packageRoot = NodePath.join(root, "pkg");
  const portal = NodePath.join(root, "portal");
  await NodeFSP.mkdir(NodePath.join(packageRoot, "src"), { recursive: true });
  await NodeFSP.mkdir(portal, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(packageRoot, "src", "worker.ts"), "export default {};\n");
  await NodeFSP.writeFile(
    NodePath.join(packageRoot, "wrangler.jsonc"),
    `${JSON.stringify(TEMPLATE, null, 2)}\n`,
  );
  await NodeFSP.writeFile(NodePath.join(portal, "index.html"), "<html></html>\n");

  const builds: Array<string> = [];
  const layout: DeployLayout = {
    root: packageRoot,
    workerScript: NodePath.join(packageRoot, "src", "worker.ts"),
    configTemplatePath: NodePath.join(packageRoot, "wrangler.jsonc"),
    generatedConfigPath: () => NodePath.join(packageRoot, "wrangler.generated.jsonc"),
    portalDirectory: portal,
    defaultSecretsFile: () => NodePath.join(packageRoot, ".wrangler", "relay-secrets.json"),
    buildPortal: async () => {
      builds.push("portal");
    },
    packageVersion: "0.0.0-test",
  };
  const fixture: Fixture = {
    root,
    layout,
    secretsFile: layout.defaultSecretsFile("t3cf"),
    builds,
  };
  cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  return fixture;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function json(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function healthJson(): Response {
  return new Response(JSON.stringify({ ok: true, service: "t3-personal-registry" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function apiFetch(routes: ReadonlyArray<Route>): {
  fetchImpl: DeployFetch;
  requests: Array<string>;
} {
  const requests: Array<string> = [];
  const fetchImpl: DeployFetch = (input) => {
    requests.push(input);
    const url = new URL(input);
    const route = routes.find((candidate) => candidate.match(url));
    if (route === undefined) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ success: false, errors: [{ message: `unexpected ${url.pathname}` }] }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(route.reply(url));
  };
  return { fetchImpl, requests };
}

const WHOAMI = JSON.stringify({ accounts: [{ id: "account-1", name: "Acme" }] });

function queueDeploy(
  wrangler: FakeWranglerRunner,
  options: { readonly secretValues?: number } = {},
) {
  wrangler.queue({ stdout: WHOAMI });
  wrangler.queue({
    stdout: `Deployed t3cf\n  https://t3cf.test-sub.workers.dev\n`,
  });
  const puts = options.secretValues ?? 4;
  for (let index = 0; index < puts; index += 1) wrangler.queue({ stdout: "" });
}

interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly fetchImpl?: DeployFetch;
  readonly prompt?: (question: string) => Promise<string>;
}

async function runCli(
  fixture: Fixture,
  wrangler: FakeWranglerRunner,
  argv: ReadonlyArray<string>,
  options: RunOptions = {},
) {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const code = await runDeployCli(argv, {
    wrangler,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    layout: fixture.layout,
    env: options.env ?? {},
    fetchImpl:
      options.fetchImpl ??
      (() => Promise.reject(new Error("The test must not reach the network."))),
    now: () => FIXED_TIME,
    sleep: () => Promise.resolve(),
    prompt: options.prompt ?? (() => Promise.reject(new Error("The test must not prompt."))),
    healthAttempts: 2,
    healthIntervalMs: 1,
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function readConfig(fixture: Fixture): Promise<Record<string, unknown>> {
  const text = await NodeFSP.readFile(fixture.layout.generatedConfigPath("t3cf"), "utf8");
  return JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
}

async function writeExistingSecrets(
  fixture: Fixture,
  overrides: Partial<StoredSecrets> = {},
): Promise<StoredSecrets> {
  const secrets: StoredSecrets = {
    adminKey: "admin".padEnd(43, "a"),
    enrollKey: "enroll".padEnd(43, "b"),
    secretKey: "c".repeat(64),
    workerName: "t3cf",
    tunnelPrefix: "t3cf",
    mode: "quick",
    hostsSuffix: null,
    zoneId: null,
    accountId: "account-1",
    relayUrl: "https://t3cf.test-sub.workers.dev",
    updatedAt: FIXED_TIME,
    ...overrides,
  };
  await NodeFSP.mkdir(NodePath.dirname(fixture.secretsFile), { recursive: true });
  await NodeFSP.writeFile(fixture.secretsFile, `${JSON.stringify(secrets, null, 2)}\n`);
  return secrets;
}

function argsText(wrangler: FakeWranglerRunner): string {
  return wrangler.calls.flatMap((call) => call.args).join("\n");
}

describe("deploy CLI", () => {
  it("plans a dry run without deploying, writing secrets or fetching", async () => {
    const fixture = await createFixture();
    const wrangler = new FakeWranglerRunner();
    wrangler.queue({ stdout: WHOAMI });

    const result = await runCli(fixture, wrangler, ["--dry-run"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dry run complete");
    expect(result.stderr).toBe("");
    expect(wrangler.calls.map((call) => call.args[0])).toEqual(["whoami"]);
    expect(fixture.builds).toEqual(["portal"]);
    await expect(NodeFSP.access(fixture.secretsFile)).rejects.toThrow();
    await expect(NodeFSP.access(fixture.layout.generatedConfigPath("t3cf"))).rejects.toThrow();
  });

  it("skips the portal build with --no-portal-build", async () => {
    const fixture = await createFixture();
    const wrangler = new FakeWranglerRunner();
    wrangler.queue({ stdout: WHOAMI });

    const result = await runCli(fixture, wrangler, ["--dry-run", "--no-portal-build"], {
      env: {},
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(fixture.builds).toEqual([]);
  });

  it("deploys in quick mode without leaking secrets through argv", async () => {
    const fixture = await createFixture();
    const wrangler = new FakeWranglerRunner();
    queueDeploy(wrangler);
    const api = apiFetch([
      {
        match: (url) => url.pathname.endsWith("/workers/subdomain"),
        reply: () => json({ subdomain: "test-sub" }),
      },
      {
        match: (url) => url.pathname === "/v1/health",
        reply: () => healthJson(),
      },
    ]);

    const result = await runCli(fixture, wrangler, ["--yes"], {
      env: { CLOUDFLARE_API_TOKEN: "deploy-token-value" },
      fetchImpl: api.fetchImpl,
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("https://t3cf.test-sub.workers.dev");
    expect(result.stdout).toContain("Admin key:");
    expect(result.stdout).toContain("Enrollment key:");

    const secrets = parseStoredSecrets(
      JSON.parse(await NodeFSP.readFile(fixture.secretsFile, "utf8")),
    );
    expect(result.stdout).toContain(secrets.adminKey);
    expect(result.stdout).toContain(secrets.enrollKey);
    expect(result.stdout).not.toContain(secrets.secretKey);

    const config = await readConfig(fixture);
    expect(config.name).toBe("t3cf");
    expect(config.workers_dev).toBe(true);
    expect(config.vars).toMatchObject({
      T3CODE_TUNNEL_MODE: "quick",
      TUNNEL_PREFIX: "t3cf",
      T3CODE_MAX_HOSTS: "20",
    });

    const deploy = wrangler.calls.find((call) => call.args[0] === "deploy");
    expect(deploy?.args).toEqual([
      "deploy",
      "--config",
      fixture.layout.generatedConfigPath("t3cf"),
    ]);

    const puts = wrangler.calls.filter((call) => call.args[0] === "secret");
    expect(puts.map((call) => call.args[2])).toEqual([
      "T3CODE_ADMIN_KEY",
      "T3CODE_SECRET_KEY",
      "T3CODE_ENROLL_KEY",
      "T3CODE_CF_API_TOKEN",
    ]);
    expect(puts[0]?.options?.input).toBe(`${secrets.adminKey}\n`);
    expect(puts[1]?.options?.input).toBe(`${secrets.secretKey}\n`);
    expect(puts[3]?.options?.input).toBe("deploy-token-value\n");

    const argv = argsText(wrangler);
    for (const secret of [secrets.adminKey, secrets.secretKey, secrets.enrollKey]) {
      expect(argv.includes(secret)).toBe(false);
    }
    expect(argv.includes("deploy-token-value")).toBe(false);
    expect(api.requests.some((request) => request.endsWith("/v1/health"))).toBe(true);
  });

  it("reuses the existing keys on --upgrade", async () => {
    const fixture = await createFixture();
    const existing = await writeExistingSecrets(fixture);
    const wrangler = new FakeWranglerRunner();
    queueDeploy(wrangler);
    const api = apiFetch([
      {
        match: (url) => url.pathname.endsWith("/workers/subdomain"),
        reply: () => json({ subdomain: "test-sub" }),
      },
      {
        match: (url) => url.pathname === "/v1/health",
        reply: () => healthJson(),
      },
    ]);

    const result = await runCli(fixture, wrangler, ["--upgrade", "--yes"], {
      env: { CLOUDFLARE_API_TOKEN: "deploy-token-value" },
      fetchImpl: api.fetchImpl,
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Reusing the keys");
    const updated = parseStoredSecrets(
      JSON.parse(await NodeFSP.readFile(fixture.secretsFile, "utf8")),
    );
    expect(updated.adminKey).toBe(existing.adminKey);
    expect(updated.enrollKey).toBe(existing.enrollKey);
    expect(updated.secretKey).toBe(existing.secretKey);
    expect(updated.updatedAt).toBe(FIXED_TIME);
  });

  it("refuses an upgrade with no secrets file instead of rotating keys", async () => {
    const fixture = await createFixture();
    const wrangler = new FakeWranglerRunner();
    wrangler.queue({ stdout: WHOAMI });

    const result = await runCli(fixture, wrangler, ["--upgrade", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--rotate-keys");
    expect(wrangler.calls.map((call) => call.args[0])).toEqual(["whoami"]);
    await expect(NodeFSP.access(fixture.secretsFile)).rejects.toThrow();
  });

  it("rejects a host suffix two labels below the zone", async () => {
    const fixture = await createFixture();
    const wrangler = new FakeWranglerRunner();
    wrangler.queue({ stdout: WHOAMI });
    const api = apiFetch([
      {
        match: (url) => url.pathname === "/client/v4/zones",
        reply: (url) =>
          json(
            url.searchParams.get("name") === "example.com"
              ? [{ id: "zone-1", name: "example.com" }]
              : [],
          ),
      },
    ]);

    const result = await runCli(
      fixture,
      wrangler,
      ["--mode", "named", "--hosts-domain", "t3.example.com", "--dry-run"],
      { env: { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl: api.fetchImpl },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ACM/Total TLS");
    expect(wrangler.calls.map((call) => call.args[0])).toEqual(["whoami"]);
  });

  it("writes the zone, suffix and account vars in named mode", async () => {
    const fixture = await createFixture();
    const wrangler = new FakeWranglerRunner();
    queueDeploy(wrangler);
    const api = apiFetch([
      {
        match: (url) => url.pathname === "/client/v4/zones",
        reply: (url) =>
          json(
            url.searchParams.get("name") === "example.com"
              ? [{ id: "zone-1", name: "example.com" }]
              : [],
          ),
      },
      {
        match: (url) => url.pathname.endsWith("/access/organizations"),
        reply: () => json({ id: "org-1" }),
      },
      {
        match: (url) => url.pathname.endsWith("/workers/subdomain"),
        reply: () => json({ subdomain: "test-sub" }),
      },
      {
        match: (url) => url.pathname === "/v1/health",
        reply: () => healthJson(),
      },
    ]);

    const result = await runCli(
      fixture,
      wrangler,
      ["--mode", "named", "--hosts-domain", "example.com", "--yes"],
      { env: { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl: api.fetchImpl },
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const config = await readConfig(fixture);
    expect(config.vars).toMatchObject({
      T3CODE_TUNNEL_MODE: "named",
      T3CODE_CF_ACCOUNT_ID: "account-1",
      T3CODE_CF_ZONE_ID: "zone-1",
      T3CODE_HOSTS_SUFFIX: "example.com",
    });
    expect(result.stdout).toContain("https://<hostId>.example.com");
    const secrets = parseStoredSecrets(
      JSON.parse(await NodeFSP.readFile(fixture.secretsFile, "utf8")),
    );
    expect(secrets.mode).toBe("named");
    expect(secrets.zoneId).toBe("zone-1");
  });

  it("lists tunnels and DNS records on a destroy dry run without deleting", async () => {
    const fixture = await createFixture();
    await writeExistingSecrets(fixture, {
      mode: "named",
      hostsSuffix: "example.com",
      zoneId: "zone-1",
    });
    const wrangler = new FakeWranglerRunner();
    wrangler.queue({ stdout: WHOAMI });
    const api = apiFetch([
      {
        match: (url) => url.pathname.endsWith("/cfd_tunnel"),
        reply: () =>
          json([
            { id: "tunnel-1", name: "t3cf-abc123def456" },
            { id: "tunnel-2", name: "other-abc123def456" },
          ]),
      },
      {
        match: (url) => url.pathname.includes("/dns_records"),
        reply: () =>
          json([
            {
              id: "dns-1",
              name: "abc123def456.example.com",
              type: "CNAME",
              content: "tunnel-1.cfargotunnel.com",
            },
          ]),
      },
    ]);

    const result = await runCli(fixture, wrangler, ["--destroy", "--dry-run", "--yes"], {
      env: { CLOUDFLARE_API_TOKEN: "token" },
      fetchImpl: api.fetchImpl,
    });

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Would delete the tunnel t3cf-abc123def456");
    expect(result.stdout).not.toContain("Would delete the tunnel other-");
    expect(result.stdout).toContain("Would run wrangler delete --name t3cf");
    expect(wrangler.calls.map((call) => call.args[0])).toEqual(["whoami"]);
  });

  it("reports a healthy doctor run", async () => {
    const fixture = await createFixture();
    const wrangler = new FakeWranglerRunner();
    wrangler.queue({ stdout: "wrangler 4.163.0" });
    wrangler.queue({ stdout: WHOAMI });
    const api = apiFetch([
      {
        match: (url) => url.pathname.endsWith("/user/tokens/verify"),
        reply: () => json({ status: "active" }),
      },
      {
        match: (url) => url.pathname.endsWith("/access/organizations"),
        reply: () => json({ id: "org-1" }),
      },
      {
        match: (url) => url.pathname === "/client/v4/zones",
        reply: (url) =>
          json(
            url.searchParams.get("name") === "example.com"
              ? [{ id: "zone-1", name: "example.com" }]
              : [],
          ),
      },
    ]);

    const result = await runCli(
      fixture,
      wrangler,
      ["--doctor", "--mode", "named", "--hosts-domain", "example.com"],
      { env: { CLOUDFLARE_API_TOKEN: "token" }, fetchImpl: api.fetchImpl },
    );

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[ok] wrangler");
    expect(result.stdout).toContain("[ok] Zero Trust");
    expect(result.stdout).toContain("[ok] hosts domain");
    expect(result.stdout).toContain("Ready");
  });
});
