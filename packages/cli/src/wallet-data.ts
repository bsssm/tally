import {
  defaultWindow, isoDate, listProviders, summarizeByProvider, summarizeClaudeCode, summarizeLocalAgents, replaceUsageEvents, verdict, getProfile, loadDeals, catalogDeals, rankDeals, summarizeByModel,
  type PlanId, type LocalAgentSummary, type ClaudeCodeSummary, type LocalAgentsSummary, type Verdict, type Profile,
} from "@tally/core";
import { ctx } from "./context.js";

export const LABEL: Record<LocalAgentSummary["source"], string> = { "claude-code": "Claude Code (local logs)", codex: "Codex CLI (local logs)", cursor: "Cursor (local db)", gemini: "Gemini CLI (local logs)" };
export const VENDOR: Record<LocalAgentSummary["source"], string> = { "claude-code": "anthropic", codex: "openai", cursor: "cursor", gemini: "google" };
const LOCAL = new Set<string>(["claude-code", "codex", "cursor", "gemini"]);

export interface WalletData {
  from: string;
  to: string;
  plan: PlanId;
  profile: Profile;
  cc: ClaudeCodeSummary;
  local: LocalAgentsSummary;
  verdict: Verdict;
  byProvider: ReturnType<typeof summarizeByProvider>;
  deals: ReturnType<typeof rankDeals>;
  connected: number;
}

/**
 * Everything the wallet screen, its JSON and the share card are built from: local agent logs priced
 * at API rates (and written to the local db), connected-provider spend, the verdict and ranked deals.
 * Opens and closes the db itself. No key, no prompt.
 */
export async function gatherWallet(opts: { days: number; plan?: PlanId }): Promise<WalletData> {
  const { db } = await ctx();
  const { from, to } = defaultWindow(opts.days);
  const f = isoDate(from), t = isoDate(to);
  const profile = getProfile(db);
  const plan = (opts.plan ?? profile.plan ?? "api") as PlanId;

  const cc = await summarizeClaudeCode(f, t);
  if (cc.events.length) replaceUsageEvents(db, "claude-code", f, t, cc.events);
  const local = await summarizeLocalAgents(f, t, { sources: ["codex", "cursor", "gemini"] });
  for (const s of local.sources) if (s.events.length) replaceUsageEvents(db, s.source, f, t, s.events);
  const v = verdict(cc, plan, { creditsClaimed: profile.creditsClaimed });

  const byProvider = summarizeByProvider(db, f, t).filter((p) => !LOCAL.has(p.providerId));
  const byModel = summarizeByModel(db, f, t, 200);
  const models = new Set(byModel.map((m) => m.model));
  const providers = new Set([
    ...byProvider.map((p) => p.providerId),
    ...(cc.turns ? ["claude-code", "anthropic"] : []),
    ...local.sources.filter((s) => s.turns).flatMap((s) => [s.source, VENDOR[s.source]]),
  ]);
  const dctx = { profile: { ...profile, plan }, models, providers, today: t };
  const deals = rankDeals([...loadDeals(), ...catalogDeals(db, dctx)], dctx).filter((d) => d.status !== "expired").slice(0, 6);
  const connected = listProviders(db).length;
  db.close();

  return { from: f, to: t, plan, profile, cc, local, verdict: v, byProvider, deals, connected };
}
