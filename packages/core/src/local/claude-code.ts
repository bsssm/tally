import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { UsageEvent } from "../types.js";

const require = createRequire(import.meta.url);
const PRICES = require("../../data/anthropic-prices.json") as {
  models: Record<string, { input: number; output: number; cache_read: number; cache_write_5m: number; cache_write_1h: number }>;
  plans: Record<string, { label: string; monthly_usd: number; api_credits_usd: number }>;
};

/**
 * Reads Claude Code's local session logs (~/.claude/projects/<project>/<session>.jsonl) and prices
 * each assistant turn at Anthropic API rates. No network, no key: this is the "wallet" source for
 * subscription users, where real dollars are $0 and the API-equivalent is what matters.
 *
 * Dedupe: Claude Code streams a message as several lines sharing message.id + requestId; count each once.
 */

export interface ClaudeCodeTurn {
  date: string;
  model: string;
  sessionId: string;
  cwd: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface ClaudeCodeSummary {
  from: string;
  to: string;
  sessions: number;
  activeDays: number;
  turns: number;
  apiEquivalentUsd: number;
  byModel: { model: string; usd: number; turns: number; output: number; cacheHitRate: number; share: number }[];
  unknownModels: Record<string, number>;
  events: UsageEvent[];
}

export function claudeProjectsDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, "projects") : join(homedir(), ".claude", "projects");
}

export function priceFor(model: string) {
  for (const [k, v] of Object.entries(PRICES.models)) if (model.startsWith(k)) return v;
  return undefined;
}

export function plans() {
  return PRICES.plans;
}

export function turnCostUsd(t: ClaudeCodeTurn): number | undefined {
  const p = priceFor(t.model);
  if (!p) return undefined;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cache_read + t.cacheWrite5m * p.cache_write_5m + t.cacheWrite1h * p.cache_write_1h) / 1e6;
}

/** Stream every session file once, yielding priced turns inside [from, to] (ISO dates, inclusive). */
export async function* readClaudeCodeTurns(from: string, to: string, dir = claudeProjectsDir()): AsyncGenerator<ClaudeCodeTurn> {
  if (!existsSync(dir)) return;
  const seen = new Set<string>();
  for (const project of readdirSync(dir)) {
    const pdir = join(dir, project);
    let files: string[];
    try {
      if (!statSync(pdir).isDirectory()) continue;
      files = readdirSync(pdir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const rl = createInterface({ input: createReadStream(join(pdir, f)), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.includes('"usage"')) continue;
        let d: any;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d?.type !== "assistant") continue;
        const ts: string = d.timestamp ?? "";
        const date = ts.slice(0, 10);
        if (date < from || date > to) continue;
        const m = d.message ?? {};
        const u = m.usage ?? {};
        const key = `${m.id}|${d.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cc = u.cache_creation ?? {};
        const hasBreakdown = typeof cc.ephemeral_5m_input_tokens === "number" || typeof cc.ephemeral_1h_input_tokens === "number";
        yield {
          date,
          model: String(m.model ?? "unknown"),
          sessionId: String(d.sessionId ?? ""),
          cwd: String(d.cwd ?? ""),
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite5m: hasBreakdown ? cc.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0,
          cacheWrite1h: hasBreakdown ? cc.ephemeral_1h_input_tokens ?? 0 : 0,
        };
      }
    }
  }
}

export async function summarizeClaudeCode(from: string, to: string, dir?: string): Promise<ClaudeCodeSummary> {
  const sessions = new Set<string>();
  const days = new Set<string>();
  const byModel = new Map<string, { usd: number; turns: number; output: number; ctx: number; cacheRead: number }>();
  const daily = new Map<string, UsageEvent>();
  const unknown: Record<string, number> = {};
  let turns = 0;
  let total = 0;
  for await (const t of readClaudeCodeTurns(from, to, dir)) {
    const usd = turnCostUsd(t);
    if (usd === undefined) {
      unknown[t.model] = (unknown[t.model] ?? 0) + 1;
      continue;
    }
    turns++;
    total += usd;
    sessions.add(t.sessionId);
    days.add(t.date);
    const bm = byModel.get(t.model) ?? { usd: 0, turns: 0, output: 0, ctx: 0, cacheRead: 0 };
    bm.usd += usd;
    bm.turns++;
    bm.output += t.output;
    bm.ctx += t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
    bm.cacheRead += t.cacheRead;
    byModel.set(t.model, bm);
    const k = `${t.date}|${t.model}`;
    const e =
      daily.get(k) ??
      ({ providerId: "claude-code", model: t.model, date: t.date, route: "subscription", inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, requests: 0, costUsd: 0, raw: null } as UsageEvent);
    e.inputTokens += t.input + t.cacheWrite5m + t.cacheWrite1h;
    e.outputTokens += t.output;
    e.cachedTokens += t.cacheRead;
    e.requests += 1;
    e.costUsd += usd;
    daily.set(k, e);
  }
  return {
    from,
    to,
    sessions: sessions.size,
    activeDays: days.size,
    turns,
    apiEquivalentUsd: total,
    byModel: [...byModel.entries()]
      .map(([model, b]) => ({ model, usd: b.usd, turns: b.turns, output: b.output, cacheHitRate: b.ctx ? b.cacheRead / b.ctx : 0, share: total ? b.usd / total : 0 }))
      .sort((a, b) => b.usd - a.usd),
    unknownModels: unknown,
    events: [...daily.values()],
  };
}
