import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertPrices, type Db } from "../db.js";
import { catalogDeals, loadDeals, rankDeals } from "./index.js";

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
  it("seed catalog loads and every entry has a verification label and a source", () => {
    const d = loadDeals();
    expect(d.length).toBeGreaterThan(5);
    for (const x of d) {
      expect(["verified", "asserted"]).toContain(x.verification);
      expect(x.source.length).toBeGreaterThan(5);
      expect(x.url).toMatch(/^https?:\/\//);
    }
  });

  it("ranks plan-matched credits first, marks expiring and expired, filters non-matching", () => {
    const ctx = { profile: { plan: "max20" as const }, models: new Set(["deepseek/deepseek-v4.1-flash"]), providers: new Set(["openrouter", "claude-code", "anthropic"]), today: "2026-10-29" };
    const r = rankDeals(loadDeals(), ctx);
    expect(r[0].id).toBe("anthropic-max-api-credits-2026-10");
    expect(r[0].because).toBe("you are on max20");
    expect(r.find((d) => d.id === "qoder-deepseek-free-until-nov-1")!.status).toBe("expiring");
    expect(r.find((d) => d.id === "minimax-m31-flash-free-72h")!.status).toBe("expired");
    expect(r.find((d) => d.id === "fireworks-us-only-premium")).toBeUndefined(); // provider:fireworks only, user has none
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
});
