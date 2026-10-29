# Claude Code pacing: what the platform allows (researched 29 Oct 2026)

Checked against the official docs at code.claude.com (the docs.claude.com paths redirect there) on Claude Code
2.1.312. Every claim carries the page it came from. Where the docs are silent, it says so.

## 1. What the status line receives on stdin

Source: https://code.claude.com/docs/en/statusline.md (sections "Available data", "Rate limit usage",
"When the status line updates").

- The command gets one JSON object on stdin with `session_id`, `transcript_path`, `cwd`, `model.{id,display_name}`,
  `workspace.{current_dir,project_dir,added_dirs,...}`, `version`, `output_style.name`,
  `cost.{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added,total_lines_removed}`,
  `context_window.{total_input_tokens,total_output_tokens,context_window_size,used_percentage,remaining_percentage,current_usage}`,
  `exceeds_200k_tokens`, `fast_mode`, `effort.level`, `thinking.enabled`, `prompt_cache.*`, and optional
  `vim`, `agent`, `pr`, `worktree` objects.
- **Rate-limit fields exist.** Quoted: "`rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` |
  Percentage of the 5-hour or 7-day rate limit consumed, from 0 to 100" and "`rate_limits.five_hour.resets_at`,
  `rate_limits.seven_day.resets_at` | Unix epoch seconds when the 5-hour or 7-day rate limit window resets."
  A `rate_limits.spend_limit` object exists behind a Claude apps gateway.
- Availability: "`rate_limits`: appears only for claude.ai Pro and Max subscribers, or behind a Claude apps gateway
  that sets a spend limit for you, and only after the first API response in the session. Each window ... may be
  independently absent, and Claude Code drops a window once its `resets_at` time passes."
- `cost.total_cost_usd` is per session, computed client-side at list price. It is not a window figure.
- Refresh: runs at session start, then on each new assistant message, after `/compact`, on permission-mode or vim
  changes, on a `refreshInterval` tick, and "when a rate-limit window in the data your script last received reaches
  its `resets_at` time". "Claude Code debounces updates at 300ms" and cancels an in-flight script when a new trigger
  fires. No documented hard timeout for the script.
- Config shape: `{"statusLine": {"type": "command", "command": "...", "padding": 0, "refreshInterval": N}}`.

**Consequence for Tally.** The status line prefers `rate_limits.five_hour.used_percentage` (exact, server-side)
and uses `resets_at` as the true window start for the dollar scan. The local log scan supplies what the platform
does not: API-equivalent dollars for the window and for today. When both are present the script calibrates a
dollar budget per window (`windowUsd / used_percentage`) and keeps it in `~/.tally/pace-cache.json`, so the
percentage keeps working from the terminal and in the hook, where `rate_limits` is not delivered. Without any
calibration or `budgetUsd` the line shows dollars only; no per-plan dollar table is invented, because Anthropic
publishes the windows as multiples of Pro (Max 5x, Max 20x), not as dollars or tokens.

## 2. Hooks: events, UserPromptSubmit, and what a hook can change

Source: https://code.claude.com/docs/en/hooks.md and https://code.claude.com/docs/en/hooks-guide.md.

- Events (33): SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest,
  PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart,
  SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange,
  CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact,
  PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.
- UserPromptSubmit stdin: `{session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt}` plus the
  common fields (`prompt_id`, `scratchpad_dir`). `rate_limits` is **not** part of hook input, and `effort` is only
  "present for events that fire within a tool-use context, such as PreToolUse, PostToolUse, Stop, and SubagentStop".
- UserPromptSubmit output: JSON with optional `decision: "block"` (the only value), `reason`, and
  `hookSpecificOutput.{hookEventName, additionalContext, sessionTitle, suppressOriginalPrompt}`. Quoted:
  "`additionalContext` | String added to Claude's context alongside the submitted prompt." Plain stdout on exit 0
  is also added as context for this event. Exit 2 blocks the prompt. Default timeout for a command hook on this
  event is lowered to 30 s. UserPromptSubmit has "no matcher support"; a matcher is silently ignored.
- A hook **cannot** switch the model or effort of the running session. Nothing in the hook output schema sets
  either. `PreModelSwitch` can block a switch, `PostModelSwitch` observes one. "There is no `$CLAUDE_MODEL`
  environment variable." `CLAUDE_ENV_FILE` (SessionStart only) persists env for the shell commands Claude runs,
  not for Claude Code's own model selection.
- Settings keys that do set model and effort, and when they are read
  (https://code.claude.com/docs/en/settings.md, https://code.claude.com/docs/en/model-config.md):
  `model`, `effortLevel` (`low|medium|high|xhigh`; `max` is not accepted as a level there), `modelSettings`,
  `maxEffortLevel`. Quoted: "Claude Code reads some keys only once, at session start, so an edit to one of them
  doesn't reach the running session", listing `model`, `effortLevel` and `modelSettings`, with the instruction
  to use `/model` and `/effort` mid-session. Env: `ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`, both read at launch.
  `opusplan` switches opus→sonnet on plan-mode exit, not on usage. Fable/Opus 4.7+/Sonnet 5+ use adaptive
  reasoning, so `MAX_THINKING_TOKENS` does not apply to them.

**Consequence for Tally.** `pace.mode: "nudge"` (default) injects `additionalContext` past the threshold and a
one-time "eased" note when the window drops. `pace.mode: "switch"` additionally writes `effortLevel: "low"` into
`~/.claude/settings.json` (saving the previous value) and restores it when the window eases; this is supported
but only reaches the **next** session, so the nudge still carries the current one. A real mid-session switch
would need `/effort` or `/model` typed by the user; no documented hook can issue them.

## 3. Plugin layout, hooks in plugins, marketplace

Sources: https://code.claude.com/docs/en/plugins/manifest-reference.md,
https://code.claude.com/docs/en/plugins/components.md, https://code.claude.com/docs/en/plugins/create-marketplace.md,
https://code.claude.com/docs/en/skills.md.

- Manifest at `.claude-plugin/plugin.json` with `name` (required, kebab-case), `version`, `description`, `author`
  (`name` required), `homepage`, `repository`, `license`, `keywords`, `hooks` (path to a hooks file), `skills`,
  `commands`, `agents`, `mcpServers`, `settings`, `userConfig`, ... Everything else lives at the plugin root.
- Hooks: `hooks/hooks.json` with a top-level `hooks` key in the settings shape. `${CLAUDE_PLUGIN_ROOT}` is
  substituted in `command`/`args`/`env`, and hook processes receive `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`.
  Plugin hooks register when the plugin is enabled; they do not wait for a skill to be used.
- **A plugin cannot ship a status line.** Quoted from components.md: "Only two keys take effect from a plugin,
  `agent` and `subagentStatusLine`; every other key is dropped." So the status line must be written into the
  user's own `settings.json`, which is what `tally pace install` and `/tally:pace install` do, and only when no
  `statusLine` is already configured.
- Skills supersede commands: "Commands are the older format ... write new ones as skills". A plugin skill gets
  `${CLAUDE_PLUGIN_ROOT}` substituted in its markdown and in `allowed-tools`, and `` !`cmd` `` lines run before
  the content reaches Claude. Tally ships `skills/pace/SKILL.md` → `/tally:pace`.
- Marketplace: `.claude-plugin/marketplace.json` at the repo root with `name`, `owner`, `plugins[]` of
  `{name, source, description}`; `source` is a path from the marketplace root (no `..`). Add with
  `claude plugin marketplace add <owner>/<repo>` (shell) or `/plugin marketplace add <owner>/<repo>` in a session,
  then `/plugin install tally@tally`. `claude plugin validate .` passes for this repo and for the plugin folder.

## 4. What is and is not possible, in one table

| Goal | Possible | How | Limit |
| --- | --- | --- | --- |
| Show 5h window % in the status line | yes, exact | `rate_limits.five_hour.used_percentage` on stdin | Pro/Max only, after first response |
| Show window and today in API dollars | yes | local scan of `~/.claude/projects/**/*.jsonl` | same estimate `tally wallet` uses |
| Tell the model to spend less past a threshold | yes | UserPromptSubmit `additionalContext` | advisory; the model decides |
| Lower effort for the running session from a hook | no | none documented | user types `/effort low` |
| Switch model for the running session from a hook | no | none documented | user types `/model` |
| Lower effort for the next session | yes | write `effortLevel` to settings.json | read once at session start |
| Ship the status line inside the plugin | no | plugin settings keep only `agent`, `subagentStatusLine` | installer writes user settings |

Help-center note: Anthropic's older article gave rough Claude Code capacity per 5-hour window as 10–40 prompts
(Pro), 50–200 (Max 5x), 200–800 (Max 20x); the current pages describe the plans as 5x and 20x Pro. Neither is a
dollar figure, which is why Tally calibrates instead of hardcoding.
