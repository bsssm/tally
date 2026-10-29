import type { Db } from "../db.js";
import type { Profile } from "../profile.js";
import { readDataJson } from "../paths.js";

/**
 * `verified`    = checked on the provider's own page on the date in `source`.
 * `unconfirmed` = reported by a third party; the first-party page could not confirm it. Shown, but labelled.
 * `asserted`    = seen only in third-party reporting and not yet checked. Should not ship in the seed.
 */
export type Verification = "verified" | "unconfirmed" | "asserted";
export const VERIFICATIONS: readonly Verification[] = ["verified", "unconfirmed", "asserted"];

export interface Deal {
  id: string;
  kind: "credit" | "free-model" | "promo-pricing" | "price-change" | "batch" | "stealth";
  provider: string;
  title: string;
  detail: string;
  value_usd_month: number | null;
  for: string[];
  starts: string | null;
  expires: string | null;
  recurring: string | null;
  url: string;
  source: string;
  verification: Verification;
  data_terms: string | null;
}

export interface RankedDeal extends Deal {
  status: "live" | "expiring" | "expired" | "upcoming";
  /** Why this one is shown to this user. */
  because: string;
  score: number;
}

export interface DealContext {
  profile: Profile;
  /** Models seen in the user's ledger (any provider), e.g. "deepseek/deepseek-v4.1-flash", "claude-fable-5-1". */
  models: Set<string>;
  /** Provider ids seen in the ledger: "openrouter", "claude-code", "anthropic" … */
  providers: Set<string>;
  today: string;
}

export function loadDeals(): Deal[] {
  return readDataJson<{ deals: Deal[] }>("deals.json").deals;
}

/** Short label for the renderer. `verified` needs no warning; the others do. */
export function verificationLabel(v: Verification): string {
  switch (v) {
    case "verified":
      return "verified";
    case "unconfirmed":
      return "unconfirmed (third-party report, not on the provider's page)";
    case "asserted":
      return "asserted (unchecked)";
  }
}

/** Catalog-derived deals: free models that appeared on OpenRouter in the last 30 days, and price drops on models the user runs. */
export function catalogDeals(db: Db, ctx: DealContext): Deal[] {
  const out: Deal[] = [];
  const rows = db
    .prepare(
      `SELECT model, MIN(seen_at) AS first_seen FROM price_history
       WHERE provider_id = 'openrouter' AND is_free = 1 GROUP BY model HAVING first_seen >= date(?, '-30 days')`,
    )
    .all(ctx.today) as { model: string; first_seen: string }[];
  for (const r of rows) {
    out.push({
      id: `or-free-${r.model}`, kind: "free-model", provider: "openrouter",
      title: `New free model on OpenRouter: ${r.model}`,
      detail: `First seen in the catalog on ${r.first_seen.slice(0, 10)}. Free tier limits: 20 requests/min, 50/day (1,000/day once you have bought $10 of credits).`,
      value_usd_month: null, for: ["any"], starts: r.first_seen.slice(0, 10), expires: null, recurring: null,
      url: `https://openrouter.ai/${r.model}`, source: "openrouter.ai/api/v1/models", verification: "verified",
      data_terms: "Check the listing's data policy; several free hosts may train on prompts.",
    });
  }
  const drops = db
    .prepare(
      `SELECT h.model, h.output_per_m AS now_out, p.output_per_m AS was_out, h.seen_at
       FROM price_history h JOIN price_history p ON p.model = h.model AND p.provider_id = h.provider_id
       WHERE h.provider_id = 'openrouter' AND h.seen_at = (SELECT MAX(seen_at) FROM price_history WHERE model = h.model AND provider_id = 'openrouter')
         AND p.seen_at = (SELECT MAX(seen_at) FROM price_history WHERE model = h.model AND provider_id = 'openrouter' AND seen_at < h.seen_at)
         AND p.output_per_m > 0 AND h.output_per_m < p.output_per_m * 0.9`,
    )
    .all() as { model: string; now_out: number; was_out: number; seen_at: string }[];
  for (const d of drops) {
    if (!ctx.models.has(d.model)) continue;
    out.push({
      id: `or-drop-${d.model}-${d.seen_at.slice(0, 10)}`, kind: "price-change", provider: "openrouter",
      title: `${d.model} output price fell ${Math.round((1 - d.now_out / d.was_out) * 100)}%`,
      detail: `$${d.was_out.toFixed(2)} → $${d.now_out.toFixed(2)} per 1M output tokens on OpenRouter's top endpoint.`,
      value_usd_month: null, for: [`model:${d.model}`], starts: d.seen_at.slice(0, 10), expires: null, recurring: null,
      url: `https://openrouter.ai/${d.model}`, source: "openrouter.ai/api/v1/models price history", verification: "verified", data_terms: null,
    });
  }
  return out;
}

export function rankDeals(deals: Deal[], ctx: DealContext): RankedDeal[] {
  const out: RankedDeal[] = [];
  for (const d of deals) {
    const status = statusOf(d, ctx.today);
    const why = matches(d, ctx);
    if (!why) continue;
    let score = 0;
    if (d.value_usd_month) score += Math.min(d.value_usd_month, 500);
    if (why.kind === "plan" || why.kind === "model" || why.kind === "provider") score += 100;
    if (status === "expiring") score += 60;
    if (status === "live") score += 30;
    if (status === "expired") score -= 500;
    if (d.verification === "verified") score += 10;
    if (d.verification === "unconfirmed") score -= 10;
    if (d.verification === "asserted") score -= 20;
    out.push({ ...d, status, because: why.text, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

function statusOf(d: Deal, today: string): RankedDeal["status"] {
  if (d.expires && d.expires < today) return "expired";
  if (d.starts && d.starts > today) return "upcoming";
  if (d.expires) {
    const days = (Date.parse(d.expires) - Date.parse(today)) / 86400000;
    if (days <= 14) return "expiring";
  }
  return "live";
}

function matches(d: Deal, ctx: DealContext): { kind: "plan" | "model" | "provider" | "any"; text: string } | undefined {
  for (const f of d.for) {
    if (f.startsWith("plan:") && ctx.profile.plan === f.slice(5)) return { kind: "plan", text: `you are on ${ctx.profile.plan}` };
    if (f.startsWith("model:") && ctx.models.has(f.slice(6))) return { kind: "model", text: `you run ${f.slice(6)}` };
    if (f.startsWith("provider:") && ctx.providers.has(f.slice(9))) return { kind: "provider", text: `you use ${f.slice(9)}` };
  }
  if (d.for.includes("any")) return { kind: "any", text: "open to anyone" };
  return undefined;
}

// ---- missed value ----

/** Share of the list price a deal of this kind would have removed. A free model removes all of it; discounts and batch halve it. */
const MISSED_FRACTION: Record<Deal["kind"], number> = {
  "free-model": 1,
  stealth: 1,
  batch: 0.5,
  "promo-pricing": 0.5,
  "price-change": 0,
  credit: 0,
};

export interface MissedDeal {
  id: string;
  title: string;
  model: string;
  /** Window the estimate covers, clipped to the deal's dates. */
  from: string;
  to: string;
  inputTokens: number;
  outputTokens: number;
  /** What those tokens cost at the ledger's list price (or the ledger's own cost when no catalog price exists). */
  spendUsd: number;
  /** What the deal would have taken off that spend. */
  missedUsd: number;
}

/**
 * For expired deals that matched one of the user's models, estimate what was left on the table:
 * tokens on that model during the deal window × the price the deal would have removed.
 * Prices come from `price_catalog` (any provider that lists the model); if none, the usage rows' own cost is used.
 * `credit` and `price-change` deals have no per-token saving and are skipped.
 */
export function missedDeals(db: Db, ranked: RankedDeal[], ctx: DealContext, windowDays = 30): MissedDeal[] {
  const out: MissedDeal[] = [];
  const tokens = db.prepare(
    `SELECT COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(output_tokens), 0) AS outp, COALESCE(SUM(cost_usd), 0) AS cost
     FROM usage_events WHERE model = ? AND date >= ? AND date <= ?`,
  );
  const price = db.prepare(
    `SELECT input_per_m, output_per_m FROM price_catalog WHERE model = ? AND is_free = 0 ORDER BY output_per_m DESC LIMIT 1`,
  );
  const floor = new Date(Date.parse(ctx.today) - windowDays * 86400000).toISOString().slice(0, 10);
  for (const d of ranked) {
    if (d.status !== "expired" || !d.expires) continue;
    const frac = MISSED_FRACTION[d.kind];
    if (!frac) continue;
    for (const f of d.for) {
      if (!f.startsWith("model:")) continue;
      const model = f.slice(6);
      if (!ctx.models.has(model)) continue;
      const from = [d.starts ?? floor, floor].sort().pop()!; // later of deal start and window floor
      const to = d.expires;
      if (from > to) continue;
      const t = tokens.get(model, from, to) as { inp: number; outp: number; cost: number };
      if (t.inp + t.outp === 0) continue;
      const p = price.get(model) as { input_per_m: number; output_per_m: number } | undefined;
      const spend = p ? (t.inp * p.input_per_m + t.outp * p.output_per_m) / 1e6 : t.cost;
      out.push({ id: d.id, title: d.title, model, from, to, inputTokens: t.inp, outputTokens: t.outp, spendUsd: spend, missedUsd: spend * frac });
    }
  }
  return out.sort((a, b) => b.missedUsd - a.missedUsd);
}
