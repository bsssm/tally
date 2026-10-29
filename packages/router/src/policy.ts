import type { PoolBalance } from "./pools.js";

/**
 * Routing policy. `choose()` is pure: it looks at the request, the pool balances and
 * which keys exist, and returns where to send the call and why. No I/O.
 *
 * Order:
 *   a. Claude model + Anthropic pool with balance + anthropic key → Anthropic direct
 *      (plan credits are applied to the org automatically, so no special header).
 *   b. Any other pool whose provider serves the model, with balance and a key → that provider.
 *      OpenRouter pools count for every model.
 *   c. Cheapest paid route:
 *      - open models → OpenRouter with provider.sort = "price" (expected price from the ledger catalog)
 *      - closed models → the owner's API if its key is stored, else OpenRouter.
 */

export type Shape = "openai" | "anthropic";
export type Upstream = "anthropic" | "openai" | "openrouter";

export interface RouteRequest {
  model: string;
  shape: Shape;
  stream?: boolean;
  job?: string | null;
}

export interface Policy {
  /** Spend declared pools before paid routes. Default true. */
  preferCredits?: boolean;
  /** Provider slug ordering hint passed to OpenRouter (`provider.order`). */
  openrouterOrder?: string[];
  /** Minimum unused balance (USD) for a pool to be eligible; keeps tiny remainders from taking a call. Default 0.01. */
  minPoolUsd?: number;
}

export interface ExpectedPrice {
  inputPerM: number;
  outputPerM: number;
  source: string;
}

export interface RouteState {
  pools: PoolBalance[];
  /** Provider ids with a stored key: "anthropic", "openai", "openrouter". */
  keys: ReadonlySet<string>;
  /** Price lookup for (upstream, upstream model). */
  price: (upstream: Upstream, model: string) => ExpectedPrice | undefined;
}

export interface Decision {
  upstream: Upstream;
  /** The model id as the upstream expects it (OpenRouter slugs differ from first-party ids). */
  upstreamModel: string;
  reason: string;
  poolId: number | null;
  expected?: ExpectedPrice;
  /** Provider preferences to attach when the upstream is OpenRouter. */
  openrouterProvider?: { sort?: "price"; order?: string[] };
  /** Set when no upstream can take the call: the server answers 503 with this hint. */
  blocked?: string;
}

export type Owner = "anthropic" | "openai" | "google" | "open";

export function ownerOf(model: string): Owner {
  const m = model.toLowerCase();
  const bare = m.includes("/") ? m.slice(m.indexOf("/") + 1) : m;
  if (m.startsWith("anthropic/") || bare.startsWith("claude")) return "anthropic";
  if (m.startsWith("openai/") || /^(gpt-|o[1-9](-|$)|chatgpt-|text-embedding)/.test(bare)) return "openai";
  if (m.startsWith("google/") || bare.startsWith("gemini")) return "google";
  return "open";
}

export function isClaude(model: string): boolean {
  return ownerOf(model) === "anthropic";
}

/** First-party id → OpenRouter slug: `claude-opus-5-5` → `anthropic/claude-opus-5.5`, `gpt-4o` → `openai/gpt-4o`. */
export function toOpenRouterSlug(model: string): string {
  if (model.includes("/")) return model;
  const owner = ownerOf(model);
  if (owner === "anthropic") {
    const noDate = model.replace(/-\d{8}$/, "");
    return `anthropic/${noDate.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
  }
  if (owner === "openai") return `openai/${model}`;
  if (owner === "google") return `google/${model}`;
  return model;
}

/** OpenRouter slug → first-party id for the owner's own API: `anthropic/claude-opus-5.5` → `claude-opus-5-5`. */
export function toFirstPartyId(model: string): string {
  if (!model.includes("/")) return model;
  const bare = model.slice(model.indexOf("/") + 1);
  return bare.replace(/-(\d+)\.(\d+)$/, "-$1-$2");
}

export function choose(policy: Policy, req: RouteRequest, state: RouteState): Decision {
  const minUsd = policy.minPoolUsd ?? 0.01;
  const owner = ownerOf(req.model);
  const live = (policy.preferCredits ?? true) ? state.pools.filter((b) => !b.expired && b.unusedUsd >= minUsd) : [];
  const byProvider = (p: string) => live.find((b) => b.pool.provider === p);

  // (a) Claude on Anthropic credits.
  if (owner === "anthropic") {
    const pool = byProvider("anthropic");
    if (pool && state.keys.has("anthropic")) {
      const m = toFirstPartyId(req.model);
      return {
        upstream: "anthropic",
        upstreamModel: m,
        poolId: pool.pool.id,
        reason: `anthropic credits: $${pool.unusedUsd.toFixed(2)} unused${pool.daysLeft != null ? `, ${pool.daysLeft} days left` : ""}`,
        expected: state.price("anthropic", m),
      };
    }
  }

  // (b) Another pool that serves this model.
  if (owner === "openai") {
    const pool = byProvider("openai");
    if (pool && state.keys.has("openai")) {
      const m = toFirstPartyId(req.model);
      return { upstream: "openai", upstreamModel: m, poolId: pool.pool.id, reason: `openai credits: $${pool.unusedUsd.toFixed(2)} unused`, expected: state.price("openai", m) };
    }
  }
  const orPool = byProvider("openrouter");
  if (orPool && state.keys.has("openrouter")) {
    const m = toOpenRouterSlug(req.model);
    return {
      upstream: "openrouter",
      upstreamModel: m,
      poolId: orPool.pool.id,
      reason: `openrouter credits: $${orPool.unusedUsd.toFixed(2)} unused`,
      expected: state.price("openrouter", m),
      openrouterProvider: { sort: "price", order: policy.openrouterOrder },
    };
  }

  // (c) Cheapest paid route.
  if (owner === "anthropic" || owner === "openai") {
    if (state.keys.has(owner)) {
      const m = toFirstPartyId(req.model);
      return { upstream: owner, upstreamModel: m, poolId: null, reason: `${owner} direct (closed model, key stored, no credits left)`, expected: state.price(owner, m) };
    }
  }
  if (state.keys.has("openrouter")) {
    const m = toOpenRouterSlug(req.model);
    const expected = state.price("openrouter", m);
    return {
      upstream: "openrouter",
      upstreamModel: m,
      poolId: null,
      reason: owner === "open" ? "cheapest: openrouter sort=price" : `openrouter (no ${owner} key stored)`,
      expected,
      openrouterProvider: { sort: "price", order: policy.openrouterOrder },
    };
  }
  const need = owner === "open" ? "openrouter" : `${owner} or openrouter`;
  return {
    upstream: owner === "open" ? "openrouter" : (owner === "google" ? "openrouter" : owner),
    upstreamModel: req.model,
    poolId: null,
    reason: "no key",
    blocked: `No key for ${need}. Run: tally connect ${owner === "open" || owner === "google" ? "openrouter" : owner}`,
  };
}
