#!/usr/bin/env node
// UserPromptSubmit hook. Past the window threshold it injects a short additionalContext asking the model to
// spend less per turn; once the window eases it injects a one-time "normal effort again" note. Never blocks.
// In `mode: "switch"` it also writes `effortLevel` into ~/.claude/settings.json, which Claude Code reads at
// the next session start only (see RESEARCH.md); the nudge still carries the current session.
"use strict";
const { readFileSync } = require("node:fs");
const { applySwitch, easedText, nudgeText, paceStatus, readCache, readConfig, writeCache } = require("./pace.cjs");

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

try {
  try {
    readFileSync(0, "utf8"); // drain stdin; the prompt itself is not needed
  } catch {}
  const config = readConfig();
  const cache = readCache();
  const s = paceStatus({ config, cache });
  const wasActive = Boolean(cache.nudge?.active);
  let context;
  if (s.over && !wasActive) cache.nudge = { active: true, since: Date.now(), pct: s.pct };
  if (s.over) context = nudgeText(s);
  else if (wasActive) {
    cache.nudge = { active: false, since: null, pct: s.pct };
    context = easedText();
  }
  if (config.mode === "switch") {
    try {
      applySwitch(cache, s.over);
    } catch {}
  }
  writeCache(cache);
  if (context) out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
} catch {}
process.exit(0);
