// Guard: refuse to pack a tarball that is missing the bundle or the data files.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const need = ["dist/bin/index.js", "data/deals.json", "data/anthropic-prices.json", "plugin/scripts/pace.cjs", "plugin/scripts/statusline.cjs", "plugin/scripts/hook.cjs", "README.md", "LICENSE"];
const missing = need.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error(`prepack: run \`pnpm build\` first; missing ${missing.join(", ")}`);
  process.exit(1);
}
