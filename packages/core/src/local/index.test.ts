import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeLocalAgents } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("summarizeLocalAgents", () => {
  it("handles an empty HOME: four sources, none detected, nothing priced, no throw", async () => {
    const home = mkdtempSync(join(tmpdir(), "tally-emptyhome-"));
    const s = await summarizeLocalAgents("2026-10-01", "2026-10-31", { home });
    expect(s.sources.map((x) => x.source)).toEqual(["claude-code", "codex", "cursor", "gemini"]);
    expect(s.sources.every((x) => !x.detected && x.turns === 0 && x.apiEquivalentUsd === 0)).toBe(true);
    expect(s.apiEquivalentUsd).toBe(0);
    expect(s.turns).toBe(0);
    expect(s.events).toEqual([]);
    expect(s.sources.find((x) => x.source === "codex")!.path).toBe(join(home, ".codex", "sessions"));
  });

  it("combines every reader under one HOME and sums them", async () => {
    const home = mkdtempSync(join(tmpdir(), "tally-fullhome-"));
    cpSync(join(here, "__fixtures__", "codex"), join(home, ".codex"), { recursive: true });
    cpSync(join(here, "__fixtures__", "gemini"), join(home, ".gemini"), { recursive: true });
    mkdirSync(join(home, ".claude", "projects", "-p"), { recursive: true });
    cpSync(join(here, "__fixtures__", "session.jsonl"), join(home, ".claude", "projects", "-p", "s.jsonl"));
    const s = await summarizeLocalAgents("2026-10-01", "2026-10-31", { home, sources: ["claude-code", "codex", "gemini"] });
    const by = Object.fromEntries(s.sources.map((x) => [x.source, x]));
    expect(by["claude-code"].turns).toBe(2);
    expect(by.codex.turns).toBe(5);
    expect(by.gemini.turns).toBe(3);
    expect(s.turns).toBe(10);
    expect(s.apiEquivalentUsd).toBeCloseTo(by["claude-code"].apiEquivalentUsd + by.codex.apiEquivalentUsd + by.gemini.apiEquivalentUsd, 9);
    expect(new Set(s.events.map((e) => e.providerId))).toEqual(new Set(["claude-code", "codex", "gemini"]));
  });
});
