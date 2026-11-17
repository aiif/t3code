import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  base64UrlDecode,
  base64UrlEncode,
  decryptHostKey,
  encryptHostKey,
  hashHostKey,
  hashToken,
  hostIdFromToken,
  newHostId,
  newHostKey,
  newHostToken,
  safeEqualText,
} from "./crypto.ts";

const SECRET_KEY = new Uint8Array(32).fill(7);

describe("base64url", () => {
  it("matches Node's unpadded base64url encoding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64url"));
    expect(encoded).not.toContain("=");
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it("accepts padded and standard-alphabet input", () => {
    expect(base64UrlDecode("SGVsbG8=")).toEqual(new TextEncoder().encode("Hello"));
    expect(base64UrlDecode("SGVsbG8")).toEqual(new TextEncoder().encode("Hello"));
    expect(base64UrlDecode("a-b_")).toEqual(new Uint8Array(Buffer.from("a-b_", "base64url")));
  });
});

describe("host credentials", () => {
  it("creates 12-character hex host ids and id-bearing tokens", () => {
    const hostId = newHostId();
    expect(hostId).toMatch(/^[a-z0-9]{12}$/u);

    const token = newHostToken(hostId);
    expect(token.startsWith(`${hostId}.`)).toBe(true);
    expect(hostIdFromToken(token)).toBe(hostId);
    expect(hostIdFromToken("missing-separator")).toBeNull();
    expect(hostIdFromToken(".token")).toBeNull();
    expect(hostIdFromToken("short.token")).toBeNull();
  });

  it("creates 32-byte base64url host keys", () => {
    const hostKey = newHostKey();
    expect(hostKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(base64UrlDecode(hostKey)).toHaveLength(32);
    expect(newHostKey()).not.toBe(hostKey);
  });

  it("hashes tokens and host keys with SHA-256 hex", async () => {
    const expected = NodeCrypto.createHash("sha256").update("token-value", "utf8").digest("hex");
    await expect(hashToken("token-value")).resolves.toBe(expected);
    await expect(hashHostKey("token-value")).resolves.toBe(expected);
    await expect(hashToken("other-value")).resolves.not.toBe(expected);
  });

  it("compares text without leaking a prefix match", () => {
    expect(safeEqualText("admin-key", "admin-key")).toBe(true);
    expect(safeEqualText("admin-key", "admin-kez")).toBe(false);
    expect(safeEqualText("admin-key", "admin-key-longer")).toBe(false);
    expect(safeEqualText("", "")).toBe(true);
  });
});

describe("host-key encryption", () => {
  it("round trips through AES-256-GCM in the v1 format", async () => {
    const hostKey = newHostKey();
    const stored = await encryptHostKey(SECRET_KEY, hostKey);
    const parts = stored.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(await decryptHostKey(SECRET_KEY, stored)).toBe(hostKey);
  });

  it("uses a fresh nonce per encryption", async () => {
    const hostKey = newHostKey();
    expect(await encryptHostKey(SECRET_KEY, hostKey)).not.toBe(
      await encryptHostKey(SECRET_KEY, hostKey),
    );
  });

  it("decrypts ciphertext written by the Node VPS registry", async () => {
    const hostKey = "vps-host-key-value";
    const nonce = Buffer.alloc(12, 3);
    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(SECRET_KEY), nonce);
    const ciphertext = Buffer.concat([cipher.update(hostKey, "utf8"), cipher.final()]);
    const stored = [
      "v1",
      nonce.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");

    expect(await decryptHostKey(SECRET_KEY, stored)).toBe(hostKey);
  });

  it("writes ciphertext the Node VPS registry can decrypt", async () => {
    const hostKey = newHostKey();
    const [version, nonce, tag, ciphertext] = (await encryptHostKey(SECRET_KEY, hostKey)).split(
      ".",
    );
    expect(version).toBe("v1");

    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(SECRET_KEY),
      Buffer.from(nonce!, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    expect(plaintext).toBe(hostKey);
  });

  it("rejects a wrong key, a tampered tag, and an unknown format", async () => {
    const stored = await encryptHostKey(SECRET_KEY, newHostKey());
    await expect(decryptHostKey(new Uint8Array(32).fill(9), stored)).rejects.toThrow();

    const parts = stored.split(".");
    const tampered = [parts[0], parts[1], base64UrlEncode(new Uint8Array(16)), parts[3]].join(".");
    await expect(decryptHostKey(SECRET_KEY, tampered)).rejects.toThrow();

    await expect(decryptHostKey(SECRET_KEY, "v2.a.b.c")).rejects.toThrow(
      "Host key ciphertext has an unknown format.",
    );
  });
});
