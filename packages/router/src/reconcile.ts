import { setPoolReconciled, TallyError, type CreditPoolRow, type Db, type FetchLike } from "@tally/core";
import { poolBalance } from "./pools.js";

/**
 * Anthropic Admin API cost report → pool.reconciled_spent_usd.
 * GET /v1/organizations/cost_report?starting_at=<period start>&ending_at=<now>&bucket_width=1d&limit=31
 * Amounts arrive as decimal strings in cents ("123.45" = $1.23). Docs: platform.claude.com/docs/en/manage-claude/usage-cost-api
 */
export interface ReconcileOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  now?: Date;
  /** Skip when the last reconcile is younger than this. Default 1h. */
  minIntervalMs?: number;
}

export interface ReconcileResult {
  poolId: number;
  spentUsd: number;
  at: string;
  skipped?: "fresh";
}

export async function reconcileAnthropicPool(db: Db, pool: CreditPoolRow, adminKey: string, opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const minInterval = opts.minIntervalMs ?? 3_600_000;
  if (pool.reconciled_at && now.getTime() - new Date(pool.reconciled_at).getTime() < minInterval) {
    return { poolId: pool.id, spentUsd: pool.reconciled_spent_usd ?? 0, at: pool.reconciled_at, skipped: "fresh" };
  }
  const f = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const { periodStart } = poolBalance(pool, now, () => 0);
  const startDay = periodStart.slice(0, 10) + "T00:00:00Z";

  let cents = 0;
  let page: string | undefined;
  for (let guard = 0; guard < 12; guard++) {
    const qs = new URLSearchParams({ starting_at: startDay, ending_at: now.toISOString(), bucket_width: "1d", limit: "31" });
    if (page) qs.set("page", page);
    const res = await f(`${base}/v1/organizations/cost_report?${qs}`, {
      headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01", Accept: "application/json", "User-Agent": "tally-router/0.0.1" },
    }).catch((e) => {
      throw new TallyError("network", `cost_report: ${e instanceof Error ? e.message : String(e)}`, undefined, [adminKey]);
    });
    if (res.status === 401 || res.status === 403) {
      throw new TallyError("unauthorized", `cost_report: HTTP ${res.status}. The anthropic-admin key must be an Admin API key (sk-ant-admin…).`, undefined, [adminKey]);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TallyError("http", `cost_report: HTTP ${res.status} ${text.slice(0, 200)}`, undefined, [adminKey]);
    }
    const body = (await res.json()) as { data?: { results?: { amount?: string }[] }[]; has_more?: boolean; next_page?: string | null };
    for (const bucket of body.data ?? []) for (const r of bucket.results ?? []) cents += Number(r.amount ?? 0) || 0;
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  const spentUsd = Math.round(cents) / 100;
  const at = now.toISOString();
  setPoolReconciled(db, pool.id, spentUsd, at);
  return { poolId: pool.id, spentUsd, at };
}
