import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const nativeDirectory = NodePath.resolve(import.meta.dirname, "..", "..", "native");

it("ships a complete native runbook with the required safety gates", async () => {
  const runbook = await NodeFSP.readFile(NodePath.join(nativeDirectory, "AI-DEPLOY.md"), "utf8");
  for (const section of [
    "## Stop conditions",
    "## 1. Preflight",
    "## 3. Install the pinned runtimes",
    "## 5. Generate the relay state",
    "## 6. Install the systemd units",
    "## 7. Start and verify",
    "## Upgrade",
    "## Uninstall",
    "## Troubleshooting",
  ]) {
    expect(runbook).toContain(section);
  }
  for (const command of [
    "caddy validate",
    "frps verify",
    "systemctl enable --now",
    'proxyBindAddr = "127.0.0.1"',
    "on_demand_tls",
    "127.0.0.1:8787/internal/tls/ask",
    "sha256sum -c -",
  ]) {
    expect(runbook).toContain(command);
  }
  expect(runbook).not.toContain("{{VERSION}}");
  expect(runbook).not.toContain("{{RELEASE_URL}}");
  expect(runbook).toContain("{{PACKAGE_NAME}}");
  expect(runbook).toContain("2.10.2");
  expect(runbook).toContain("0.61.1");
  expect(runbook).toContain("24.22.3");
});

it("ships a short prompt that points at the runbook and the release", async () => {
  const prompt = await NodeFSP.readFile(NodePath.join(nativeDirectory, "PROMPT.md"), "utf8");
  expect(prompt).toContain("{{RELEASE_URL}}");
  expect(prompt).toContain("{{VERSION}}");
  expect(prompt).toContain("{{PACKAGE_NAME}}");
  expect(prompt).toContain("native/AI-DEPLOY.md");
  expect(prompt).toContain("Do not install Docker");
});

it("ships systemd units with the expected hardening and paths", async () => {
  const templates = NodePath.join(nativeDirectory, "templates");
  const registry = await NodeFSP.readFile(
    NodePath.join(templates, "t3-relay-registry.service"),
    "utf8",
  );
  expect(registry).toContain("User=t3relay");
  expect(registry).toContain("EnvironmentFile=/opt/t3-relay/relay.env");
  expect(registry).toContain("ReadWritePaths=/opt/t3-relay/data");
  expect(registry).toContain("NoNewPrivileges=yes");

  const caddy = await NodeFSP.readFile(NodePath.join(templates, "t3-relay-caddy.service"), "utf8");
  expect(caddy).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
  expect(caddy).toContain("ReadWritePaths=/opt/t3-relay/caddy");

  const frps = await NodeFSP.readFile(NodePath.join(templates, "t3-relay-frps.service"), "utf8");
  expect(frps).toContain("ExecStart=/opt/t3-relay/bin/frps -c /opt/t3-relay/frps.toml");
});
