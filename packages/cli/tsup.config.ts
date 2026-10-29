import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * One ESM file at dist/bin/index.js with @tally/core inlined. better-sqlite3 is native and stays a
 * runtime dependency. The core reads data/*.json relative to its own file, so the bundle sits two
 * levels below the package root and `data/` is copied there by scripts/copy-data.mjs.
 */
export default defineConfig({
  entry: { "bin/index": "src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  noExternal: ["@tally/core", "@tally/router"],
  external: ["better-sqlite3"],
  outExtension: () => ({ js: ".js" }),
  define: { __TALLY_VERSION__: JSON.stringify(version) },
  onSuccess: "chmod +x dist/bin/index.js",
});
