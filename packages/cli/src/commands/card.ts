import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { renderCard, type CardData, type PlanId, type LocalAgentSummary } from "@tally/core";
import { gatherWallet } from "../wallet-data.js";
import { bold, dim, ok } from "../ui.js";

const AGENT: Record<LocalAgentSummary["source"], string> = { "claude-code": "Claude Code", codex: "Codex CLI", cursor: "Cursor", gemini: "Gemini CLI" };

export interface CardOpts {
  days: number;
  square?: boolean;
  dark?: boolean;
  out?: string;
  png?: boolean;
  open?: boolean;
  redactModels?: boolean;
  plan?: PlanId;
}

/** The monthly share card. Totals and model names only; no project names, paths or keys. */
export async function card(opts: CardOpts): Promise<void> {
  const w = await gatherWallet({ days: opts.days, plan: opts.plan });
  const data = toCardData(w);
  const svg = renderCard(data, { square: opts.square, dark: opts.dark, redactModels: opts.redactModels });

  const month = w.to.slice(0, 7);
  const out = resolve(opts.out ?? join(homedir(), ".tally", "cards", `tally-${month}${opts.square ? "-square" : ""}${opts.dark ? "-dark" : ""}.svg`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, svg);
  console.log(`${ok("wrote")} ${out}`);

  let pngPath: string | undefined;
  if (opts.png) {
    pngPath = out.replace(/\.svg$/i, "") + ".png";
    const used = toPng(out, pngPath, opts.square ? 1080 : 1200, opts.square ? 1080 : 675);
    if (used) console.log(`${ok("wrote")} ${pngPath} ${dim(`(${used})`)}`);
    else {
      pngPath = undefined;
      console.log(dim("No SVG converter found (rsvg-convert, Chrome, or sips). The SVG is written; open it in a browser and screenshot it, or brew install librsvg."));
    }
  }

  console.log(dim(`Privacy: the card holds totals and model names only, no project names or paths.${opts.redactModels ? " Model names replaced by vendor family." : " Use --redact-models to show vendor families instead."}`));
  if (opts.open) {
    const target = pngPath ?? out;
    try {
      execFileSync(process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open", [target], { stdio: "ignore" });
    } catch {
      console.log(dim(`Could not open ${target} automatically.`));
    }
  }
}

/** Only totals cross this boundary: nothing with a cwd, session id or key. */
export function toCardData(w: Awaited<ReturnType<typeof gatherWallet>>): CardData {
  const sources: { name: string; s: { apiEquivalentUsd: number; turns: number; sessions: number; activeDays: number; byModel: LocalAgentSummary["byModel"] } }[] = [];
  if (w.cc.turns) sources.push({ name: AGENT["claude-code"], s: w.cc });
  for (const s of w.local.sources) if (s.turns) sources.push({ name: AGENT[s.source], s });

  const total = sources.reduce((a, x) => a + x.s.apiEquivalentUsd, 0);
  const byModelMap = new Map<string, number>();
  let ctxTurns = 0, hitTurns = 0;
  for (const { s } of sources) {
    for (const m of s.byModel) {
      byModelMap.set(m.model, (byModelMap.get(m.model) ?? 0) + m.usd);
      ctxTurns += m.turns;
      hitTurns += m.turns * m.cacheHitRate;
    }
  }
  const byModel = [...byModelMap.entries()].map(([model, usd]) => ({ model, usd, share: total ? usd / total : 0 })).sort((a, b) => b.usd - a.usd);

  const data: CardData = { window: { from: w.from, to: w.to } };
  if (sources.length) {
    data.apiEquivalentUsd = total;
    data.agents = sources.map((x) => x.name);
    data.byModel = byModel;
    data.sessions = sources.reduce((a, x) => a + x.s.sessions, 0);
    data.activeDays = Math.max(...sources.map((x) => x.s.activeDays));
    data.turns = sources.reduce((a, x) => a + x.s.turns, 0);
    if (ctxTurns) data.cacheHitRate = hitTurns / ctxTurns;
  }
  if (w.cc.turns) {
    data.plan = { label: w.verdict.planLabel, monthlyUsd: w.verdict.planUsd, usd: w.verdict.apiEquivalentUsd, multiple: w.verdict.multiple };
    data.verdict = w.verdict.headline;
  }
  return data;
}

function has(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function chromeBinary(): string | undefined {
  for (const b of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) if (has(b)) return b;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(mac)) return mac;
  return undefined;
}

/** rsvg-convert, then headless Chrome, then macOS sips (exact size, but it drops font weights). Returns the converter used. */
function toPng(svg: string, png: string, w: number, h: number): string | undefined {
  if (has("rsvg-convert")) {
    execFileSync("rsvg-convert", ["-w", String(w), "-h", String(h), "-o", png, svg], { stdio: "ignore" });
    return "rsvg-convert";
  }
  const chrome = chromeBinary();
  if (chrome) {
    try {
      const profile = mkdtempSync(join(tmpdir(), "tally-card-"));
      execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--force-device-scale-factor=2", `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${svg}`], { stdio: "ignore", timeout: 60_000 });
      rmSync(profile, { recursive: true, force: true });
      if (existsSync(png)) return "chrome headless, 2x";
    } catch {
      /* fall through */
    }
  }
  if (process.platform === "darwin" && has("sips")) {
    try {
      execFileSync("sips", ["-s", "format", "png", svg, "--out", png], { stdio: "ignore" });
      if (existsSync(png)) return "sips; fonts approximate, Chrome or rsvg-convert render the real ones";
    } catch {
      /* fall through */
    }
  }
  return undefined;
}
