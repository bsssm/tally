// Tally pace: the 5-hour window math shared by the statusline, the UserPromptSubmit hook and `tally pace`.
// Node built-ins only, CommonJS on purpose: ESM import of builtins adds tens of ms on Node 20, and the
// statusline budget is 150 ms warm including Node's own boot.
"use strict";
const { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { createRequire } = require("node:module");

const PLUGIN_ROOT = resolve(__dirname, "..");
const WINDOW_MS = 5 * 60 * 60 * 1000;
const KEEP_MS = 48 * 60 * 60 * 1000; // turns older than this are dropped from the cache
const CACHE_VERSION = 1;

// ---------- paths ----------

function tallyHome() {
  return process.env.TALLY_HOME || join(homedir(), ".tally");
}
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
function claudeProjectsDir() {
  return join(claudeHome(), "projects");
}
function cachePath() {
  return join(tallyHome(), "pace-cache.json");
}
function configPath() {
  return join(tallyHome(), "pace.json");
}
function settingsPath() {
  return join(claudeHome(), "settings.json");
}
function installRecordPath() {
  return join(tallyHome(), "pace-install.json");
}

// ---------- prices (same table as @tally/core; the core file wins when it is reachable) ----------

const FALLBACK_PRICES = {
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25, cache_write_5m: 12.5, cache_write_1h: 20 },
  "claude-fable-5": { input: 10, output: 50, cache_read: 1.0, cache_write_5m: 12.5, cache_write_1h: 20 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 },
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
  "claude-opus-4": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 },
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4 },
  "claude-sonnet-4": { input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 },
};
/** Official plan multipliers (Max 5x and Max 20x are stated as multiples of Pro). */
const PLAN_MULTIPLIER = { pro: 1, max5: 5, max20: 20 };

let pricesCache;
function prices() {
  if (pricesCache) return pricesCache;
  // Monorepo: packages/claude-code-plugin → packages/core/data. npm package: <pkg>/plugin → <pkg>/data.
  for (const p of [process.env.TALLY_DATA_DIR && join(process.env.TALLY_DATA_DIR, "anthropic-prices.json"), resolve(PLUGIN_ROOT, "../core/data/anthropic-prices.json"), resolve(PLUGIN_ROOT, "../data/anthropic-prices.json")]) {
    if (!p) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j?.models) return (pricesCache = j.models);
    } catch {}
  }
  return (pricesCache = FALLBACK_PRICES);
}
function priceFor(model) {
  for (const [k, v] of Object.entries(prices())) if (model.startsWith(k)) return v;
  return undefined;
}
function turnUsd(model, u) {
  const p = priceFor(model);
  if (!p) return undefined;
  const cc = u.cache_creation ?? {};
  const hasBreakdown = typeof cc.ephemeral_5m_input_tokens === "number" || typeof cc.ephemeral_1h_input_tokens === "number";
  const w5 = hasBreakdown ? cc.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0;
  const w1 = hasBreakdown ? cc.ephemeral_1h_input_tokens ?? 0 : 0;
  return ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cache_read + w5 * p.cache_write_5m + w1 * p.cache_write_1h) / 1e6;
}

// ---------- config ----------

const DEFAULT_CONFIG = { plan: undefined, budgetUsd: undefined, threshold: 0.8, mode: "nudge", credits: undefined };

function readConfig(path = configPath()) {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------- cache ----------

function readCache(path = cachePath()) {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (c?.version === CACHE_VERSION) return c;
  } catch {}
  return { version: CACHE_VERSION, files: {}, rateLimits: null, calibration: null, nudge: null, switch: null, credits: null };
}

function writeCache(cache, path = cachePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, path);
  } catch {}
}

// ---------- log scan (incremental, keyed by mtime + size, append-aware) ----------

/** Parse `buf` (a chunk of a session .jsonl) into priced turns. Returns { turns: [[tsMs, usd]], consumed, keys }. */
function parseChunk(buf, seen, sinceMs) {
  const turns = [];
  let start = 0;
  let consumed = 0;
  while (true) {
    const nl = buf.indexOf(10, start);
    if (nl === -1) break;
    const line = buf.toString("utf8", start, nl);
    start = nl + 1;
    consumed = start;
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type !== "assistant") continue;
    const ts = Date.parse(d.timestamp ?? "");
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    const m = d.message ?? {};
    const key = `${m.id}|${d.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const usd = turnUsd(String(m.model ?? "unknown"), m.usage ?? {});
    if (usd === undefined) continue;
    turns.push([ts, Math.round(usd * 1e6) / 1e6]);
  }
  return { turns, consumed };
}

function readRange(path, offset, size) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(size - offset);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return got === buf.length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan every session log modified since `sinceMs`, reusing cache.files entries whose mtime+size match and
 * reading only the appended bytes when a file grew. Mutates cache.files. Returns all turns with ts >= sinceMs.
 */
function scanTurns(cache, sinceMs, dir = claudeProjectsDir(), nowMs = Date.now()) {
  const out = [];
  const live = new Set();
  if (!existsSync(dir)) return out;
  let projects = [];
  try {
    projects = readdirSync(dir);
  } catch {
    return out;
  }
  for (const project of projects) {
    const pdir = join(dir, project);
    let files;
    try {
      files = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(pdir, f);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      live.add(path);
      const prev = cache.files[path];
      let entry;
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
        entry = prev;
      } else {
        const append = prev && st.size > prev.size && prev.offset <= st.size;
        const offset = append ? prev.offset : 0;
        const seen = new Set(append ? prev.tail : []);
        let turns = append ? prev.turns.slice() : [];
        try {
          const buf = readRange(path, offset, st.size);
          const r = parseChunk(buf, seen, nowMs - KEEP_MS);
          turns.push(...r.turns);
          entry = { mtime: st.mtimeMs, size: st.size, offset: offset + r.consumed, turns: turns.filter((t) => t[0] >= nowMs - KEEP_MS), tail: [...seen].slice(-64) };
        } catch {
          entry = prev ?? { mtime: st.mtimeMs, size: st.size, offset: 0, turns: [], tail: [] };
        }
        cache.files[path] = entry;
      }
      for (const t of entry.turns) if (t[0] >= sinceMs) out.push(t);
    }
  }
  for (const k of Object.keys(cache.files)) if (!live.has(k)) delete cache.files[k];
  return out;
}

// ---------- window math ----------

function startOfToday(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Window start: from Claude Code's own resets_at when we have a live one, else a rolling 5 hours. */
function windowStart(cache, nowMs = Date.now()) {
  const rl = cache.rateLimits?.five_hour;
  if (rl?.resets_at && rl.resets_at * 1000 > nowMs && rl.resets_at * 1000 - WINDOW_MS <= nowMs) return { startMs: rl.resets_at * 1000 - WINDOW_MS, resetsAtMs: rl.resets_at * 1000, exact: true };
  return { startMs: nowMs - WINDOW_MS, resetsAtMs: undefined, exact: false };
}

function sumSince(turns, sinceMs, untilMs = Infinity) {
  let s = 0;
  for (const t of turns) if (t[0] >= sinceMs && t[0] <= untilMs) s += t[1];
  return s;
}

/** Budget for one 5h window in API-equivalent dollars, with where it came from. */
function budgetFor(config, cache) {
  if (config.budgetUsd > 0) return { usd: config.budgetUsd, source: "config" };
  const cal = cache.calibration;
  if (cal?.budgetUsd > 0) {
    const scale = config.plan && cal.plan && PLAN_MULTIPLIER[config.plan] && PLAN_MULTIPLIER[cal.plan] ? PLAN_MULTIPLIER[config.plan] / PLAN_MULTIPLIER[cal.plan] : 1;
    return { usd: cal.budgetUsd * scale, source: "calibrated" };
  }
  return { usd: undefined, source: "none" };
}

/** Percent of the window used. Claude Code's own number wins; the local estimate is the fallback. */
function windowPercent({ config, cache, windowUsd, nowMs = Date.now() }) {
  const rl = cache.rateLimits?.five_hour;
  if (rl && typeof rl.used_percentage === "number" && rl.resets_at * 1000 > nowMs) return { pct: rl.used_percentage, source: "claude", resetsAtMs: rl.resets_at * 1000 };
  const b = budgetFor(config, cache);
  if (b.usd) return { pct: (windowUsd / b.usd) * 100, source: b.source, budgetUsd: b.usd };
  return { pct: undefined, source: "none" };
}

/** Record a statusline-provided rate_limits object and calibrate the dollar budget from it. */
function recordRateLimits(cache, rateLimits, windowUsd, plan, nowMs = Date.now()) {
  if (!rateLimits || typeof rateLimits !== "object") return;
  cache.rateLimits = { ...rateLimits, observedAt: nowMs };
  const pct = rateLimits.five_hour?.used_percentage;
  if (typeof pct === "number" && pct >= 5 && windowUsd > 0) {
    const implied = windowUsd / (pct / 100);
    const prev = cache.calibration?.budgetUsd;
    cache.calibration = { budgetUsd: prev ? prev * 0.7 + implied * 0.3 : implied, plan: plan ?? cache.calibration?.plan, at: nowMs };
  }
}

function overThreshold(pct, threshold) {
  return typeof pct === "number" && pct >= threshold * 100;
}

// ---------- credits countdown ----------

function daysUntilDayOfMonth(day, nowMs) {
  const now = new Date(nowMs);
  let next = new Date(now.getFullYear(), now.getMonth(), day);
  if (next.getTime() <= now.getTime()) next = new Date(now.getFullYear(), now.getMonth() + 1, day);
  return Math.ceil((next.getTime() - nowMs) / 86400000);
}

/**
 * Credits pool: ~/.tally/tally.db `credit_pools` (read-only, only when better-sqlite3 resolves from the monorepo
 * core package), else `credits` in ~/.tally/pace.json, else nothing. Returns { remainingUsd, daysLeft, label } or null.
 */
function creditsCountdown(config, nowMs = Date.now(), cache) {
  let pool = config.credits && config.credits.poolUsd > 0 ? { amount: config.credits.poolUsd, resetsOn: config.credits.resetsOn, expires: config.credits.expires, spent: config.credits.spentUsd ?? 0, label: config.credits.label } : null;
  if (!pool) {
    const db = join(tallyHome(), "tally.db");
    let mtime;
    try {
      mtime = statSync(db).mtimeMs;
    } catch {}
    // Loading better-sqlite3 costs ~20 ms, so the row is cached until tally.db changes.
    if (mtime && cache?.credits && cache.credits.dbMtime === mtime) pool = cache.credits.pool;
    else if (mtime) {
      try {
        // better-sqlite3 resolves from core in the monorepo, or from the tallywallet package when shipped inside it.
        let Database;
        for (const from of [resolve(PLUGIN_ROOT, "../core/package.json"), resolve(PLUGIN_ROOT, "../package.json")]) {
          try {
            Database = createRequire(from)("better-sqlite3");
            break;
          } catch {}
        }
        if (!Database) throw new Error("better-sqlite3 not reachable");
        const d = new Database(db, { readonly: true, fileMustExist: true });
        try {
          const row = d.prepare("SELECT amount_usd, resets_on, expires, label, reconciled_spent_usd FROM credit_pools WHERE provider = 'anthropic' ORDER BY created_at DESC LIMIT 1").get();
          if (row) pool = { amount: row.amount_usd, resetsOn: row.resets_on, expires: row.expires, spent: row.reconciled_spent_usd ?? 0, label: row.label };
        } finally {
          d.close();
        }
      } catch {}
      if (cache) cache.credits = { dbMtime: mtime, pool };
    }
  }
  if (!pool) return null;
  let daysLeft;
  if (pool.resetsOn >= 1 && pool.resetsOn <= 31) daysLeft = daysUntilDayOfMonth(pool.resetsOn, nowMs);
  else if (pool.expires) daysLeft = Math.ceil((Date.parse(pool.expires) - nowMs) / 86400000);
  return { remainingUsd: Math.max(0, pool.amount - (pool.spent ?? 0)), daysLeft, label: pool.label };
}

// ---------- the one call everything uses ----------

function paceStatus({ config = readConfig(), cache = readCache(), dir = claudeProjectsDir(), nowMs = Date.now(), rateLimits } = {}) {
  const w = windowStart(cache, nowMs);
  const sinceMs = Math.min(w.startMs, startOfToday(nowMs));
  const turns = scanTurns(cache, sinceMs, dir, nowMs);
  const windowUsd = sumSince(turns, w.startMs, nowMs);
  const todayUsd = sumSince(turns, startOfToday(nowMs), nowMs);
  if (rateLimits) recordRateLimits(cache, rateLimits, windowUsd, config.plan, nowMs);
  const pct = windowPercent({ config, cache, windowUsd, nowMs });
  const credits = creditsCountdown(config, nowMs, cache);
  return { windowUsd, todayUsd, pct: pct.pct, pctSource: pct.source, budgetUsd: pct.budgetUsd, resetsAtMs: pct.resetsAtMs ?? w.resetsAtMs, windowExact: w.exact, credits, threshold: config.threshold, over: overThreshold(pct.pct, config.threshold), plan: config.plan, mode: config.mode };
}

// ---------- rendering ----------

const C = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };
function money(n) {
  return n >= 100 ? `$${Math.round(n)}` : n >= 10 ? `$${n.toFixed(1).replace(/\.0$/, "")}` : `$${n.toFixed(2)}`;
}
function renderLine(s, { color = true } = {}) {
  const c = (k, t) => (color ? `${C[k]}${t}${C.reset}` : t);
  const parts = [];
  let win = `5h ${money(s.windowUsd)}`;
  if (typeof s.pct === "number") {
    const tone = s.pct >= s.threshold * 100 ? "red" : s.pct >= s.threshold * 100 * 0.75 ? "yellow" : "green";
    win = `5h ${c(tone, `${Math.round(s.pct)}%`)} ${money(s.windowUsd)}${s.pctSource === "claude" ? "" : "~"}`;
  }
  if (s.resetsAtMs) {
    const mins = Math.max(0, Math.round((s.resetsAtMs - Date.now()) / 60000));
    win += c("dim", ` ↻${mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}` : `${mins}m`}`);
  }
  parts.push(win);
  parts.push(`today ${money(s.todayUsd)}`);
  if (s.credits) {
    let t = `credits ${money(s.credits.remainingUsd)}`;
    if (typeof s.credits.daysLeft === "number") t += ` ${s.credits.daysLeft}d`;
    parts.push(t);
  }
  return `tally ${parts.join(c("dim", " · "))}`;
}

// ---------- nudge text ----------

function nudgeText(s) {
  const pct = typeof s.pct === "number" ? `${Math.round(s.pct)}%` : money(s.windowUsd);
  return (
    `[tally pace] This Claude Code 5-hour usage window is at ${pct} (threshold ${Math.round(s.threshold * 100)}%). ` +
    `Until it resets, spend less per turn: keep routine turns short and low-effort, do not re-read files already in context, ` +
    `batch tool calls, and delegate mechanical work (searches, bulk edits, test runs) to cheaper subagents (Sonnet or Haiku) with a tight brief. ` +
    `Keep full effort for decisions that need it.`
  );
}
function easedText() {
  return `[tally pace] The 5-hour window has reset or dropped below the threshold. Normal effort is fine again.`;
}

// ---------- settings merge / unmerge (install, uninstall) ----------

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function statusLineCommand(root = PLUGIN_ROOT) {
  return `node "${join(root, "scripts", "statusline.cjs")}"`;
}
function hookCommand(root = PLUGIN_ROOT) {
  return `node "${join(root, "scripts", "hook.cjs")}"`;
}
function hookEntry(root = PLUGIN_ROOT) {
  return { hooks: [{ type: "command", command: hookCommand(root), timeout: 5, statusMessage: "tally pace" }] };
}
function proposedSettings(root = PLUGIN_ROOT) {
  return { statusLine: { type: "command", command: statusLineCommand(root) }, hooks: { UserPromptSubmit: [hookEntry(root)] } };
}

/** Pure merge. Returns { settings, written: {...} | null, reason }. Never clobbers an existing statusLine. */
function mergeSettings(settings, { root = PLUGIN_ROOT, withHook = true } = {}) {
  const s = settings && typeof settings === "object" ? settings : {};
  if (s.statusLine) return { settings: s, written: null, reason: "statusLine already configured" };
  const next = { ...s, statusLine: proposedSettings(root).statusLine };
  const written = { statusLineCommand: next.statusLine.command, hookCommand: null };
  if (withHook) {
    const cmd = hookCommand(root);
    const hooks = { ...(s.hooks ?? {}) };
    const list = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit.slice() : [];
    const present = list.some((e) => (e?.hooks ?? []).some((h) => h?.command === cmd));
    if (!present) list.push(hookEntry(root));
    hooks.UserPromptSubmit = list;
    next.hooks = hooks;
    written.hookCommand = cmd;
  }
  return { settings: next, written, reason: "written" };
}

/** Pure unmerge: removes exactly the statusLine and hook recorded by install. */
function unmergeSettings(settings, record) {
  const s = settings && typeof settings === "object" ? { ...settings } : {};
  const removed = { statusLine: false, hook: false };
  if (record?.statusLineCommand && s.statusLine?.command === record.statusLineCommand) {
    delete s.statusLine;
    removed.statusLine = true;
  }
  if (record?.hookCommand && Array.isArray(s.hooks?.UserPromptSubmit)) {
    const before = s.hooks.UserPromptSubmit.length;
    const list = s.hooks.UserPromptSubmit.filter((e) => !((e?.hooks ?? []).length === 1 && e.hooks[0]?.command === record.hookCommand));
    if (list.length !== before) removed.hook = true;
    const hooks = { ...s.hooks };
    if (list.length) hooks.UserPromptSubmit = list;
    else delete hooks.UserPromptSubmit;
    if (Object.keys(hooks).length) s.hooks = hooks;
    else delete s.hooks;
  }
  return { settings: s, removed };
}

function pluginEnabled(settings) {
  const ep = settings?.enabledPlugins ?? {};
  return Object.keys(ep).some((k) => k === "tally" || k.startsWith("tally@"));
}

/** Install into a settings file. Returns a report; writes only when nothing would be clobbered. */
function install({ settings = settingsPath(), record = installRecordPath(), root = PLUGIN_ROOT } = {}) {
  const cur = readJson(settings, {});
  const withHook = !pluginEnabled(cur);
  const r = mergeSettings(cur, { root, withHook });
  if (!r.written) return { ok: false, reason: r.reason, proposed: proposedSettings(root), settingsPath: settings };
  writeJson(settings, r.settings);
  writeJson(record, { settingsPath: settings, ...r.written, at: new Date().toISOString() });
  return { ok: true, reason: withHook ? "written" : "written (hook skipped: the tally plugin is enabled and already provides it)", written: r.written, settingsPath: settings };
}

function uninstall({ settings = settingsPath(), record = installRecordPath() } = {}) {
  const rec = readJson(record, null);
  if (!rec) return { ok: false, reason: "nothing recorded by install" };
  const target = rec.settingsPath ?? settings;
  const cur = readJson(target, {});
  const r = unmergeSettings(cur, rec);
  writeJson(target, r.settings);
  try {
    writeFileSync(record, "");
    renameSync(record, `${record}.removed`);
  } catch {}
  return { ok: true, removed: r.removed, settingsPath: target };
}

// ---------- switch mode (effortLevel in settings; takes effect at the NEXT session start, see RESEARCH.md) ----------

function applySwitch(cache, over, { settings = settingsPath(), level = "low" } = {}) {
  const cur = readJson(settings, null);
  if (!cur) return { changed: false };
  if (over && !cache.switch?.active) {
    cache.switch = { active: true, prev: cur.effortLevel ?? null, at: Date.now() };
    writeJson(settings, { ...cur, effortLevel: level });
    return { changed: true, to: level };
  }
  if (!over && cache.switch?.active) {
    const prev = cache.switch.prev;
    const next = { ...cur };
    if (prev) next.effortLevel = prev;
    else delete next.effortLevel;
    writeJson(settings, next);
    cache.switch = { active: false, prev: null, at: Date.now() };
    return { changed: true, to: prev ?? "default" };
  }
  return { changed: false };
}

// ---------- CLI entry (also what `tally pace` delegates to) ----------

function formatReport(s, { color = true } = {}) {
  const lines = [renderLine(s, { color })];
  const src = { claude: "Claude Code rate_limits (exact)", config: `pace.json budgetUsd $${s.budgetUsd?.toFixed(0)}`, calibrated: `calibrated from rate_limits, ~$${s.budgetUsd?.toFixed(0)} per window`, none: "unknown (no rate_limits seen yet and no budgetUsd set)" }[s.pctSource];
  lines.push(`  window %: ${src}`);
  lines.push(`  window:   ${s.windowExact ? "from Claude Code's resets_at" : "rolling 5h (no resets_at seen yet)"}${s.resetsAtMs ? `, resets ${new Date(s.resetsAtMs).toLocaleTimeString()}` : ""}`);
  lines.push(`  threshold ${Math.round(s.threshold * 100)}% · mode ${s.mode} · plan ${s.plan ?? "unset"} · ${s.over ? "NUDGING" : "quiet"}`);
  if (!s.credits) lines.push(`  credits:  none configured (credit_pools in tally.db or "credits" in ~/.tally/pace.json)`);
  return lines.join("\n");
}

function runCli(argv, { stdout = (t) => process.stdout.write(t + "\n") } = {}) {
  const cmd = argv.find((a) => !a.startsWith("--")) ?? "status";
  const json = argv.includes("--json");
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (cmd === "status") {
    const cache = readCache();
    const s = paceStatus({ cache });
    writeCache(cache);
    stdout(json ? JSON.stringify(s) : formatReport(s, { color: !process.env.NO_COLOR }));
    return 0;
  }
  if (cmd === "install") {
    const r = install({ settings: opt("--settings") ?? settingsPath() });
    if (json) stdout(JSON.stringify(r));
    else if (r.ok) stdout(`tally pace: ${r.reason} → ${r.settingsPath}\nRestart Claude Code (or open a new session) to see the status line.`);
    else stdout(`tally pace: not written, ${r.reason} in ${r.settingsPath}.\nAdd this by hand (merge the statusLine command into your own script, append the hook entry):\n${JSON.stringify(r.proposed, null, 2)}`);
    return 0;
  }
  if (cmd === "uninstall") {
    const r = uninstall({ settings: opt("--settings") ?? settingsPath() });
    stdout(json ? JSON.stringify(r) : r.ok ? `tally pace: removed ${Object.entries(r.removed).filter(([, v]) => v).map(([k]) => k).join(" + ") || "nothing (already gone)"} from ${r.settingsPath}` : `tally pace: ${r.reason}`);
    return 0;
  }
  stdout("usage: pace.cjs [status|install|uninstall] [--settings <path>] [--json]");
  return 1;
}

module.exports = { tallyHome, claudeHome, claudeProjectsDir, cachePath, configPath, settingsPath, installRecordPath, PLAN_MULTIPLIER, prices, priceFor, turnUsd, DEFAULT_CONFIG, readConfig, readCache, writeCache, parseChunk, scanTurns, startOfToday, windowStart, sumSince, budgetFor, windowPercent, recordRateLimits, overThreshold, creditsCountdown, paceStatus, money, renderLine, nudgeText, easedText, readJson, statusLineCommand, hookCommand, hookEntry, proposedSettings, mergeSettings, unmergeSettings, pluginEnabled, install, uninstall, applySwitch, formatReport, runCli };

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}
