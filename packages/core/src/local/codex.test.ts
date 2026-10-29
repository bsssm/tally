import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeCodex, openaiPriceFor, resolveCodexAlias, codexTurnCostUsd } from "./codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "__fixtures__", "codex");

describe("Codex CLI local reader", () => {
  it("prices token_count deltas, recovers deltas from cumulative totals, applies the fast tier, skips malformed and out-of-window lines", async () => {
    const s = await summarizeCodex("2026-10-01", "2026-10-31", fixture);
    expect(s.source).toBe("codex");
    expect(s.detected).toBe(true);
    // gpt-5.4 turn 1: 6000 uncached*2.5 + 4000 cached*0.25 + 500 out*15 = 0.0235
    // gpt-5.4 turn 2 (cumulative only): delta 20000/10000 cached/1000 out = 0.0425
    // gpt-5.4 fast: (1000*2.5 + 100*15)/1e6 * 2 = 0.008
    // codex-auto-review on 2026-10-05 → gpt-5.6-luna standard: (1000*0.2 + 100*1.2)/1e6 = 0.00032
    // fork file: replayed turn deduped; gpt-5.3-codex: (1000*1.75 + 1000*0.175 + 300*14)/1e6 = 0.006125
    expect(s.apiEquivalentUsd).toBeCloseTo(0.0235 + 0.0425 + 0.008 + 0.00032 + 0.006125, 9);
    expect(s.turns).toBe(5);
    expect(s.sessions).toBe(2);
    expect(s.activeDays).toBe(2);
    expect(s.unknownModels).toEqual({ "gpt-unknown-9": 1 });
    expect(s.byModel[0].model).toBe("gpt-5.4");
    expect(s.byModel.map((m) => m.model)).toEqual(["gpt-5.4", "gpt-5.3-codex", "gpt-5.6-luna"]);
    expect(s.events.every((e) => e.providerId === "codex")).toBe(true);
    expect(s.events.find((e) => e.model === "gpt-5.4")!.reasoningTokens).toBe(600);
    expect(s.notes.some((n) => /no model in the log/.test(n))).toBe(true);
  });

  it("returns an undetected, empty summary when the directory is missing", async () => {
    const s = await summarizeCodex("2026-10-01", "2026-10-31", join(mkdtempSync(join(tmpdir(), "tally-nocodex-")), "nope"));
    expect(s.detected).toBe(false);
    expect(s.turns).toBe(0);
    expect(s.apiEquivalentUsd).toBe(0);
    expect(s.events).toEqual([]);
  });

  it("matches the longest price key, resolves the auto-review alias by date, and prices long context", () => {
    expect(openaiPriceFor("gpt-5.5-pro")!.output).toBe(180);
    expect(openaiPriceFor("gpt-5.5")!.output).toBe(30);
    expect(openaiPriceFor("gpt-5")!.output).toBe(10);
    expect(openaiPriceFor("gpt-5-mini-2026-01-01")!.output).toBe(2);
    expect(openaiPriceFor("davinci")).toBeUndefined();
    expect(resolveCodexAlias("codex-auto-review", "2026-04-01")).toEqual({ model: "gpt-5.4", fallback: true });
    expect(resolveCodexAlias("codex-auto-review", "2025-01-01")).toEqual({ model: "gpt-5", fallback: true });
    expect(resolveCodexAlias("gpt-5.4", "2026-04-01")).toEqual({ model: "gpt-5.4", fallback: false });
    const base = { date: "2026-10-05", sessionId: "s", cacheRead: 0, cacheWrite: 0, reasoning: 0, output: 0 };
    expect(codexTurnCostUsd({ ...base, model: "gpt-5.4", input: 100_000 })).toBeCloseTo(0.25, 9);
    expect(codexTurnCostUsd({ ...base, model: "gpt-5.4", input: 300_000 })).toBeCloseTo(1.5, 9); // >272k → $5/M
    expect(codexTurnCostUsd({ ...base, model: "gpt-5.4", input: 100_000, tierMultiplier: 0.5 })).toBeCloseTo(0.125, 9);
  });
});
