import Database from "better-sqlite3";
import { dbPath } from "./paths.js";
import type { UsageEvent, PriceRow, KeyType } from "./types.js";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  key_ciphertext BLOB NOT NULL,
  key_type TEXT NOT NULL CHECK (key_type IN ('api','admin')),
  meta JSON,
  last_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  date TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  raw JSON,
  UNIQUE (provider_id, model, date, route)
);
CREATE INDEX IF NOT EXISTS usage_events_date ON usage_events (date);
CREATE INDEX IF NOT EXISTS usage_events_provider_date ON usage_events (provider_id, date);
CREATE TABLE IF NOT EXISTS price_catalog (
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_m REAL NOT NULL,
  output_per_m REAL NOT NULL,
  cached_per_m REAL,
  is_free INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (provider_id, model)
);
CREATE TABLE IF NOT EXISTS model_aliases (
  canonical TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  PRIMARY KEY (provider_id, provider_model)
);
CREATE TABLE IF NOT EXISTS credit_programs (
  id TEXT PRIMARY KEY,
  provider_id TEXT,
  name TEXT NOT NULL,
  amount_usd REAL,
  fees_waived_months INTEGER,
  eligibility JSON,
  apply_url TEXT,
  expires TEXT,
  last_verified TEXT
);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  est_savings_usd REAL NOT NULL DEFAULT 0,
  action_url TEXT,
  created_at TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  value JSON
);
`;

export function openDb(path: string = dbPath()): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export interface ProviderRow {
  id: string;
  name: string;
  connected_at: string;
  key_ciphertext: Buffer;
  key_type: KeyType;
  meta: string | null;
  last_synced_at: string | null;
}

export function upsertProvider(
  db: Db,
  p: { id: string; name: string; keyCiphertext: Buffer; keyType: KeyType; meta?: Record<string, unknown> },
): void {
  db.prepare(
    `INSERT INTO providers (id, name, connected_at, key_ciphertext, key_type, meta)
     VALUES (@id, @name, @connected_at, @key_ciphertext, @key_type, @meta)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, connected_at = excluded.connected_at,
       key_ciphertext = excluded.key_ciphertext, key_type = excluded.key_type, meta = excluded.meta`,
  ).run({
    id: p.id,
    name: p.name,
    connected_at: new Date().toISOString(),
    key_ciphertext: p.keyCiphertext,
    key_type: p.keyType,
    meta: p.meta ? JSON.stringify(p.meta) : null,
  });
}

export function getProvider(db: Db, id: string): ProviderRow | undefined {
  return db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;
}

export function listProviders(db: Db): ProviderRow[] {
  return db.prepare("SELECT * FROM providers ORDER BY connected_at").all() as ProviderRow[];
}

export function removeProvider(db: Db, id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM usage_events WHERE provider_id = ?").run(id);
    db.prepare("DELETE FROM sync_runs WHERE provider_id = ?").run(id);
    db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  })();
}

/**
 * Replace the provider's rows inside [from, to] with the fresh set.
 * Providers restate past days (late-arriving usage), so replacing beats inserting.
 */
export function replaceUsageEvents(db: Db, providerId: string, from: string, to: string, events: UsageEvent[]): number {
  const del = db.prepare("DELETE FROM usage_events WHERE provider_id = ? AND date >= ? AND date <= ?");
  const ins = db.prepare(
    `INSERT INTO usage_events
       (provider_id, model, date, route, input_tokens, output_tokens, cached_tokens, reasoning_tokens, requests, cost_usd, raw)
     VALUES (@provider_id, @model, @date, @route, @input_tokens, @output_tokens, @cached_tokens, @reasoning_tokens, @requests, @cost_usd, @raw)
     ON CONFLICT(provider_id, model, date, route) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cached_tokens = cached_tokens + excluded.cached_tokens,
       reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
       requests = requests + excluded.requests,
       cost_usd = cost_usd + excluded.cost_usd`,
  );
  return db.transaction(() => {
    del.run(providerId, from, to);
    let n = 0;
    for (const e of events) {
      ins.run({
        provider_id: providerId,
        model: e.model,
        date: e.date,
        route: e.route ?? "",
        input_tokens: e.inputTokens,
        output_tokens: e.outputTokens,
        cached_tokens: e.cachedTokens,
        reasoning_tokens: e.reasoningTokens,
        requests: e.requests,
        cost_usd: e.costUsd,
        raw: JSON.stringify(e.raw ?? null),
      });
      n++;
    }
    db.prepare("UPDATE providers SET last_synced_at = ? WHERE id = ?").run(new Date().toISOString(), providerId);
    return n;
  })();
}

export function upsertPrices(db: Db, rows: PriceRow[]): number {
  const ins = db.prepare(
    `INSERT INTO price_catalog (provider_id, model, input_per_m, output_per_m, cached_per_m, is_free, updated_at, source)
     VALUES (@provider_id, @model, @input_per_m, @output_per_m, @cached_per_m, @is_free, @updated_at, @source)
     ON CONFLICT(provider_id, model) DO UPDATE SET
       input_per_m = excluded.input_per_m, output_per_m = excluded.output_per_m, cached_per_m = excluded.cached_per_m,
       is_free = excluded.is_free, updated_at = excluded.updated_at, source = excluded.source`,
  );
  return db.transaction(() => {
    for (const r of rows) {
      ins.run({
        provider_id: r.providerId,
        model: r.model,
        input_per_m: r.inputPerM,
        output_per_m: r.outputPerM,
        cached_per_m: r.cachedPerM,
        is_free: r.isFree ? 1 : 0,
        updated_at: r.updatedAt,
        source: r.source,
      });
    }
    return rows.length;
  })();
}

export function recordSyncRun(
  db: Db,
  r: { providerId: string; startedAt: string; status: "ok" | "error"; rows: number; error?: string },
): void {
  db.prepare(
    `INSERT INTO sync_runs (provider_id, started_at, finished_at, status, rows, error) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(r.providerId, r.startedAt, new Date().toISOString(), r.status, r.rows, r.error ?? null);
}

export interface ProviderSummary {
  providerId: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  models: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface ModelSummary {
  providerId: string;
  model: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export function summarizeByProvider(db: Db, from: string, to: string): ProviderSummary[] {
  return db
    .prepare(
      `SELECT provider_id AS providerId, SUM(cost_usd) AS costUsd, SUM(requests) AS requests,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cached_tokens) AS cachedTokens,
              COUNT(DISTINCT model) AS models, MIN(date) AS firstDate, MAX(date) AS lastDate
       FROM usage_events WHERE date >= ? AND date <= ?
       GROUP BY provider_id ORDER BY costUsd DESC`,
    )
    .all(from, to) as ProviderSummary[];
}

export function summarizeByModel(db: Db, from: string, to: string, limit = 50): ModelSummary[] {
  return db
    .prepare(
      `SELECT provider_id AS providerId, model, SUM(cost_usd) AS costUsd, SUM(requests) AS requests,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
       FROM usage_events WHERE date >= ? AND date <= ?
       GROUP BY provider_id, model ORDER BY costUsd DESC LIMIT ?`,
    )
    .all(from, to, limit) as ModelSummary[];
}
