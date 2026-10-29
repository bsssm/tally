import { describe, expect, it } from "vitest";
import { cardMoney, monthLabel, redactModels, renderCard, vendorFamily, wrap, type CardData } from "./card.js";

const full: CardData = {
  window: { from: "2026-09-29", to: "2026-10-29" },
  apiEquivalentUsd: 1614.23,
  plan: { label: "Claude Max 20x", monthlyUsd: 200, usd: 1614.23, multiple: 8.07 },
  byModel: [
    { model: "claude-fable-5-1", usd: 1156.74, share: 0.7166 },
    { model: "claude-opus-5-5", usd: 322.84, share: 0.2 },
    { model: "claude-opus-4-8", usd: 129.91, share: 0.08 },
    { model: "claude-sonnet-5", usd: 2.94, share: 0.0018 },
  ],
  cacheHitRate: 0.912,
  agents: ["Claude Code"],
  sessions: 1403,
  activeDays: 31,
  turns: 7975,
  verdict: "You used $1614 API-equivalent on a $200 plan: 8.1x. Keep it.",
};

describe("renderCard", () => {
  it("returns a self-contained 1200x675 SVG with no embedded assets", () => {
    const svg = renderCard(full);
    expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="1200" height="675"');
    expect(svg).not.toMatch(/<image|@font-face|data:|<script|href=/);
    expect(svg).toContain("system-ui");
    expect(svg).toContain("ui-monospace");
  });

  it("puts every number on the card", () => {
    const svg = renderCard(full);
    expect(svg).toContain(">$1,614<");
    expect(svg).toContain("$1,614 on a $200 plan");
    expect(svg).toContain(">8.1x<");
    expect(svg).toContain("91%");
    expect(svg).toContain("claude-fable-5-1");
    expect(svg).toContain(">72%<");
    expect(svg).toContain(">20%<");
    expect(svg).toContain(">8%<");
    expect(svg).toContain("Claude Code");
    expect(svg).toContain("31 active days");
    expect(svg).toContain(">1,403 · 7,975<");
    expect(svg).toContain("SESSIONS · TURNS");
    expect(svg).toContain("Keep it.");
    expect(svg).toContain("npx tallywallet");
    expect(svg).toContain("October 2026");
  });

  it("shows only the top 3 models", () => {
    const svg = renderCard(full);
    expect(svg).not.toContain("claude-sonnet-5");
  });

  it("omits rows whose field is missing instead of inventing a value", () => {
    const svg = renderCard({ window: full.window });
    expect(svg).not.toMatch(/\$\d/);
    expect(svg).not.toContain("plan");
    expect(svg).not.toContain("CACHE HIT");
    expect(svg).not.toContain("AGENT");
    expect(svg).not.toContain("<rect x=\"330\"");
    expect(svg).toContain("npx tallywallet");
    expect(svg).toContain("October 2026");
    expect(svg).toContain("29 Sep → 29 Oct");
    const noPlan = renderCard({ ...full, plan: undefined, verdict: undefined });
    expect(noPlan).not.toContain("on a $200 plan");
    expect(noPlan).not.toContain("Keep it.");
    expect(noPlan).toContain(">$1,614<");
  });

  it("renders the square variant at 1080x1080", () => {
    const svg = renderCard(full, { square: true });
    expect(svg).toContain('width="1080" height="1080"');
    expect(svg).toContain('viewBox="0 0 1080 1080"');
    expect(svg).toContain(">$1,614<");
    expect(svg).toContain("Keep it.");
  });

  it("renders the dark variant on the terminal background", () => {
    const light = renderCard(full);
    const dark = renderCard(full, { dark: true });
    expect(light).toContain('fill="#ffffff"');
    expect(dark).toContain('fill="#0b0e14"');
    expect(dark).toContain("#e8eaf0");
    expect(dark).not.toContain("#1f2b4d");
    expect(dark).toContain("#f7941d");
  });

  it("replaces model names with the vendor family when redacting, merging rows", () => {
    const svg = renderCard(full, { redactModels: true });
    expect(svg).not.toContain("claude-fable-5-1");
    expect(svg).not.toContain("claude-opus");
    expect(svg).toContain(">claude<");
    expect(svg).toContain(">100%<");
    const rows = redactModels([
      { model: "claude-opus-5-5", usd: 10, share: 0.5 },
      { model: "openai/gpt-5.5", usd: 6, share: 0.3 },
      { model: "gemini-3-pro", usd: 4, share: 0.2 },
    ]);
    expect(rows.map((r) => r.model)).toEqual(["claude", "openai", "gemini"]);
  });

  it("escapes text that came from logs", () => {
    const svg = renderCard({ ...full, verdict: "a < b & \"c\"", agents: ["<Tool>"] });
    expect(svg).toContain("a &lt; b &amp; &quot;c&quot;");
    expect(svg).toContain("&lt;Tool&gt;");
    expect(svg).not.toContain("<Tool>");
  });

  it("wraps a long verdict and never writes more lines than fit", () => {
    const long = "You paid about $412 at API rates. Max 20x is $200 flat for the same Claude Code usage, and it keeps going on and on past the width of the card so it has to wrap and then be cut.";
    const lines = wrap(long, 82, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(83);
    expect(wrap("short", 82, 2)).toEqual(["short"]);
  });
});

describe("helpers", () => {
  it("formats money without false precision", () => {
    expect(cardMoney(1614.23)).toBe("$1,614");
    expect(cardMoney(200)).toBe("$200");
    expect(cardMoney(4.2)).toBe("$4.20");
  });
  it("names the month of the window end", () => {
    expect(monthLabel("2026-10-29")).toBe("October 2026");
    expect(monthLabel("2027-01-03")).toBe("January 2027");
  });
  it("maps models to vendor families", () => {
    expect(vendorFamily("claude-fable-5-1")).toBe("claude");
    expect(vendorFamily("gpt-5.5-codex")).toBe("openai");
    expect(vendorFamily("o3-pro")).toBe("openai");
    expect(vendorFamily("google/gemini-3-pro")).toBe("gemini");
    expect(vendorFamily("deepseek/deepseek-v4.1-flash")).toBe("deepseek");
    expect(vendorFamily("kimi-k2")).toBe("kimi");
  });
});
