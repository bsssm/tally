import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { LocalAgentSummary, LocalTurn } from "./types.js";
import { aggregateTurns, emptySummary } from "./shared.js";
import { priceFor as anthropicPriceFor } from "./claude-code.js";
import { openaiPriceFor } from "./codex.js";
import { googlePriceFor } from "./gemini.js";

/**
 * Cursor keeps chat state in one SQLite file, state.vscdb, table `cursorDiskKV`: `composerData:<id>` rows
 * (one per conversation) and `bubbleId:<composer>:<bubble>` rows (one per message). An assistant bubble
 * carries `modelInfo.modelName`, `createdAt` and `tokenCount: {inputTokens, outputTokens}`. On current
 * builds tokenCount stays {0,0}: Cursor meters tokens server-side and shows them at cursor.com/dashboard.
 * So this reader is honest: it reports the conversations it can see, prices bubbles that DO carry counts,
 * and says plainly when nothing is priceable. It never estimates tokens from text length.
 */

export const CURSOR_BUBBLE_LIMIT = 250_000;

export function cursorStateDb(home = homedir()): string {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const tail = join("Cursor", "User", "globalStorage", "state.vscdb");
  const os = platform();
  if (os === "darwin") return join(home, "Library", "Application Support", tail);
  if (os === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), tail);
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), tail);
}

/** Cursor spells Anthropic models "claude-4.5-sonnet[-thinking]"; the price table uses "claude-sonnet-4-5". */
export function normalizeCursorModel(model: string): string {
  const m = /^claude-(\d+)(?:\.(\d+))?-(opus|sonnet|haiku|fable)(?:-.*)?$/.exec(model);
  if (m) return `claude-${m[3]}-${m[1]}${m[2] ? `-${m[2]}` : ""}`;
  return model;
}

/** Price a Cursor turn by whichever vendor table knows the model. Cache buckets are always 0 here. */
export function cursorTurnCostUsd(t: LocalTurn): number | undefined {
  const model = normalizeCursorModel(t.model);
  const a = anthropicPriceFor(model);
  if (a) return (t.input * a.input + t.output * a.output) / 1e6;
  const o = openaiPriceFor(model);
  if (o) return (t.input * o.input + t.output * o.output) / 1e6;
  const g = googlePriceFor(model);
  if (g) return (t.input * g.input + t.output * g.output) / 1e6;
  return undefined;
}

function dateOf(v: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof v === "number" && Number.isFinite(v)) ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === "string" && v) {
    const n = Number(v);
    ms = Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(v);
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

export interface CursorScan {
  conversations: number;
  bubbles: number;
  turns: LocalTurn[];
}

/** Read conversations + assistant bubbles with real token counts from a state.vscdb. Throws on an unreadable file. */
export function scanCursorDb(file: string, from: string, to: string): CursorScan {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name));
    if (!tables.has("cursorDiskKV")) return { conversations: 0, bubbles: 0, turns: [] };
    let conversations = 0;
    for (const r of db.prepare("SELECT json_extract(CAST(value AS TEXT), '$.createdAt') AS c FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' AND json_valid(CAST(value AS TEXT))").iterate() as Iterable<any>) {
      const d = dateOf(r.c);
      if (d && d >= from && d <= to) conversations++;
    }
    const rows = db
      .prepare(
        `SELECT key,
                json_extract(CAST(value AS TEXT), '$.type') AS type,
                json_extract(CAST(value AS TEXT), '$.createdAt') AS createdAt,
                json_extract(CAST(value AS TEXT), '$.modelInfo.modelName') AS model,
                json_extract(CAST(value AS TEXT), '$.tokenCount.inputTokens') AS input,
                json_extract(CAST(value AS TEXT), '$.tokenCount.outputTokens') AS output
         FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND json_valid(CAST(value AS TEXT)) LIMIT ?`,
      )
      .iterate(CURSOR_BUBBLE_LIMIT) as Iterable<any>;
    let bubbles = 0;
    const turns: LocalTurn[] = [];
    for (const r of rows) {
      if (r.type === 1) continue;
      bubbles++;
      const input = typeof r.input === "number" && r.input > 0 ? Math.trunc(r.input) : 0;
      const output = typeof r.output === "number" && r.output > 0 ? Math.trunc(r.output) : 0;
      if (!input && !output) continue;
      const date = dateOf(r.createdAt);
      if (!date) continue;
      const parts = String(r.key).split(":");
      turns.push({ date, model: typeof r.model === "string" && r.model ? r.model : "unknown", sessionId: parts[1] ?? "", input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    }
    return { conversations, bubbles, turns };
  } finally {
    db.close();
  }
}

export async function summarizeCursor(from: string, to: string, file = cursorStateDb()): Promise<LocalAgentSummary> {
  if (!existsSync(file)) return emptySummary("cursor", from, to, file, []);
  let scan: CursorScan;
  try {
    scan = scanCursorDb(file, from, to);
  } catch (e) {
    return emptySummary("cursor", from, to, file, [`Cursor database found but could not be read (${(e as Error).message}).`], true);
  }
  const notes: string[] = [];
  const s = aggregateTurns("cursor", from, to, scan.turns, cursorTurnCostUsd, { detected: true, path: file, notes });
  if (!s.turns) {
    notes.push(
      `Cursor detected: ${scan.conversations} conversation(s) in this window, but Cursor keeps token counts server-side (local tokenCount is 0). ` +
        "Unpriced here; see cursor.com/dashboard → Usage.",
    );
  } else {
    notes.push("Cursor bubbles carried token counts; priced at vendor list rates without cache discounts. Cursor's own dashboard is authoritative.");
  }
  if (scan.bubbles >= CURSOR_BUBBLE_LIMIT) notes.push(`Stopped after ${CURSOR_BUBBLE_LIMIT} bubbles; the database is larger than that.`);
  return s;
}
