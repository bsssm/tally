import { defaultWindow, isoDate, summarizeByModel, summarizeByProvider, getProfile, loadDeals, catalogDeals, rankDeals } from "@tally/core";
import { ctx } from "../context.js";
import { bold, dim, err, ok, warn } from "../ui.js";

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
  db.close();
  const shown = opts.all ? ranked : ranked.filter((d) => d.status !== "expired");
  if (opts.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  for (const d of shown) {
    const tag = d.status === "expired" ? dim("missed") : d.status === "expiring" ? err(`ends ${d.expires}`) : d.status === "upcoming" ? dim(`from ${d.starts}`) : ok("live");
    console.log(`${tag.padEnd(26)} ${bold(d.title)}`);
    console.log(`${"".padEnd(14)}${d.detail}`);
    console.log(`${"".padEnd(14)}${dim(`${d.because} · ${d.verification} · ${d.url}`)}`);
    if (d.data_terms) console.log(`${"".padEnd(14)}${warn("data:")} ${dim(d.data_terms)}`);
    console.log();
  }
  if (!opts.all) console.log(dim(`${ranked.length - shown.length} expired hidden · tally deals --all`));
}
