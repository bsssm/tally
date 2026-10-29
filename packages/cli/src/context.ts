import * as p from "@clack/prompts";
import { openDb, openKeystore, type Db, type Keystore } from "@tally/core";

/** Open the local store once per command. The passphrase prompt only fires when no Keychain/env key exists. */
export async function ctx(): Promise<{ db: Db; keystore: Keystore }> {
  const keystore = await openKeystore({ askPassphrase: askPassphrase });
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
