import * as NodeCrypto from "node:crypto";

/** The key space id: the only thing the registry keeps about the personal key. */
export function spaceIdFor(personalKey: string): string {
  return NodeCrypto.createHash("sha256").update(personalKey, "utf8").digest("hex");
}

/**
 * Host tokens are derived, not stored: a database leak does not hand out host
 * authority, and rotating the personal key rotates every host token with it.
 */
export function hostTokenFor(personalKey: string, hostId: string): string {
  const signature = NodeCrypto.createHmac("sha256", personalKey)
    .update(`t3-personal-host:${hostId}`)
    .digest("base64url");
  return `${hostId}.${signature}`;
}

export function hostIdFromToken(token: string): string | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const hostId = token.slice(0, separator);
  return /^[a-z0-9]{6,32}$/.test(hostId) ? hostId : null;
}

export function verifyHostToken(personalKey: string, hostId: string, token: string): boolean {
  return safeEqualText(hostTokenFor(personalKey, hostId), token);
}

export function newHostId(): string {
  return NodeCrypto.randomBytes(6).toString("hex");
}

export function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length && NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
}
