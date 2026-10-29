import type { CreditPoolRow } from "@tally/core";

const DAY = 86_400_000;

export interface PoolBalance {
  pool: CreditPoolRow;
  /** Start of the current credit period (ISO). Local events before it do not count. */
  periodStart: string;
  /** When the pool refills or expires (ISO), or null for a one-off pool with no expiry. */
  periodEnd: string | null;
  daysLeft: number | null;
  spentUsd: number;
  unusedUsd: number;
  /** True when the pool is past its expiry date. */
  expired: boolean;
  /** How spend was measured. */
  accounting: "admin-api" | "local";
}

/** The most recent occurrence of day-of-month `day` at or before `now` (UTC). */
export function periodStartForReset(day: number, now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const clamp = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, Math.min(day, daysInMonth(yy, mm))));
  const thisMonth = clamp(y, m);
  if (thisMonth.getTime() <= now.getTime()) return thisMonth;
  return clamp(y, m - 1);
}

export function nextResetAfter(day: number, now: Date): Date {
  const start = periodStartForReset(day, now);
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + 1;
  return new Date(Date.UTC(y, m, Math.min(day, daysInMonth(y, m))));
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/**
 * Period and balance for a pool. `localSpend(sinceIso)` returns the router's own
 * accounting for events after `sinceIso`; when the pool was reconciled from the
 * provider inside the current period, that figure replaces local events up to the
 * reconcile time and local events after it are added on top.
 */
export function poolBalance(pool: CreditPoolRow, now: Date, localSpend: (sinceIso: string) => number): PoolBalance {
  let periodStart: Date;
  let periodEnd: Date | null = null;
  let expired = false;
  if (pool.resets_on != null) {
    periodStart = periodStartForReset(pool.resets_on, now);
    periodEnd = nextResetAfter(pool.resets_on, now);
  } else {
    periodStart = new Date(pool.created_at);
    if (pool.expires) {
      periodEnd = new Date(pool.expires.length === 10 ? `${pool.expires}T00:00:00Z` : pool.expires);
      expired = now.getTime() >= periodEnd.getTime();
    }
  }
  const startIso = periodStart.toISOString();

  let spent: number;
  let accounting: PoolBalance["accounting"] = "local";
  if (pool.reconciled_at && pool.reconciled_spent_usd != null && pool.reconciled_at >= startIso) {
    spent = pool.reconciled_spent_usd + localSpend(pool.reconciled_at);
    accounting = "admin-api";
  } else {
    // Events exactly at the period boundary belong to the new period; sumPoolSpend is exclusive.
    spent = localSpend(new Date(periodStart.getTime() - 1).toISOString());
  }
  const unused = Math.max(0, pool.amount_usd - spent);
  const daysLeft = periodEnd ? Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / DAY)) : null;
  return { pool, periodStart: startIso, periodEnd: periodEnd?.toISOString() ?? null, daysLeft, spentUsd: spent, unusedUsd: expired ? 0 : unused, expired, accounting };
}
