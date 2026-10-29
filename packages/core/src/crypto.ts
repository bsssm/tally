import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
export const MASTER_KEY_LEN = 32;

/** AES-256-GCM. Blob layout: version(1) | iv(12) | tag(16) | ciphertext. */
export function encrypt(plaintext: string, masterKey: Buffer): Buffer {
  assertKey(masterKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

export function decrypt(blob: Buffer, masterKey: Buffer): string {
  assertKey(masterKey);
  if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) {
    throw new Error("Unrecognised ciphertext format");
  }
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = blob.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function newMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_LEN);
}

export function deriveMasterKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, MASTER_KEY_LEN, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertKey(k: Buffer) {
  if (!Buffer.isBuffer(k) || k.length !== MASTER_KEY_LEN) {
    throw new Error(`Master key must be ${MASTER_KEY_LEN} bytes`);
  }
}
