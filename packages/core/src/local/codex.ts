import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import type { LocalAgentSummary, LocalTurn } from "./types.js";
import { aggregateTurns, longestPrefixMatch, num, walkFiles } from "./shared.js";

const require = createRequire(import.meta.url);

interface OpenAIPrice {
  input: number;
  cached_input: number;
  output: number;
  long_context?: { input: number; cached_input: number; output: number };
  verified: boolean;
}
const PRICES = require("../../data/openai-prices.json") as {
  as_of: string;
  long_context_threshold: number;
  service_tiers: Record<string, number>;
  models: Record<string, OpenAIPrice>;
  codex_auto_review_fallbacks: { timeline: { from: string; model: string }[] };
};

/**
 * OpenAI Codex CLI keeps one JSONL "rollout" per thread under $CODEX_HOME/sessions/YYYY/MM/DD/ (and
 * archived_sessions/). Usage arrives as `event_msg` lines whose payload.type is `token_count`:
 * `payload.info.last_token_usage` is the turn delta, `payload.info.total_token_usage` the running total.
 * The model lives on the preceding `turn_context` line. See FORMATS.md for what is and is not handled.
 */

export function codexHome(home = homedir()): string {
  return process.env.CODEX_HOME || join(home, ".codex");
}

export function openaiPriceFor(model: string): OpenAIPrice | undefined {
  return longestPrefixMatch(PRICES.models, model);
}

export function openaiPricesAsOf(): string {
  return PRICES.as_of;
}

/** `codex-auto-review` is server-routed; the log never says which model answered. Estimate by date. */
export function resolveCodexAlias(model: string, date: string): { model: string; fallback: boolean } {
  if (model !== "codex-auto-review") return { model, fallback: false };
  for (const t of PRICES.codex_auto_review_fallbacks.timeline) if (date >= t.from) return { model: t.model, fallback: true };
  return { model: "gpt-5", fallback: true };
}

export function codexTurnCostUsd(t: LocalTurn): number | undefined {
  const p = openaiPriceFor(t.model);
  if (!p) return undefined;
  const totalInput = t.input + t.cacheRead;
  const r = p.long_context && totalInput > PRICES.long_context_threshold ? p.long_context : p;
  const base = (t.input * r.input + t.cacheRead * r.cached_input + t.output * r.output) / 1e6;
  return base * (t.tierMultiplier ?? 1);
}

interface RawUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

function rawUsage(u: any): RawUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  return {
    input_tokens: num(u.input_tokens),
    cached_input_tokens: num(u.cached_input_tokens),
    output_tokens: num(u.output_tokens),
    reasoning_output_tokens: num(u.reasoning_output_tokens),
  };
}

function subtract(a: RawUsage, b: RawUsage | undefined): RawUsage {
  if (!b) return a;
  return {
    input_tokens: Math.max(0, a.input_tokens - b.input_tokens),
    cached_input_tokens: Math.max(0, a.cached_input_tokens - b.cached_input_tokens),
    output_tokens: Math.max(0, a.output_tokens - b.output_tokens),
    reasoning_output_tokens: Math.max(0, a.reasoning_output_tokens - b.reasoning_output_tokens),
  };
}

function sameUsage(a: RawUsage, b: RawUsage | undefined): boolean {
  return !!b && a.input_tokens === b.input_tokens && a.cached_input_tokens === b.cached_input_tokens && a.output_tokens === b.output_tokens && a.reasoning_output_tokens === b.reasoning_output_tokens;
}

function tierMultiplier(tier: unknown): number | undefined {
  if (typeof tier !== "string") return undefined;
  const m = PRICES.service_tiers[tier.toLowerCase()];
  return typeof m === "number" ? m : undefined;
}

/** Stream one rollout file into turns. `seen` dedupes replayed history across forked/subagent rollouts. */
async function readRollout(file: string, seen: Set<string>): Promise<LocalTurn[]> {
  const turns: LocalTurn[] = [];
  let sessionId = basename(file).replace(/\.jsonl$/i, "");
  let model: string | undefined;
  let tier: number | undefined;
  let prevTotal: RawUsage | undefined;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
    const p = d.payload;
    if (d.type === "session_meta") {
      if (typeof p?.id === "string" && p.id) sessionId = p.id;
      continue;
    }
    if (d.type === "turn_context") {
      if (typeof p?.model === "string" && p.model) model = p.model;
      continue;
    }
    if (d.type !== "event_msg" || !p || typeof p !== "object") continue;
    if (p.type === "thread_settings_applied") {
      const st = p.thread_settings;
      if (st && typeof st === "object" && "service_tier" in st) tier = tierMultiplier(st.service_tier);
      continue;
    }
    if (p.type !== "token_count") continue;
    const info = p.info;
    if (!info || typeof info !== "object") continue;
    const total = rawUsage(info.total_token_usage);
    const last = rawUsage(info.last_token_usage);
    const advanced = !total || !sameUsage(total, prevTotal);
    let delta: RawUsage | undefined;
    if (last && advanced) delta = last;
    else if (total) delta = subtract(total, prevTotal);
    if (total) prevTotal = total;
    if (!delta) continue;
    const cached = Math.min(delta.cached_input_tokens, delta.input_tokens);
    if (delta.input_tokens === 0 && delta.output_tokens === 0) continue;
    const ts = typeof d.timestamp === "string" ? d.timestamp : "";
    const date = ts.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // Forked and subagent rollouts replay the parent's history verbatim: same timestamp, same counts.
    const key = `${ts}|${delta.input_tokens}|${cached}|${delta.output_tokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = model ?? (typeof info.model === "string" ? info.model : undefined);
    const resolved = raw ? resolveCodexAlias(raw, date) : { model: "gpt-5", fallback: true };
    turns.push({
      date,
      model: resolved.model,
      sessionId,
      input: delta.input_tokens - cached,
      output: delta.output_tokens,
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: delta.reasoning_output_tokens,
      tierMultiplier: tier,
      fallbackModel: resolved.fallback,
    });
  }
  return turns;
}

export async function* readCodexTurns(dir = codexHome()): AsyncGenerator<LocalTurn> {
  const seen = new Set<string>();
  for (const sub of ["sessions", "archived_sessions"]) {
    for (const f of walkFiles(join(dir, sub), [".jsonl"])) {
      let turns: LocalTurn[];
      try {
        turns = await readRollout(f, seen);
      } catch {
        continue;
      }
      yield* turns;
    }
  }
}

export async function summarizeCodex(from: string, to: string, dir = codexHome()): Promise<LocalAgentSummary> {
  const notes: string[] = [];
  const detected = existsSync(dir);
  const sessionsDir = join(dir, "sessions");
  const zst = detected ? walkFiles(sessionsDir, [".jsonl.zst"]).length + walkFiles(join(dir, "archived_sessions"), [".jsonl.zst"]).length : 0;
  if (zst) notes.push(`${zst} Zstandard-compressed rollout(s) skipped (.jsonl.zst not supported yet).`);
  const turns: LocalTurn[] = [];
  let fallback = 0;
  let unverified = new Set<string>();
  if (detected) {
    for await (const t of readCodexTurns(dir)) {
      if (t.fallbackModel) fallback++;
      const p = openaiPriceFor(t.model);
      if (p && !p.verified) unverified.add(t.model);
      turns.push(t);
    }
  }
  if (fallback) notes.push(`${fallback} turn(s) had no model in the log and were priced as a best guess (gpt-5 or the codex-auto-review timeline).`);
  if (unverified.size) notes.push(`Prices for ${[...unverified].sort().join(", ")} are not on OpenAI's pricing page; taken from a models.dev snapshot.`);
  notes.push("Compaction usage (token_usage_record) is not counted; Standard-tier prices unless the rollout recorded fast/flex.");
  return aggregateTurns("codex", from, to, turns, codexTurnCostUsd, { detected, path: sessionsDir, notes });
}
