import { describe, expect, it } from "vitest";
import { decrypt, deriveMasterKey, encrypt, newMasterKey } from "./crypto.js";

describe("crypto", () => {
  it("round-trips a secret", () => {
    const k = newMasterKey();
    const blob = encrypt("sk-or-v1-abcdef0123456789", k);
    expect(decrypt(blob, k)).toBe("sk-or-v1-abcdef0123456789");
  });
  it("ciphertext does not contain the plaintext", () => {
    const k = newMasterKey();
    const blob = encrypt("sk-or-v1-abcdef0123456789", k);
    expect(blob.toString("latin1")).not.toContain("sk-or-v1");
    expect(blob.toString("utf8")).not.toContain("abcdef0123456789");
  });
  it("rejects a tampered blob and a wrong key", () => {
    const k = newMasterKey();
    const blob = encrypt("hello", k);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob, k)).toThrow();
    expect(() => decrypt(encrypt("hello", k), newMasterKey())).toThrow();
  });
  it("derives the same key from the same passphrase and salt", () => {
    const salt = Buffer.from("0123456789abcdef");
    expect(deriveMasterKey("correct horse", salt).equals(deriveMasterKey("correct horse", salt))).toBe(true);
    expect(deriveMasterKey("correct horse", salt).equals(deriveMasterKey("wrong horse", salt))).toBe(false);
  });
});
