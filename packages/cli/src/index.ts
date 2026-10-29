#!/usr/bin/env node
import { Command } from "commander";
import { connect } from "./commands/connect.js";
import { sync } from "./commands/sync.js";
import { disconnect, providers } from "./commands/providers.js";

const program = new Command();
program
  .name("tally")
  .description("One ledger for your AI inference spend, plus the credits and cheaper routes you're not using. Read-only, local.")
  .version("0.0.1");

program
  .command("connect")
  .argument("<provider>", "openrouter (openai, anthropic … in M2)")
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

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
