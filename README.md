# Tally

One ledger for your AI inference spend, plus the credits and cheaper routes you're not using. Read-only, local, no account.

Status: **M1** — OpenRouter `connect` + `sync`. OpenAI and Anthropic adapters, catalogs, the opportunities engine and the dashboard follow (see [SPEC.md](SPEC.md) §12).

## 60-second quickstart

```sh
pnpm install && pnpm build
alias tally="node $PWD/packages/cli/dist/index.js"   # or: ln -s $PWD/packages/cli/dist/index.js ~/.local/bin/tally

tally connect openrouter     # prompts for a key, validates it, stores it encrypted in ~/.tally/tally.db
tally sync                   # last 30 days: spend by provider and by model
tally providers              # connection status
```

OpenRouter exposes the per-model ledger only to a **Management key** (Settings → Keys → Management). A regular key still validates; `tally sync` then reports this month's and lifetime spend from the key itself and tells you how to upgrade.

## How keys are stored

Provider keys are encrypted with AES-256-GCM before they touch SQLite. The 32-byte master key lives, in order of preference:

1. `TALLY_MASTER_KEY` (64 hex chars) — CI and headless use.
2. macOS Keychain (`tally-master-key`), via the system `security` tool. No native module.
3. A passphrase you type, stretched with scrypt against a salt in `~/.tally/salt`.

`~/.tally/keycheck` lets Tally tell a wrong passphrase from a corrupt store. Keys are redacted from every error message and never logged; tests assert this.

Set `TALLY_HOME` to use a different store (tests do).

## Layout

```
packages/core        schema, crypto, keystore, adapters, sync, summaries   (@tally/core)
packages/cli         commander + clack CLI                                  (tally)
packages/dashboard   placeholder until M4
```

Tests are fixture-based (`packages/core/src/adapters/__fixtures__`); nothing calls a provider in CI.

```sh
pnpm test
pnpm typecheck
```

## Normalization notes

- OpenRouter: one row per `(date, model, upstream provider)`, from `GET /api/v1/activity` (last 30 completed UTC days). `cost_usd` is OpenRouter credits only; BYOK spend is kept in `raw` and flagged, so it is not double-counted when you connect that provider directly.
- The price catalog (`price_catalog`) is refreshed from `GET /api/v1/models` on every sync, in USD per million tokens.
