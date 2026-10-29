# Tally — MVP Spec ("Honey for AI inference")

> Paste this whole file into Claude Code as the first message, or save it as `SPEC.md` in an empty repo and say: "Read SPEC.md and build it. Start with M1."

## 1. One-liner
A read-only CLI + local dashboard that pulls a developer's token usage and spend from every AI provider they use, shows it in one ledger, and surfaces free credits, promo pricing, and cheaper equivalent routes they're not using.

## 2. Why (for context, not to build)
- Spend is fragmented across OpenAI, Anthropic, Google, OpenRouter, Fireworks, Together, Groq, etc. Nobody owns the cross-provider wallet.
- Startup credit programs ($1k–$5k) are opaque and partner-gated; promo pricing on new models is never tracked.
- Honey's wedge was zero-effort, read-only, and installed where spend happens. Same here: no proxy in v0, no request-path risk.

## 3. Target user (v0)
- Solo dev / small team spending $50–$5k/month on LLM APIs across 2+ providers.
- Has API keys already. Comfortable with a terminal.

## 4. Scope — v0 (build this)
### Must have
1. `tally connect <provider>` — store an API key (or admin key) locally, encrypted at rest.
2. `tally sync` — pull usage + spend for the last 30 days from each connected provider via their official usage/billing endpoints. Normalize into one schema.
3. `tally dashboard` — launch a local web UI (localhost) showing:
   - Total spend, spend by provider, spend by model, tokens in/out, 30-day trend.
   - "Opportunities" panel (see §7).
4. `tally credits` — list startup/promo credit programs the user is likely eligible for, with apply links. Driven by a maintained JSON catalog.
5. `tally savings` — for each model used, show cheaper equivalent routes (same model on another provider/gateway, or a free tier) with estimated monthly savings.
6. Everything runs locally. No account, no server, no telemetry in v0.

### Nice to have (only after must-haves pass tests)
- `tally export` → CSV/JSON of the normalized ledger.
- Slack/email weekly digest.
- Budget alerts.

### Explicit non-goals (v0)
- No request proxy. No key forwarding. No rewrite of user traffic.
- No hosted SaaS, auth, or billing.
- No Chrome extension yet.

## 5. Tech stack
- **Language:** TypeScript, Node 20+.
- **CLI:** `commander` + `@clack/prompts`.
- **Storage:** SQLite via `better-sqlite3`, file at `~/.tally/tally.db`. Keys encrypted with `node:crypto` (AES-256-GCM), key derived from OS keychain via `keytar` if available, else a local passphrase.
- **Dashboard:** Vite + React + Tailwind, served by a small Fastify server on `localhost:4477`. Charts via `recharts`.
- **Package:** single monorepo, `pnpm` workspaces: `packages/core`, `packages/cli`, `packages/dashboard`.
- **Tests:** `vitest`. Adapters must have fixture-based tests (recorded JSON responses), no live calls in CI.

## 6. Data model (SQLite)
```sql
providers(id TEXT PK, name TEXT, connected_at TEXT, key_ciphertext BLOB, key_type TEXT)  -- key_type: 'api' | 'admin'
usage_events(
  id INTEGER PK, provider_id TEXT, model TEXT, date TEXT,        -- ISO date, daily granularity is fine
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  requests INTEGER, cost_usd REAL, raw JSON
)
price_catalog(provider_id TEXT, model TEXT, input_per_m REAL, output_per_m REAL, cached_per_m REAL, updated_at TEXT, source TEXT)
model_aliases(canonical TEXT, provider_id TEXT, provider_model TEXT)  -- maps "llama-3.3-70b" -> each provider's model id
credit_programs(id TEXT PK, provider_id TEXT, name TEXT, amount_usd REAL, fees_waived_months INTEGER,
  eligibility JSON, apply_url TEXT, expires TEXT, last_verified TEXT)
opportunities(id INTEGER PK, kind TEXT, title TEXT, detail TEXT, est_savings_usd REAL, action_url TEXT, created_at TEXT, dismissed INTEGER)
```

## 7. Provider adapters (`packages/core/src/adapters/`)
Each adapter implements:
```ts
interface ProviderAdapter {
  id: string;                       // 'openai' | 'anthropic' | 'openrouter' | 'google' | 'fireworks' | 'together' | 'groq'
  keyType: 'api' | 'admin';
  validateKey(key: string): Promise<boolean>;
  fetchUsage(key: string, from: Date, to: Date): Promise<UsageEvent[]>;
  fetchPrices?(): Promise<PriceRow[]>; // optional; else fall back to bundled price JSON
}
```
Order of implementation:
1. **OpenRouter** — easiest; has credits + activity endpoints and a public models/pricing endpoint. Also pulls free-model list.
2. **OpenAI** — usage/costs endpoints (admin key).
3. **Anthropic** — admin usage/cost endpoints (admin key).
4. **Fireworks, Together, Groq, Google** — stub with clear "not yet supported" + manual CSV import fallback.

Rules:
- Look up each provider's current usage/billing API in its docs before coding; do not guess endpoints.
- If a provider has no usage API, implement `tally import <provider> <csv>` instead.
- Never log keys. Redact in all error output.

## 8. Opportunities engine (`packages/core/src/opportunities/`)
Pure functions over the ledger + catalogs. Three rule families:

1. **Credits** — match `credit_programs.eligibility` against a short local profile (`tally profile` asks: stage, funding, is AI-native, monthly spend). Output: "You likely qualify for X ($N). Apply →".
2. **Cheaper route** — for each `(canonical model, monthly spend)`, find other providers serving the same canonical model at lower blended price. Output: est. monthly savings = spend × (1 − alt_price/current_price). Flag quality caveats (quantization, context limits) if the catalog marks them.
3. **Free tier / promo** — if a model the user pays for has a `:free` variant or a time-boxed promo in the catalog, surface it with the rate limit caveat.

Opportunities are ranked by `est_savings_usd`, deduped, and dismissible.

## 9. Catalogs (`packages/core/data/`)
- `prices.json` — seed with current public pricing for the top ~40 models across the supported providers. Include `source` URL and `updated_at`.
- `aliases.json` — canonical model → provider-specific ids.
- `credit_programs.json` — seed with known programs (e.g. OpenRouter for Startups, major-lab startup programs, VC-partner perk channels). Fields per §6. Mark `last_verified`.
- `promos.json` — time-boxed free/discounted model promos. Can start empty.
- All catalogs are plain JSON so they can be updated via PR without a release.

## 10. CLI UX
```
tally connect openrouter        # prompts for key, validates, stores
tally connect openai --admin    # admin key flow
tally sync                      # pulls 30 days, prints per-provider summary table
tally dashboard                 # opens http://localhost:4477
tally credits                   # table: program, amount, likely eligible?, apply link
tally savings                   # table: model, current $/mo, best alt, est. savings
tally profile                   # 4 questions, stored locally
tally import openai usage.csv   # fallback
tally export --format csv
```
Output should be clean tables (`cli-table3`), colors via `picocolors`, never dump raw JSON unless `--json`.

## 11. Dashboard (localhost)
Pages:
- **Overview** — KPI cards (30-day spend, Δ vs prior 30, tokens, requests), stacked area chart spend by provider, bar chart spend by model.
- **Opportunities** — ranked cards, each with est. savings, one-line why, CTA link, dismiss.
- **Credits** — the credit programs table with eligibility badges.
- **Providers** — connection status, last sync, reconnect.
Reads from the same SQLite via the Fastify API (`/api/overview`, `/api/opportunities`, `/api/credits`, `/api/providers`). No auth needed; bind to 127.0.0.1 only.

Visual direction will come from a separate Claude Design handoff (design tokens + screens). Until then, use a neutral dark theme and don't spend time on styling.

## 12. Milestones (do in order; stop and report after each)
- **M1** — Monorepo scaffold, SQLite + encryption, `connect`/`sync` for OpenRouter with fixture tests. `tally sync` prints a correct table.
- **M2** — OpenAI + Anthropic adapters. Normalization verified: a day's spend matches the provider dashboard within ±1%.
- **M3** — Catalogs + opportunities engine with unit tests for all three rule families. `tally credits` and `tally savings` work.
- **M4** — Dashboard: Overview + Opportunities pages wired to real local data.
- **M5** — Credits + Providers pages, `export`, `import`, README with a 60-second quickstart.

## 13. Acceptance tests
- Fresh machine → `npx tally connect openrouter` → `tally sync` → correct totals in < 60 seconds.
- Keys never appear in logs, DB in plaintext, or error messages (test asserts this).
- Opportunities engine: given fixture ledger of $1,000/mo on model X at provider A, and provider B at 60% price, outputs one "cheaper route" with est. savings $400 ± $1.
- Dashboard renders with zero providers connected (empty states), not a crash.

## 14. Open questions (answer before M3, otherwise take the default)
- Canonical model matching: exact id match only in v0 (default), or allow "equivalent family" matches? Default: exact only.
- Should `tally sync` run on a schedule? Default: no, manual only in v0.

## 15. Roadmap after v0 (do not build now)
- Optional proxy mode (`tally proxy`) that auto-routes to the cheapest equivalent — only after trust is earned with read-only.
- Hosted team dashboard, shared ledger.
- Provider-funded rewards: cashback for trying newly listed models (the merchant-side revenue model).
- Browser extension that reads provider billing pages for providers with no usage API.
