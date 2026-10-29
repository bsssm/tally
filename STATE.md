# Tally — state of play (saved 29 Oct 2026, evening)

Resume prompt (paste into Claude Code from any directory):

> Resume Tally. Read ~/GitHub/tally/STATE.md and ~/knowledge/personal/tally-plan.md, then do the next unchecked item unless I say otherwise. Don't re-explain the product.

## What exists (main, pushed to the private repo github.com/bsssm/tally)

- `npx tallywallet` (package `tallywallet` 0.1.0, not yet published): wallet screen from Claude Code, Codex CLI, Cursor and Gemini CLI local logs priced at API rates, OpenRouter ledger, plan verdict with levers, top deals. Clean empty state, no Keychain or passphrase prompt until the first `connect`.
- `tally deals [--all]`: 16 verified + 1 unconfirmed deals, expired ones with a missed line. Six Context.dev page monitors (`packages/core/data/monitors.json`, about 75 credits a month); `pnpm sweep` lists changes.
- `tally route`: credits router on 127.0.0.1:7411 (`packages/router`). OpenAI and Anthropic shapes, streaming, pools (`route pool add anthropic --usd 200 --resets 7`), `route status`, `route jobs`. Reconciles from the Admin API when `tally connect anthropic --admin` is stored.
- `tally pace [install|uninstall]`: Claude Code statusline + UserPromptSubmit hook (`packages/claude-code-plugin`), also installable as a plugin from the repo root marketplace. Rendered here: `tally 5h 64% $90.4 ↻1h24 · today $103`.
- `tally card [--square] [--dark] [--png] [--redact-models]`: monthly share card SVG (PNG via rsvg-convert or headless Chrome); sample in `packages/site/assets/card-sample.png`.
- Landing page `packages/site` (static, Netlify site `tally-ai-wallet`, draft deploys only).
- 95 tests, typecheck clean, CI workflow on ubuntu + macOS, node 20 + 22. `scripts/fresh-machine.sh` passes in under 10 s.

## Done 29 Oct evening on his "publish"

- [x] Repo public: github.com/bsssm/tally. Plugin: `/plugin marketplace add bsssm/tally`.
- [x] Site live: https://tally-ai-wallet.netlify.app (Netlify site id d3596cd1-b2c2-408b-86c6-5a0b4d4fe3e9, deploy from packages/site with `--prod --dir=. --site <id> --json`).
- [x] $200/month API credits were already linked (next credit 21 Nov); profile marked claimed; router pool #1 added (resets on the 21st).
- [x] npm login as bsssm (needs a real Terminal: `npm login` crashes under Claude's shell).
- [ ] `npm publish --access public` from packages/cli: 403 until 2FA is enabled on the npm account (npmjs.com/settings/bsssm/tfa). Then rerun in Terminal.app.

## Waiting on Bassam (also Todoist, 30 Oct 10am)

- [ ] Name: keep Tally / `tallywallet`, or rename (9 live TALLY marks in USPTO classes 9 and 42; every tally domain taken; free: aiwallet.sh, tallied.dev, purse.dev $89).
- [ ] Enable 2FA on npm, then the publish goes through.
- [ ] Anthropic API key + admin key → `tally connect anthropic` / `--admin`. Until then the router's credit path is untested with real credits.
- [x] Downgrade to Max 5x stays (20 Nov). Flip `tally profile --plan max5` and the pool to $100 after that date.
- [ ] Domain: undecided; he owns pobopay.com and agntpay.com; tally.bassame.com is the free option.

## Next for Claude, in order

- [x] Landing page rounds 1 and 2 (draft https://6ae384bc52fb657aecc0d6a2--tally-ai-wallet.netlify.app). Prod deploy once the name is settled.
- [x] Dashboard Σ Tally tab (wallet, deals, router /status, pace), 29 Oct.
- [ ] Launch drafts ready in `~/knowledge/personal/tally-launch-drafts.md` (X post + Show HN), unsent.
- [ ] Announce: X post with the wallet screenshot, Show HN, ccusage comparison in the README.
- [ ] M2 adapters: Anthropic + OpenAI usage sync (±1% check against their dashboards); `tally sync` currently skips those keys.
- [ ] Credit-claiming agent (fills Anthropic / Google / AWS / Together / Cloudflare forms from the profile).
- [ ] Team layer and provider placements later.

## Where the thinking lives

- `~/knowledge/personal/tally-plan.md` — relaunch plan, gaps, unblocks (29 Oct).
- `~/knowledge/personal/tally-value.md` — value quantification and the innovation list.
- `~/knowledge/agent-memory/tally.md` — project memory.
- `packages/claude-code-plugin/RESEARCH.md` — what Claude Code hooks and statusline can and cannot do.
- `packages/core/src/local/FORMATS.md` — on-disk formats of the four agents.
