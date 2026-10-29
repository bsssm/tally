/** One normalized row of usage: one provider, one model, one UTC day (optionally one route). */
export interface UsageEvent {
  providerId: string;
  model: string;
  /** ISO date, YYYY-MM-DD, UTC. */
  date: string;
  /** Upstream route when the provider is a gateway (e.g. OpenRouter's `provider_name`). */
  route?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  requests: number;
  /** Spend billed by this provider, in USD. */
  costUsd: number;
  /** The provider's original row, kept verbatim. */
  raw: unknown;
}

export interface PriceRow {
  providerId: string;
  model: string;
  inputPerM: number;
  outputPerM: number;
  cachedPerM: number | null;
  /** True when the provider serves this model at zero cost (e.g. OpenRouter `:free`). */
  isFree: boolean;
  source: string;
  updatedAt: string;
}

export type KeyType = "api" | "admin";

export interface KeyInfo {
  /** The provider's label for this key, if it exposes one. */
  label?: string | null;
  /** Whether the key can read account-wide usage (admin / management key). */
  isAdmin: boolean;
  /** Lifetime spend in USD if the provider reports it with the key. */
  usageUsd?: number;
  /** Current-month spend in USD if the provider reports it with the key. */
  usageMonthlyUsd?: number;
  /** Anything else worth keeping, redacted of secrets. */
  extra?: Record<string, unknown>;
}

export interface FetchUsageResult {
  events: UsageEvent[];
  /** Human-readable caveats (e.g. "regular key: per-model breakdown unavailable"). */
  notes: string[];
}

export interface ProviderAdapter {
  id: string;
  displayName: string;
  /** The key type that unlocks the full ledger for this provider. */
  keyType: KeyType;
  /** Where the user creates the right kind of key. */
  keyHelpUrl: string;
  validateKey(key: string): Promise<boolean>;
  describeKey?(key: string): Promise<KeyInfo>;
  fetchUsage(key: string, from: Date, to: Date): Promise<FetchUsageResult>;
  fetchPrices?(): Promise<PriceRow[]>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AdapterOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}
