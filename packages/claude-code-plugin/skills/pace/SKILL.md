---
name: pace
description: Show the current Claude Code 5-hour window burn (API-equivalent dollars, percent of budget, today's total, credits countdown) and install or remove the Tally status line. Use for /tally:pace, "how much of my window is left", "install the tally statusline".
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pace.cjs" *)
---

Current pace (computed just now from local session logs, nothing sent anywhere):

```
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pace.cjs" status`
```

Show the user that block as-is, then:

- If they asked to install: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pace.cjs" install`. It writes a `statusLine` into `~/.claude/settings.json` only when none is configured; otherwise it prints the JSON for them to merge by hand. The hook is already active through this plugin, so install skips it.
- If they asked to uninstall: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pace.cjs" uninstall`. It removes exactly what install wrote.
- Config lives in `~/.tally/pace.json`: `plan` (pro | max5 | max20), `budgetUsd` (API-equivalent dollars per 5h window; optional, the status line calibrates it from Claude Code's own rate_limits), `threshold` (0.8 default), `mode` ("nudge" default, "switch" also writes `effortLevel` for the next session), `credits` ({ poolUsd, resetsOn, spentUsd }).
