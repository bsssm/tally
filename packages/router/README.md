# @tally/router — the credits router

A local endpoint that non-interactive jobs point at. It spends your expiring credits first, then
takes the cheapest paid route, and logs every decision in the Tally ledger.

```
tally route pool add anthropic --usd 200 --resets 7     # declare the $200/month Max credits
tally connect anthropic                                  # the key the credits apply to
tally connect openrouter                                 # the cheapest-route fallback
tally route                                              # http://127.0.0.1:7411
tally route status                                       # "9 days left, $173.20 unused"
```

Speaks both shapes on the same port:

- `POST /v1/chat/completions` (OpenAI shape, streaming and non-streaming)
- `POST /v1/messages` (Anthropic shape, streaming and non-streaming; `/v1/messages/count_tokens` when an Anthropic key is stored)
- `GET /status` (pools, headline sentences, last 20 route events, as JSON for a dashboard)

Binds to 127.0.0.1 only. Keys are decrypted once at start and only ever leave the process as the
auth header of the upstream request. Request bodies are never written anywhere; the ledger stores
model, upstream, reason, tokens, estimated cost, pool id, job label and HTTP status.

## How it routes

For every call, in order:

1. **Claude model and an Anthropic pool with balance** (and an `anthropic` key): Anthropic direct.
   Plan credits apply to the org automatically, so a plain API key is all it needs.
2. **Another pool that serves the model**: an `openai` pool for GPT models, an `openrouter` pool for
   anything. Needs that provider's key.
3. **Cheapest paid route**: open models go to OpenRouter with `provider.sort = "price"` (the
   expected price comes from the ledger catalog that `tally sync` fills); closed models go to the
   owner's API when its key is stored, otherwise to OpenRouter.
4. Nothing usable: `503` with the `tally connect …` command that would fix it.

`choose(policy, request, state)` in `src/policy.ts` is pure and tested on its own.

Pool balance = size − spend in the current period. The period is the month that starts on
`--resets <day>` (UTC) or the life of a one-off `--expires YYYY-MM-DD` pool. Spend is the sum of the
router's own priced events, unless an Admin API key is stored, in which case the Anthropic cost
report replaces local accounting once an hour (`tally connect anthropic --admin`). `tally route status`
says which of the two it is using.

Pricing: OpenRouter calls carry `usage: {include: true}` so the response's own `usage.cost` is used;
Anthropic calls are priced from `packages/core/data/anthropic-prices.json` including cache reads and
writes; everything else from the ledger `price_catalog`. Calls that fail upstream never draw on a pool.

## Translation (kept minimal)

| Request shape | Upstream   | What happens                                                                  |
| ------------- | ---------- | ----------------------------------------------------------------------------- |
| Anthropic     | Anthropic  | Pass-through, byte for byte, `anthropic-version` / `anthropic-beta` forwarded |
| Anthropic     | OpenRouter | Pass-through to OpenRouter's Anthropic-compatible `/api/v1/messages`          |
| OpenAI        | Anthropic  | Pass-through to Anthropic's OpenAI-compatible `/v1/chat/completions`          |
| OpenAI        | OpenRouter | Pass-through, plus `provider.sort = "price"` and `usage.include`              |
| OpenAI        | OpenAI     | Pass-through                                                                  |
| Anthropic     | OpenAI     | Translated (system, text, images, tools, tool_use/tool_result); a streaming request is served non-streaming upstream and re-emitted as Anthropic SSE |

Upstream errors are forwarded unmodified (status and body), which is what Claude Code's own retry
logic needs. Model ids are converted where the upstream spells them differently
(`claude-opus-5-5` ↔ `anthropic/claude-opus-5.5`).

## Setup for the three common cases

Tag every job with `X-Tally-Job: <name>` (or `?job=<name>` on the URL) so `tally route jobs` can
answer "these 3 jobs qualify". Use any non-empty string as the API key; the router replaces it.

### A cron agent on the OpenAI SDK

```bash
export OPENAI_BASE_URL=http://127.0.0.1:7411/v1
export OPENAI_API_KEY=tally
```

```ts
import OpenAI from "openai";
const client = new OpenAI({ defaultHeaders: { "X-Tally-Job": "nightly-evals" } });
const r = await client.chat.completions.create({ model: "claude-opus-5-5", messages: [{ role: "user", content: "…" }] });
```

Ask for a Claude model and the call rides the Anthropic credits through Anthropic's OpenAI-compatible
endpoint. Ask for `meta-llama/llama-3.3-70b-instruct` and it goes to OpenRouter at the lowest price.
Note the compat endpoint's limits: no prompt caching, `strict` ignored, `response_format` ignored.

### An agent on the Anthropic SDK

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:7411
export ANTHROPIC_API_KEY=tally
```

```python
import anthropic
client = anthropic.Anthropic(default_headers={"X-Tally-Job": "inbox-triage"})
msg = client.messages.create(model="claude-sonnet-5-5", max_tokens=1024, messages=[{"role": "user", "content": "…"}])
```

Requests pass through unchanged, so caching, thinking, tools and betas all work exactly as against
`api.anthropic.com`.

### `claude -p` (non-interactive Claude Code)

Claude Code honours `ANTHROPIC_BASE_URL` for any gateway that speaks the Anthropic Messages format,
with the credential in `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) or `ANTHROPIC_API_KEY`
(sent as `x-api-key`). Either works; the router discards it.

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:7411 ANTHROPIC_AUTH_TOKEN=tally \
  claude -p "summarise the failing tests in this repo"
```

What to know:

- Setting the credential variable switches that run off your claude.ai subscription and onto the
  key the router forwards, billed per token to the org that owns it. That is the point: these runs
  spend the API credits the plan grants. Keep the variables scoped to the job (as above) rather than
  exported in your shell, or interactive sessions follow too.
- **Plan credits are not usable for interactive Claude Code.** Anthropic's terms for the monthly
  Max credits cover the Claude Platform API only. The router cannot change that; use it for `-p`,
  cron, CI and evals, and keep interactive `claude` on the subscription.
- The router forwards `anthropic-beta` and `anthropic-version` verbatim and passes error bodies
  through unmodified, both of which Claude Code's capability-retry logic depends on.
  `/v1/messages/count_tokens` is proxied when an Anthropic key is stored; without one Claude Code
  falls back to its own estimate, which only affects `/context`.
- To confirm it is routed, run `claude` with the variables set and check `/status`: it shows the
  `Anthropic base URL` line and names `ANTHROPIC_AUTH_TOKEN` as the credential.
- Remote Control, voice dictation and the fast-mode check are off while a gateway credential is
  set; irrelevant for `-p`.

## Programmatic use

```ts
import { startRouter, choose, routerStatus } from "@tally/router";
const r = await startRouter({ db, keystore, port: 7411, log: console.error });
r.status();            // pools, headline, events
await r.reconcileNow(); // Admin API cost report → pool.reconciled_spent_usd
await r.close();
```

`startRouter` options: `port`, `host` (loopback only), `policy` (`preferCredits`, `openrouterOrder`,
`minPoolUsd`), `upstreams` (base URLs, used by the tests to point at a mock), `fetch`, `now`,
`reconcileIntervalMs` (0 disables), `log`.

## Known limitations

- The router prices calls locally until an Admin API key is stored. Local accounting ignores spend
  from other clients on the same org; the hourly reconcile corrects that.
- Anthropic's OpenAI-compatible endpoint is the route for OpenAI-shaped Claude calls. It does not
  support prompt caching or structured outputs; use the Anthropic SDK for those.
- The Anthropic → OpenAI translation covers text, images, tools and tool results. Thinking blocks,
  documents and citations are dropped. Streaming through that one pairing is synthesized from a
  non-streaming upstream call, so tokens arrive at the end.
- `provider.sort = "price"` is only attached on OpenRouter's chat-completions endpoint. Anthropic-shaped
  requests to OpenRouter go through its Messages endpoint without provider preferences.
- Only one Admin API cost report is read: the whole org's. If several pools share one org, each gets
  the same reconciled figure.
- `tally sync` has no usage adapter for `anthropic` / `openai` yet (M2); those keys are router-only
  and `tally sync` reports "No adapter" for them.
