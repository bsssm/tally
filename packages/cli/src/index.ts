#!/usr/bin/env node
import { Command } from "commander";
import { connect } from "./commands/connect.js";
import { sync } from "./commands/sync.js";
import { disconnect, providers } from "./commands/providers.js";
import { wallet } from "./commands/wallet.js";
import { deals } from "./commands/deals.js";
import { profile } from "./commands/profile.js";
import { routeCommand } from "./commands/route.js";
import { pace } from "./commands/pace.js";
import { card } from "./commands/card.js";
import { VERSION } from "./version.js";

const program = new Command();
program
  .name("tally")
  .description("One ledger for your AI inference spend, plus the credits and cheaper routes you're not using. Read-only, local.")
  .version(VERSION);

program
  .command("wallet", { isDefault: true })
  .option("-d, --days <n>", "window in days", (v) => Number(v), 30)
  .option("--plan <plan>", "api | pro | max5 | max20 (overrides profile)")
  .option("--json", "machine-readable output")
  .description("your AI wallet: local Claude Code usage priced at API rates, connected providers, a verdict, and live deals")
  .action((opts) => wallet(opts));

program
  .command("deals")
  .option("--all", "include expired")
  .option("--json")
  .description("credits, free models, promo pricing and price changes, ranked for your mix")
  .action((opts) => deals(opts));

program
  .command("profile")
  .option("--plan <plan>", "api | pro | max5 | max20")
  .option("--credits-claimed", "mark the monthly API credits as claimed")
  .option("--json")
  .description("the four questions the verdict and credit matching need")
  .action((opts) => profile(opts));

program
  .command("connect")
  .argument("<provider>", "openrouter | anthropic | openai (anthropic --admin stores an Admin API key for reconciliation)")
  .option("--admin", "the key is an admin / management key")
  .option("--key <key>", "pass the key instead of being prompted (visible in shell history)")
  .option("--key-stdin", "read the key from stdin")
  .description("store a provider key locally, encrypted at rest")
  .action((provider: string, opts) => connect(provider, opts));

program
  .command("sync")
  .option("-d, --days <n>", "window in days", (v) => Number(v), 30)
  .option("--only <providers...>", "sync only these providers")
  .option("--no-prices", "skip the price catalog refresh")
  .option("--json", "machine-readable output")
  .description("pull usage and spend from every connected provider")
  .action((opts) => sync(opts));

program.command("providers").option("--json").description("list connected providers").action((opts) => providers(opts));
program.command("disconnect").argument("<provider>").description("remove a provider and its rows").action((id: string) => disconnect(id));
program.addCommand(routeCommand());

program
  .command("pace")
  .argument("[action]", "status (default) | install | uninstall")
  .option("--settings <path>", "settings.json to write (default ~/.claude/settings.json)")
  .option("--json")
  .description("Claude Code 5-hour window gauge: burn in API dollars and % of the window; install writes the status line + hook, never over an existing one")
  .action((action: string | undefined, opts) => pace(action, opts));

program
  .command("card")
  .option("-d, --days <n>", "window in days", (v) => Number(v), 30)
  .option("--square", "1080x1080 instead of 1200x675")
  .option("--dark", "dark variant")
  .option("--out <path>", "where to write the SVG (default ~/.tally/cards/tally-YYYY-MM.svg)")
  .option("--png", "also write a PNG next to it (rsvg-convert, Chrome or sips, whichever is installed)")
  .option("--open", "open the file when written")
  .option("--redact-models", "show vendor families instead of model names")
  .option("--plan <plan>", "api | pro | max5 | max20 (overrides profile)")
  .description("monthly share card of your wallet as an SVG (or PNG): totals and model names only, nothing private")
  .action((opts) => card(opts));

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  const hint = e && typeof e === "object" && "hint" in e ? (e as { hint?: string }).hint : undefined;
  if (hint) console.error(hint);
  process.exit(1);
});
