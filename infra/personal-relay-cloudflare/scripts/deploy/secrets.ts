// @effect-diagnostics nodeBuiltinImport:off -- The deploy CLI runs outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isWindows } from "./platform.ts";
import type { DeploySecrets } from "./types.ts";

export const MIN_KEY_LENGTH = 32;
const SECRET_KEY_PATTERN = /^[0-9a-f]{64}$/u;

export type SecretMode = "named" | "quick";

export interface StoredSecrets extends DeploySecrets {
  readonly workerName: string;
  readonly tunnelPrefix: string;
  readonly mode: SecretMode;
  readonly hostsSuffix: string | null;
  readonly zoneId: string | null;
  readonly accountId: string | null;
  readonly relayUrl: string | null;
  readonly updatedAt: string;
}

export class DeploySecretsError extends Error {
  override name = "DeploySecretsError";
}

export function generateDeploySecrets(): DeploySecrets {
  return {
    adminKey: NodeCrypto.randomBytes(32).toString("base64url"),
    secretKey: NodeCrypto.randomBytes(32).toString("hex"),
    enrollKey: NodeCrypto.randomBytes(32).toString("base64url"),
  };
}

export function validateDeploySecrets(secrets: DeploySecrets): void {
  const adminKey = secrets.adminKey.trim();
  const enrollKey = secrets.enrollKey.trim();
  const secretKey = secrets.secretKey.trim();

  if (adminKey.length < MIN_KEY_LENGTH) {
    throw new DeploySecretsError(`T3CODE_ADMIN_KEY must be at least ${MIN_KEY_LENGTH} characters.`);
  }
  if (enrollKey.length < MIN_KEY_LENGTH) {
    throw new DeploySecretsError(
      `T3CODE_ENROLL_KEY must be at least ${MIN_KEY_LENGTH} characters.`,
    );
  }
  if (!SECRET_KEY_PATTERN.test(secretKey)) {
    throw new DeploySecretsError(
      "T3CODE_SECRET_KEY must be 32 bytes as 64 lowercase hex characters.",
    );
  }
  if (adminKey === enrollKey) {
    throw new DeploySecretsError("The enrollment key must differ from the admin key.");
  }
  if (secretKey === adminKey || secretKey === enrollKey) {
    throw new DeploySecretsError("The secret key must differ from the admin and enrollment keys.");
  }
}

export function generateSecretKey(): string {
  return NodeCrypto.randomBytes(32).toString("hex");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseStoredSecrets(raw: unknown): StoredSecrets {
  if (typeof raw !== "object" || raw === null) {
    throw new DeploySecretsError("The secrets file is not a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  const adminKey = optionalString(record.adminKey);
  const secretKey = optionalString(record.secretKey);
  const enrollKey = optionalString(record.enrollKey);
  if (adminKey === null || secretKey === null || enrollKey === null) {
    throw new DeploySecretsError(
      "The secrets file is missing adminKey, secretKey or enrollKey. Restore it, or pass --secrets-file or --rotate-keys.",
    );
  }
  const mode = record.mode === "named" ? "named" : "quick";
  const cfApiToken = optionalString(record.cfApiToken);
  const secrets: StoredSecrets = {
    adminKey,
    secretKey,
    enrollKey,
    ...(cfApiToken === null ? {} : { cfApiToken }),
    workerName: optionalString(record.workerName) ?? "t3cf",
    tunnelPrefix: optionalString(record.tunnelPrefix) ?? "t3cf",
    mode,
    hostsSuffix: optionalString(record.hostsSuffix),
    zoneId: optionalString(record.zoneId),
    accountId: optionalString(record.accountId),
    relayUrl: optionalString(record.relayUrl),
    updatedAt: optionalString(record.updatedAt) ?? "",
  };
  validateDeploySecrets(secrets);
  return secrets;
}

export async function readSecretsFile(file: string): Promise<StoredSecrets | null> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DeploySecretsError(`Could not read ${file}: ${(cause as Error).message}`);
  }
  try {
    return parseStoredSecrets(JSON.parse(raw));
  } catch (cause) {
    if (cause instanceof DeploySecretsError) {
      throw new DeploySecretsError(`${file}: ${cause.message}`);
    }
    throw new DeploySecretsError(`${file} is not valid JSON.`);
  }
}

export async function writeSecretsFile(file: string, secrets: StoredSecrets): Promise<void> {
  validateDeploySecrets(secrets);
  const directory = NodePath.dirname(file);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  if (!isWindows) await NodeFSP.chmod(temporary, 0o600);
  await NodeFSP.rename(temporary, file);
  if (!isWindows) await NodeFSP.chmod(directory, 0o700);
}

export interface ResolveSecretsInput {
  readonly existing: StoredSecrets | null;
  readonly upgrade: boolean;
  readonly rotateKeys: boolean;
  readonly interactive: boolean;
  readonly prompt: (question: string) => Promise<string>;
  readonly metadata: Omit<StoredSecrets, keyof DeploySecrets | "updatedAt">;
}

export interface ResolveSecretsResult {
  readonly secrets: StoredSecrets;
  readonly action: "created" | "reused" | "rotated" | "prompted";
  readonly secretKeyReplaced: boolean;
}

function stored(
  secrets: DeploySecrets,
  metadata: ResolveSecretsInput["metadata"],
  updatedAt: string,
): StoredSecrets {
  return { ...metadata, ...secrets, updatedAt };
}

/**
 * Keys only change when the user asks. `--upgrade` with no file either prompts
 * for the existing keys or fails; it never mints new ones behind their back.
 */
export async function resolveDeploySecrets(
  input: ResolveSecretsInput,
  updatedAt: string,
): Promise<ResolveSecretsResult> {
  const existing = input.existing;

  if (existing !== null) {
    if (!input.rotateKeys) {
      return {
        secrets: stored(existing, input.metadata, updatedAt),
        action: "reused",
        secretKeyReplaced: false,
      };
    }
    const rotated = {
      adminKey: NodeCrypto.randomBytes(32).toString("base64url"),
      enrollKey: NodeCrypto.randomBytes(32).toString("base64url"),
      secretKey: existing.secretKey,
      ...(existing.cfApiToken === undefined ? {} : { cfApiToken: existing.cfApiToken }),
    };
    return {
      secrets: stored(rotated, input.metadata, updatedAt),
      action: "rotated",
      secretKeyReplaced: false,
    };
  }

  if (input.upgrade && !input.rotateKeys) {
    if (!input.interactive) {
      throw new DeploySecretsError(
        "This looks like an upgrade but there is no secrets file. Restore it, pass --secrets-file, or pass --rotate-keys to create new keys explicitly.",
      );
    }
    const adminKey = (await input.prompt("Existing T3CODE_ADMIN_KEY: ")).trim();
    const enrollKey = (await input.prompt("Existing T3CODE_ENROLL_KEY: ")).trim();
    const secretAnswer = (
      await input.prompt(
        "Existing T3CODE_SECRET_KEY (blank generates a new one; existing host keys can no longer be revealed): ",
      )
    ).trim();
    const secretKey = secretAnswer === "" ? generateSecretKey() : secretAnswer;
    validateDeploySecrets({ adminKey, enrollKey, secretKey });
    return {
      secrets: stored({ adminKey, enrollKey, secretKey }, input.metadata, updatedAt),
      action: "prompted",
      secretKeyReplaced: secretAnswer === "",
    };
  }

  return {
    secrets: stored(generateDeploySecrets(), input.metadata, updatedAt),
    action: "created",
    secretKeyReplaced: false,
  };
}
