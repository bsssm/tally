// Makes the CLI package self-contained for publishing: copies the core's data folder
// (deals.json, anthropic-prices.json) plus the root README.md and LICENSE into packages/cli.
// Runs after tsup; the copies are gitignored. See tsup.config.ts for the dist layout.
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(pkg, "..", "..");

const dataSrc = join(repo, "packages", "core", "data");
const dataDst = join(pkg, "data");
rmSync(dataDst, { recursive: true, force: true });
mkdirSync(dataDst, { recursive: true });
cpSync(dataSrc, dataDst, { recursive: true });

for (const f of ["README.md", "LICENSE"]) copyFileSync(join(repo, f), join(pkg, f));

// The Claude Code plugin's scripts (node built-ins only) so `tally pace` works from the npm package.
const pluginSrc = join(repo, "packages", "claude-code-plugin", "scripts");
const pluginDst = join(pkg, "plugin", "scripts");
rmSync(join(pkg, "plugin"), { recursive: true, force: true });
mkdirSync(pluginDst, { recursive: true });
cpSync(pluginSrc, pluginDst, { recursive: true, filter: (p) => !p.endsWith(".test.cjs") });
console.log(`copied data/, plugin/scripts/, README.md, LICENSE into ${pkg}`);
