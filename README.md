# Tally

Your AI wallet. One screen that prices your local Claude Code usage at API rates, adds what you spend on connected providers, tells you whether your plan is paying off, and lists the credits and cheaper routes you are not using. Read-only, local, no account.

## Quickstart

```sh
npx tallywallet
```

That is the whole install. Node 20 or newer. No key, no sign-up. On a machine with Claude Code logs the first screen looks like this (sample numbers):

```
tally · 2026-09-29 → 2026-10-29

YOUR AI WALLET
  Claude Code (local logs)      $412.30 API-equivalent   218 sessions · 24 days · 1,930 turns
    claude-fable-5-1             $290.10   70%   cache hit 91%
    claude-opus-5-5              $101.40   25%   cache hit 93%
    claude-haiku-5-5              $20.80    5%   cache hit 88%
  openrouter                      $18.75 billed            640 requests · 4 models

VERDICT  (Claude Max 5x)
  You used $412 API-equivalent on a $100 plan: 4.1x. Keep it.
  → 70% of your usage is claude-fable-5-1, which bills 2.5x claude-opus-5-5 per token. Moving routine turns there is worth up to $174/month at API rates.
  → Your plan includes $100/month of Claude Platform API credits. They expire monthly. Claim once in claude.ai → settings by linking a Console org.

DEALS  (tally deals for all)
  live                         Max plans include monthly Claude API credits: $100 on 5x, $200 on 20x  · you are on max5 · verified
  live                         Claude Batch API: 50% off input and output on every model  · you use anthropic · verified
  ends 2026-10-31              Qoder: DeepSeek-Flash at 0 credits within a daily allowance until 31 Oct  · open to anyone · verified
```

With no logs and nothing connected you get a short empty state that says where it looked and the two next steps:

```sh
tally connect openrouter        # add API spend (key stays on this machine, encrypted)
tally profile --plan max20      # tell the verdict how you pay Anthropic
```

The package installs two commands, `tallywallet` and `tally`. They are the same binary.

## What it reads, and what never leaves your machine

Tally reads:

- Claude Code's session logs in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). Each assistant turn is priced at Anthropic's published API rates from the bundled `data/anthropic-prices.json`. Nothing is uploaded.
- Provider ledgers you connect, over that provider's own API, with a key you give it. Today that is OpenRouter.
- The bundled deal list in `data/deals.json`, plus free models and price drops seen in the OpenRouter catalog after a sync.

Tally sends nothing anywhere. There is no telemetry, no account, no update check. The only network calls are `tally connect` (key validation) and `tally sync` (pulling your usage from the provider you connected). The default `tally` command makes no network calls at all.

Everything lives in `~/.tally` (override with `TALLY_HOME`):

- `tally.db`, a SQLite file with your usage rows, price history, profile and provider records.
- Provider keys are encrypted with AES-256-GCM before they are written to that file. Keys are redacted from every error message and never logged; tests assert this.
- The 32-byte master key is created the first time you run `tally connect`, not before. It lives, in order of preference, in `TALLY_MASTER_KEY` (64 hex chars, for CI and headless use), the macOS Keychain (item `tally-master-key`, via the system `security` tool, no native module), or a passphrase you type, stretched with scrypt against a salt in `~/.tally/salt`. `TALLY_KEY_SOURCE=passphrase` pins the passphrase route; `TALLY_PASSPHRASE` supplies it without a prompt. A wrong passphrase is reported as such, not as a corrupt store.

Read-only commands (`tally`, `deals`, `profile`, `providers`) never open the keystore, so they never trigger a Keychain or passphrase prompt.

## Commands

| Command | What it does |
| --- | --- |
| `tally` | The wallet: local Claude Code usage at API rates, connected providers, verdict, top deals. `--days 7`, `--plan max20`, `--json`. |
| `tally deals` | Credits, free models, promo pricing and price changes, ranked for your mix. `--all` includes expired ones. |
| `tally profile` | How you pay Anthropic and your company stage. `--plan api|pro|max5|max20`, `--credits-claimed`. |
| `tally connect openrouter` | Store a provider key, encrypted. `--key`, `--key-stdin`, `--admin`. |
| `tally sync` | Pull usage and spend from every connected provider. `--days`, `--only`, `--no-prices`, `--json`. |
| `tally providers` | Connection status per provider. |
| `tally disconnect <id>` | Remove a provider and its ledger rows. |
| `tally pace` | The 5-hour Claude Code window gauge. `install` and `uninstall` manage the status line and hook. |
| `tally route` | Start the local credits router. `pool add`, `pool rm`, `status`. |

Every command that prints a table also takes `--json`.

## Connect OpenRouter

```sh
tally connect openrouter
tally sync
```

OpenRouter exposes the per-model ledger only to a Management key (Settings → Keys → Management). A regular key still validates; `tally sync` then reports this month's and lifetime spend from the key itself and tells you how to upgrade. OpenAI and Anthropic API adapters are next. Keys stored for the credits router (`tally connect anthropic`, `openai`) are skipped by `sync` with a one-line note until their adapters exist.

## Claude Code plugin

In Claude Code:

```
/plugin marketplace add bsssm/tally
/plugin install tally@tally
/tally:pace install
```

Or, with the CLI installed, `tally pace install`. Both write a status line into `~/.claude/settings.json` only if none is configured; otherwise they print the JSON to merge by hand. `tally pace uninstall` removes exactly what was added.

## Pacing

`tally pace` shows your 5-hour Claude Code window in API-equivalent dollars and percent, today's total, and a credits countdown. The status line reads the JSON Claude Code hands it, so the percent is Claude Code's own `rate_limits` figure when available and a calibrated estimate otherwise. A `UserPromptSubmit` hook asks the model to spend less once the window passes a threshold (default 80 percent). Config lives in `~/.tally/pace.json`. Everything is local; the plugin uses Node built-ins only. Details and the research behind what a hook can and cannot do: [packages/claude-code-plugin/README.md](packages/claude-code-plugin/README.md).

## Credits router

`tally route` starts a local endpoint on 127.0.0.1 that non-interactive jobs point at. It spends your expiring credits first (for example the monthly Max API credits), then takes the cheapest paid route, and logs every decision in the Tally ledger. It speaks both the OpenAI and the Anthropic request shapes, streaming included. Declare a pool with `tally route pool add anthropic --usd 200 --resets 7`, store the keys with `tally connect`, then check `tally route status`. Keys are decrypted once at start and only leave the process as the upstream auth header. Routing rules, pricing and translation notes: [packages/router/README.md](packages/router/README.md).

## Where deals come from

The feed is `data/deals.json` in this repo. Each entry has a provider, a kind (credit, free model, promo pricing, price change, batch), who it is for, start and end dates, a source URL and a `verification` label:

- `verified`: someone checked the provider's own page on the date in the entry and the terms matched.
- `asserted`: reported somewhere else (a post, a newsletter, a changelog) and not yet confirmed on the provider's page. Treat as a lead, not a fact.

Entries that carry data-use terms (for example free tiers that may train on prompts) show them inline. Ranking is local: an entry scores higher when it matches your plan, a model you actually run, or a provider you already use. Expired entries are hidden unless you ask for `--all`. Pull requests that add or correct an entry are welcome; include the source URL and the date you checked it.

## Normalization notes

- Claude Code: one event per assistant message. A message streamed as several log lines shares `message.id` and `requestId` and is counted once. Input, output, cache read and cache write tokens are priced separately. Models missing from the price table are listed as unpriced, not guessed.
- OpenRouter: one row per `(date, model, upstream provider)` from `GET /api/v1/activity` (last 30 completed UTC days). `cost_usd` is OpenRouter credits only; BYOK spend is kept in `raw` and flagged so it is not double-counted when you connect that provider directly.
- The price catalog is refreshed from `GET /api/v1/models` on every sync, in USD per million tokens, and kept as history so price drops can be surfaced.
- Windows are UTC calendar days, from `days` ago up to today, inclusive.

## Development

pnpm monorepo. `packages/core` holds the schema, crypto, keystore, adapters, local log readers and the deals engine. `packages/router` is the credits router and `packages/claude-code-plugin` the Claude Code plugin. `packages/cli` is the published `tallywallet` package: tsup bundles core and router into one file at `dist/bin/index.js`; `data/` and the plugin's `scripts/*.cjs` are copied in at build time. `better-sqlite3` stays a native runtime dependency.

```sh
pnpm install
pnpm build
pnpm test            # fixture-based; nothing calls a provider
pnpm typecheck
pnpm tally           # run the built CLI from the repo
```

Two scripts cover the first-run promises:

- `scripts/fresh-machine.sh` packs the CLI, installs the tarball with `npx` inside a temp `HOME` and `TALLY_HOME`, and asserts the empty state appears within 60 seconds, exit 0, with no master key created. CI runs it on Linux and macOS, Node 20 and 22.
- `scripts/passphrase-test.sh` drives the passphrase key source through `connect`, `sync` and a wrong passphrase, non-interactively. It needs a real OpenRouter key in `OPENROUTER_API_KEY` because `connect` validates online.

Environment variables: `TALLY_HOME`, `TALLY_MASTER_KEY`, `TALLY_KEY_SOURCE` (`passphrase` or `keychain`), `TALLY_PASSPHRASE`, `TALLY_DATA_DIR`, `CLAUDE_CONFIG_DIR`.

## Contributing

Open an issue or a pull request at https://github.com/bsssm/tally. Deal entries need a source URL and a check date. Adapters need fixtures, not live calls. Keep the CLI read-only: Tally never changes anything on a provider.

## License

MIT. See [LICENSE](LICENSE).
