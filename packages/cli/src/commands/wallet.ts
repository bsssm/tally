import { defaultWindow, isoDate, listProviders, summarizeByProvider, summarizeClaudeCode, replaceUsageEvents, verdict, getProfile, loadDeals, catalogDeals, rankDeals, summarizeByModel, type PlanId } from "@tally/core";
import { ctx } from "../context.js";
import { bold, dim, int, money, ok, table, warn, err } from "../ui.js";

export interface WalletOpts {
  days: number;
  json?: boolean;
  plan?: PlanId;
}

/** The first screen: what you used, what it is worth, what to do. No key needed. */
export async function wallet(opts: WalletOpts): Promise<void> {
  const { db } = await ctx();
  const { from, to } = defaultWindow(opts.days);
  const f = isoDate(from), t = isoDate(to);
  const profile = getProfile(db);
  const plan = (opts.plan ?? profile.plan ?? "api") as PlanId;

  const cc = await summarizeClaudeCode(f, t);
  if (cc.events.length) replaceUsageEvents(db, "claude-code", f, t, cc.events);
  const v = verdict(cc, plan, { creditsClaimed: profile.creditsClaimed });

  const byProvider = summarizeByProvider(db, f, t).filter((p) => p.providerId !== "claude-code");
  const byModel = summarizeByModel(db, f, t, 200);
  const models = new Set(byModel.map((m) => m.model));
  const providers = new Set([...byProvider.map((p) => p.providerId), ...(cc.turns ? ["claude-code", "anthropic"] : [])]);
  const dctx = { profile: { ...profile, plan }, models, providers, today: t };
  const deals = rankDeals([...loadDeals(), ...catalogDeals(db, dctx)], dctx).filter((d) => d.status !== "expired").slice(0, 6);
  const connected = listProviders(db).length;
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ window: { from: f, to: t }, plan, claudeCode: { ...cc, events: undefined }, verdict: v, providers: byProvider, deals }, null, 2));
    return;
  }

  console.log(bold(`tally · ${f} → ${t}`));
  console.log();
  console.log(bold("YOUR AI WALLET"));
  if (cc.turns) {
    console.log(`  Claude Code (local logs)   ${bold(money(cc.apiEquivalentUsd).padStart(10))} API-equivalent   ${int(cc.sessions)} sessions · ${cc.activeDays} days · ${int(cc.turns)} turns`);
    for (const m of cc.byModel.slice(0, 5)) {
      console.log(`    ${m.model.padEnd(26)} ${money(m.usd).padStart(9)}  ${String(Math.round(m.share * 100)).padStart(3)}%   cache hit ${Math.round(m.cacheHitRate * 100)}%`);
    }
    const unk = Object.keys(cc.unknownModels).filter((k) => k !== "<synthetic>");
    if (unk.length) console.log(dim(`    unpriced models skipped: ${unk.join(", ")}`));
  } else {
    console.log(dim("  No Claude Code logs found in ~/.claude/projects."));
  }
  for (const p of byProvider) {
    console.log(`  ${p.providerId.padEnd(26)} ${bold(money(p.costUsd).padStart(10))} billed            ${int(p.requests)} requests · ${p.models} models`);
  }
  if (!connected) console.log(dim("  Add API spend: tally connect openrouter"));
  console.log();
  console.log(bold("VERDICT") + dim(`  (${v.planLabel}${opts.plan ? "" : profile.plan ? "" : " assumed; set with tally profile --plan max20"})`));
  console.log(`  ${v.headline}`);
  for (const l of v.levers) console.log(`  ${warn("→")} ${l}`);
  console.log();
  console.log(bold("DEALS") + dim("  (tally deals for all)"));
  if (!deals.length) console.log(dim("  nothing live for your mix"));
  for (const d of deals) {
    const tag = d.status === "expiring" ? err(`ends ${d.expires}`) : d.status === "upcoming" ? dim(`from ${d.starts}`) : ok("live");
    console.log(`  ${tag.padEnd(28)} ${d.title}  ${dim(`· ${d.because} · ${d.verification}`)}`);
  }
}
