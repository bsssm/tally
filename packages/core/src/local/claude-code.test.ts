import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeClaudeCode } from "./claude-code.js";
import { verdict } from "../wallet.js";

const here = dirname(fileURLToPath(import.meta.url));

function projectsDir() {
  const root = mkdtempSync(join(tmpdir(), "tally-cc-"));
  const p = join(root, "-Users-x-proj");
  mkdirSync(p);
  copyFileSync(join(here, "__fixtures__", "session.jsonl"), join(p, "abc.jsonl"));
  return root;
}

describe("Claude Code local reader", () => {
  it("prices turns at API rates, dedupes streamed duplicates, respects the window, skips unknown models", async () => {
    const s = await summarizeClaudeCode("2026-10-01", "2026-10-31", projectsDir());
    expect(s.turns).toBe(2);
    expect(s.sessions).toBe(2);
    expect(s.activeDays).toBe(2);
    expect(s.unknownModels).toEqual({ "claude-mystery-9": 1 });
    // fable: 100*10 + 1000*50 + 1e6*0.25 + 1e5*20 (1h write)  = 1000+50000+250000+2000000 = 2,301,000 /1e6
    // opus:  200*4 + 2000*20 + 2e6*0.20 + 5e4*5             = 800+40000+400000+250000  = 690,800 /1e6
    expect(s.apiEquivalentUsd).toBeCloseTo(2.301 + 0.6908, 6);
    expect(s.byModel[0].model).toBe("claude-fable-5-1");
    expect(s.byModel[0].share).toBeCloseTo(2.301 / (2.301 + 0.6908), 6);
    expect(s.byModel[0].cacheHitRate).toBeCloseTo(1_000_000 / 1_100_100, 6);
    // normalized events: one per (date, model)
    expect(s.events).toHaveLength(2);
    expect(s.events.every((e) => e.providerId === "claude-code" && e.route === "subscription")).toBe(true);
  });

  it("verdict: keep / downgrade / credits / model-mix levers", async () => {
    const s = await summarizeClaudeCode("2026-10-01", "2026-10-31", projectsDir());
    // ~$3 of usage on a $200 plan → downgrade suggestion, credits lever present
    const v = verdict(s, "max20");
    expect(v.headline).toMatch(/Max 5x would cover this/);
    expect(v.levers.some((l) => /\$200\/month of Claude Platform API credits/.test(l))).toBe(true);
    expect(v.levers.some((l) => /claude-fable-5-1, which bills 2\.5x claude-opus-5-5/.test(l))).toBe(true);
    expect(verdict(s, "max20", { creditsClaimed: true }).levers.some((l) => /API credits/.test(l))).toBe(false);
    // scale it: pretend $1,400 on max20 → keep
    const big = { ...s, apiEquivalentUsd: 1400, byModel: s.byModel.map((m) => ({ ...m, usd: m.usd * 468 })) };
    expect(verdict(big, "max20").headline).toMatch(/7\.0x\. Keep it/);
    expect(verdict(big, "api").headline).toMatch(/Max 20x is \$200 flat/);
  });
});
