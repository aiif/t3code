// @effect-diagnostics nodeBuiltinImport:off -- The standalone CLI runs outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { stackFiles } from "./config.ts";
import { isWindows } from "./platform.ts";
import type { RelayState } from "./types.ts";

export class InstallError extends Error {
  override name = "InstallError";
}

export async function ensureInstallDir(installDir: string): Promise<void> {
  await NodeFSP.mkdir(installDir, { recursive: true, mode: 0o755 });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeFile(file: string, contents: string, mode: number): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await NodeFSP.writeFile(temporary, contents, { mode });
  if (!isWindows) await NodeFSP.chmod(temporary, mode);
  await NodeFSP.rename(temporary, file);
}

export async function writeStackFiles(installDir: string, state: RelayState): Promise<void> {
  await ensureInstallDir(installDir);
  for (const file of stackFiles(state)) {
    await writeFile(NodePath.join(installDir, file.path), file.contents, file.mode);
  }
}

export async function copyAssets(input: {
  readonly installDir: string;
  readonly registrySource: string;
  readonly portalSource: string;
}): Promise<void> {
  const registryDirectory = NodePath.join(input.installDir, "registry");
  const portalDirectory = NodePath.join(input.installDir, "portal");
  await NodeFSP.mkdir(registryDirectory, { recursive: true });
  await NodeFSP.copyFile(input.registrySource, NodePath.join(registryDirectory, "registry.mjs"));
  if (!isWindows) {
    await NodeFSP.chmod(NodePath.join(registryDirectory, "registry.mjs"), 0o644);
  }

  await NodeFSP.rm(portalDirectory, { recursive: true, force: true });
  await NodeFSP.cp(input.portalSource, portalDirectory, {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  if (!isWindows) {
    await NodeFSP.chmod(portalDirectory, 0o755);
  }

  await NodeFSP.mkdir(NodePath.join(input.installDir, "data"), { recursive: true, mode: 0o750 });
  await NodeFSP.mkdir(NodePath.join(input.installDir, "caddy"), { recursive: true, mode: 0o700 });
}

export async function copyTlsFiles(input: {
  readonly installDir: string;
  readonly certPath: string;
  readonly keyPath: string;
}): Promise<{ readonly certPath: string; readonly keyPath: string }> {
  const certDirectory = NodePath.join(input.installDir, "certs");
  await NodeFSP.mkdir(certDirectory, { recursive: true, mode: 0o700 });
  const certPath = NodePath.join(certDirectory, "fullchain.pem");
  const keyPath = NodePath.join(certDirectory, "privkey.pem");
  await NodeFSP.copyFile(input.certPath, certPath);
  await NodeFSP.copyFile(input.keyPath, keyPath);
  if (!isWindows) {
    await NodeFSP.chmod(certPath, 0o644);
    await NodeFSP.chmod(keyPath, 0o600);
    await NodeFSP.chmod(certDirectory, 0o700);
  }
  return { certPath, keyPath };
}

export function validateCertificatePair(input: {
  readonly certPath: string;
  readonly keyPath: string;
  readonly domain: string;
}): void {
  let certificate: NodeCrypto.X509Certificate;
  let key: NodeCrypto.KeyObject;
  try {
    certificate = new NodeCrypto.X509Certificate(NodeFS.readFileSync(input.certPath, "utf8"));
    key = NodeCrypto.createPrivateKey(NodeFS.readFileSync(input.keyPath, "utf8"));
  } catch (cause) {
    throw new InstallError(
      `Could not parse the TLS certificate or key: ${(cause as Error).message}`,
    );
  }

  if (certificate.checkHost(input.domain) === undefined) {
    throw new InstallError(`The certificate does not cover ${input.domain}.`);
  }
  if (certificate.checkHost(`t3check.${input.domain}`) === undefined) {
    throw new InstallError(`The certificate does not cover *.${input.domain}.`);
  }

  const certKey = certificate.publicKey.export({ type: "spki", format: "der" });
  const privateKey = NodeCrypto.createPublicKey(key).export({ type: "spki", format: "der" });
  if (!certKey.equals(privateKey)) {
    throw new InstallError("The TLS certificate and private key do not match.");
  }
}

export async function backupData(input: {
  readonly installDir: string;
  readonly timestamp: string;
}): Promise<string> {
  const backups = NodePath.join(input.installDir, "backups");
  await NodeFSP.mkdir(backups, { recursive: true, mode: 0o700 });
  const destination = NodePath.join(backups, input.timestamp.replaceAll(":", "-"));
  await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
  const data = NodePath.join(input.installDir, "data");
  if (await pathExists(data)) {
    await NodeFSP.cp(data, NodePath.join(destination, "data"), { recursive: true });
  }
  const certs = NodePath.join(input.installDir, "certs");
  if (await pathExists(certs)) {
    await NodeFSP.cp(certs, NodePath.join(destination, "certs"), { recursive: true });
  }
  for (const name of ["compose.yaml", "deploy.json", "relay.env", "Caddyfile", "frps.toml"]) {
    const source = NodePath.join(input.installDir, name);
    if (await pathExists(source)) {
      await NodeFSP.copyFile(source, NodePath.join(destination, name));
    }
  }
  return destination;
}

export async function pruneBackups(installDir: string, keep = 3): Promise<void> {
  const backups = NodePath.join(installDir, "backups");
  let entries;
  try {
    entries = await NodeFSP.readdir(backups, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of directories.slice(keep)) {
    await NodeFSP.rm(NodePath.join(backups, name), { recursive: true, force: true });
  }
}
