# Tally — state of play (saved 29 Oct 2026)

Resume prompt (paste into Claude Code from any directory):

> Resume Tally. Read ~/GitHub/tally/STATE.md and ~/knowledge/personal/tally-value.md, then do the next unchecked item in "To publish" unless I say otherwise. Don't re-explain the product.

## What exists (commits b83c2c3, db1f70f)

- `tally` (default) → wallet screen: local Claude Code logs priced at API rates, connected providers, plan verdict with levers, top deals.
- `tally deals` → ranked feed (credits, free models, promo pricing, price changes); `--all` shows missed ones.
- `tally profile` → plan + stage; `tally connect|sync|providers|disconnect` → OpenRouter (Management key) ledger.
- Core: encrypted key store (macOS Keychain / env / passphrase), SQLite ledger with price history, OpenRouter adapter, deals seed `packages/core/data/deals.json`, Anthropic price table. 23 tests.
- Bassam's live numbers 29 Oct: $1,601 API-equivalent in 30 days (72% Fable 5.1), 8.0x on Max 20x; $0.52 on OpenRouter.

## In progress / waiting on Bassam

- [ ] **Claim the $200/month Max API credits**: claude.ai → Settings → Billing → "Link organization". Unclaimed as of 29 Oct. Say "link it" and Claude clicks it, or do it yourself.
- [ ] **Decide the 20 Nov downgrade to Max 5x** (scheduled). At 8x utilization 5x halves the window and credits drop to $100. "Renew current Max plan" button is on the same page.
- [ ] Provider board items (Todoist task 29 Oct 10am): log in to HF + OpenRouter + `wrangler login`, then say "go".
- [ ] Tally M2 per the original spec (OpenAI + Anthropic API adapters, ±1% check) — parked behind the publish list.

## To publish and go live (`npx <name>` + GitHub)

- [x] Monorepo, encrypted keys, OpenRouter adapter, tests (M1)
- [x] Wallet screen, verdict, deal feed, profile
- [x] Local commits on main
- [ ] Pick the npm name. `tally`, `tally-ai`, `tally-cli` are taken. Available: `tallyai`, `aitally`, `tally-wallet`. (Bassam's call)
- [ ] Bundle `@tally/core` into the CLI (tsup) so `npx <name>` works without the workspace; ship `data/` in the package
- [ ] LICENSE (MIT) + package metadata (repository, homepage, keywords, `engines`)
- [ ] README rewrite: wallet-first quickstart, what is read locally, what never leaves the machine
- [ ] GitHub remote under `bsssm` (gh is logged in) + push; CI running `pnpm test`
- [ ] First-run UX for strangers: no Keychain prompt until a key is stored; passphrase path tested interactively; `tally` with zero logs shows a clean empty state
- [ ] Readers for Codex, Cursor, Gemini CLI (ccusage parity; MIT parsers can be adapted) — optional for v0.1
- [ ] Verify every `asserted` deal on the provider's own page before release; drop or label what fails
- [ ] Deal sweep automation: Context.dev monitors on pricing pages + a weekly Exa/Parallel sweep → PR to deals.json
- [ ] Fresh-machine acceptance test (spec §13): `npx <name>` → wallet in under 60s with no key
- [ ] `npm publish` (dry run first), then announce: X post with the wallet screenshot, Show HN
- [ ] Later: statusline/menu-bar gauge, monthly share card, dashboard (M4), proxy mode

## Where the thinking lives

- `~/knowledge/personal/tally-value.md` — value quantification, start/stay analysis, trends, innovation list.
- `~/knowledge/agent-memory/tally.md` — project memory (loaded every session).
- `SPEC.md` — the original spec; milestones reordered by the reposition.
