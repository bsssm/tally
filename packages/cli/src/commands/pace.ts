import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * `tally pace`: the Claude Code 5-hour window gauge and its installer. The logic lives in the Claude Code plugin
 * (packages/claude-code-plugin/scripts/pace.cjs, node built-ins only) so the plugin works without the CLI and
 * the CLI never duplicates it. We locate that plugin dir and require it.
 */
function pluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Shipped inside the npm package: <pkg>/plugin/scripts/*.cjs next to <pkg>/dist/bin/index.js (copied at build).
    resolve(here, "../../plugin"),
    process.env.TALLY_PLUGIN_DIR,
    // Monorepo: packages/cli/src/commands → packages/claude-code-plugin.
    resolve(here, "../../../claude-code-plugin"),
  ];
  // A copy installed through `/plugin marketplace add bsssm/tally` (any version).
  try {
    const reg = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "plugins", "installed_plugins.json"), "utf8"));
    for (const [k, v] of Object.entries<any>(reg.plugins ?? {})) if (k === "tally" || k.startsWith("tally@")) for (const inst of v as any[]) candidates.push(inst?.installPath);
  } catch {}
  for (const c of candidates) if (c && existsSync(join(c, "scripts", "pace.cjs"))) return c;
  throw new Error("tally pace: the Claude Code plugin was not found. Set TALLY_PLUGIN_DIR to a checkout of packages/claude-code-plugin, or run `/plugin marketplace add bsssm/tally` in Claude Code.");
}

export async function pace(action: string | undefined, opts: { settings?: string; json?: boolean }): Promise<void> {
  const root = pluginRoot();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib: any = createRequire(import.meta.url)(join(root, "scripts", "pace.cjs"));
  const argv = [action ?? "status"];
  if (opts.settings) argv.push("--settings", opts.settings);
  if (opts.json) argv.push("--json");
  process.exitCode = lib.runCli(argv);
}
