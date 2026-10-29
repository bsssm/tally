# Tally — state of play (saved 29 Oct 2026, evening)

Resume prompt (paste into Claude Code from any directory):

> Resume Tally. Read ~/GitHub/tally/STATE.md and ~/knowledge/personal/tally-plan.md, then do the next unchecked item unless I say otherwise. Don't re-explain the product.

## What exists (main, pushed to the private repo github.com/bsssm/tally)

- `npx tallyai` (package `tallyai` 0.1.0, not yet published): wallet screen from Claude Code, Codex CLI, Cursor and Gemini CLI local logs priced at API rates, OpenRouter ledger, plan verdict with levers, top deals. Clean empty state, no Keychain or passphrase prompt until the first `connect`.
- `tally deals [--all]`: 16 verified + 1 unconfirmed deals, expired ones with a missed line. Six Context.dev page monitors (`packages/core/data/monitors.json`, about 75 credits a month); `pnpm sweep` lists changes.
- `tally route`: credits router on 127.0.0.1:7411 (`packages/router`). OpenAI and Anthropic shapes, streaming, pools (`route pool add anthropic --usd 200 --resets 7`), `route status`, `route jobs`. Reconciles from the Admin API when `tally connect anthropic --admin` is stored.
- `tally pace [install|uninstall]`: Claude Code statusline + UserPromptSubmit hook (`packages/claude-code-plugin`), also installable as a plugin from the repo root marketplace. Rendered here: `tally 5h 64% $90.4 ↻1h24 · today $103`.
- Landing page `packages/site` (static, Netlify site `tally-ai-wallet`, draft deploys only).
- 83 tests, typecheck clean, CI workflow on ubuntu + macOS, node 20 + 22. `scripts/fresh-machine.sh` passes in under 10 s.

## Waiting on Bassam (also Todoist, 30 Oct 10am)

- [ ] Name: keep Tally / `tallyai`, or rename (9 live TALLY marks in USPTO classes 9 and 42; every tally domain taken; free: aiwallet.sh, tallied.dev, purse.dev $89).
- [ ] `npm login` (type `! npm login` in Claude Code).
- [ ] Claim the $200/month API credits: say "link it".
- [ ] Anthropic API key + admin key → `tally connect anthropic` / `--admin`. Until then the router's credit path is untested with real credits.
- [ ] Decide the 20 Nov Max 5x downgrade.
- [ ] Domain if renaming; otherwise tally.bassame.com.
- [ ] Say "publish": `npm publish` + repo public + Netlify prod are the irreversible steps.

## Next for Claude, in order

- [ ] Landing page round 2 (phone overflow, reveal-on-scroll content, real router output) and a prod deploy once the name is settled.
- [ ] Dashboard Tally tab (wallet, deals, router /status, pace) — in progress 29 Oct.
- [ ] Share card (`tally card`: monthly PNG/SVG of the wallet for X). First thing after publish; it is the acquisition loop.
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
