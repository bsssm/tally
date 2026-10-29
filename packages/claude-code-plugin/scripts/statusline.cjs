#!/usr/bin/env node
// Claude Code status line: `node statusline.cjs` with the session JSON on stdin. Prints one line, never throws.
// When stdin carries `rate_limits.five_hour` (Pro/Max subscribers) that percentage is used as-is and the
// local dollar scan is calibrated against it; otherwise the local estimate stands in.
"use strict";
const { readFileSync } = require("node:fs");
const { paceStatus, readCache, readConfig, renderLine, writeCache } = require("./pace.cjs");

let line = "tally n/a";
try {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {}
  const cache = readCache();
  const s = paceStatus({ config: readConfig(), cache, rateLimits: input.rate_limits });
  writeCache(cache);
  line = renderLine(s, { color: !process.env.NO_COLOR });
} catch {}
process.stdout.write(line + "\n");
