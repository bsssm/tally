import type { UsageEvent } from "../types.js";
import type { ClaudeCodeSummary } from "./claude-code.js";

/** The local coding-agent logs Tally can read without a key. */
export type LocalSource = "claude-code" | "codex" | "cursor" | "gemini";

/** One priced request from any local agent log. Token buckets mirror what each tool records; zero when the tool has no such bucket. */
export interface LocalTurn {
  date: string;
  model: string;
  sessionId: string;
  /** Input tokens NOT served from cache. */
  input: number;
  output: number;
  cacheRead: number;
  /** Cache-write tokens (Anthropic only; OpenAI and Google bill writes as plain input). */
  cacheWrite: number;
  /** Reasoning/thinking tokens. Informational: already inside `output` for OpenAI and Google. */
  reasoning: number;
  /** Price multiplier for the request's service tier (Codex fast/flex). 1 when not applicable. */
  tierMultiplier?: number;
  /** True when the model was guessed (no model metadata in the log). */
  fallbackModel?: boolean;
}

/** Same shape as the Claude Code summary, plus where it came from and what the reader wants you to know. */
export interface LocalAgentSummary extends ClaudeCodeSummary {
  source: LocalSource;
  /** True when the tool's data directory (or database) exists on this machine, even if it held no priced turns. */
  detected: boolean;
  /** The directory or file that was read (or looked for). */
  path: string;
  /** Caveats a human should see: unsupported files, unpriced data, estimation rules. */
  notes: string[];
}

export interface LocalAgentsSummary {
  from: string;
  to: string;
  sources: LocalAgentSummary[];
  /** Sum across sources. */
  apiEquivalentUsd: number;
  turns: number;
  /** Every source's normalized daily events, concatenated. */
  events: UsageEvent[];
}
