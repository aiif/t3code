import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DeploySecretsError,
  generateDeploySecrets,
  parseStoredSecrets,
  readSecretsFile,
  resolveDeploySecrets,
  validateDeploySecrets,
  writeSecretsFile,
  type StoredSecrets,
} from "./secrets.ts";

const metadata = {
  workerName: "t3cf",
  tunnelPrefix: "t3cf",
  mode: "quick" as const,
  hostsSuffix: null,
  zoneId: null,
  accountId: "account-1",
  relayUrl: "https://t3cf.example.workers.dev",
};

const UPDATED_AT = "2026-11-17T00:00:00.000Z";

function stored(overrides: Partial<StoredSecrets> = {}): StoredSecrets {
  return {
    adminKey: "a".repeat(43),
    enrollKey: "b".repeat(43),
    secretKey: "c".repeat(64),
    ...metadata,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

const tempDirectories: Array<string> = [];

async function tempFile(): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3cf-secrets-"));
  tempDirectories.push(directory);
  return NodePath.join(directory, "nested", "relay-secrets.json");
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("deploy secrets", () => {
  it("generates distinct keys with the required shapes", () => {
    const secrets = generateDeploySecrets();
    expect(secrets.adminKey).toHaveLength(43);
    expect(secrets.enrollKey).toHaveLength(43);
    expect(secrets.secretKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(secrets.adminKey).not.toBe(secrets.enrollKey);
    expect(() => validateDeploySecrets(secrets)).not.toThrow();
  });

  it("rejects short keys, equal admin and enrollment keys and bad secret keys", () => {
    expect(() =>
      validateDeploySecrets({
        adminKey: "short",
        enrollKey: "b".repeat(43),
        secretKey: "c".repeat(64),
      }),
    ).toThrow(DeploySecretsError);
    expect(() =>
      validateDeploySecrets({
        adminKey: "a".repeat(43),
        enrollKey: "a".repeat(43),
        secretKey: "c".repeat(64),
      }),
    ).toThrow(/differ/u);
    expect(() =>
      validateDeploySecrets({
        adminKey: "a".repeat(43),
        enrollKey: "b".repeat(43),
        secretKey: "nope",
      }),
    ).toThrow(/64 lowercase hex/u);
  });

  it("round-trips a secrets file and keeps it private on POSIX", async () => {
    const file = await tempFile();
    await writeSecretsFile(file, stored());
    expect(await readSecretsFile(file)).toEqual(stored());
    if (NodePath.sep !== "\\") {
      const stats = await NodeFSP.stat(file);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it("returns null for a missing file and rejects corrupt files", async () => {
    const file = await tempFile();
    expect(await readSecretsFile(file)).toBeNull();
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, "{");
    await expect(readSecretsFile(file)).rejects.toThrow(DeploySecretsError);
    await NodeFSP.writeFile(file, JSON.stringify({ adminKey: "a" }));
    await expect(readSecretsFile(file)).rejects.toThrow(/missing adminKey/u);
  });

  it("reuses existing keys instead of rotating them", async () => {
    const existing = stored();
    const result = await resolveDeploySecrets(
      {
        existing,
        upgrade: true,
        rotateKeys: false,
        interactive: false,
        prompt: () => Promise.reject(new Error("must not prompt")),
        metadata,
      },
      UPDATED_AT,
    );

    expect(result.action).toBe("reused");
    expect(result.secrets.adminKey).toBe(existing.adminKey);
    expect(result.secrets.enrollKey).toBe(existing.enrollKey);
    expect(result.secrets.secretKey).toBe(existing.secretKey);
  });

  it("rotates only the admin and enrollment keys when asked", async () => {
    const existing = stored();
    const result = await resolveDeploySecrets(
      {
        existing,
        upgrade: true,
        rotateKeys: true,
        interactive: false,
        prompt: () => Promise.reject(new Error("must not prompt")),
        metadata,
      },
      UPDATED_AT,
    );

    expect(result.action).toBe("rotated");
    expect(result.secrets.adminKey).not.toBe(existing.adminKey);
    expect(result.secrets.enrollKey).not.toBe(existing.enrollKey);
    expect(result.secrets.secretKey).toBe(existing.secretKey);
  });

  it("refuses to invent keys for an upgrade without a secrets file", async () => {
    await expect(
      resolveDeploySecrets(
        {
          existing: null,
          upgrade: true,
          rotateKeys: false,
          interactive: false,
          prompt: () => Promise.reject(new Error("must not prompt")),
          metadata,
        },
        UPDATED_AT,
      ),
    ).rejects.toThrow(/--rotate-keys/u);
  });

  it("prompts for the existing keys on an upgrade", async () => {
    const answers = ["A".repeat(32), "B".repeat(32), "c".repeat(64)];
    const prompts: Array<string> = [];
    const result = await resolveDeploySecrets(
      {
        existing: null,
        upgrade: true,
        rotateKeys: false,
        interactive: true,
        prompt: (question) => {
          prompts.push(question);
          return Promise.resolve(answers.shift() ?? "");
        },
        metadata,
      },
      UPDATED_AT,
    );

    expect(result.action).toBe("prompted");
    expect(result.secretKeyReplaced).toBe(false);
    expect(result.secrets.adminKey).toBe("A".repeat(32));
    expect(result.secrets.secretKey).toBe("c".repeat(64));
    expect(prompts).toHaveLength(3);
  });

  it("generates a new secret key only when the prompt is left blank", async () => {
    const result = await resolveDeploySecrets(
      {
        existing: null,
        upgrade: true,
        rotateKeys: false,
        interactive: true,
        prompt: (question) => {
          if (question.includes("ADMIN_KEY")) return Promise.resolve("a".repeat(32));
          if (question.includes("ENROLL_KEY")) return Promise.resolve("b".repeat(32));
          return Promise.resolve("");
        },
        metadata,
      },
      UPDATED_AT,
    );

    expect(result.secretKeyReplaced).toBe(true);
    expect(result.secrets.secretKey).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts a secrets file that only carries the keys", () => {
    const parsed = parseStoredSecrets({
      adminKey: "a".repeat(43),
      enrollKey: "b".repeat(43),
      secretKey: "c".repeat(64),
    });
    expect(parsed.workerName).toBe("t3cf");
    expect(parsed.mode).toBe("quick");
    expect(parsed.updatedAt).toBe("");
  });
});
