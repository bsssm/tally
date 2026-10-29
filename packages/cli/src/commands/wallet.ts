import { rankDeals, type PlanId, type LocalAgentSummary } from "@tally/core";
import { gatherWallet, LABEL } from "../wallet-data.js";
import { bold, dim, int, money, ok, warn, err } from "../ui.js";

export interface WalletOpts {
  days: number;
  json?: boolean;
  plan?: PlanId;
}

/** The first screen: what you used, what it is worth, what to do. No key needed. */
export async function wallet(opts: WalletOpts): Promise<void> {
  const { from: f, to: t, plan, profile, cc, local, verdict: v, byProvider, deals, connected } = await gatherWallet({ days: opts.days, plan: opts.plan });

  if (!cc.turns && !local.turns && !byProvider.length && !opts.json) {
    emptyState(f, t, plan, profile.plan, deals, local.sources);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ window: { from: f, to: t }, plan, claudeCode: { ...cc, events: undefined }, local: local.sources.map((s) => ({ ...s, events: undefined })), verdict: v, providers: byProvider, deals }, null, 2));
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
  for (const s of local.sources) {
    if (s.turns) {
      console.log(`  ${LABEL[s.source].padEnd(26)} ${bold(money(s.apiEquivalentUsd).padStart(10))} API-equivalent   ${int(s.sessions)} sessions · ${s.activeDays} days · ${int(s.turns)} turns`);
      for (const m of s.byModel.slice(0, 3)) console.log(`    ${m.model.padEnd(26)} ${money(m.usd).padStart(9)}  ${String(Math.round(m.share * 100)).padStart(3)}%   cache hit ${Math.round(m.cacheHitRate * 100)}%`);
      const unk = Object.keys(s.unknownModels);
      if (unk.length) console.log(dim(`    unpriced models skipped: ${unk.join(", ")}`));
    } else if (s.detected) {
      console.log(dim(`  ${LABEL[s.source].padEnd(26)} detected, nothing priced in this window${s.notes[0] ? ` · ${s.notes[0]}` : ""}`));
    }
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

/** Nothing local, nothing connected: say what was looked for and the two next steps. Short, exit 0. */
function emptyState(f: string, t: string, plan: PlanId, savedPlan: PlanId | null | undefined, deals: ReturnType<typeof rankDeals>, local: LocalAgentSummary[]): void {
  console.log(bold(`tally · ${f} → ${t}`));
  console.log();
  console.log(bold("YOUR AI WALLET") + dim("  (empty)"));
  console.log(`  Looked for Claude Code logs in ${dim(claudeProjectsDir())}: none found.`);
  const others = local.map((s) => `${LABEL[s.source].replace(/ \(.*\)$/, "")} (${dim(tilde(s.path))})`).join(", ");
  console.log(`  Also looked for ${others || "Codex, Cursor and Gemini CLI"}: none found.`);
  console.log("  No provider connected.");
  console.log();
  console.log(bold("NEXT"));
  console.log(`  ${warn("→")} ${bold("tally connect openrouter")}   add API spend (key stays on this machine, encrypted)`);
  console.log(`  ${warn("→")} ${bold("tally profile --plan max20")}  tell the verdict how you pay Anthropic${savedPlan ? "" : dim(` (assumed: ${plan})`)}`);
  if (deals.length) {
    console.log();
    console.log(bold("DEALS") + dim("  (tally deals for all)"));
    for (const d of deals.slice(0, 3)) console.log(`  ${ok("live").padEnd(28)} ${d.title}  ${dim(`· ${d.verification}`)}`);
  }
}

function tilde(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ? `${process.env.CLAUDE_CONFIG_DIR}/projects` : "~/.claude/projects";
  return base;
}
