import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageEvent } from "../types.js";
import { claudeProjectsDir, summarizeClaudeCode } from "./claude-code.js";
import { codexHome, summarizeCodex } from "./codex.js";
import { cursorStateDb, summarizeCursor } from "./cursor.js";
import { geminiDataDir, summarizeGemini } from "./gemini.js";
import { emptySummary } from "./shared.js";
import type { LocalAgentSummary, LocalAgentsSummary, LocalSource } from "./types.js";

export * from "./types.js";
export * from "./codex.js";
export * from "./gemini.js";
export * from "./cursor.js";
export { longestPrefixMatch } from "./shared.js";

export interface LocalAgentsOptions {
  /** Override $HOME for every reader (tests, CI). Env overrides such as CODEX_HOME still win. */
  home?: string;
  /** Read only these sources. Default: all four. */
  sources?: LocalSource[];
}

/**
 * Run every local reader. A missing directory, an unreadable database or a malformed line never throws:
 * each source comes back as a summary with `detected` and `notes` saying what happened.
 */
export async function summarizeLocalAgents(from: string, to: string, opts: LocalAgentsOptions = {}): Promise<LocalAgentsSummary> {
  const home = opts.home ?? homedir();
  const want = new Set<LocalSource>(opts.sources ?? ["claude-code", "codex", "cursor", "gemini"]);
  const readers: { source: LocalSource; path: string; run: () => Promise<LocalAgentSummary> }[] = [
    {
      source: "claude-code",
      path: opts.home && !process.env.CLAUDE_CONFIG_DIR ? join(home, ".claude", "projects") : claudeProjectsDir(),
      run: async function () {
        const cc = await summarizeClaudeCode(from, to, this.path);
        return { ...cc, source: "claude-code", detected: existsSync(this.path), path: this.path, notes: [] };
      },
    },
    { source: "codex", path: codexHome(home), run: async function () { return summarizeCodex(from, to, this.path); } },
    { source: "cursor", path: cursorStateDb(home), run: async function () { return summarizeCursor(from, to, this.path); } },
    { source: "gemini", path: geminiDataDir(home), run: async function () { return summarizeGemini(from, to, this.path); } },
  ];
  const sources: LocalAgentSummary[] = [];
  for (const r of readers) {
    if (!want.has(r.source)) continue;
    try {
      sources.push(await r.run());
    } catch (e) {
      sources.push(emptySummary(r.source, from, to, r.path, [`Reader failed: ${(e as Error).message}`], existsSync(r.path)));
    }
  }
  const events: UsageEvent[] = sources.flatMap((s) => s.events);
  return {
    from,
    to,
    sources,
    apiEquivalentUsd: sources.reduce((a, s) => a + s.apiEquivalentUsd, 0),
    turns: sources.reduce((a, s) => a + s.turns, 0),
    events,
  };
}
