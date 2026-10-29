import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import type { LocalAgentSummary, LocalTurn } from "./types.js";
import { aggregateTurns, longestPrefixMatch, num, walkFiles } from "./shared.js";

const require = createRequire(import.meta.url);

interface GooglePrice {
  input: number;
  output: number;
  cache_read: number;
  long_context?: { threshold: number; input: number; output: number; cache_read: number };
  verified: boolean;
}
const PRICES = require("../../data/google-prices.json") as { as_of: string; models: Record<string, GooglePrice> };

/**
 * Gemini CLI records every chat under $GEMINI_DATA_DIR/tmp/<projectHash>/chats/session-<time>-<id>.jsonl
 * (older builds: .json with a top-level `messages` array). A `gemini` message carries
 * `tokens: {input, output, cached, thoughts, tool, total}` straight from the API's usageMetadata
 * (promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount, toolUsePromptTokenCount).
 * `input` already includes the cached part; thinking bills at the output rate.
 */

export function geminiDataDir(home = homedir()): string {
  return process.env.GEMINI_DATA_DIR || join(home, ".gemini");
}

export function googlePriceFor(model: string): GooglePrice | undefined {
  return longestPrefixMatch(PRICES.models, model);
}

export function googlePricesAsOf(): string {
  return PRICES.as_of;
}

export function geminiTurnCostUsd(t: LocalTurn): number | undefined {
  const p = googlePriceFor(t.model);
  if (!p) return undefined;
  const totalInput = t.input + t.cacheRead;
  const r = p.long_context && totalInput > p.long_context.threshold ? p.long_context : p;
  return (t.input * r.input + t.cacheRead * r.cache_read + t.output * r.output) / 1e6;
}

function turnFromMessage(m: any, sessionId: string, modelHint?: string): LocalTurn | undefined {
  if (!m || typeof m !== "object" || m.type !== "gemini") return undefined;
  const tk = m.tokens;
  if (!tk || typeof tk !== "object") return undefined;
  const input = num(tk.input);
  const cached = Math.min(num(tk.cached), input);
  const output = num(tk.output);
  const thoughts = num(tk.thoughts);
  const tool = num(tk.tool);
  if (input + output + thoughts === 0) return undefined;
  const ts = typeof m.timestamp === "string" ? m.timestamp : "";
  const date = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const model = typeof m.model === "string" && m.model ? m.model : modelHint;
  if (!model) return undefined;
  return { date, model, sessionId, input: input - cached + tool, output: output + thoughts, cacheRead: cached, cacheWrite: 0, reasoning: thoughts };
}

/** Parse one chat file (.json or .jsonl). Never throws; a malformed file yields nothing. */
export function readGeminiChatFile(file: string): LocalTurn[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let sessionId = basename(file).replace(/\.jsonl?$/i, "");
  if (file.toLowerCase().endsWith(".json")) {
    let doc: any;
    try {
      doc = JSON.parse(text);
    } catch {
      return [];
    }
    if (typeof doc?.sessionId === "string" && doc.sessionId) sessionId = doc.sessionId;
    const msgs: any[] = Array.isArray(doc?.messages) ? doc.messages : [];
    return msgs.map((m) => turnFromMessage(m, sessionId)).filter((t): t is LocalTurn => !!t);
  }
  // JSONL: line 1 is metadata; `$set` / `$patch` / `$rewindTo` are control records; message ids can repeat (later wins).
  const byId = new Map<string, LocalTurn>();
  const anon: LocalTurn[] = [];
  let model: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== "object") continue;
    if (typeof d.sessionId === "string" && d.sessionId && !("type" in d)) sessionId = d.sessionId;
    if (typeof d.model === "string" && d.model) model = d.model;
    if ("$set" in d || "$patch" in d || "$rewindTo" in d) continue;
    const t = turnFromMessage(d, sessionId, model);
    if (!t) continue;
    if (typeof d.id === "string" && d.id) byId.set(d.id, t);
    else anon.push(t);
  }
  return [...byId.values(), ...anon];
}

export function* readGeminiTurns(dir = geminiDataDir()): Generator<LocalTurn> {
  for (const f of walkFiles(join(dir, "tmp"), [".json", ".jsonl"])) {
    // Only chat recordings; tmp/ also holds checkpoints and shell output.
    if (!f.includes(`${join("chats")}/`) && !f.includes("/chats/")) continue;
    yield* readGeminiChatFile(f);
  }
}

export async function summarizeGemini(from: string, to: string, dir = geminiDataDir()): Promise<LocalAgentSummary> {
  const tmp = join(dir, "tmp");
  const detected = existsSync(dir);
  const notes: string[] = [];
  const turns: LocalTurn[] = [];
  const unverified = new Set<string>();
  if (detected) {
    for (const t of readGeminiTurns(dir)) {
      const p = googlePriceFor(t.model);
      if (p && !p.verified) unverified.add(t.model);
      turns.push(t);
    }
  }
  if (detected && !existsSync(tmp)) notes.push(`${dir} exists but has no tmp/ chat recordings (Antigravity data is not read).`);
  if (unverified.size) notes.push(`Prices for ${[...unverified].sort().join(", ")} are not on Google's pricing page; taken from a models.dev snapshot.`);
  notes.push("Priced at paid-tier Standard rates; Gemini CLI on a Google-account free tier bills $0 in real dollars.");
  return aggregateTurns("gemini", from, to, turns, geminiTurnCostUsd, { detected, path: tmp, notes });
}
