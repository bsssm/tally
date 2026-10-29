import * as p from "@clack/prompts";
import { openDb, openKeystore, type Db, type Keystore } from "@tally/core";

/**
 * Open the local store once per command. The keystore (and with it the Keychain or a passphrase
 * prompt) is only touched by commands that handle provider keys: `connect` creates the master key
 * on first use, `sync` opens an existing one. The wallet, deals and profile never ask for anything.
 */
export async function ctx(): Promise<{ db: Db; keystore: null }>;
export async function ctx(opts: { keys: "create" | "open" }): Promise<{ db: Db; keystore: Keystore }>;
export async function ctx(opts: { keys?: "create" | "open" } = {}): Promise<{ db: Db; keystore: Keystore | null }> {
  const keystore = opts.keys ? await openKeystore({ askPassphrase, create: opts.keys === "create" }) : null;
  const db = openDb();
  return { db, keystore };
}

async function askPassphrase(): Promise<string> {
  if (process.env.TALLY_PASSPHRASE) return process.env.TALLY_PASSPHRASE;
  const v = await p.password({ message: "Passphrase to protect your stored API keys", validate: (s) => (s && s.length >= 8 ? undefined : "At least 8 characters") });
  if (p.isCancel(v)) {
    p.cancel("Cancelled");
    process.exit(1);
  }
  return v;
}
