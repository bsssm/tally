import type { AdapterOptions, ProviderAdapter } from "../types.js";
import { OpenRouterAdapter } from "./openrouter.js";

export type AdapterFactory = (opts?: AdapterOptions) => ProviderAdapter;

const REGISTRY: Record<string, AdapterFactory> = {
  openrouter: (o) => new OpenRouterAdapter(o),
};

/** Providers the spec names but M1 does not implement; `tally connect` explains instead of failing silently. */
export const PLANNED_PROVIDERS: Record<string, string> = {
  openai: "M2 — usage/costs endpoints (admin key)",
  anthropic: "M2 — admin usage/cost endpoints (admin key)",
  fireworks: "M2 — stub + CSV import",
  together: "M2 — stub + CSV import",
  groq: "M2 — stub + CSV import",
  google: "M2 — stub + CSV import",
};

export function getAdapter(id: string, opts?: AdapterOptions): ProviderAdapter | undefined {
  const f = REGISTRY[id];
  return f ? f(opts) : undefined;
}

export function listAdapterIds(): string[] {
  return Object.keys(REGISTRY);
}

export { OpenRouterAdapter };
