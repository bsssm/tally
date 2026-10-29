import type { Db } from "./db.js";
import { getProvider, listProviders, recordSyncRun, replaceUsageEvents, upsertPrices } from "./db.js";
import type { Keystore } from "./keystore.js";
import { getAdapter } from "./adapters/index.js";
import { toSafeError } from "./redact.js";
import { isoDate } from "./dates.js";
import type { AdapterOptions } from "./types.js";

export interface SyncReport {
  providerId: string;
  status: "ok" | "error";
  rows: number;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  models: number;
  notes: string[];
  error?: string;
  priceRows?: number;
}

export interface SyncOptions {
  from: Date;
  to: Date;
  /** Limit to these provider ids; default all connected. */
  only?: string[];
  adapterOptions?: AdapterOptions;
  /** Also refresh the provider's price catalog when it has one. Default true. */
  prices?: boolean;
}

export async function syncProviders(db: Db, keystore: Keystore, opts: SyncOptions): Promise<SyncReport[]> {
  const from = isoDate(opts.from);
  const to = isoDate(opts.to);
  const targets = (opts.only?.length ? opts.only.map((id) => getProvider(db, id)).filter(Boolean) : listProviders(db)) as NonNullable<
    ReturnType<typeof getProvider>
  >[];
  const reports: SyncReport[] = [];

  for (const p of targets) {
    const startedAt = new Date().toISOString();
    const adapter = getAdapter(p.id, opts.adapterOptions);
    if (!adapter) {
      reports.push(empty(p.id, "error", `No adapter for provider "${p.id}"`));
      continue;
    }
    let key = "";
    try {
      key = keystore.open(p.key_ciphertext);
      const result = await adapter.fetchUsage(key, opts.from, opts.to);
      const rows = replaceUsageEvents(db, p.id, from, to, result.events);
      const report = empty(p.id, "ok");
      report.rows = rows;
      report.notes = result.notes;
      for (const e of result.events) {
        report.costUsd += e.costUsd;
        report.requests += e.requests;
        report.inputTokens += e.inputTokens;
        report.outputTokens += e.outputTokens;
      }
      report.models = new Set(result.events.map((e) => e.model)).size;
      if (opts.prices !== false && adapter.fetchPrices) {
        try {
          report.priceRows = upsertPrices(db, await adapter.fetchPrices());
        } catch (err) {
          report.notes.push(`Price catalog not refreshed: ${toSafeError(err, [key]).message}`);
        }
      }
      recordSyncRun(db, { providerId: p.id, startedAt, status: "ok", rows });
      reports.push(report);
    } catch (err) {
      const safe = toSafeError(err, [key], "sync");
      recordSyncRun(db, { providerId: p.id, startedAt, status: "error", rows: 0, error: safe.message });
      reports.push(empty(p.id, "error", safe.hint ? `${safe.message} — ${safe.hint}` : safe.message));
    }
  }
  return reports;
}

function empty(providerId: string, status: "ok" | "error", error?: string): SyncReport {
  return { providerId, status, rows: 0, costUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0, models: 0, notes: [], error };
}
