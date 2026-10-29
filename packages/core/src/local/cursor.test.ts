import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { summarizeCursor, normalizeCursorModel, scanCursorDb } from "./cursor.js";

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(join(here, "__fixtures__", "cursor-rows.json"), "utf8")) as { key: string; value: unknown }[];

function makeDb(filter: (r: { key: string; value: any }) => boolean = () => true, zeroTokens = false): string {
  const file = join(mkdtempSync(join(tmpdir(), "tally-cursor-")), "state.vscdb");
  const db = new Database(file);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  const ins = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const r of rows.filter(filter)) {
    let v = r.value;
    if (zeroTokens && v && typeof v === "object" && (v as any).tokenCount) v = { ...(v as any), tokenCount: { inputTokens: 0, outputTokens: 0 } };
    ins.run(r.key, typeof v === "string" ? v : Buffer.from(JSON.stringify(v)));
  }
  db.close();
  return file;
}

describe("Cursor local reader", () => {
  it("prices assistant bubbles that carry token counts, normalizes Cursor's Anthropic names, skips user bubbles, junk and out-of-window rows", async () => {
    const s = await summarizeCursor("2026-10-01", "2026-10-31", makeDb());
    expect(s.source).toBe("cursor");
    expect(s.detected).toBe(true);
    // b3 gpt-5: 1000*1.25 + 100*10 = 0.00225 ; b4 claude-sonnet-4-5: 1000*3 + 100*15 = 0.0045
    expect(s.apiEquivalentUsd).toBeCloseTo(0.00225 + 0.0045, 9);
    expect(s.turns).toBe(2);
    expect(s.sessions).toBe(1);
    expect(s.byModel.map((m) => m.model)).toEqual(["claude-4.5-sonnet-thinking", "gpt-5"]);
    expect(s.notes.some((n) => /dashboard is authoritative/.test(n))).toBe(true);
  });

  it("is detected but unpriced when every tokenCount is zero (current Cursor builds)", async () => {
    const s = await summarizeCursor("2026-10-01", "2026-10-31", makeDb(() => true, true));
    expect(s.detected).toBe(true);
    expect(s.turns).toBe(0);
    expect(s.apiEquivalentUsd).toBe(0);
    expect(s.notes[0]).toMatch(/1 conversation\(s\) in this window.*server-side.*cursor\.com\/dashboard/);
    const scan = scanCursorDb(makeDb(() => true, true), "2026-10-01", "2026-10-31");
    expect(scan.conversations).toBe(1);
    expect(scan.bubbles).toBe(4); // b2, b3, b4, b5 (b1 is user, b6 is junk)
  });

  it("handles a missing file, a non-Cursor database and model name normalization", async () => {
    const missing = await summarizeCursor("2026-10-01", "2026-10-31", join(tmpdir(), "tally-definitely-missing", "state.vscdb"));
    expect(missing.detected).toBe(false);
    expect(missing.turns).toBe(0);
    const other = join(mkdtempSync(join(tmpdir(), "tally-cursor-other-")), "state.vscdb");
    writeFileSync(other, "this is not sqlite");
    const bad = await summarizeCursor("2026-10-01", "2026-10-31", other);
    expect(bad.detected).toBe(true);
    expect(bad.notes[0]).toMatch(/could not be read/);
    const empty = join(mkdtempSync(join(tmpdir(), "tally-cursor-empty-")), "state.vscdb");
    new Database(empty).exec("CREATE TABLE ItemTable (key TEXT, value BLOB)");
    expect((await summarizeCursor("2026-10-01", "2026-10-31", empty)).turns).toBe(0);
    expect(normalizeCursorModel("claude-4.5-sonnet-thinking")).toBe("claude-sonnet-4-5");
    expect(normalizeCursorModel("claude-4-opus")).toBe("claude-opus-4");
    expect(normalizeCursorModel("claude-5.1-fable")).toBe("claude-fable-5-1");
    expect(normalizeCursorModel("gpt-5")).toBe("gpt-5");
    expect(normalizeCursorModel("auto")).toBe("auto");
  });
});
