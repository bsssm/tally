import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, replaceUsageEvents, upsertPrices, type Db } from "../db.js";
import { catalogDeals, loadDeals, missedDeals, rankDeals, verificationLabel, VERIFICATIONS, type Deal } from "./index.js";

let home: string;
let db: Db;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tally-deals-"));
  process.env.TALLY_HOME = home;
  db = openDb();
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const base = { providerId: "openrouter", cachedPerM: null, source: "t", updatedAt: "2026-10-29T00:00:00Z" };

describe("deals", () => {
  it("seed catalog loads; every entry is verified or unconfirmed (never asserted), has a source and a first-party-looking url", () => {
    const d = loadDeals();
    expect(d.length).toBeGreaterThan(10);
    const ids = new Set<string>();
    for (const x of d) {
      expect(VERIFICATIONS).toContain(x.verification);
      expect(x.verification).not.toBe("asserted");
      expect(x.source.length).toBeGreaterThan(5);
      expect(x.url).toMatch(/^https?:\/\//);
      expect(x.for.length).toBeGreaterThan(0);
      expect(ids.has(x.id)).toBe(false);
      ids.add(x.id);
      if (x.starts) expect(x.starts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (x.expires) expect(x.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("labels each verification level for the renderer", () => {
    expect(verificationLabel("verified")).toBe("verified");
    expect(verificationLabel("unconfirmed")).toMatch(/third-party/);
    expect(verificationLabel("asserted")).toMatch(/unchecked/);
  });

  it("ranks plan-matched credits first, marks expiring and expired, filters non-matching, penalises unconfirmed", () => {
    const ctx = { profile: { plan: "max20" as const }, models: new Set(["deepseek/deepseek-v4.1-flash"]), providers: new Set(["openrouter", "claude-code", "anthropic"]), today: "2026-10-29" };
    const r = rankDeals(loadDeals(), ctx);
    expect(r[0].id).toBe("anthropic-max-api-credits-2026-10");
    expect(r[0].because).toBe("you are on max20");
    expect(r.find((d) => d.id === "qoder-deepseek-free-until-nov-1")!.status).toBe("expiring");
    expect(r.find((d) => d.id === "minimax-m31-flash-free-72h")!.status).toBe("expired");
    expect(r.find((d) => d.id === "fireworks-us-only-premium")).toBeUndefined(); // provider:fireworks only, user has none
    const kilo = r.find((d) => d.id === "kilo-stealth-glyph-cluster")!;
    const vercel = r.find((d) => d.id === "vercel-gateway-stealth-glyph-cluster")!;
    expect(kilo.verification).toBe("unconfirmed");
    expect(kilo.score).toBeLessThan(vercel.score);
    const apiUser = rankDeals(loadDeals(), { ...ctx, profile: { plan: "api" } });
    expect(apiUser.find((d) => d.id === "anthropic-max-api-credits-2026-10")).toBeUndefined();
  });

  it("derives deals from price history: new free models and drops on models you run", () => {
    upsertPrices(db, [
      { ...base, model: "a/b", inputPerM: 1, outputPerM: 4, isFree: false },
      { ...base, model: "c/d:free", inputPerM: 0, outputPerM: 0, isFree: true },
    ]);
    upsertPrices(db, [{ ...base, model: "a/b", inputPerM: 1, outputPerM: 2, isFree: false }]); // 50% drop
    const ctx = { profile: {}, models: new Set(["a/b"]), providers: new Set(["openrouter"]), today: "2026-10-29" };
    const d = catalogDeals(db, ctx);
    expect(d.find((x) => x.id === "or-free-c/d:free")).toBeTruthy();
    const drop = d.find((x) => x.id.startsWith("or-drop-a/b"))!;
    expect(drop.title).toMatch(/fell 50%/);
    // history has 3 rows: a/b twice (changed), c/d once
    expect(db.prepare("SELECT COUNT(*) n FROM price_history").get()).toEqual({ n: 3 });
  });

  it("estimates what an expired model-matched deal would have saved from the ledger's tokens and catalog price", () => {
    const model = "deepseek/deepseek-v4.1-flash";
    upsertPrices(db, [{ ...base, model, inputPerM: 0.3, outputPerM: 1.2, isFree: false }]);
    const ev = (date: string, inp: number, outp: number) => ({ providerId: "openrouter", model, date, route: "", inputTokens: inp, outputTokens: outp, cachedTokens: 0, reasoningTokens: 0, requests: 1, costUsd: 0, raw: null });
    replaceUsageEvents(db, "openrouter", "2026-10-01", "2026-10-29", [
      ev("2026-10-18", 1_000_000, 100_000), // before the window: ignored
      ev("2026-10-20", 2_000_000, 500_000), // in window
      ev("2026-10-22", 1_000_000, 500_000), // in window (last day)
      ev("2026-10-23", 9_000_000, 900_000), // after: ignored
    ]);
    const free: Deal = {
      id: "x-free", kind: "free-model", provider: "x", title: "x free for 72h", detail: "", value_usd_month: null,
      for: [`model:${model}`], starts: "2026-10-19", expires: "2026-10-22", recurring: null, url: "https://x", source: "test", verification: "verified", data_terms: null,
    };
    const half: Deal = { ...free, id: "x-batch", kind: "batch", for: [`model:${model}`, "any"] };
    const credit: Deal = { ...free, id: "x-credit", kind: "credit" };
    const ctx = { profile: {}, models: new Set([model]), providers: new Set(["openrouter"]), today: "2026-10-29" };
    const ranked = rankDeals([free, half, credit], ctx);
    expect(ranked.every((d) => d.status === "expired")).toBe(true);
    const m = missedDeals(db, ranked, ctx);
    // 3M input × $0.30 + 1M output × $1.20 = $0.90 + $1.20 = $2.10 in the window
    const f = m.find((x) => x.id === "x-free")!;
    expect(f.inputTokens).toBe(3_000_000);
    expect(f.outputTokens).toBe(1_000_000);
    expect(f.from).toBe("2026-10-19");
    expect(f.to).toBe("2026-10-22");
    expect(f.spendUsd).toBeCloseTo(2.1, 6);
    expect(f.missedUsd).toBeCloseTo(2.1, 6);
    expect(m.find((x) => x.id === "x-batch")!.missedUsd).toBeCloseTo(1.05, 6);
    expect(m.find((x) => x.id === "x-credit")).toBeUndefined(); // no per-token saving
    expect(m[0].id).toBe("x-free"); // sorted by missed value
    // a model the user never ran yields nothing
    expect(missedDeals(db, ranked, { ...ctx, models: new Set(["other"]) })).toEqual([]);
  });

  it("falls back to the ledger's own cost when the catalog has no price for the model", () => {
    const model = "local/mystery";
    replaceUsageEvents(db, "openrouter", "2026-10-01", "2026-10-29", [
      { providerId: "openrouter", model, date: "2026-10-20", route: "", inputTokens: 10, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0, requests: 1, costUsd: 0.42, raw: null },
    ]);
    const d: Deal = {
      id: "y", kind: "free-model", provider: "y", title: "y", detail: "", value_usd_month: null, for: [`model:${model}`],
      starts: null, expires: "2026-10-21", recurring: null, url: "https://y", source: "test", verification: "unconfirmed", data_terms: null,
    };
    const ctx = { profile: {}, models: new Set([model]), providers: new Set(["openrouter"]), today: "2026-10-29" };
    const m = missedDeals(db, rankDeals([d], ctx), ctx);
    expect(m).toHaveLength(1);
    expect(m[0].missedUsd).toBeCloseTo(0.42, 6);
    expect(m[0].from).toBe("2026-09-29"); // no deal start: 30-day window floor
  });
});
