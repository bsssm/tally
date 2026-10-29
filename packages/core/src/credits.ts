import type { Db } from "./db.js";

/**
 * Credit pools and route events: the ledger side of the credits router.
 * A pool is a declared bucket of prepaid or expiring credit on one provider
 * ("$200/month of Anthropic API credits, resets on the 7th"). Balance math
 * (period start, days left, unused) lives in @tally/router's policy; this file
 * only stores rows.
 */

export interface CreditPoolRow {
  id: number;
  provider: string;
  amount_usd: number;
  /** Day of month (1–31) the pool refills; null for one-off pools. */
  resets_on: number | null;
  /** ISO date the pool expires; null for monthly pools. */
  expires: string | null;
  label: string | null;
  source: "manual" | "admin-api";
  created_at: string;
  /** Spend confirmed by the provider's own report (Admin API), if any. */
  reconciled_spent_usd: number | null;
  reconciled_at: string | null;
}

export interface NewCreditPool {
  provider: string;
  amountUsd: number;
  resetsOn?: number | null;
  expires?: string | null;
  label?: string | null;
  source?: "manual" | "admin-api";
  createdAt?: string;
}

export function addCreditPool(db: Db, p: NewCreditPool): CreditPoolRow {
  if (p.resetsOn != null && (p.resetsOn < 1 || p.resetsOn > 31)) throw new Error("resetsOn must be 1–31");
  const r = db
    .prepare(
      `INSERT INTO credit_pools (provider, amount_usd, resets_on, expires, label, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.provider, p.amountUsd, p.resetsOn ?? null, p.expires ?? null, p.label ?? null, p.source ?? "manual", p.createdAt ?? new Date().toISOString());
  return getCreditPool(db, Number(r.lastInsertRowid))!;
}

export function getCreditPool(db: Db, id: number): CreditPoolRow | undefined {
  return db.prepare("SELECT * FROM credit_pools WHERE id = ?").get(id) as CreditPoolRow | undefined;
}

export function listCreditPools(db: Db): CreditPoolRow[] {
  return db.prepare("SELECT * FROM credit_pools ORDER BY id").all() as CreditPoolRow[];
}

export function removeCreditPool(db: Db, id: number): boolean {
  return db.prepare("DELETE FROM credit_pools WHERE id = ?").run(id).changes > 0;
}

export function setPoolReconciled(db: Db, id: number, spentUsd: number, at: string): void {
  db.prepare("UPDATE credit_pools SET reconciled_spent_usd = ?, reconciled_at = ? WHERE id = ?").run(spentUsd, at, id);
}

export interface RouteEventRow {
  id: number;
  ts: string;
  model: string;
  upstream: string;
  upstream_model: string | null;
  reason: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  est_cost_usd: number | null;
  pool_id: number | null;
  job: string | null;
  status: number | null;
}

export interface NewRouteEvent {
  ts?: string;
  model: string;
  upstream: string;
  upstreamModel?: string | null;
  reason: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  estCostUsd?: number | null;
  poolId?: number | null;
  job?: string | null;
  status?: number | null;
}

export function insertRouteEvent(db: Db, e: NewRouteEvent): number {
  const r = db
    .prepare(
      `INSERT INTO route_events (ts, model, upstream, upstream_model, reason, input_tokens, output_tokens, cached_tokens, est_cost_usd, pool_id, job, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.ts ?? new Date().toISOString(),
      e.model,
      e.upstream,
      e.upstreamModel ?? null,
      e.reason,
      e.inputTokens ?? 0,
      e.outputTokens ?? 0,
      e.cachedTokens ?? 0,
      e.estCostUsd ?? null,
      e.poolId ?? null,
      e.job ?? null,
      e.status ?? null,
    );
  return Number(r.lastInsertRowid);
}

export function listRouteEvents(db: Db, limit = 20): RouteEventRow[] {
  return db.prepare("SELECT * FROM route_events ORDER BY id DESC LIMIT ?").all(limit) as RouteEventRow[];
}

/** Local spend attributed to a pool since `sinceIso` (exclusive of events before it). */
export function sumPoolSpend(db: Db, poolId: number, sinceIso: string): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(est_cost_usd), 0) AS usd FROM route_events WHERE pool_id = ? AND ts > ?")
    .get(poolId, sinceIso) as { usd: number };
  return r.usd;
}

export interface JobSummary {
  job: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  onCredits: number;
  lastTs: string;
  models: number;
}

export function summarizeRouteJobs(db: Db, sinceIso?: string): JobSummary[] {
  return db
    .prepare(
      `SELECT COALESCE(job, '(untagged)') AS job, COUNT(*) AS requests,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              COALESCE(SUM(est_cost_usd), 0) AS estCostUsd,
              SUM(CASE WHEN pool_id IS NOT NULL THEN 1 ELSE 0 END) AS onCredits,
              MAX(ts) AS lastTs, COUNT(DISTINCT model) AS models
       FROM route_events WHERE ts >= ?
       GROUP BY COALESCE(job, '(untagged)') ORDER BY estCostUsd DESC`,
    )
    .all(sinceIso ?? "0000") as JobSummary[];
}

export interface CatalogPrice {
  inputPerM: number;
  outputPerM: number;
  cachedPerM: number | null;
  isFree: boolean;
  updatedAt: string;
}

/** One row of the ledger price catalog (filled by `tally sync`). */
export function getCatalogPrice(db: Db, providerId: string, model: string): CatalogPrice | undefined {
  const r = db
    .prepare("SELECT input_per_m, output_per_m, cached_per_m, is_free, updated_at FROM price_catalog WHERE provider_id = ? AND model = ?")
    .get(providerId, model) as { input_per_m: number; output_per_m: number; cached_per_m: number | null; is_free: number; updated_at: string } | undefined;
  if (!r) return undefined;
  return { inputPerM: r.input_per_m, outputPerM: r.output_per_m, cachedPerM: r.cached_per_m, isFree: r.is_free === 1, updatedAt: r.updated_at };
}
