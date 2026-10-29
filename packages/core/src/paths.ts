import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `~/.tally` unless TALLY_HOME overrides it (tests and CI point this at a temp dir). */
export function tallyHome(): string {
  const dir = process.env.TALLY_HOME || join(homedir(), ".tally");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function dbPath(): string {
  return join(tallyHome(), "tally.db");
}

/**
 * The bundled data folder (deals.json, anthropic-prices.json). Resolved relative to this file so it
 * works from core's src (vitest), core's dist, and the single-file CLI bundle, whose layout is
 * `dist/bin/index.js` + `data/` at the package root. `TALLY_DATA_DIR` overrides it.
 */
export function dataDir(): string {
  if (process.env.TALLY_DATA_DIR) return process.env.TALLY_DATA_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../data", "../../data"]) {
    const dir = resolve(here, rel);
    if (existsSync(join(dir, "deals.json"))) return dir;
  }
  throw new Error(`Tally data folder not found next to ${here}; set TALLY_DATA_DIR`);
}

export function dataFile(name: string): string {
  return join(dataDir(), name);
}

export function readDataJson<T>(name: string): T {
  return JSON.parse(readFileSync(dataFile(name), "utf8")) as T;
}
