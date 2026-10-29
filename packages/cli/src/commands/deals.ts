import { defaultWindow, isoDate, summarizeByModel, summarizeByProvider, getProfile, loadDeals, catalogDeals, rankDeals, missedDeals, verificationLabel } from "@tally/core";
import { ctx } from "../context.js";
import { bold, dim, err, ok, warn, tokens } from "../ui.js";

export async function deals(opts: { json?: boolean; all?: boolean }): Promise<void> {
  const { db } = await ctx();
  const { from, to } = defaultWindow(30);
  const f = isoDate(from), t = isoDate(to);
  const profile = getProfile(db);
  const byModel = summarizeByModel(db, f, t, 500);
  const providers = new Set(summarizeByProvider(db, f, t).map((p) => p.providerId));
  if (providers.has("claude-code")) providers.add("anthropic");
  const dctx = { profile, models: new Set(byModel.map((m) => m.model)), providers, today: t };
  const ranked = rankDeals([...loadDeals(), ...catalogDeals(db, dctx)], dctx);
  const missed = opts.all ? missedDeals(db, ranked, dctx, 30) : [];
  db.close();
  const shown = opts.all ? ranked : ranked.filter((d) => d.status !== "expired");
  if (opts.json) {
    console.log(JSON.stringify(opts.all ? { deals: shown, missed } : shown, null, 2));
    return;
  }
  for (const d of shown) {
    const tag = d.status === "expired" ? dim("missed") : d.status === "expiring" ? err(`ends ${d.expires}`) : d.status === "upcoming" ? dim(`from ${d.starts}`) : ok("live");
    console.log(`${tag.padEnd(26)} ${bold(d.title)}`);
    console.log(`${"".padEnd(14)}${d.detail}`);
    const ver = d.verification === "verified" ? dim(verificationLabel(d.verification)) : warn(verificationLabel(d.verification));
    console.log(`${"".padEnd(14)}${dim(`${d.because} · `)}${ver}${dim(` · ${d.url}`)}`);
    if (d.data_terms) console.log(`${"".padEnd(14)}${warn("data:")} ${dim(d.data_terms)}`);
    console.log();
  }
  if (opts.all) {
    const total = missed.reduce((s, m) => s + m.missedUsd, 0);
    if (missed.length === 0) {
      console.log(dim("missed: nothing to count. No expired deal in the last 30 days matched a model you ran."));
    } else {
      console.log(`${bold("missed")} ${err(`$${total.toFixed(2)}`)} ${dim("estimated, last 30 days, list price × tokens in each deal's window")}`);
      for (const m of missed) {
        console.log(`${"".padEnd(14)}$${m.missedUsd.toFixed(2).padStart(7)}  ${m.title} ${dim(`· ${m.model} · ${tokens(m.inputTokens + m.outputTokens)} tokens ${m.from}→${m.to}`)}`);
      }
    }
  } else {
    console.log(dim(`${ranked.length - shown.length} expired hidden · tally deals --all`));
  }
}
