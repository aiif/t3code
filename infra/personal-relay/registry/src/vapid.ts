import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import webPush from "web-push";

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

const VAPID_FILE = "vapid.json";

function isVapidKeys(value: unknown): value is VapidKeys {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["publicKey"] === "string" && typeof record["privateKey"] === "string";
}

/**
 * VAPID keys persist in the data volume. Regenerating them would silently
 * invalidate every subscription a client already installed.
 */
export async function loadOrCreateVapidKeys(dataDir: string): Promise<VapidKeys> {
  const path = NodePath.join(dataDir, VAPID_FILE);
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (isVapidKeys(parsed)) return parsed;
    throw new Error(`${path} does not contain a VAPID key pair.`);
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") throw cause;
  }

  const generated = webPush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  await NodeFSP.mkdir(dataDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temporary, path);
  return keys;
}
