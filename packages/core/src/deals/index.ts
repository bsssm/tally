import { createRequire } from "node:module";
import type { Db } from "../db.js";
import type { Profile } from "../profile.js";

const require = createRequire(import.meta.url);

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
  verification: "verified" | "asserted";
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
  return (require("../../data/deals.json") as { deals: Deal[] }).deals;
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
      detail: `First seen in the catalog on ${r.first_seen.slice(0, 10)}. Free tier limits: 50 requests/day (1,000/day after a $10 top-up).`,
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
