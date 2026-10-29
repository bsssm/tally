import { getCatalogPrice, priceFor, type Db } from "@tally/core";
import type { ExpectedPrice, Upstream } from "./policy.js";

/** Normalized usage out of either response shape. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Anthropic cache writes (5m unless the 1h field is present). */
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** A provider-reported USD figure (OpenRouter `usage.cost`), preferred when present. */
  reportedCostUsd?: number;
}

export function usageFromOpenAI(u: unknown): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const details = (o.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: n(o.prompt_tokens),
    outputTokens: n(o.completion_tokens),
    cachedTokens: n(details.cached_tokens),
    reportedCostUsd: typeof o.cost === "number" ? o.cost : undefined,
  };
}

export function usageFromAnthropic(u: unknown): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const cc = (o.cache_creation ?? {}) as Record<string, unknown>;
  const w1h = n(cc.ephemeral_1h_input_tokens);
  const w5m = cc.ephemeral_5m_input_tokens != null ? n(cc.ephemeral_5m_input_tokens) : n(o.cache_creation_input_tokens) - w1h;
  return {
    inputTokens: n(o.input_tokens),
    outputTokens: n(o.output_tokens),
    cachedTokens: n(o.cache_read_input_tokens),
    cacheWrite5m: Math.max(0, w5m),
    cacheWrite1h: w1h,
  };
}

/** Price a call. Ledger catalog first (OpenRouter), then the bundled Anthropic table. */
export function estimateCostUsd(db: Db, upstream: Upstream, model: string, usage: Usage): number | null {
  if (usage.reportedCostUsd != null) return usage.reportedCostUsd;
  if (upstream === "anthropic") {
    const p = priceFor(model);
    if (!p) return null;
    const uncached = Math.max(0, usage.inputTokens);
    return (
      (uncached * p.input +
        usage.outputTokens * p.output +
        usage.cachedTokens * p.cache_read +
        (usage.cacheWrite5m ?? 0) * p.cache_write_5m +
        (usage.cacheWrite1h ?? 0) * p.cache_write_1h) /
      1e6
    );
  }
  const row = getCatalogPrice(db, upstream === "openrouter" ? "openrouter" : upstream, model);
  if (!row) return null;
  const cachedRate = row.cachedPerM ?? row.inputPerM;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (uncached * row.inputPerM + usage.cachedTokens * cachedRate + usage.outputTokens * row.outputPerM) / 1e6;
}

export function expectedPrice(db: Db, upstream: Upstream, model: string): ExpectedPrice | undefined {
  if (upstream === "anthropic") {
    const p = priceFor(model);
    return p ? { inputPerM: p.input, outputPerM: p.output, source: "anthropic-prices.json" } : undefined;
  }
  const row = getCatalogPrice(db, upstream, model);
  return row ? { inputPerM: row.inputPerM, outputPerM: row.outputPerM, source: `ledger price_catalog (${row.updatedAt.slice(0, 10)})` } : undefined;
}
