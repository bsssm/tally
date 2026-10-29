# Wiring the Codex / Cursor / Gemini readers into the wallet

Owner of `packages/cli/src/commands/wallet.ts` and `packages/core/src/wallet.ts`: apply the patch below.
`verdict()` in core stays Claude-only (plans are Anthropic plans); nothing in core/wallet.ts needs to change.
Everything is exported from `@tally/core` via `packages/core/src/local/index.ts`.

```ts
import { summarizeLocalAgents, type LocalAgentSummary } from "@tally/core";
```

`summarizeLocalAgents(from, to, { sources?: ["codex","cursor","gemini"], home? })` returns
`{ sources: LocalAgentSummary[], apiEquivalentUsd, turns, events }`. Each source has the Claude Code
summary shape plus `source`, `detected`, `path`, `notes[]`. It never throws.

## The patch (packages/cli/src/commands/wallet.ts)

```diff
-import { ..., summarizeClaudeCode, ... } from "@tally/core";
+import { ..., summarizeClaudeCode, summarizeLocalAgents, ... } from "@tally/core";

   const cc = await summarizeClaudeCode(f, t);
   if (cc.events.length) replaceUsageEvents(db, "claude-code", f, t, cc.events);
+  const local = await summarizeLocalAgents(f, t, { sources: ["codex", "cursor", "gemini"] });
+  for (const s of local.sources) if (s.events.length) replaceUsageEvents(db, s.source, f, t, s.events);

-  const byProvider = summarizeByProvider(db, f, t).filter((p) => p.providerId !== "claude-code");
+  const LOCAL = new Set(["claude-code", "codex", "cursor", "gemini"]);
+  const byProvider = summarizeByProvider(db, f, t).filter((p) => !LOCAL.has(p.providerId));

-  const providers = new Set([...byProvider.map((p) => p.providerId), ...(cc.turns ? ["claude-code", "anthropic"] : [])]);
+  const providers = new Set([
+    ...byProvider.map((p) => p.providerId),
+    ...(cc.turns ? ["claude-code", "anthropic"] : []),
+    ...local.sources.filter((s) => s.turns).flatMap((s) => [s.source, VENDOR[s.source]]),
+  ]);

-  if (!cc.turns && !byProvider.length && !opts.json) {
+  if (!cc.turns && !local.turns && !byProvider.length && !opts.json) {

   if (opts.json) {
-    console.log(JSON.stringify({ window: { from: f, to: t }, plan, claudeCode: { ...cc, events: undefined }, verdict: v, providers: byProvider, deals }, null, 2));
+    console.log(JSON.stringify({ window: { from: f, to: t }, plan, claudeCode: { ...cc, events: undefined }, local: local.sources.map((s) => ({ ...s, events: undefined })), verdict: v, providers: byProvider, deals }, null, 2));

   // after the Claude Code block, before `for (const p of byProvider)`:
+  for (const s of local.sources) {
+    if (s.turns) {
+      console.log(`  ${LABEL[s.source].padEnd(26)} ${bold(money(s.apiEquivalentUsd).padStart(10))} API-equivalent   ${int(s.sessions)} sessions · ${s.activeDays} days · ${int(s.turns)} turns`);
+      for (const m of s.byModel.slice(0, 3)) console.log(`    ${m.model.padEnd(26)} ${money(m.usd).padStart(9)}  ${String(Math.round(m.share * 100)).padStart(3)}%   cache hit ${Math.round(m.cacheHitRate * 100)}%`);
+      const unk = Object.keys(s.unknownModels);
+      if (unk.length) console.log(dim(`    unpriced models skipped: ${unk.join(", ")}`));
+    } else if (s.detected) {
+      console.log(dim(`  ${LABEL[s.source].padEnd(26)} detected, nothing priced in this window${s.notes[0] ? ` · ${s.notes[0]}` : ""}`));
+    }
+  }
```

Add near the top of the file:

```ts
const LABEL: Record<LocalAgentSummary["source"], string> = { "claude-code": "Claude Code (local logs)", codex: "Codex CLI (local logs)", cursor: "Cursor (local db)", gemini: "Gemini CLI (local logs)" };
const VENDOR: Record<LocalAgentSummary["source"], string> = { "claude-code": "anthropic", codex: "openai", cursor: "cursor", gemini: "google" };
```

## Empty state

In `emptyState()`, after the Claude Code line, list what else was looked for so a stranger sees the scan was real:

```ts
console.log(`  Also looked for Codex (~/.codex/sessions), Cursor (state.vscdb) and Gemini CLI (~/.gemini/tmp): none found.`);
```

(`local.sources[i].path` has the exact resolved path per source if you want to print them.)

## Notes

- Cursor on current builds is always "detected, nothing priced": its local `tokenCount` is `{0,0}`.
  The note on that source points at cursor.com/dashboard. Do not estimate tokens from text; see FORMATS.md.
- The verdict's levers stay Claude-only. A Codex plan verdict (ChatGPT Plus/Pro vs API) would need an
  OpenAI plan table; `openai-prices.json` has no `plans` block yet.
- `replaceUsageEvents` with providerId `codex|cursor|gemini` is safe: it deletes and re-inserts only that
  provider's rows in the window, same as `claude-code`.
