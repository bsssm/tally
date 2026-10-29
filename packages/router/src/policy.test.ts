import { describe, expect, it } from "vitest";
import type { CreditPoolRow } from "@tally/core";
import { choose, ownerOf, toFirstPartyId, toOpenRouterSlug, type RouteState } from "./policy.js";
import { nextResetAfter, periodStartForReset, poolBalance } from "./pools.js";

const NOW = new Date("2026-10-29T18:00:00Z");

function pool(over: Partial<CreditPoolRow> = {}): CreditPoolRow {
  return {
    id: 1,
    provider: "anthropic",
    amount_usd: 200,
    resets_on: 7,
    expires: null,
    label: "Max 20x credits",
    source: "manual",
    created_at: "2026-10-01T00:00:00Z",
    reconciled_spent_usd: null,
    reconciled_at: null,
    ...over,
  };
}

const PRICES: Record<string, { inputPerM: number; outputPerM: number }> = {
  "openrouter:meta-llama/llama-3.3-70b-instruct": { inputPerM: 0.1, outputPerM: 0.25 },
  "openrouter:anthropic/claude-opus-5.5": { inputPerM: 4, outputPerM: 20 },
  "anthropic:claude-opus-5-5": { inputPerM: 4, outputPerM: 20 },
};

function state(over: Partial<RouteState> & { spent?: Record<number, number> } = {}): RouteState {
  const spent = over.spent ?? {};
  const pools = (over.pools as unknown as CreditPoolRow[] | undefined)?.map((p) => poolBalance(p, NOW, () => spent[p.id] ?? 0)) ?? [];
  return {
    pools,
    keys: over.keys ?? new Set(["anthropic", "openrouter"]),
    price: over.price ?? ((u, m) => (PRICES[`${u}:${m}`] ? { ...PRICES[`${u}:${m}`], source: "test" } : undefined)),
  };
}
const rows = (...p: CreditPoolRow[]) => p as unknown as RouteState["pools"];

describe("choose(): policy", () => {
  it("(a) Claude + Anthropic pool with balance → Anthropic direct on credits", () => {
    const d = choose({}, { model: "claude-opus-5-5", shape: "openai" }, state({ pools: rows(pool()), spent: { 1: 27 } }));
    expect(d.upstream).toBe("anthropic");
    expect(d.poolId).toBe(1);
    expect(d.reason).toContain("$173.00 unused");
    expect(d.reason).toContain("days left");
    expect(d.expected?.inputPerM).toBe(4);
  });

  it("exhausted pool → cheapest paid route (OpenRouter sort=price when no anthropic key)", () => {
    const d = choose({}, { model: "claude-opus-5-5", shape: "openai" }, state({ pools: rows(pool()), spent: { 1: 200 }, keys: new Set(["openrouter"]) }));
    expect(d.upstream).toBe("openrouter");
    expect(d.poolId).toBeNull();
    expect(d.upstreamModel).toBe("anthropic/claude-opus-5.5");
    expect(d.openrouterProvider?.sort).toBe("price");
    expect(d.expected?.inputPerM).toBe(4);
  });

  it("exhausted pool but anthropic key stored → Anthropic direct, paid, no pool", () => {
    const d = choose({}, { model: "claude-sonnet-5-5", shape: "anthropic" }, state({ pools: rows(pool()), spent: { 1: 199.995 } }));
    expect(d.upstream).toBe("anthropic");
    expect(d.poolId).toBeNull();
    expect(d.reason).toContain("no credits left");
  });

  it("pool that resets today: period restarted, old spend does not count", () => {
    const today = new Date("2026-11-07T09:00:00Z");
    // A ledger with $999 of events before the reset day; sumPoolSpend counts events strictly after `since`.
    const ledger = [{ ts: "2026-11-06T23:00:00.000Z", usd: 999 }];
    const b = poolBalance(pool(), today, (since) => ledger.filter((e) => e.ts > since).reduce((s, e) => s + e.usd, 0));
    expect(b.periodStart).toBe("2026-11-07T00:00:00.000Z");
    expect(b.unusedUsd).toBe(200);
    expect(b.daysLeft).toBe(30);
    const d = choose({}, { model: "claude-haiku-5-5", shape: "openai" }, { pools: [b], keys: new Set(["anthropic"]), price: () => undefined });
    expect(d.upstream).toBe("anthropic");
    expect(d.poolId).toBe(1);
  });

  it("non-Claude model ignores the Anthropic pool and takes the cheapest route", () => {
    const d = choose({}, { model: "meta-llama/llama-3.3-70b-instruct", shape: "openai" }, state({ pools: rows(pool()) }));
    expect(d.upstream).toBe("openrouter");
    expect(d.poolId).toBeNull();
    expect(d.reason).toBe("cheapest: openrouter sort=price");
    expect(d.expected).toEqual({ inputPerM: 0.1, outputPerM: 0.25, source: "test" });
  });

  it("(b) an OpenRouter pool covers any model", () => {
    const d = choose({}, { model: "deepseek/deepseek-chat", shape: "openai" }, state({ pools: rows(pool({ id: 2, provider: "openrouter", amount_usd: 10, resets_on: null })), spent: { 2: 3 } }));
    expect(d.upstream).toBe("openrouter");
    expect(d.poolId).toBe(2);
    expect(d.reason).toContain("openrouter credits: $7.00 unused");
  });

  it("closed OpenAI model: direct when the key is stored, OpenRouter otherwise", () => {
    expect(choose({}, { model: "gpt-4o", shape: "openai" }, state({ keys: new Set(["openai", "openrouter"]) })).upstream).toBe("openai");
    const viaOr = choose({}, { model: "gpt-4o", shape: "openai" }, state({ keys: new Set(["openrouter"]) }));
    expect(viaOr.upstream).toBe("openrouter");
    expect(viaOr.upstreamModel).toBe("openai/gpt-4o");
  });

  it("no usable key → blocked with a connect hint", () => {
    const d = choose({}, { model: "claude-opus-5-5", shape: "anthropic" }, state({ keys: new Set() }));
    expect(d.blocked).toContain("tally connect anthropic");
    expect(choose({}, { model: "qwen/qwen3-32b", shape: "openai" }, state({ keys: new Set(["anthropic"]) })).blocked).toContain("tally connect openrouter");
  });

  it("expired one-off pool is skipped; preferCredits=false skips every pool", () => {
    const expired = pool({ id: 3, resets_on: null, expires: "2026-10-01", created_at: "2026-09-01T00:00:00Z" });
    expect(choose({}, { model: "claude-opus-5-5", shape: "openai" }, state({ pools: rows(expired) })).poolId).toBeNull();
    expect(choose({ preferCredits: false }, { model: "claude-opus-5-5", shape: "openai" }, state({ pools: rows(pool()) })).poolId).toBeNull();
  });

  it("reconciled spend from the Admin API replaces local accounting up to the reconcile time", () => {
    const p = pool({ reconciled_spent_usd: 50, reconciled_at: "2026-10-20T00:00:00Z" });
    const b = poolBalance(p, NOW, (since) => (since === "2026-10-20T00:00:00Z" ? 5 : 999));
    expect(b.accounting).toBe("admin-api");
    expect(b.spentUsd).toBe(55);
    expect(b.unusedUsd).toBe(145);
  });
});

describe("model naming", () => {
  it("maps first-party ids to OpenRouter slugs and back", () => {
    expect(toOpenRouterSlug("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(toOpenRouterSlug("claude-sonnet-4-5-20250929")).toBe("anthropic/claude-sonnet-4.5");
    expect(toOpenRouterSlug("gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(toOpenRouterSlug("meta-llama/llama-3.3-70b-instruct")).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(toFirstPartyId("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(ownerOf("gemini-2.5-pro")).toBe("google");
    expect(ownerOf("o3-mini")).toBe("openai");
    expect(ownerOf("qwen/qwen3-32b")).toBe("open");
  });

  it("period math handles month ends", () => {
    expect(periodStartForReset(31, new Date("2026-03-05T00:00:00Z")).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(nextResetAfter(31, new Date("2026-03-05T00:00:00Z")).toISOString()).toBe("2026-03-31T00:00:00.000Z");
    expect(nextResetAfter(7, NOW).toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });
});
