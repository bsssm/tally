import {
  defaultWindow, isoDate, listProviders, summarizeByModel, summarizeByProvider, syncProviders,
} from "@tally/core";
import { ctx } from "../context.js";
import { bold, dim, err, int, money, ok, table, tokens, warn } from "../ui.js";

export interface SyncOpts {
  days: number;
  json?: boolean;
  only?: string[];
  prices?: boolean;
}

export async function sync(opts: SyncOpts): Promise<void> {
  const { db, keystore } = await ctx();
  if (listProviders(db).length === 0) {
    console.error(warn("No providers connected. Start with: ") + bold("tally connect openrouter"));
    db.close();
    process.exit(1);
  }
  const { from, to } = defaultWindow(opts.days);
  const reports = await syncProviders(db, keystore, { from, to, only: opts.only, prices: opts.prices });
  const byProvider = summarizeByProvider(db, isoDate(from), isoDate(to));
  const byModel = summarizeByModel(db, isoDate(from), isoDate(to), 15);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify({ window: { from: isoDate(from), to: isoDate(to) }, reports, byProvider, byModel }, null, 2));
    process.exit(reports.some((r) => r.status === "error") ? 1 : 0);
  }

  console.log(dim(`Window: ${isoDate(from)} → ${isoDate(to)} (UTC, ${opts.days} days)`));
  console.log();
  console.log(
    table(
      ["Provider", "Spend", "Requests", "Input tok", "Output tok", "Models", "Sync"],
      reports.map((r) => {
        const s = byProvider.find((b) => b.providerId === r.providerId);
        return [
          r.providerId,
          money(s?.costUsd ?? 0),
          int(s?.requests ?? 0),
          tokens(s?.inputTokens ?? 0),
          tokens(s?.outputTokens ?? 0),
          int(s?.models ?? 0),
          r.status === "ok" ? ok(`${r.rows} rows`) : err("failed"),
        ];
      }),
      { right: [1, 2, 3, 4, 5] },
    ),
  );
  const total = byProvider.reduce((s, b) => s + b.costUsd, 0);
  console.log(`${bold("Total")} ${money(total)} across ${reports.length} provider${reports.length === 1 ? "" : "s"}`);

  if (byModel.length) {
    console.log();
    console.log(
      table(
        ["Model", "Provider", "Spend", "Requests", "Input tok", "Output tok"],
        byModel.map((m) => [m.model, m.providerId, money(m.costUsd), int(m.requests), tokens(m.inputTokens), tokens(m.outputTokens)]),
        { right: [2, 3, 4, 5] },
      ),
    );
  }

  let failed = false;
  for (const r of reports) {
    for (const n of r.notes) console.log(`${warn("note")} ${r.providerId}: ${n}`);
    if (r.error) {
      failed = true;
      console.error(`${err("error")} ${r.providerId}: ${r.error}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
