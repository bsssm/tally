# tally — Claude Code window pacing

A status line that shows your 5-hour window in API-equivalent dollars and percent, today's total, and a credits
countdown, plus a hook that asks the model to spend less once the window is nearly used. Local only: it reads
`~/.claude/projects/**/*.jsonl` and the JSON Claude Code hands the status line. Nothing leaves the machine.

```
tally 5h 64% $90.2 ↻1h28 · today $103 · credits $173 6d
```

## Install

```
/plugin marketplace add bsssm/tally
/plugin install tally@tally
/tally:pace install
```

Or from the Tally CLI: `tally pace install`. Either way the status line is written into `~/.claude/settings.json`
only if no `statusLine` is configured; otherwise the JSON to merge by hand is printed. The hook comes with the
plugin, so install skips it when the plugin is enabled. `tally pace uninstall` removes exactly what was added.

Plain `tally pace` (or `/tally:pace`) prints the current numbers and where they came from.

## How the numbers are made

- Percent: Claude Code's own `rate_limits.five_hour.used_percentage` whenever the status line receives it
  (Pro and Max subscribers). From it the script calibrates a dollar budget per window, so the percent still
  works in the hook and in the terminal, where that field is not delivered. `~` after the dollars marks an estimate.
- Dollars: each assistant turn priced at Anthropic API list rates, the same table as `tally wallet`. The window
  starts at `resets_at − 5h` when known, else rolls 5 hours back.
- Speed: files are scanned incrementally (mtime + size, appended bytes only), cached in `~/.tally/pace-cache.json`.
  Warm run ≈ 25 ms of work on top of Node's own boot.
- Credits: the latest `credit_pools` row for Anthropic in `~/.tally/tally.db` (read-only, when the monorepo's
  better-sqlite3 is reachable), else `credits` in `~/.tally/pace.json`, else the field is left out.

## Config: `~/.tally/pace.json`

```json
{ "plan": "max20", "budgetUsd": 150, "threshold": 0.8, "mode": "nudge", "credits": { "poolUsd": 200, "resetsOn": 7, "spentUsd": 27 } }
```

- `plan`: pro | max5 | max20. Scales a calibrated budget by the official 1x/5x/20x multipliers if you change plan.
- `budgetUsd`: fixed dollars per window; overrides calibration.
- `threshold`: fraction of the window at which the hook starts nudging (default 0.8).
- `mode`: `nudge` injects context only. `switch` also writes `effortLevel: "low"` into `~/.claude/settings.json`
  and restores the previous value when the window eases. Claude Code reads that key at session start, so it
  affects the next session, not this one. See RESEARCH.md for why nothing stronger is possible.
