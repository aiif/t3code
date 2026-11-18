// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI runs outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isWindows } from "./platform.ts";
import type { RelayImages, RelayState, TlsConfig } from "./types.ts";

export const MIN_ADMIN_KEY_LENGTH = 32;
const SECRET_KEY_PATTERN = /^[0-9a-f]{64}$/u;

export interface RelaySecrets {
  readonly adminKey: string;
  readonly secretKey: string;
  readonly frpAuthToken: string;
}

export class RelayStateError extends Error {
  override name = "RelayStateError";
}

export function generateSecrets(): RelaySecrets {
  return {
    adminKey: NodeCrypto.randomBytes(32).toString("base64url"),
    secretKey: NodeCrypto.randomBytes(32).toString("hex"),
    frpAuthToken: NodeCrypto.randomBytes(32).toString("base64url"),
  };
}

export function validateSecrets(secrets: RelaySecrets): void {
  if (secrets.adminKey.trim().length < MIN_ADMIN_KEY_LENGTH) {
    throw new RelayStateError(`The admin key must be at least ${MIN_ADMIN_KEY_LENGTH} characters.`);
  }
  if (!SECRET_KEY_PATTERN.test(secrets.secretKey.trim())) {
    throw new RelayStateError("The secret key must be 32 bytes as 64 lowercase hex characters.");
  }
  if (secrets.frpAuthToken.trim().length < MIN_ADMIN_KEY_LENGTH) {
    throw new RelayStateError("The frp auth token must be at least 32 characters.");
  }
  if (secrets.adminKey === secrets.secretKey || secrets.adminKey === secrets.frpAuthToken) {
    throw new RelayStateError("The admin key, secret key and frp token must be different.");
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requiredString(value: unknown, what: string): string {
  const text = optionalString(value);
  if (text === null) throw new RelayStateError(`${what} is required.`);
  return text;
}

function parseTls(value: unknown): TlsConfig {
  if (typeof value !== "object" || value === null) {
    throw new RelayStateError("tls must be an object.");
  }
  const record = value as Record<string, unknown>;
  const mode = record["mode"];
  if (mode === "on-demand") return { mode };
  if (mode === "files") {
    const certPath = optionalString(record["certPath"]);
    const keyPath = optionalString(record["keyPath"]);
    if (certPath === null || keyPath === null) {
      throw new RelayStateError("tls.certPath and tls.keyPath are required in files mode.");
    }
    return { mode, certPath, keyPath };
  }
  throw new RelayStateError("tls.mode must be on-demand or files.");
}

function parseImages(value: unknown): RelayImages {
  if (typeof value !== "object" || value === null) {
    throw new RelayStateError("images must be an object.");
  }
  const record = value as Record<string, unknown>;
  return {
    caddy: requiredString(record["caddy"], "images.caddy"),
    frps: requiredString(record["frps"], "images.frps"),
    node: requiredString(record["node"], "images.node"),
  };
}

export function parseState(raw: unknown): RelayState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RelayStateError("deploy.json is not a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  if (record["version"] !== 1) {
    throw new RelayStateError("deploy.json has an unsupported version.");
  }
  const mode = record["mode"];
  if (mode !== "docker" && mode !== "native") {
    throw new RelayStateError("deploy.json mode must be docker or native.");
  }
  const domain = requiredString(record["domain"], "domain").toLowerCase();
  const portalUrl = requiredString(record["portalUrl"], "portalUrl").replace(/\/+$/u, "");
  const email = optionalString(record["email"]);
  const secrets: RelaySecrets = {
    adminKey: requiredString(record["adminKey"], "adminKey"),
    secretKey: requiredString(record["secretKey"], "secretKey"),
    frpAuthToken: requiredString(record["frpAuthToken"], "frpAuthToken"),
  };
  validateSecrets(secrets);
  return {
    version: 1,
    mode,
    domain,
    portalUrl,
    email,
    ...secrets,
    tls: parseTls(record["tls"]),
    images: parseImages(record["images"]),
    createdAt: requiredString(record["createdAt"], "createdAt"),
    updatedAt: requiredString(record["updatedAt"], "updatedAt"),
  };
}

export async function readState(file: string): Promise<RelayState | null> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RelayStateError(`Could not read ${file}: ${(cause as Error).message}`);
  }
  try {
    return parseState(JSON.parse(raw));
  } catch (cause) {
    if (cause instanceof RelayStateError) {
      throw new RelayStateError(`${file}: ${cause.message}`);
    }
    throw new RelayStateError(`${file} is not valid JSON.`);
  }
}

export async function writeState(file: string, state: RelayState): Promise<void> {
  validateSecrets(state);
  const directory = NodePath.dirname(file);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  if (!isWindows) await NodeFSP.chmod(temporary, 0o600);
  await NodeFSP.rename(temporary, file);
  if (!isWindows) await NodeFSP.chmod(directory, 0o700);
}

export function createState(input: {
  readonly domain: string;
  readonly email: string | null;
  readonly tls: TlsConfig;
  readonly images: RelayImages;
  readonly now: string;
}): RelayState {
  const secrets = generateSecrets();
  const portalUrl = `https://${input.domain}`;
  return {
    version: 1,
    mode: "docker",
    domain: input.domain,
    portalUrl,
    email: input.email,
    ...secrets,
    tls: input.tls,
    images: input.images,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function rotateAdminKey(state: RelayState, now: string): RelayState {
  const rotated = { ...state, adminKey: generateSecrets().adminKey, updatedAt: now };
  validateSecrets(rotated);
  return rotated;
}

export function touchState(state: RelayState, now: string): RelayState {
  return { ...state, updatedAt: now };
}

export function stateFile(installDir: string): string {
  return NodePath.join(installDir, "deploy.json");
}
