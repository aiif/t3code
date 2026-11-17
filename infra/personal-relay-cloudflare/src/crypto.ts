const HOST_KEY_BYTES = 32;
const HOST_TOKEN_BYTES = 32;
const HOST_ID_BYTES = 6;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/").replace(/=+$/u, "");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

export function newHostKey(): string {
  return base64UrlEncode(randomBytes(HOST_KEY_BYTES));
}

export function newHostId(): string {
  return [...randomBytes(HOST_ID_BYTES)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newHostToken(hostId: string): string {
  return `${hostId}.${base64UrlEncode(randomBytes(HOST_TOKEN_BYTES))}`;
}

/** Host tokens carry the id so lookups stay O(1); only their hash is stored. */
export function hostIdFromToken(token: string): string | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const hostId = token.slice(0, separator);
  return /^[a-z0-9]{6,32}$/u.test(hostId) ? hostId : null;
}

export async function hashToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export async function hashHostKey(hostKey: string): Promise<string> {
  return hashToken(hostKey);
}

export async function encryptHostKey(secretKey: Uint8Array, hostKey: string): Promise<string> {
  const key = await importAesKey(secretKey);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      key,
      encoder.encode(hostKey),
    ),
  );
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  const ciphertext = sealed.slice(0, sealed.length - TAG_BYTES);
  return [VERSION, base64UrlEncode(nonce), base64UrlEncode(tag), base64UrlEncode(ciphertext)].join(
    ".",
  );
}

export async function decryptHostKey(secretKey: Uint8Array, stored: string): Promise<string> {
  const [version, nonce, tag, ciphertext] = stored.split(".");
  if (version !== VERSION || nonce === undefined || tag === undefined || ciphertext === undefined) {
    throw new Error("Host key ciphertext has an unknown format.");
  }
  const key = await importAesKey(secretKey);
  const sealed = new Uint8Array([...base64UrlDecode(ciphertext), ...base64UrlDecode(tag)]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(nonce), tagLength: 128 },
    key,
    sealed,
  );
  return decoder.decode(plaintext);
}

/** Constant-time for equal-length strings; length mismatch is not secret worth hiding. */
export function safeEqualText(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

async function importAesKey(secretKey: Uint8Array): Promise<CryptoKey> {
  if (secretKey.length !== 32) {
    throw new Error("The host-key encryption key must be exactly 32 bytes.");
  }
  return crypto.subtle.importKey("raw", asBufferSource(secretKey), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
