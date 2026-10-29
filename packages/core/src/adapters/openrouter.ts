import type {
  AdapterOptions, FetchLike, FetchUsageResult, KeyInfo, PriceRow, ProviderAdapter, UsageEvent,
} from "../types.js";
import { TallyError } from "../redact.js";
import { isoDate } from "../dates.js";

/**
 * OpenRouter. Endpoints verified against https://openrouter.ai/openapi.json (fetched 2026-10-28):
 *   GET /api/v1/key       — info on the calling key (any key). Fields: label, usage, usage_monthly, is_management_key …
 *   GET /api/v1/activity  — daily rows per (date, model, endpoint) for the last 30 completed UTC days.
 *                           Management key required (403 otherwise).
 *   GET /api/v1/credits   — total_credits / total_usage. Management key required.
 *   GET /api/v1/models    — public catalog with per-token USD pricing as strings.
 */

export interface OpenRouterActivityRow {
  date: string;
  model: string;
  model_permaslug: string;
  endpoint_id: string;
  provider_name: string;
  usage: number;
  byok_usage_inference: number;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  workspace_id?: string;
}

interface OpenRouterKeyData {
  label: string;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
  byok_usage: number;
  byok_usage_monthly: number;
  limit: number | null;
  limit_remaining: number | null;
  is_free_tier: boolean;
  is_management_key: boolean;
  is_provisioning_key: boolean;
}

interface OpenRouterModel {
  id: string;
  canonical_slug: string;
  name: string;
  pricing: { prompt?: string; completion?: string; input_cache_read?: string; discount?: number };
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = "openrouter";
  readonly displayName = "OpenRouter";
  readonly keyType = "admin" as const;
  readonly keyHelpUrl = "https://openrouter.ai/settings/keys";
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: AdapterOptions = {}) {
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  }

  async validateKey(key: string): Promise<boolean> {
    try {
      await this.keyData(key);
      return true;
    } catch (err) {
      if (err instanceof TallyError && err.code === "unauthorized") return false;
      throw err;
    }
  }

  async describeKey(key: string): Promise<KeyInfo> {
    const d = await this.keyData(key);
    return {
      label: d.label,
      isAdmin: Boolean(d.is_management_key),
      usageUsd: d.usage,
      usageMonthlyUsd: d.usage_monthly,
      extra: {
        limit: d.limit,
        limit_remaining: d.limit_remaining,
        is_free_tier: d.is_free_tier,
        byok_usage_monthly: d.byok_usage_monthly,
      },
    };
  }

  async fetchUsage(key: string, from: Date, to: Date): Promise<FetchUsageResult> {
    const fromIso = isoDate(from);
    const toIso = isoDate(to);
    const notes: string[] = [];

    const res = await this.request(key, "/activity");
    if (res.status === 403) {
      // Regular key: no per-model rows. Report the aggregate so the user still learns something.
      const d = await this.keyData(key);
      notes.push(
        `Regular API key: OpenRouter only exposes per-model activity to a Management key. ` +
          `This key has spent $${d.usage_monthly.toFixed(2)} this month ($${d.usage.toFixed(2)} lifetime). ` +
          `Create a Management key at ${this.keyHelpUrl} and run \`tally connect openrouter\` again for the full ledger.`,
      );
      return { events: [], notes };
    }
    const body = await this.okJson<{ data: OpenRouterActivityRow[] }>(res, key, "/activity");
    const rows = body.data ?? [];
    const events = rows
      .filter((r) => r.date >= fromIso && r.date <= toIso)
      .map((r) => normalizeActivityRow(r));

    const byok = rows.reduce((s, r) => s + (r.byok_usage_inference || 0), 0);
    if (byok > 0) {
      notes.push(
        `$${byok.toFixed(2)} of BYOK inference went through OpenRouter on your own provider keys; ` +
          `it is kept in \`raw\` but not counted here, so it is not double-counted when you connect that provider.`,
      );
    }
    return { events, notes };
  }

  async fetchPrices(): Promise<PriceRow[]> {
    const res = await this.fetch(`${this.baseUrl}/models`, { headers: { Accept: "application/json" } });
    const body = await this.okJson<{ data: OpenRouterModel[] }>(res, "", "/models");
    const updatedAt = new Date().toISOString();
    return (body.data ?? []).map((m) => normalizeModelPrice(m, updatedAt));
  }

  // --- internals -------------------------------------------------------

  private async keyData(key: string): Promise<OpenRouterKeyData> {
    const res = await this.request(key, "/key");
    const body = await this.okJson<{ data: OpenRouterKeyData }>(res, key, "/key");
    return body.data;
  }

  private request(key: string, path: string): Promise<Response> {
    return this.fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    }).catch((err) => {
      throw new TallyError("network", `OpenRouter ${path}: ${err instanceof Error ? err.message : String(err)}`, undefined, [key]);
    });
  }

  private async okJson<T>(res: Response, key: string, path: string): Promise<T> {
    if (res.status === 401) {
      throw new TallyError("unauthorized", `OpenRouter ${path}: key rejected (401)`, `Check the key at ${this.keyHelpUrl}`, [key]);
    }
    if (res.status === 403) {
      throw new TallyError("forbidden", `OpenRouter ${path}: this key may not read it (403)`, `A Management key is needed; create one at ${this.keyHelpUrl}`, [key]);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TallyError("http", `OpenRouter ${path}: HTTP ${res.status} ${text.slice(0, 200)}`, undefined, [key]);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new TallyError("bad-json", `OpenRouter ${path}: response was not JSON`, undefined, [key]);
    }
  }
}

export function normalizeActivityRow(r: OpenRouterActivityRow): UsageEvent {
  return {
    providerId: "openrouter",
    model: r.model,
    date: r.date,
    route: r.provider_name ?? "",
    inputTokens: r.prompt_tokens ?? 0,
    outputTokens: r.completion_tokens ?? 0,
    cachedTokens: r.cached_tokens ?? 0,
    reasoningTokens: r.reasoning_tokens ?? 0,
    requests: r.requests ?? 0,
    // OpenRouter credits only. BYOK spend is billed by the upstream provider and lives in `raw`.
    costUsd: r.usage ?? 0,
    raw: r,
  };
}

export function normalizeModelPrice(m: OpenRouterModel, updatedAt: string): PriceRow {
  const perM = (s?: string) => (s == null ? null : Number(s) * 1_000_000);
  const input = perM(m.pricing?.prompt) ?? 0;
  const output = perM(m.pricing?.completion) ?? 0;
  return {
    providerId: "openrouter",
    model: m.id,
    inputPerM: input,
    outputPerM: output,
    cachedPerM: perM(m.pricing?.input_cache_read),
    isFree: m.id.endsWith(":free") || (input === 0 && output === 0),
    source: "https://openrouter.ai/api/v1/models",
    updatedAt,
  };
}
