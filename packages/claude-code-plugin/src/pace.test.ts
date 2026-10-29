import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const scripts = join(pluginRoot, "scripts");
const fixture = resolve(here, "../../core/src/local/__fixtures__/session.jsonl");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pace: any = createRequire(import.meta.url)(join(scripts, "pace.cjs"));

const tmpRoots: string[] = [];
function tmp(prefix = "tally-pace-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A fake ~/.claude/projects with the shared fixture, mtime bumped so the scanner looks at it. */
function projectsDir(mtimeMs: number) {
  const root = tmp();
  const p = join(root, "-Users-x-proj");
  mkdirSync(p);
  const f = join(p, "abc.jsonl");
  copyFileSync(fixture, f);
  utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return { root, file: f };
}

const T = (s: string) => Date.parse(s);
const FABLE = 2.301; // from the core fixture test
const OPUS = 0.6908;

describe("window bucketing against the core fixture", () => {
  it("rolling 5h window and today, streamed duplicates counted once, unknown models skipped", () => {
    const now = T("2026-10-02T13:00:00Z");
    const { root } = projectsDir(now);
    const cache = pace.readCache("/nonexistent");
    const s = pace.paceStatus({ config: pace.readConfig("/nonexistent"), cache, dir: root, nowMs: now });
    expect(s.windowUsd).toBeCloseTo(FABLE, 6); // 10:00Z turn, inside 08:00–13:00Z; the duplicate line is not double counted
    expect(s.windowExact).toBe(false);
    expect(s.pct).toBeUndefined();
    expect(s.pctSource).toBe("none");
  });

  it("uses Claude Code's resets_at as the exact window start when present", () => {
    const now = T("2026-10-03T12:00:00Z");
    const { root } = projectsDir(now);
    const cache = pace.readCache("/nonexistent");
    // window resets at 15:30Z → started 10:30Z → the 10:00Z opus turn is outside the window but inside today
    cache.rateLimits = { five_hour: { used_percentage: 12, resets_at: T("2026-10-03T15:30:00Z") / 1000 } };
    const s = pace.paceStatus({ config: pace.readConfig("/nonexistent"), cache, dir: root, nowMs: now });
    expect(s.windowUsd).toBe(0);
    expect(s.windowExact).toBe(true);
    expect(s.pct).toBe(12);
    expect(s.pctSource).toBe("claude");
    expect(s.todayUsd).toBeCloseTo(OPUS, 6);
    // and a 5h-rolling window at the same instant does include it
    const s2 = pace.paceStatus({ config: pace.readConfig("/nonexistent"), cache: pace.readCache("/nonexistent"), dir: root, nowMs: now });
    expect(s2.windowUsd).toBeCloseTo(OPUS, 6);
  });

  it("scan is incremental: unchanged files are reused, appended bytes are read from the old offset", () => {
    const now = T("2026-10-02T13:00:00Z");
    const { root, file } = projectsDir(now);
    const cache = pace.readCache("/nonexistent");
    pace.scanTurns(cache, now - 5 * 3600e3, root, now);
    const entry = cache.files[file];
    expect(entry.turns.length).toBeGreaterThan(0);
    const offset = entry.offset;
    // unchanged → same entry object
    pace.scanTurns(cache, now - 5 * 3600e3, root, now);
    expect(cache.files[file]).toBe(entry);
    // append one more turn → only the new bytes are parsed
    const line = JSON.stringify({ type: "assistant", timestamp: "2026-10-02T12:30:00Z", sessionId: "s9", requestId: "r9", message: { id: "m9", model: "claude-haiku-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
    appendFileSync(file, line + "\n");
    utimesSync(file, now / 1000 + 1, now / 1000 + 1);
    const turns = pace.scanTurns(cache, now - 5 * 3600e3, root, now);
    expect(cache.files[file].offset).toBe(offset + line.length + 1);
    expect(pace.sumSince(turns, 0, now)).toBeCloseTo(FABLE + 0.1, 6);
  });

  it("parseChunk leaves a partial trailing line unconsumed", () => {
    const seen = new Set<string>();
    const full = JSON.stringify({ type: "assistant", timestamp: "2026-10-02T12:30:00Z", requestId: "r1", message: { id: "m1", model: "claude-haiku-5-5", usage: { input_tokens: 1_000_000 } } });
    const buf = Buffer.from(full + "\n" + full.slice(0, 40));
    const r = pace.parseChunk(buf, seen, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.consumed).toBe(full.length + 1);
  });
});

describe("threshold and budget logic", () => {
  it("percent source precedence: claude > config budget > calibrated > none", () => {
    const now = Date.now();
    const cfg = { ...pace.DEFAULT_CONFIG };
    expect(pace.windowPercent({ config: cfg, cache: { rateLimits: null, calibration: null }, windowUsd: 10, nowMs: now })).toMatchObject({ pct: undefined, source: "none" });
    expect(pace.windowPercent({ config: cfg, cache: { calibration: { budgetUsd: 40, plan: "max20" } }, windowUsd: 10, nowMs: now })).toMatchObject({ pct: 25, source: "calibrated" });
    expect(pace.windowPercent({ config: { ...cfg, budgetUsd: 20 }, cache: { calibration: { budgetUsd: 40 } }, windowUsd: 10, nowMs: now })).toMatchObject({ pct: 50, source: "config" });
    const live = { rateLimits: { five_hour: { used_percentage: 91, resets_at: now / 1000 + 100 } } };
    expect(pace.windowPercent({ config: { ...cfg, budgetUsd: 20 }, cache: live, windowUsd: 10, nowMs: now })).toMatchObject({ pct: 91, source: "claude" });
    const stale = { rateLimits: { five_hour: { used_percentage: 91, resets_at: now / 1000 - 1 } }, calibration: null };
    expect(pace.windowPercent({ config: { ...cfg, budgetUsd: 20 }, cache: stale, windowUsd: 10, nowMs: now })).toMatchObject({ pct: 50, source: "config" });
  });

  it("calibrates a dollar budget from rate_limits and scales it by the official plan multipliers", () => {
    const cache = pace.readCache("/nonexistent");
    pace.recordRateLimits(cache, { five_hour: { used_percentage: 50, resets_at: 1 } }, 10, "max5");
    expect(cache.calibration.budgetUsd).toBeCloseTo(20, 6);
    expect(pace.budgetFor({ plan: "max20" }, cache)).toMatchObject({ usd: 80, source: "calibrated" });
    expect(pace.budgetFor({ plan: "pro" }, cache).usd).toBeCloseTo(4, 6);
    // below 5% the sample is too noisy to calibrate from
    const c2 = pace.readCache("/nonexistent");
    pace.recordRateLimits(c2, { five_hour: { used_percentage: 2, resets_at: 1 } }, 10, "max5");
    expect(c2.calibration).toBeNull();
  });

  it("overThreshold", () => {
    expect(pace.overThreshold(80, 0.8)).toBe(true);
    expect(pace.overThreshold(79.9, 0.8)).toBe(false);
    expect(pace.overThreshold(undefined, 0.8)).toBe(false);
  });

  it("renderLine shows window %, dollars, today and a credits countdown", () => {
    const line = pace.renderLine({ windowUsd: 18.3, todayUsd: 61, pct: 42, pctSource: "claude", threshold: 0.8, credits: { remainingUsd: 173, daysLeft: 6 } }, { color: false });
    expect(line).toBe("tally 5h 42% $18.3 · today $61 · credits $173 6d");
    expect(pace.renderLine({ windowUsd: 3, todayUsd: 3, pct: 50, pctSource: "calibrated", threshold: 0.8 }, { color: false })).toContain("$3.00~");
  });
});

describe("hook and statusline end to end (subprocess)", () => {
  function env(home: string, claude: string) {
    return { ...process.env, TALLY_HOME: home, CLAUDE_CONFIG_DIR: claude, NO_COLOR: "1" };
  }
  function liveProjects(claude: string, usd = 10) {
    const p = join(claude, "projects", "-Users-x-live");
    mkdirSync(p, { recursive: true });
    // haiku 5.5 input is $0.10 / 1M, so `usd` dollars = usd * 10M input tokens
    const line = JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), sessionId: "s", requestId: "r", message: { id: "m", model: "claude-haiku-5-5", usage: { input_tokens: usd * 10_000_000 } } });
    writeFileSync(join(p, "live.jsonl"), line + "\n");
  }

  it("nudges past the threshold, keeps nudging, and sends one eased note when the window drops", () => {
    const home = tmp();
    const claude = tmp();
    liveProjects(claude, 10);
    writeFileSync(join(home, "pace.json"), JSON.stringify({ budgetUsd: 12, threshold: 0.8 })); // 10/12 = 83%
    const run = () => spawnSync("node", [join(scripts, "hook.cjs")], { input: "{}", env: env(home, claude), encoding: "utf8" });
    const r1 = run();
    expect(r1.status).toBe(0);
    const j1 = JSON.parse(r1.stdout);
    expect(j1.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(j1.hookSpecificOutput.additionalContext).toMatch(/window is at 83%/);
    expect(j1.decision).toBeUndefined();
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toMatch(/83%/);
    writeFileSync(join(home, "pace.json"), JSON.stringify({ budgetUsd: 100, threshold: 0.8 })); // now 10%
    expect(JSON.parse(run().stdout).hookSpecificOutput.additionalContext).toMatch(/Normal effort is fine again/);
    expect(run().stdout).toBe("");
  });

  it("statusline prints one line from stdin rate_limits and records them for the hook", () => {
    const home = tmp();
    const claude = tmp();
    liveProjects(claude, 2);
    const resets = Math.floor(Date.now() / 1000) + 1800;
    const input = JSON.stringify({ model: { id: "claude-fable-5-1" }, rate_limits: { five_hour: { used_percentage: 64, resets_at: resets } } });
    const r = spawnSync("node", [join(scripts, "statusline.cjs")], { input, env: env(home, claude), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toMatch(/^tally 5h 64% \$2\.00 ↻\d+m · today \$2\.00/);
    const cache = JSON.parse(readFileSync(join(home, "pace-cache.json"), "utf8"));
    expect(cache.rateLimits.five_hour.resets_at).toBe(resets);
    expect(cache.calibration.budgetUsd).toBeCloseTo(2 / 0.64, 6);
    // garbage stdin still yields a line
    const r2 = spawnSync("node", [join(scripts, "statusline.cjs")], { input: "not json", env: env(home, claude), encoding: "utf8" });
    expect(r2.stdout).toMatch(/^tally 5h/);
  });
});

describe("settings merge / unmerge", () => {
  const root = "/plug";
  it("writes statusLine + hook into empty settings and is idempotent", () => {
    const r = pace.mergeSettings({}, { root });
    expect(r.written).toEqual({ statusLineCommand: 'node "/plug/scripts/statusline.cjs"', hookCommand: 'node "/plug/scripts/hook.cjs"' });
    expect(r.settings.statusLine).toEqual({ type: "command", command: 'node "/plug/scripts/statusline.cjs"' });
    expect(r.settings.hooks.UserPromptSubmit).toHaveLength(1);
    const again = pace.mergeSettings({ ...r.settings, statusLine: undefined }, { root });
    expect(again.settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("never clobbers an existing statusLine; preserves other hooks; skips the hook when the plugin is enabled", () => {
    const existing = { statusLine: { type: "command", command: "~/mine.sh" }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "memgraph" }] }] } };
    const r = pace.mergeSettings(existing, { root });
    expect(r.written).toBeNull();
    expect(r.settings).toBe(existing);
    const r2 = pace.mergeSettings({ hooks: existing.hooks, model: "x" }, { root });
    expect(r2.settings.model).toBe("x");
    expect(r2.settings.hooks.UserPromptSubmit.map((e: any) => e.hooks[0].command)).toEqual(["memgraph", 'node "/plug/scripts/hook.cjs"']);
    const r3 = pace.mergeSettings({ enabledPlugins: { "tally@tally": true } }, { root, withHook: !pace.pluginEnabled({ enabledPlugins: { "tally@tally": true } }) });
    expect(r3.settings.hooks).toBeUndefined();
    expect(r3.settings.statusLine).toBeDefined();
  });

  it("unmerge removes exactly what was recorded and leaves the rest", () => {
    const merged = pace.mergeSettings({ model: "x", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "memgraph" }] }], Stop: [{ hooks: [] }] } }, { root });
    const u = pace.unmergeSettings(merged.settings, merged.written);
    expect(u.removed).toEqual({ statusLine: true, hook: true });
    expect(u.settings).toEqual({ model: "x", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "memgraph" }] }], Stop: [{ hooks: [] }] } });
    // a statusLine the user changed since install is left alone
    const u2 = pace.unmergeSettings({ statusLine: { type: "command", command: "theirs" } }, merged.written);
    expect(u2.removed.statusLine).toBe(false);
    expect(u2.settings.statusLine.command).toBe("theirs");
  });

  it("install/uninstall round-trips a temp settings.json byte for byte", () => {
    const home = tmp();
    const settings = join(home, "settings.json");
    const original = JSON.stringify({ model: "claude-fable-5-1", hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }, null, 2) + "\n";
    writeFileSync(settings, original);
    const record = join(home, "pace-install.json");
    const r = pace.install({ settings, record, root });
    expect(r.ok).toBe(true);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.statusLine.command).toBe('node "/plug/scripts/statusline.cjs"');
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.UserPromptSubmit).toHaveLength(1);
    const second = pace.install({ settings, record, root });
    expect(second.ok).toBe(false);
    expect(second.proposed.statusLine.type).toBe("command");
    const u = pace.uninstall({ settings, record });
    expect(u.ok).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(pace.uninstall({ settings, record }).ok).toBe(false);
  });

  it("switch mode writes effortLevel for the next session and restores the previous value", () => {
    const home = tmp();
    const settings = join(home, "settings.json");
    writeFileSync(settings, JSON.stringify({ effortLevel: "high", model: "m" }));
    const cache = pace.readCache("/nonexistent");
    expect(pace.applySwitch(cache, true, { settings })).toEqual({ changed: true, to: "low" });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ effortLevel: "low", model: "m" });
    expect(pace.applySwitch(cache, true, { settings }).changed).toBe(false);
    expect(pace.applySwitch(cache, false, { settings })).toEqual({ changed: true, to: "high" });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ effortLevel: "high", model: "m" });
    writeFileSync(settings, JSON.stringify({ model: "m" }));
    pace.applySwitch(cache, true, { settings });
    pace.applySwitch(cache, false, { settings });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ model: "m" });
  });
});
