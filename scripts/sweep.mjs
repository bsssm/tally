#!/usr/bin/env node
// sweep.mjs — what changed on the pricing pages the deal feed cites.
//
// Reads packages/core/data/monitors.json (Context.dev page monitors), asks the Context
// monitors API for changes since the last run, and prints a markdown summary: which page
// changed, what the monitor saw, and which deals.json entries cite that page so a human or
// an agent can re-verify them. It never edits deals.json.
//
// Key lookup and request plumbing come from ~/dashboard/context/client.mjs (env
// CONTEXT_DEV_API_KEY, else Keychain `context-dev-api-key`). That module exposes scrape()
// and search() only, so the two read-only monitor calls (0 credits each) are made here with
// the same key resolution; nothing is hardcoded.
//
// Usage:  pnpm sweep              changes since the last sweep (state in data/sweep-state.json)
//         pnpm sweep -- --since 2026-10-01   explicit window
//         pnpm sweep -- --all     every change the monitors have ever recorded
//         pnpm sweep -- --dry     do not advance the saved cursor
//         CONTEXT_CLIENT=/path/to/client.mjs overrides the dashboard client location.

import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MONITORS = join(root, "packages", "core", "data", "monitors.json");
const DEALS = join(root, "packages", "core", "data", "deals.json");
const STATE = join(root, "packages", "core", "data", "sweep-state.json");
const BASE = "https://api.context.dev/v1";
const CLIENT = process.env.CONTEXT_CLIENT || join(homedir(), "dashboard", "context", "client.mjs");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

async function loadJson(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
}

// Same resolution order as the dashboard client; import it first so a future export there wins.
async function apiKey() {
  if (process.env.CONTEXT_DEV_API_KEY) return process.env.CONTEXT_DEV_API_KEY;
  try {
    const mod = await import(pathToFileURL(CLIENT).href);
    if (typeof mod.key === "function") { const k = mod.key(); if (k) return k; }
  } catch { /* client absent: fall through to Keychain */ }
  try {
    return execFileSync("security", ["find-generic-password", "-s", "context-dev-api-key", "-w"], { encoding: "utf8" }).trim();
  } catch { return ""; }
}

async function get(path, key) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error_code || json.message || ""}`.trim());
  return json;
}

async function listAll(path, key) {
  const out = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const j = await get(path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""), key);
    out.push(...(j.data || []));
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
  }
  return out;
}

function host(u) { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } }
function samePage(a, b) {
  const n = (u) => { try { const x = new URL(u); return x.host.replace(/^www\./, "") + x.pathname.replace(/\/$/, "") + x.search; } catch { return u; } };
  return n(a) === n(b);
}

const key = await apiKey();
if (!key) {
  console.error("no Context.dev key: set CONTEXT_DEV_API_KEY or store Keychain item `context-dev-api-key`");
  process.exit(2);
}

const monitors = (await loadJson(MONITORS, { monitors: [] })).monitors;
const deals = (await loadJson(DEALS, { deals: [] })).deals;
const state = await loadJson(STATE, { last_sweep_at: null });
const now = new Date().toISOString();
const since = flag("--all") ? null : (opt("--since") ? new Date(opt("--since")).toISOString() : state.last_sweep_at);

if (monitors.length === 0) {
  console.log("No monitors in packages/core/data/monitors.json. Nothing to sweep.");
  process.exit(0);
}

// Live status for each monitor we know about (0 credits).
const live = await listAll("/monitors?tag=tally&limit=100", key);
const liveById = new Map(live.map((m) => [m.id, m]));

const q = new URLSearchParams({ tag: "tally", limit: "100" });
if (since) q.set("since", since);
const changes = (await listAll(`/monitors/changes?${q}`, key)).filter((c) => monitors.some((m) => m.id === c.monitor_id));

const lines = [];
lines.push(`# Deal sweep · ${now.slice(0, 16)}Z`);
lines.push("");
lines.push(since ? `Changes since ${since.slice(0, 16)}Z across ${monitors.length} monitors.` : `All recorded changes across ${monitors.length} monitors.`);
lines.push("");

if (changes.length === 0) {
  lines.push("**No page changes.** Nothing in deals.json needs re-verifying from the monitors.");
} else {
  lines.push(`## ${changes.length} changed page${changes.length === 1 ? "" : "s"}`);
  for (const c of changes.sort((a, b) => (b.detected_at || "").localeCompare(a.detected_at || ""))) {
    const m = monitors.find((x) => x.id === c.monitor_id);
    const cited = deals.filter((d) => samePage(d.url, m.url) || host(d.url) === host(m.url));
    lines.push("");
    lines.push(`### ${m.name} · ${c.detected_at?.slice(0, 16)}Z${c.importance ? ` · ${c.importance}` : ""}${c.confidence != null ? ` · ${(c.confidence * 100).toFixed(0)}%` : ""}`);
    lines.push(`<${m.url}>`);
    if (c.title) lines.push(`**${c.title}**`);
    if (c.summary) lines.push(c.summary.trim());
    if (c.after_text_excerpt) lines.push(`> ${c.after_text_excerpt.trim().replace(/\n+/g, " ").slice(0, 400)}`);
    lines.push("");
    if (cited.length === 0) {
      lines.push("_No deals.json entry cites this page. Consider whether the change is a new deal._");
    } else {
      lines.push("Re-verify these deals.json entries:");
      for (const d of cited) lines.push(`- \`${d.id}\` (${d.verification}${d.expires ? `, expires ${d.expires}` : ""}): ${d.title}`);
    }
  }
}

lines.push("");
lines.push("## Monitor health");
lines.push("");
lines.push("| monitor | cadence | status | last run | next run | last change |");
lines.push("|---|---|---|---|---|---|");
for (const m of monitors) {
  const l = liveById.get(m.id);
  const cad = l?.schedule ? `every ${l.schedule.frequency} ${l.schedule.unit}` : m.cadence;
  lines.push(`| ${m.name} | ${cad} | ${l ? l.status + (l.last_error ? ` (${l.last_error})` : "") : "MISSING on Context"} | ${l?.last_run_at?.slice(0, 16) ?? "—"} | ${l?.next_run_at?.slice(0, 16) ?? "—"} | ${l?.last_change_at?.slice(0, 16) ?? "—"} |`);
}

// Deals whose dates say they expire soon, so the sweep also nags about them.
const soon = deals.filter((d) => d.expires && Date.parse(d.expires) - Date.now() < 14 * 86400000 && Date.parse(d.expires) >= Date.now() - 86400000);
if (soon.length) {
  lines.push("");
  lines.push("## Expiring within 14 days (check the page before the date, then set `expires` or extend)");
  lines.push("");
  for (const d of soon) lines.push(`- ${d.expires} \`${d.id}\`: ${d.title} — <${d.url}>`);
}

lines.push("");
lines.push("_Monitors are read-only here; edit deals.json by hand (or PR) after re-reading the provider page. Sweep never changes it._");
console.log(lines.join("\n"));

if (!flag("--dry")) {
  await writeFile(STATE, JSON.stringify({ last_sweep_at: now, changes_seen: changes.length }, null, 2) + "\n");
}
