import { Command } from "commander";
import { addCreditPool, listCreditPools, removeCreditPool, summarizeRouteJobs, type Db } from "@tally/core";
import { DEFAULT_PORT, headline, routerStatus, startRouter } from "@tally/router";
import { ctx } from "../context.js";
import { bold, dim, err, int, money, ok, table, tokens, warn } from "../ui.js";

/**
 * `tally route`: the credits router. Non-interactive jobs point at it and it spends expiring
 * credits first, then the cheapest paid route. Everything stays on 127.0.0.1.
 */
export function routeCommand(): Command {
  const route = new Command("route").description("local OpenAI/Anthropic-compatible endpoint that spends expiring credits first, then the cheapest paid route");

  route
    .command("start", { isDefault: true })
    .option("-p, --port <n>", "port on 127.0.0.1", (v) => Number(v), DEFAULT_PORT)
    .option("-q, --quiet", "do not print one line per request")
    .description("start the router (default)")
    .action((opts: { port: number; quiet?: boolean }) => start(opts));

  route
    .command("status")
    .option("--json")
    .description("pools with days left and unused balance, plus the last 20 route events")
    .action((opts: { json?: boolean }) => status(opts));

  route
    .command("jobs")
    .option("-d, --days <n>", "window in days", (v) => Number(v), 30)
    .option("--json")
    .description("route events grouped by job label (X-Tally-Job header or ?job=)")
    .action((opts: { days: number; json?: boolean }) => jobs(opts));

  const pool = route.command("pool").description("declare the credit pools the router may spend");
  pool
    .command("add")
    .argument("<provider>", "anthropic | openai | openrouter")
    .requiredOption("--usd <amount>", "pool size in USD", (v) => Number(v))
    .option("--resets <day>", "day of month the pool refills (1–31)", (v) => Number(v))
    .option("--expires <date>", "YYYY-MM-DD for a one-off pool")
    .option("--label <text>", "a name, e.g. \"Max 20x credits\"")
    .description("add a pool, e.g. tally route pool add anthropic --usd 200 --resets 7")
    .action((provider: string, opts: { usd: number; resets?: number; expires?: string; label?: string }) => poolAdd(provider, opts));
  pool
    .command("rm")
    .argument("<id>", "pool id from `tally route status`", (v) => Number(v))
    .description("remove a pool (its past route events stay)")
    .action((id: number) => poolRm(id));

  return route;
}

async function start(opts: { port: number; quiet?: boolean }): Promise<void> {
  const { db, keystore } = await ctx({ keys: "open" });
  const log = opts.quiet ? undefined : (line: string) => console.error(dim(`${new Date().toISOString().slice(11, 19)} ${line}`));
  const r = await startRouter({ db, keystore, port: opts.port, log });
  const st = r.status();

  console.log(`${ok("Tally router")} listening on ${bold(r.url)} ${dim("(loopback only)")}`);
  console.log();
  if (!st.keys.length) console.log(warn("No provider keys stored. Every call will 503 until you run: tally connect anthropic | openai | openrouter"));
  if (!st.pools.length) console.log(warn("No credit pools declared. Declare one: tally route pool add anthropic --usd 200 --resets 7"));
  for (const h of st.headline) console.log(`  ${h}`);
  if (st.pools.length) console.log(dim(st.adminKey ? "  Spend reconciled hourly from the Anthropic Admin API." : "  Spend is local accounting only (store an admin key with `tally connect anthropic --admin` to reconcile)."));
  console.log();
  console.log(bold("Point a job at it:"));
  console.log(`  OpenAI SDK      ${dim("OPENAI_BASE_URL=")}${r.url}/v1  ${dim("OPENAI_API_KEY=")}tally`);
  console.log(`  Anthropic SDK   ${dim("ANTHROPIC_BASE_URL=")}${r.url}  ${dim("ANTHROPIC_API_KEY=")}tally`);
  console.log(`  claude -p       ${dim("ANTHROPIC_BASE_URL=")}${r.url}  ${dim("ANTHROPIC_AUTH_TOKEN=")}tally  claude -p "..."`);
  console.log(dim(`  Tag a job with the header X-Tally-Job: <name> (or ?job=<name>). Ctrl-C stops the router.`));
  console.log();

  const stop = async () => {
    await r.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => {});
}

async function status(opts: { json?: boolean }): Promise<void> {
  const { db } = await ctx();
  const st = routerStatus(db);
  db.close();
  if (opts.json) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  if (!st.pools.length) {
    console.log(dim("No credit pools declared. Add one: ") + bold("tally route pool add anthropic --usd 200 --resets 7"));
  } else {
    for (const b of st.pools) console.log(bold(headline(b)));
    console.log();
    console.log(
      table(
        ["Id", "Provider", "Label", "Size", "Spent", "Unused", "Period", "Days left", "Accounting"],
        st.pools.map((b) => [
          b.pool.id,
          b.pool.provider,
          b.pool.label ?? "",
          money(b.pool.amount_usd),
          money(b.spentUsd),
          b.expired ? err("expired") : money(b.unusedUsd),
          `${b.periodStart.slice(0, 10)} → ${b.periodEnd ? b.periodEnd.slice(0, 10) : "∞"}`,
          b.daysLeft == null ? "—" : String(b.daysLeft),
          b.accounting === "admin-api" ? ok("admin api") : warn("local"),
        ]),
        { right: [3, 4, 5, 7] },
      ),
    );
    console.log(dim(st.adminKey ? "Spend reconciled from the Anthropic Admin API cost report while the router runs (hourly)." : "Local accounting only: the router prices each call from the ledger catalog. Store an admin key (tally connect anthropic --admin) to reconcile with Anthropic's own report."));
  }
  console.log();
  console.log(dim(`Keys stored: ${st.keys.length ? st.keys.join(", ") : "none"}${st.adminKey ? " + anthropic-admin" : ""}`));
  if (!st.events.length) {
    console.log(dim("No route events yet. Start the router with `tally route` and point a job at it."));
    return;
  }
  console.log();
  console.log(
    table(
      ["When", "Model", "Upstream", "Reason", "Job", "In", "Out", "Est", "Pool", "HTTP"],
      st.events.map((e) => [
        e.ts.slice(5, 16).replace("T", " "),
        e.model,
        e.upstream,
        e.reason.length > 40 ? `${e.reason.slice(0, 39)}…` : e.reason,
        e.job ?? dim("—"),
        tokens(e.input_tokens),
        tokens(e.output_tokens),
        e.est_cost_usd == null ? dim("—") : `$${e.est_cost_usd < 0.01 ? e.est_cost_usd.toFixed(6) : e.est_cost_usd.toFixed(4)}`,
        e.pool_id == null ? dim("—") : ok(`#${e.pool_id}`),
        e.status == null ? "" : e.status >= 200 && e.status < 300 ? ok(String(e.status)) : err(String(e.status)),
      ]),
      { right: [5, 6, 7] },
    ),
  );
}

async function jobs(opts: { days: number; json?: boolean }): Promise<void> {
  const { db } = await ctx();
  const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
  const rows = summarizeRouteJobs(db, since);
  db.close();
  if (opts.json) {
    console.log(JSON.stringify({ since, jobs: rows }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(dim(`No route events in the last ${opts.days} days.`));
    return;
  }
  console.log(dim(`Last ${opts.days} days. "On credits" counts calls that drew on a pool.`));
  console.log(
    table(
      ["Job", "Calls", "On credits", "Models", "In", "Out", "Est spend", "Last"],
      rows.map((j) => [j.job, int(j.requests), int(j.onCredits), int(j.models), tokens(j.inputTokens), tokens(j.outputTokens), money(j.estCostUsd), j.lastTs.slice(5, 16).replace("T", " ")]),
      { right: [1, 2, 3, 4, 5, 6] },
    ),
  );
}

async function poolAdd(provider: string, opts: { usd: number; resets?: number; expires?: string; label?: string }): Promise<void> {
  if (!["anthropic", "openai", "openrouter"].includes(provider)) {
    console.error(err(`Unknown provider "${provider}". Use anthropic, openai or openrouter.`));
    process.exit(1);
  }
  if (!(opts.usd > 0)) {
    console.error(err("--usd must be a positive amount"));
    process.exit(1);
  }
  if (opts.resets != null && (opts.resets < 1 || opts.resets > 31)) {
    console.error(err("--resets must be a day of month, 1–31"));
    process.exit(1);
  }
  if (opts.expires && !/^\d{4}-\d{2}-\d{2}$/.test(opts.expires)) {
    console.error(err("--expires must be YYYY-MM-DD"));
    process.exit(1);
  }
  if (opts.resets != null && opts.expires) {
    console.error(err("Use --resets for a monthly pool or --expires for a one-off pool, not both"));
    process.exit(1);
  }
  const { db } = await ctx();
  const row = addCreditPool(db, { provider, amountUsd: opts.usd, resetsOn: opts.resets ?? null, expires: opts.expires ?? null, label: opts.label ?? null });
  const st = routerStatus(db);
  db.close();
  const b = st.pools.find((p) => p.pool.id === row.id)!;
  console.log(`${ok(`Pool #${row.id} added.`)} ${headline(b)}`);
  if (!st.keys.includes(provider)) console.log(warn(`No ${provider} key stored yet; the router cannot spend this pool until you run: tally connect ${provider}`));
}

async function poolRm(id: number): Promise<void> {
  const { db } = await ctx();
  const removed = removeCreditPool(db, id);
  db.close();
  if (!removed) {
    console.error(err(`No pool #${id}.`));
    process.exit(1);
  }
  console.log(ok(`Pool #${id} removed.`));
}

/** Exposed for the wallet screen: the one-line credit sentence, or null when nothing is declared. */
export function creditSentence(db: Db): string | null {
  const pools = listCreditPools(db);
  if (!pools.length) return null;
  return routerStatus(db).headline.join("; ");
}
