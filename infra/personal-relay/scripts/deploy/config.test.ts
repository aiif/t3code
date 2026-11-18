import { expect, it } from "vite-plus/test";

import {
  renderCaddyfile,
  renderCompose,
  renderFrpsToml,
  renderPrompt,
  renderRelayEnv,
  stackFiles,
} from "./config.ts";
import { createState } from "./secrets.ts";
import type { RelayState } from "./types.ts";

function makeState(tls: RelayState["tls"] = { mode: "on-demand" }): RelayState {
  return createState({
    domain: "relay.example.com",
    email: "ops@example.com",
    tls,
    images: {
      caddy: "caddy:2.10-alpine",
      frps: "fatedier/frps:v0.61.1",
      node: "node:24-alpine",
    },
    now: "2026-11-18T00:00:00.000Z",
  });
}

it("renders a compose stack with only the intended host ports", () => {
  const compose = renderCompose(makeState());
  expect(compose).toContain("services:");
  expect(compose).toContain("image: caddy:2.10-alpine");
  expect(compose).toContain('"7001:7001"');
  expect(compose).toContain('"80:80"');
  expect(compose).toContain('"443:443"');
  expect(compose).not.toContain("8787:8787");
  expect(compose).not.toContain("8080:8080");
  expect(compose).toContain("condition: service_healthy");
});

it("renders on-demand TLS and the registry ask endpoint", () => {
  const caddyfile = renderCaddyfile(makeState());
  expect(caddyfile).toContain("ask http://registry:8787/internal/tls/ask");
  expect(caddyfile).toContain("tls {");
  expect(caddyfile).toContain("on_demand");
  expect(caddyfile).toContain("https://*.relay.example.com");
  expect(caddyfile).toContain("reverse_proxy registry:8787");
  expect(caddyfile).toContain("reverse_proxy frps:8080");
  expect(caddyfile).toContain("header_up Host {host}");
  expect(caddyfile).toContain("flush_interval -1");
  expect(caddyfile).toContain('Cache-Control "public, max-age=31536000, immutable"');
  expect(caddyfile).toContain("try_files {path} /index.html");
});

it("renders file-based TLS without on-demand", () => {
  const caddyfile = renderCaddyfile(
    makeState({
      mode: "files",
      certPath: "/opt/t3-relay/certs/fullchain.pem",
      keyPath: "/opt/t3-relay/certs/privkey.pem",
    }),
  );
  expect(caddyfile).toContain("tls /certs/fullchain.pem /certs/privkey.pem");
  expect(caddyfile.split("tls /certs/fullchain.pem /certs/privkey.pem")).toHaveLength(3);
  expect(caddyfile).not.toContain("on_demand");
  expect(caddyfile).not.toContain("on_demand_tls");
});

it("renders frps loopback-only vhost and the token", () => {
  const state = makeState();
  const frps = renderFrpsToml(state);
  expect(frps).toContain("bindPort = 7001");
  expect(frps).toContain("vhostHTTPPort = 8080");
  expect(frps).toContain(`auth.token = "${state.frpAuthToken}"`);
  expect(frps).toContain("allowPorts = []");
});

it("renders registry env and redacts secrets for a dry run", () => {
  const state = makeState();
  const env = renderRelayEnv(state);
  expect(env).toContain(`T3CODE_ADMIN_KEY=${state.adminKey}`);
  expect(env).toContain(`T3CODE_SECRET_KEY=${state.secretKey}`);
  expect(env).toContain("T3CODE_PORTAL_URL=https://relay.example.com");
  expect(env).toContain("FRP_SERVER_ADDR=relay.example.com");
  expect(env).toContain("VAPID_SUBJECT=mailto:ops@example.com");

  const redacted = renderRelayEnv(state, { redactSecrets: true });
  expect(redacted).not.toContain(state.adminKey);
  expect(redacted).not.toContain(state.secretKey);
  expect(redacted).toContain("T3CODE_ADMIN_KEY=<generated>");
});

it("exposes the stack files with owner-only env and group-readable frps config", () => {
  const files = stackFiles(makeState());
  const byPath = new Map(files.map((file) => [file.path, file]));
  expect(byPath.get("relay.env")?.mode).toBe(0o600);
  expect(byPath.get("frps.toml")?.mode).toBe(0o640);
  expect(byPath.get("Caddyfile")?.mode).toBe(0o644);
});

it("renders the native prompt with the release URL", () => {
  const prompt = renderPrompt({
    version: "0.1.0",
    releaseUrl: "https://example.com/t3relay-native-0.1.0.tar.gz",
    packageName: "@aiif/t3relay",
  });
  expect(prompt).toContain("native/AI-DEPLOY.md");
  expect(prompt).toContain("https://example.com/t3relay-native-0.1.0.tar.gz");
  expect(prompt).toContain("@aiif/t3relay");
});
