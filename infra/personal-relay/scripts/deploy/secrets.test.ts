import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { isWindows } from "./platform.ts";
import {
  createState,
  generateSecrets,
  parseState,
  readState,
  RelayStateError,
  rotateAdminKey,
  stateFile,
  validateSecrets,
  writeState,
} from "./secrets.ts";

const IMAGES = {
  caddy: "caddy:2.10-alpine",
  frps: "fatedier/frps:v0.61.1",
  node: "node:24-alpine",
};

it("generates distinct keys with the right shapes", () => {
  const secrets = generateSecrets();
  expect(secrets.adminKey.length).toBeGreaterThanOrEqual(32);
  expect(secrets.secretKey).toMatch(/^[0-9a-f]{64}$/u);
  expect(secrets.frpAuthToken.length).toBeGreaterThanOrEqual(32);
  expect(secrets.adminKey).not.toBe(secrets.secretKey);
  expect(secrets.adminKey).not.toBe(secrets.frpAuthToken);
  validateSecrets(secrets);
  expect(() => validateSecrets({ ...secrets, adminKey: "short" })).toThrow(RelayStateError);
  expect(() => validateSecrets({ ...secrets, secretKey: "nope" })).toThrow(RelayStateError);
});

it("round-trips deploy.json and creates owner-only files", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3relay-state-"));
  try {
    const state = createState({
      domain: "relay.example.com",
      email: null,
      tls: { mode: "on-demand" },
      images: IMAGES,
      now: "2026-11-18T00:00:00.000Z",
    });
    const file = stateFile(directory);
    await writeState(file, state);
    expect(await readState(file)).toEqual(state);
    if (!isWindows) {
      const stats = await NodeFSP.stat(file);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("rejects unknown versions and malformed state", () => {
  expect(() => parseState({ version: 2 })).toThrow(RelayStateError);
  expect(() => parseState(null)).toThrow(RelayStateError);
  expect(() =>
    parseState({
      version: 1,
      mode: "docker",
      domain: "relay.example.com",
      portalUrl: "https://relay.example.com",
      adminKey: "a".repeat(43),
      secretKey: "short",
      frpAuthToken: "c".repeat(43),
      tls: { mode: "on-demand" },
      images: IMAGES,
      createdAt: "now",
      updatedAt: "now",
    }),
  ).toThrow(RelayStateError);
});

it("rotates only the admin key", () => {
  const state = createState({
    domain: "relay.example.com",
    email: null,
    tls: { mode: "on-demand" },
    images: IMAGES,
    now: "2026-11-18T00:00:00.000Z",
  });
  const rotated = rotateAdminKey(state, "2026-11-19T00:00:00.000Z");
  expect(rotated.adminKey).not.toBe(state.adminKey);
  expect(rotated.secretKey).toBe(state.secretKey);
  expect(rotated.frpAuthToken).toBe(state.frpAuthToken);
  expect(rotated.updatedAt).toBe("2026-11-19T00:00:00.000Z");
});
