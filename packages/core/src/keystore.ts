import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { decrypt, deriveMasterKey, encrypt, MASTER_KEY_LEN, newMasterKey } from "./crypto.js";
import { tallyHome } from "./paths.js";
import { TallyError } from "./redact.js";

const execFileP = promisify(execFile);
const KEYCHAIN_SERVICE = "tally-master-key";
const KEYCHAIN_ACCOUNT = "tally";
const VERIFIER_PLAINTEXT = "tally-keycheck-v1";

/**
 * Where the 32-byte master key lives. Provider API keys in SQLite are encrypted with it.
 * Resolution order:
 *   1. TALLY_MASTER_KEY env (64 hex chars) — tests, CI, headless use.
 *   2. macOS Keychain via the `security` CLI (no native module; keytar is unmaintained).
 *   3. A passphrase, derived with scrypt and a salt kept in ~/.tally/salt.
 */
export interface MasterKeySource {
  readonly name: string;
  get(): Promise<Buffer | null>;
  set(key: Buffer): Promise<void>;
}

export class EnvKeySource implements MasterKeySource {
  readonly name = "env:TALLY_MASTER_KEY";
  async get(): Promise<Buffer | null> {
    const hex = process.env.TALLY_MASTER_KEY;
    if (!hex) return null;
    const buf = Buffer.from(hex, "hex");
    if (buf.length !== MASTER_KEY_LEN) {
      throw new TallyError("bad-master-key", "TALLY_MASTER_KEY must be 64 hex characters");
    }
    return buf;
  }
  async set(): Promise<void> {
    throw new TallyError("readonly-key-source", "TALLY_MASTER_KEY is read-only; set it in the environment");
  }
}

export class MacKeychainSource implements MasterKeySource {
  readonly name = "macos-keychain";
  static available(): boolean {
    return process.platform === "darwin";
  }
  async get(): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileP("security", [
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
      ]);
      const hex = stdout.trim();
      return hex ? Buffer.from(hex, "hex") : null;
    } catch (err) {
      // exit 44 = item not found
      if (err && typeof err === "object" && "code" in err && (err as { code: number }).code === 44) return null;
      throw new TallyError("keychain-read", "Could not read the macOS Keychain");
    }
  }
  async set(key: Buffer): Promise<void> {
    // Interactive mode keeps the secret off argv (not visible in `ps`).
    const cmd = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${key.toString("hex")}\n`;
    await new Promise<void>((resolve, reject) => {
      const child = execFile("security", ["-i"], (err) => (err ? reject(err) : resolve()));
      child.stdin?.end(cmd);
    }).catch(() => {
      throw new TallyError("keychain-write", "Could not write to the macOS Keychain");
    });
  }
}

export class PassphraseKeySource implements MasterKeySource {
  readonly name = "passphrase";
  constructor(private readonly ask: () => Promise<string>) {}
  private saltPath() {
    return join(tallyHome(), "salt");
  }
  async get(): Promise<Buffer | null> {
    if (!existsSync(this.saltPath())) return null;
    const salt = readFileSync(this.saltPath());
    return deriveMasterKey(await this.ask(), salt);
  }
  async set(): Promise<void> {
    // The key is derived, not stored: create the salt and the verifier will check the passphrase later.
    const salt = randomBytes(16);
    writeFileSync(this.saltPath(), salt, { mode: 0o600 });
  }
  /** Passphrase mode derives the key from the salt it just wrote. */
  async create(): Promise<Buffer> {
    await this.set();
    const salt = readFileSync(this.saltPath());
    return deriveMasterKey(await this.ask(), salt);
  }
}

export interface Keystore {
  readonly source: string;
  seal(secret: string): Buffer;
  open(blob: Buffer): string;
}

export interface OpenKeystoreOptions {
  /** Asked only when the passphrase fallback is in use. */
  askPassphrase?: () => Promise<string>;
  sources?: MasterKeySource[];
}

/**
 * Resolve the master key, creating one on first run, and verify it against ~/.tally/keycheck.
 */
export async function openKeystore(opts: OpenKeystoreOptions = {}): Promise<Keystore> {
  const sources = opts.sources ?? defaultSources(opts.askPassphrase);
  const verifierPath = join(tallyHome(), "keycheck");

  for (const src of sources) {
    const key = await src.get();
    if (!key) continue;
    verify(key, verifierPath, src.name);
    return makeKeystore(key, src.name);
  }

  // First run: create a key in the first source that can hold one.
  for (const src of sources) {
    if (src instanceof EnvKeySource) continue;
    let key: Buffer;
    if (src instanceof PassphraseKeySource) {
      key = await src.create();
    } else {
      key = newMasterKey();
      await src.set(key);
    }
    writeFileSync(verifierPath, encrypt(VERIFIER_PLAINTEXT, key), { mode: 0o600 });
    return makeKeystore(key, src.name);
  }
  throw new TallyError("no-key-source", "No place to keep the master key", "Set TALLY_MASTER_KEY or run interactively to use a passphrase");
}

function defaultSources(askPassphrase?: () => Promise<string>): MasterKeySource[] {
  const list: MasterKeySource[] = [new EnvKeySource()];
  if (MacKeychainSource.available()) list.push(new MacKeychainSource());
  if (askPassphrase) list.push(new PassphraseKeySource(askPassphrase));
  return list;
}

function verify(key: Buffer, verifierPath: string, sourceName: string) {
  if (!existsSync(verifierPath)) {
    writeFileSync(verifierPath, encrypt(VERIFIER_PLAINTEXT, key), { mode: 0o600 });
    return;
  }
  try {
    if (decrypt(readFileSync(verifierPath), key) === VERIFIER_PLAINTEXT) return;
  } catch {
    /* fall through */
  }
  throw new TallyError(
    "master-key-mismatch",
    `The master key from ${sourceName} does not match the one that encrypted ~/.tally`,
    "Wrong passphrase, or TALLY_HOME points at a store made with another key",
  );
}

function makeKeystore(key: Buffer, source: string): Keystore {
  return {
    source,
    seal: (secret) => encrypt(secret, key),
    open: (blob) => decrypt(blob, key),
  };
}
