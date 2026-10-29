import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UsageEvent } from "../types.js";
import type { LocalAgentSummary, LocalSource, LocalTurn } from "./types.js";

/** Longest-prefix lookup: "gpt-5.5-pro" wins over "gpt-5.5" when both are keys. */
export function longestPrefixMatch<T>(table: Record<string, T>, model: string): T | undefined {
  let best: string | undefined;
  for (const k of Object.keys(table)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best === undefined ? undefined : table[best];
}

/** Recursively list files under `dir` with one of `exts` (lowercase, with dot). Never throws. */
export function walkFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (exts.some((e) => n.toLowerCase().endsWith(e))) out.push(p);
    }
  }
  return out.sort();
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** Fold priced turns into the summary shape every reader returns. `price` returns undefined for an unknown model. */
export function aggregateTurns(
  source: LocalSource,
  from: string,
  to: string,
  turns: Iterable<LocalTurn>,
  price: (t: LocalTurn) => number | undefined,
  meta: { detected: boolean; path: string; notes: string[] },
): LocalAgentSummary {
  const sessions = new Set<string>();
  const days = new Set<string>();
  const byModel = new Map<string, { usd: number; turns: number; output: number; ctx: number; cacheRead: number }>();
  const daily = new Map<string, UsageEvent>();
  const unknown: Record<string, number> = {};
  let n = 0;
  let total = 0;
  for (const t of turns) {
    if (t.date < from || t.date > to) continue;
    const usd = price(t);
    if (usd === undefined) {
      unknown[t.model] = (unknown[t.model] ?? 0) + 1;
      continue;
    }
    n++;
    total += usd;
    sessions.add(t.sessionId);
    days.add(t.date);
    const bm = byModel.get(t.model) ?? { usd: 0, turns: 0, output: 0, ctx: 0, cacheRead: 0 };
    bm.usd += usd;
    bm.turns++;
    bm.output += t.output;
    bm.ctx += t.input + t.cacheRead + t.cacheWrite;
    bm.cacheRead += t.cacheRead;
    byModel.set(t.model, bm);
    const k = `${t.date}|${t.model}`;
    const e =
      daily.get(k) ??
      ({ providerId: source, model: t.model, date: t.date, route: "subscription", inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, requests: 0, costUsd: 0, raw: null } as UsageEvent);
    e.inputTokens += t.input + t.cacheWrite;
    e.outputTokens += t.output;
    e.cachedTokens += t.cacheRead;
    e.reasoningTokens += t.reasoning;
    e.requests += 1;
    e.costUsd += usd;
    daily.set(k, e);
  }
  return {
    source,
    detected: meta.detected,
    path: meta.path,
    notes: meta.notes,
    from,
    to,
    sessions: sessions.size,
    activeDays: days.size,
    turns: n,
    apiEquivalentUsd: total,
    byModel: [...byModel.entries()]
      .map(([model, b]) => ({ model, usd: b.usd, turns: b.turns, output: b.output, cacheHitRate: b.ctx ? b.cacheRead / b.ctx : 0, share: total ? b.usd / total : 0 }))
      .sort((a, b) => b.usd - a.usd),
    unknownModels: unknown,
    events: [...daily.values()],
  };
}

/** A summary for a tool that was looked for and not found (or failed to read). */
export function emptySummary(source: LocalSource, from: string, to: string, path: string, notes: string[], detected = false): LocalAgentSummary {
  return aggregateTurns(source, from, to, [], () => undefined, { detected, path, notes });
}
