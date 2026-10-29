# Local coding-agent log formats

What each tool writes to disk, what Tally reads from it, and how sure we are. Researched 29 Oct 2026
from the tools' own source and from ccusage's MIT adapters (github.com/ryoppippi/ccusage, commit
757b457, `rust/adapters/*`). Confidence: **documented** = read in the tool's source or official docs;
**asserted** = from a third-party parser or forum thread, not seen in the vendor's code.

| Tool | Local token counts? | Reader | Confidence |
|---|---|---|---|
| Claude Code | yes, per assistant message | `claude-code.ts` (unchanged) | documented |
| OpenAI Codex CLI | yes, per turn (`token_count` events) | `codex.ts` | documented via ccusage, cross-checked with its fixture |
| Gemini CLI | yes, per `gemini` message (`tokens`) | `gemini.ts` | documented (gemini-cli source) |
| Cursor | **no** on current builds; `tokenCount` is `{0,0}` | `cursor.ts` → "detected but unpriced" | asserted (codeburn, toolpath-cursor, forum) |

## OpenAI Codex CLI

Source: ccusage `rust/adapters/codex/src/README.md` and `parser.rs`; fixture
`apps/ccusage/test/fixtures/codex/sessions/project-alpha/session-alpha.jsonl`.

- Location: `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` and
  `archived_sessions/`. Rollouts may also be Zstandard-compressed (`.jsonl.zst`); **Tally skips those**
  and says how many in `notes`.
- Line shapes (all have `timestamp` ISO and `type`):
  - `session_meta` → `payload.id` (thread id), `payload.timestamp`, `payload.cwd`, `payload.cli_version`.
  - `turn_context` → `payload.model` (the model for following turns), `payload.effort`.
  - `event_msg` with `payload.type === "token_count"` → `payload.info.last_token_usage` (this turn)
    and `payload.info.total_token_usage` (cumulative). Fields: `input_tokens`, `cached_input_tokens`
    (subset of input), `output_tokens` (includes reasoning), `reasoning_output_tokens`, `total_tokens`.
    When only totals exist, the delta is total minus the previous total. A `token_count` whose totals
    did not advance is a repeat and is dropped.
  - `event_msg` with `payload.type === "thread_settings_applied"` → `payload.thread_settings.service_tier`
    in `default|standard|fast|priority|flex` (Codex CLI ≥ 0.144). Inherited by later turns in the file.
    Tally multiplies by 2 for fast/priority and 0.5 for flex (OpenAI lists "about" those; a few cells differ).
  - `token_usage_record` (auto-compaction usage) → **not counted** in v0.1. Slight undercount.
- Model: `turn_context.payload.model`, else `info.model` if present, else `gpt-5` flagged as a guess.
  `codex-auto-review` is a server-routed alias; priced by the date timeline in `openai-prices.json`
  (`codex_auto_review_fallbacks`, copied from ccusage, unverified against OpenAI).
- Dedupe: forked and subagent rollouts replay the parent's history. Tally drops any turn whose
  (timestamp, input, cached, output) tuple was already seen in another file. ccusage does a stricter
  marker-based replay detection (`task_started`, `inter_agent_communication_metadata`).
- Pricing: `(input − cached) × input + cached × cached_input + output × output`, Standard tier;
  long-context rates when input > 272k and the model lists one. Reasoning is already inside output.

## Gemini CLI

Source: `packages/core/src/services/chatRecordingService.ts` and `chatRecordingTypes.ts` in
github.com/google-gemini/gemini-cli (main, 29 Oct 2026); ccusage `rust/adapters/gemini/src/parser.rs`.

- Location: `${GEMINI_DATA_DIR:-~/.gemini}/tmp/<projectHash>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl`.
  Subagent sessions: `chats/<parentSessionId>/<sessionId>.jsonl`. Legacy builds wrote `.json` with a
  top-level `messages` array; the CLI migrates them, Tally reads both. Only files under a `chats/`
  directory are read (`tmp/` also holds checkpoints and shell output).
- JSONL: line 1 is metadata (`sessionId`, `projectHash`, `startTime`, `lastUpdated`, `kind`,
  `directories`). Then one message per line: `id`, `timestamp`, `type` in `user|gemini|info|error|warning`,
  `content`. A `gemini` message adds `model`, `thoughts`, `toolCalls` and
  `tokens: { input, output, cached, thoughts?, tool?, total }` which map 1:1 to the API's
  `promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`,
  `toolUsePromptTokenCount`, `totalTokenCount`. Control lines `{"$set":{…}}`, `{"$patch":{…}}`,
  `{"$rewindTo":id}` are skipped. A repeated message `id` replaces the earlier one (last write wins).
- Pricing: `cached` is part of `input`, so uncached input = input − cached (+ tool tokens, billed as
  input). Thinking bills at the output rate, so output = output + thoughts. Long-context rates when
  input > 200k for models that list them. Paid-tier Standard prices; Gemini CLI on a Google account
  (Code Assist free tier) bills $0 real dollars, the figure is API-equivalent like Claude Code on Max.
- Not read: Antigravity (`~/.gemini/antigravity/**`). ccusage reads its SQLite `conversations/*.db`
  with protobuf-encoded `gen_metadata`; on this machine the folder holds `.pb` files only. Out of scope.

## Cursor

Sources: codeburn `docs/providers/cursor.md` + `src/providers/cursor.ts` (github.com/getagentseal/codeburn),
docs.rs/toolpath-cursor, ccstats docs, forum.cursor.com threads on `state.vscdb` growth. ccusage has no
Cursor adapter. Nothing here is from Cursor's own code; the schema is not a public API.

- Location (global DB): macOS `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
  Linux `${XDG_CONFIG_HOME:-~/.config}/Cursor/User/globalStorage/state.vscdb`, Windows
  `%APPDATA%\Cursor\User\globalStorage\state.vscdb`. Override: `CURSOR_STATE_DB`. Opened read-only.
  Known to grow to tens of GB (`bubbleId:*`, `agentKv:*` rows); Tally caps the bubble scan at 250,000 rows.
- Table `cursorDiskKV (key, value)`:
  - `composerData:<composerId>` → one JSON per conversation: `createdAt` (epoch ms),
    `modelConfig.modelName`, `fullConversationHeadersOnly[]`, `contextTokensUsed`,
    `promptTokenBreakdown.totalUsedTokens`, `usageData` (empty object).
  - `bubbleId:<composerId>:<bubbleId>` → one JSON per message: `type` (1 user, 2 assistant),
    `createdAt` (ISO), `modelInfo.modelName` (Cursor spelling, e.g. `claude-4.5-sonnet-thinking`,
    `gpt-5`, `auto`, `composer-1`), `requestId`, `tokenCount: { inputTokens, outputTokens }`.
  - `agentKv:blob:*` → newer per-conversation blobs (`role`, `content`, `providerOptions.cursor.requestId`,
    `providerOptions.cursor.modelName`), no timestamps, no token counts. Not read.
  - Table `ItemTable` holds `composer.composerHeaders` (index) and workspace UI state.
- The catch: on current Cursor builds `tokenCount` stays `{0,0}` on every bubble and cache reads are never
  recorded locally. Cursor meters usage server-side; the authoritative numbers are at
  cursor.com/dashboard → Usage (CSV export; a Team/Enterprise Admin API exists, no endpoint for
  individual Pro accounts). Third-party tools estimate tokens from text length ÷ 4; Tally does not.
- What Tally does: counts conversations in the window from `composerData.createdAt`, prices any assistant
  bubble that carries non-zero `tokenCount` by matching `modelInfo.modelName` against the Anthropic,
  OpenAI and Google tables (Cursor's `claude-4.5-sonnet` is normalized to `claude-sonnet-4-5`), and
  otherwise reports "detected, N conversations, unpriced" with the dashboard pointer. No cache discount
  is applied because the local data has no cache fields.

## Price tables

- `data/openai-prices.json`: OpenAI pricing page https://developers.openai.com/api/docs/pricing read
  29 Oct 2026. Standard per-1M prices plus `long_context` (> 272k input) where listed, `service_tiers`
  multipliers, and `verified: false` on models the page no longer lists (older codex models, taken from
  the models.dev snapshot vendored in ccusage).
- `data/google-prices.json`: https://ai.google.dev/gemini-api/docs/pricing read 29 Oct 2026, paid tier.
  Several models carry an announced step-up (`until` / `after`): Gemini 4 Argon doubles on 1 Dec 2026,
  3.6/3.8 Flash on 1 Jan 2027. The current price is the top-level one. `verified: false` on legacy 2.0
  models and 3.5 Flash.
- Both tables are longest-prefix matched (`gpt-5.5-pro` beats `gpt-5.5`), same idea as the Anthropic one.
