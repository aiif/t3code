import { expect, it } from "vite-plus/test";

import {
  DEFAULT_CADDY_IMAGE,
  DEFAULT_FRPS_IMAGE,
  DEFAULT_INSTALL_DIR,
  DEFAULT_NODE_IMAGE,
  DeployFlagError,
  parseDeployFlags,
} from "./flags.ts";

it("defaults to help and accepts init", () => {
  expect(parseDeployFlags([]).command).toBe("help");
  const flags = parseDeployFlags(["init"]);
  expect(flags.command).toBe("init");
  expect(flags.installDir).toBe(DEFAULT_INSTALL_DIR);
  expect(flags.caddyImage).toBeNull();
  expect(flags.tail).toBe(200);
});

it("parses deploy flags and normalizes the domain", () => {
  const flags = parseDeployFlags([
    "init",
    "--domain",
    "Relay.Example.COM.",
    "--email=ops@example.com",
    "--yes",
    "--dry-run",
    "--skip-dns-check",
    "--install-dir",
    "/tmp/t3-relay",
    "--caddy-image",
    "mirror.example/caddy:2.10-alpine",
    "--frps-image=mirror.example/frps:v0.61.1",
    "--node-image",
    "mirror.example/node:24-alpine",
    "--tail",
    "50",
  ]);
  expect(flags.domain).toBe("relay.example.com");
  expect(flags.email).toBe("ops@example.com");
  expect(flags.yes).toBe(true);
  expect(flags.dryRun).toBe(true);
  expect(flags.skipDnsCheck).toBe(true);
  expect(flags.installDir).toBe("/tmp/t3-relay");
  expect(flags.caddyImage).toBe("mirror.example/caddy:2.10-alpine");
  expect(flags.frpsImage).toBe("mirror.example/frps:v0.61.1");
  expect(flags.nodeImage).toBe("mirror.example/node:24-alpine");
  expect(flags.tail).toBe(50);
});

it("rejects invalid input", () => {
  expect(() => parseDeployFlags(["nope"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["help", "init"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["init", "--domain", "localhost"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["init", "--domain", "1.2.3.4"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["init", "--email", "nope"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["init", "--tls-cert", "/tmp/cert"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["init", "--public-ip", "nope"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["init", "--tail", "0"])).toThrow(DeployFlagError);
  expect(() => parseDeployFlags(["init", "--caddy-image", "bad image"])).toThrow(DeployFlagError);
});

it("uses the documented default images", () => {
  expect(DEFAULT_CADDY_IMAGE).toBe("caddy:2.10-alpine");
  expect(DEFAULT_FRPS_IMAGE).toBe("fatedier/frps:v0.61.1");
  expect(DEFAULT_NODE_IMAGE).toBe("node:24-alpine");
});
