import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeGemini, googlePriceFor, readGeminiChatFile, geminiTurnCostUsd } from "./gemini.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "__fixtures__", "gemini");

describe("Gemini CLI local reader", () => {
  it("reads .jsonl and legacy .json chats, lets a re-emitted message id win, bills thoughts as output and cached as cache reads", async () => {
    const s = await summarizeGemini("2026-10-01", "2026-10-31", fixture);
    expect(s.source).toBe("gemini");
    expect(s.detected).toBe(true);
    // g1 (final version): input 5000-2000 cached + 50 tool = 3050 @1.25, 2000 cached @0.125, output 600+100 thoughts @10 → 0.0110625
    // g2: 250000 input > 200k → long context @4, 1000 out @18 → 1.018
    // legacy g1: 1000 @0.30 + 100 @2.5 → 0.00055
    expect(s.apiEquivalentUsd).toBeCloseTo(0.0110625 + 1.018 + 0.00055, 9);
    expect(s.turns).toBe(3);
    expect(s.sessions).toBe(2);
    expect(s.activeDays).toBe(2);
    expect(s.unknownModels).toEqual({});
    expect(s.byModel[0].model).toBe("gemini-3.1-pro-preview");
    const pro = s.events.find((e) => e.model === "gemini-2.5-pro")!;
    expect(pro.reasoningTokens).toBe(100);
    expect(pro.cachedTokens).toBe(2000);
    expect(pro.providerId).toBe("gemini");
  });

  it("ignores files outside chats/, control records and malformed lines", () => {
    const turns = readGeminiChatFile(join(fixture, "tmp", "hash1", "chats", "session-2026-10-05T10-00-abcd1234.jsonl"));
    expect(turns.map((t) => t.sessionId)).toEqual(["sess-g", "sess-g"]);
    expect(turns.find((t) => t.model === "gemini-2.5-pro")!.output).toBe(700);
    const dir = mkdtempSync(join(tmpdir(), "tally-gem-"));
    mkdirSync(join(dir, "tmp", "h", "chats"), { recursive: true });
    writeFileSync(join(dir, "tmp", "h", "chats", "broken.json"), "{not json");
    writeFileSync(join(dir, "tmp", "h", "chats", "empty.jsonl"), "");
    expect(readGeminiChatFile(join(dir, "tmp", "h", "chats", "broken.json"))).toEqual([]);
  });

  it("is empty and undetected without ~/.gemini, and prices by longest prefix", async () => {
    const s = await summarizeGemini("2026-10-01", "2026-10-31", join(mkdtempSync(join(tmpdir(), "tally-nogem-")), "none"));
    expect(s.detected).toBe(false);
    expect(s.turns).toBe(0);
    expect(googlePriceFor("gemini-2.5-flash-lite")!.output).toBe(0.4);
    expect(googlePriceFor("gemini-2.5-flash")!.output).toBe(2.5);
    expect(googlePriceFor("gemini-3.1-pro-preview-06-2026")!.input).toBe(2);
    expect(googlePriceFor("palm-2")).toBeUndefined();
    const t = { date: "2026-10-05", sessionId: "s", model: "gemini-2.5-pro", input: 100_000, output: 0, cacheRead: 100_000, cacheWrite: 0, reasoning: 0 };
    expect(geminiTurnCostUsd(t)).toBeCloseTo((100_000 * 1.25 + 100_000 * 0.125) / 1e6, 9);
    expect(geminiTurnCostUsd({ ...t, input: 150_000 })).toBeCloseTo((150_000 * 2.5 + 100_000 * 0.25) / 1e6, 9); // 250k > 200k
  });
});
