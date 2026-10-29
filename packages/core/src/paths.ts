import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** `~/.tally` unless TALLY_HOME overrides it (tests and CI point this at a temp dir). */
export function tallyHome(): string {
  const dir = process.env.TALLY_HOME || join(homedir(), ".tally");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function dbPath(): string {
  return join(tallyHome(), "tally.db");
}
