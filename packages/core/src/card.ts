/**
 * The monthly share card: a self-contained SVG of the wallet for posting (ccusage screenshots are a
 * genre on X). Pure: everything on the card comes from `CardData`; a missing field drops its row.
 * Nothing is embedded; fonts are stacks with system fallbacks so the file renders anywhere.
 */

export interface CardModel {
  model: string;
  usd: number;
  /** Share of the headline number, 0..1. */
  share: number;
}

export interface CardData {
  window: { from: string; to: string };
  /** API-equivalent for the window across every agent found. */
  apiEquivalentUsd?: number;
  /** The plan line: "$1,611 on a $200 plan · 8.1x". `usd` is what the multiple was computed from. */
  plan?: { label: string; monthlyUsd: number; usd: number; multiple: number };
  byModel?: CardModel[];
  /** Weighted cache hit rate, 0..1. */
  cacheHitRate?: number;
  /** Agents whose logs were priced, e.g. ["Claude Code", "Codex CLI"]. */
  agents?: string[];
  sessions?: number;
  activeDays?: number;
  turns?: number;
  /** The verdict headline. */
  verdict?: string;
}

export interface CardOptions {
  /** 1080x1080 instead of 1200x675. */
  square?: boolean;
  dark?: boolean;
  /** Replace model names with the vendor family and merge rows. */
  redactModels?: boolean;
  /** Footer month, e.g. "October 2026". Defaults to the month of `window.to`. */
  month?: string;
}

/** Colours mirror packages/site/style.css tokens. */
const LIGHT = { bg: "#ffffff", ink: "#1f2b4d", muted: "#5c6378", accent: "#f7941d", track: "#e3e1dc", rule: "#d6d8de" };
const DARK = { bg: "#0b0e14", ink: "#e8eaf0", muted: "#8b93a7", accent: "#f7941d", track: "#232a38", rule: "#232a38" };

const SANS = `'Schibsted Grotesk', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `'IBM Plex Mono', ui-monospace, Menlo, 'SF Mono', Consolas, monospace`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function cardMoney(n: number): string {
  if (n >= 10) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

export function monthLabel(iso: string): string {
  const m = Number(iso.slice(5, 7)) - 1;
  return `${MONTHS[m] ?? ""} ${iso.slice(0, 4)}`.trim();
}

function shortDate(iso: string): string {
  const m = Number(iso.slice(5, 7)) - 1;
  return `${Number(iso.slice(8, 10))} ${SHORT[m] ?? ""}`;
}

/** "claude-fable-5-1" → "claude"; "openai/gpt-5.5" → "openai"; "gemini-3-pro" → "gemini". */
export function vendorFamily(model: string): string {
  const m = model.toLowerCase().replace(/^[^/]+\//, "");
  if (m.startsWith("claude")) return "claude";
  if (/^(gpt|o\d|codex|chatgpt)/.test(m)) return "openai";
  if (m.startsWith("gemini") || m.startsWith("gemma")) return "gemini";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("qwen")) return "qwen";
  if (m.startsWith("llama")) return "llama";
  if (m.startsWith("mistral") || m.startsWith("mixtral") || m.startsWith("codestral")) return "mistral";
  if (m.startsWith("grok")) return "grok";
  return m.split(/[-_.:]/)[0] || "other";
}

export function redactModels(models: CardModel[]): CardModel[] {
  const out = new Map<string, CardModel>();
  for (const m of models) {
    const k = vendorFamily(m.model);
    const cur = out.get(k) ?? { model: k, usd: 0, share: 0 };
    cur.usd += m.usd;
    cur.share += m.share;
    out.set(k, cur);
  }
  return [...out.values()].sort((a, b) => b.usd - a.usd);
}

/** Greedy word wrap on an estimated glyph width; SVG has no text flow. */
export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s+\S*$/, "") + "…";
    return kept;
  }
  return lines;
}

interface Geometry {
  w: number; h: number; pad: number;
  headline: number; headlineY: number; label: number; labelY: number; planY: number;
  stats: { x: number; labelY: number; valueY: number }[];
  barsY: number; barRow: number; barX: number; barW: number; pctX: number;
  verdictY: number; verdictSize: number; verdictChars: number; verdictLines: number; verdictLh: number;
  ruleY: number; footerY: number;
}

const WIDE: Geometry = {
  w: 1200, h: 675, pad: 56,
  headline: 140, headlineY: 258, label: 20, labelY: 300, planY: 344,
  stats: [{ x: 780, labelY: 200, valueY: 258 }, { x: 780, labelY: 330, valueY: 362 }, { x: 780, labelY: 430, valueY: 462 }],
  barsY: 404, barRow: 42, barX: 330, barW: 280, pctX: 690,
  verdictY: 548, verdictSize: 24, verdictChars: 82, verdictLines: 2, verdictLh: 32,
  ruleY: 612, footerY: 648,
};

const SQUARE: Geometry = {
  w: 1080, h: 1080, pad: 64,
  headline: 150, headlineY: 300, label: 20, labelY: 344, planY: 392,
  stats: [{ x: 64, labelY: 470, valueY: 518 }, { x: 400, labelY: 470, valueY: 518 }, { x: 740, labelY: 470, valueY: 518 }],
  barsY: 620, barRow: 44, barX: 360, barW: 500, pctX: 1016,
  verdictY: 800, verdictSize: 24, verdictChars: 72, verdictLines: 3, verdictLh: 34,
  ruleY: 960, footerY: 1000,
};

export function renderCard(data: CardData, opts: CardOptions = {}): string {
  const g = opts.square ? SQUARE : WIDE;
  const c = opts.dark ? DARK : LIGHT;
  const right = g.w - g.pad;
  const month = opts.month ?? monthLabel(data.window.to);
  const out: string[] = [];
  const text = (x: number, y: number, s: string, a: { size: number; fill?: string; weight?: number; mono?: boolean; anchor?: "start" | "end"; spacing?: number; opacity?: number }) =>
    out.push(
      `<text x="${x}" y="${y}" font-family="${a.mono ? MONO : SANS}" font-size="${a.size}" font-weight="${a.weight ?? 400}" fill="${a.fill ?? c.ink}"` +
        `${a.anchor ? ` text-anchor="${a.anchor}"` : ""}${a.spacing ? ` letter-spacing="${a.spacing}"` : ""}${a.opacity ? ` opacity="${a.opacity}"` : ""}>${esc(s)}</text>`,
    );
  const label = (x: number, y: number, s: string) => text(x, y, s.toUpperCase(), { size: 13, mono: true, fill: c.muted, spacing: 2 });

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${g.w}" height="${g.h}" viewBox="0 0 ${g.w} ${g.h}" role="img" aria-label="Tally wallet card, ${esc(month)}">`);
  out.push(`<title>Tally · ${esc(month)}</title>`);
  out.push(`<rect width="${g.w}" height="${g.h}" fill="${c.bg}"/>`);

  // Header: wordmark and window.
  text(g.pad, g.pad + 34, "tally", { size: 32, weight: 700 });
  text(right, g.pad + 34, `${shortDate(data.window.from)} → ${shortDate(data.window.to)}`, { size: 17, mono: true, fill: c.muted, anchor: "end" });

  // Headline number and its label.
  if (data.apiEquivalentUsd !== undefined) {
    text(g.pad - 4, g.headlineY, cardMoney(data.apiEquivalentUsd), { size: g.headline, weight: 700, spacing: -4 });
    const parts = ["API-equivalent"];
    if (data.activeDays !== undefined) parts.push(`${data.activeDays} active days`);
    if (data.agents?.length) parts.push(data.agents.join(" · "));
    text(g.pad, g.labelY, parts.join(" · "), { size: g.label, fill: c.muted });
  }

  // Plan line: "$1,611 on a $200 plan · 8.1x".
  if (data.plan && data.plan.monthlyUsd > 0) {
    out.push(
      `<text x="${g.pad}" y="${g.planY}" font-family="${MONO}" font-size="24" fill="${c.ink}">` +
        `${esc(cardMoney(data.plan.usd))} on a ${esc(cardMoney(data.plan.monthlyUsd))} plan` +
        `<tspan fill="${c.muted}"> · </tspan><tspan fill="${c.accent}" font-weight="700">${data.plan.multiple.toFixed(1)}x</tspan></text>`,
    );
  } else if (data.plan) {
    text(g.pad, g.planY, `${data.plan.label}, pay as you go`, { size: 24, mono: true });
  }

  // Stats: cache hit, agents, sessions. Each only when present.
  const stats: { label: string; value: string; big: boolean }[] = [];
  if (data.cacheHitRate !== undefined) stats.push({ label: "cache hit", value: `${Math.round(data.cacheHitRate * 100)}%`, big: true });
  if (data.agents?.length) stats.push({ label: data.agents.length === 1 ? "agent found" : "agents found", value: data.agents.join(" · "), big: false });
  const counts = [data.sessions !== undefined ? `${data.sessions.toLocaleString("en-US")} sessions` : "", data.turns !== undefined ? `${data.turns.toLocaleString("en-US")} turns` : ""].filter(Boolean);
  if (counts.length) stats.push({ label: counts.length === 2 ? "sessions · turns" : counts[0].split(" ")[1], value: counts.map((x) => x.split(" ")[0]).join(" · "), big: false });
  const slots = g.stats;
  const slotW = opts.square ? 300 : right - slots[0].x;
  stats.slice(0, slots.length).forEach((s, i) => {
    const p = slots[i];
    label(p.x, p.labelY, s.label);
    if (s.big) text(p.x - 2, p.valueY, s.value, { size: opts.square ? 44 : 64, weight: 700, spacing: -1 });
    else {
      const lines = wrap(s.value, Math.floor(slotW / (24 * 0.55)), 2);
      lines.forEach((l, j) => text(p.x, p.valueY - (opts.square ? 12 : 0) + j * 28, l, { size: 24 }));
    }
  });

  // Top 3 models as bars.
  const models = (opts.redactModels ? redactModels(data.byModel ?? []) : (data.byModel ?? [])).slice(0, 3);
  const maxShare = Math.max(...models.map((m) => m.share), 0.0001);
  models.forEach((m, i) => {
    const y = g.barsY + i * g.barRow;
    text(g.pad, y, m.model.length > 26 ? `${m.model.slice(0, 25)}…` : m.model, { size: 18, mono: true });
    out.push(`<rect x="${g.barX}" y="${y - 12}" width="${g.barW}" height="14" fill="${c.track}"/>`);
    const w = Math.max(2, Math.round((m.share / maxShare) * g.barW));
    out.push(`<rect x="${g.barX}" y="${y - 12}" width="${w}" height="14" fill="${i === 0 ? c.accent : c.ink}"/>`);
    text(g.pctX, y, `${Math.round(m.share * 100)}%`, { size: 18, mono: true, anchor: "end" });
  });

  // The verdict headline.
  if (data.verdict) {
    const lines = wrap(data.verdict, g.verdictChars, g.verdictLines);
    lines.forEach((l, j) => text(g.pad, g.verdictY + j * g.verdictLh, l, { size: g.verdictSize, weight: 500 }));
  }

  // Footer.
  out.push(`<line x1="${g.pad}" y1="${g.ruleY}" x2="${right}" y2="${g.ruleY}" stroke="${c.rule}" stroke-width="1"/>`);
  out.push(
    `<text x="${g.pad}" y="${g.footerY}" font-family="${MONO}" font-size="22" fill="${c.ink}"><tspan fill="${c.muted}">$ </tspan><tspan fill="${c.accent}" font-weight="700">npx tallyai</tspan></text>`,
  );
  text(right, g.footerY, month, { size: 18, mono: true, fill: c.muted, anchor: "end" });
  out.push(`</svg>`);
  return out.join("\n");
}
