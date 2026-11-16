import * as NodeCrypto from "node:crypto";

const HOST_KEY_BYTES = 32;
const HOST_TOKEN_BYTES = 32;
const HOST_ID_BYTES = 6;
const VERSION = "v1";

/** Random host keys are 32 bytes of entropy, base64url without padding. */
export function newHostKey(): string {
  return NodeCrypto.randomBytes(HOST_KEY_BYTES).toString("base64url");
}

/** Random host id: a stable, opaque slug. */
export function newHostId(): string {
  return NodeCrypto.randomBytes(HOST_ID_BYTES).toString("hex");
}

/**
 * Host tokens carry the host id so lookups stay O(1); only their SHA-256 hash is
 * stored. A database leak does not hand out host authority.
 */
export function newHostToken(hostId: string): string {
  return `${hostId}.${NodeCrypto.randomBytes(HOST_TOKEN_BYTES).toString("base64url")}`;
}

export function hostIdFromToken(token: string): string | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const hostId = token.slice(0, separator);
  return /^[a-z0-9]{6,32}$/.test(hostId) ? hostId : null;
}

export function hashToken(token: string): string {
  return NodeCrypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashHostKey(hostKey: string): string {
  return NodeCrypto.createHash("sha256").update(hostKey, "utf8").digest("hex");
}

/**
 * AES-256-GCM with a per-key random nonce. The stored value is
 * `v1.<nonce>.<tag>.<ciphertext>`, all base64url. The relay can decrypt only
 * because the admin must reveal host keys; nothing else about the key is kept.
 */
export function encryptHostKey(secretKey: Buffer, hostKey: string): string {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", secretKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(hostKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    nonce.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptHostKey(secretKey: Buffer, stored: string): string {
  const [version, encodedNonce, encodedTag, encodedCiphertext] = stored.split(".");
  if (
    version !== VERSION ||
    encodedNonce === undefined ||
    encodedTag === undefined ||
    encodedCiphertext === undefined
  ) {
    throw new Error("Host key ciphertext has an unknown format.");
  }
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    secretKey,
    Buffer.from(encodedNonce, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length && NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
}
