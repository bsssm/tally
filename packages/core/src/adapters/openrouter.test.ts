import { describe, expect, it } from "vitest";
import { OpenRouterAdapter } from "./openrouter.js";
import { fakeFetch, fixture, json } from "./__fixtures__/index.js";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef";
const FROM = new Date("2026-10-01T00:00:00Z");
const TO = new Date("2026-10-28T00:00:00Z");

function managementBackend() {
  return fakeFetch({
    "/key": () => json(fixture("openrouter-key-management.json")),
    "/activity": ({ headers }) =>
      headers.Authorization === `Bearer ${KEY}` ? json(fixture("openrouter-activity.json")) : json({ error: "bad" }, 401),
    "/models": () => json(fixture("openrouter-models.json")),
  });
}

describe("OpenRouterAdapter", () => {
  it("validates a key via /key and sends it as a bearer token", async () => {
    const f = managementBackend();
    const a = new OpenRouterAdapter({ fetch: f });
    expect(await a.validateKey(KEY)).toBe(true);
    expect(f.calls[0]).toMatchObject({ path: "/key", headers: { Authorization: `Bearer ${KEY}` } });
  });

  it("returns false (not an exception) for a rejected key", async () => {
    const a = new OpenRouterAdapter({ fetch: fakeFetch({ "/key": () => json({ error: "unauthorized" }, 401) }) });
    expect(await a.validateKey("sk-or-v1-nope")).toBe(false);
  });

  it("describes a management key", async () => {
    const a = new OpenRouterAdapter({ fetch: managementBackend() });
    const info = await a.describeKey(KEY);
    expect(info).toMatchObject({ label: "tally (management)", isAdmin: true, usageMonthlyUsd: 61.95 });
  });

  it("normalizes /activity rows into UsageEvents inside the window", async () => {
    const a = new OpenRouterAdapter({ fetch: managementBackend() });
    const { events, notes } = await a.fetchUsage(KEY, FROM, TO);
    // 8 fixture rows, one is 2026-09-20 and falls outside the window
    expect(events).toHaveLength(7);
    expect(events.every((e) => e.providerId === "openrouter")).toBe(true);
    expect(events.find((e) => e.date === "2026-09-20")).toBeUndefined();

    const sonnet1 = events.find((e) => e.model === "anthropic/claude-sonnet-4.5" && e.date === "2026-10-01")!;
    expect(sonnet1).toMatchObject({
      route: "Anthropic", inputTokens: 1_800_000, outputTokens: 420_000, cachedTokens: 600_000,
      reasoningTokens: 0, requests: 310, costUsd: 12.4,
    });
    // same model on two routes the same day stays as two rows
    expect(events.filter((e) => e.model === "meta-llama/llama-3.3-70b-instruct" && e.date === "2026-10-01")).toHaveLength(2);
    // BYOK spend is not counted as OpenRouter cost but is flagged
    const byok = events.find((e) => e.model === "openai/gpt-5-mini")!;
    expect(byok.costUsd).toBe(0);
    expect((byok.raw as { byok_usage_inference: number }).byok_usage_inference).toBe(2.3);
    expect(notes.join("\n")).toMatch(/BYOK/);

    const total = events.reduce((s, e) => s + e.costUsd, 0);
    expect(total).toBeCloseTo(12.4 + 0.85 + 0.4 + 9.1 + 0 + 0 + 1.25, 6);
  });

  it("with a regular key: no rows, but a note carrying the aggregate spend", async () => {
    const f = fakeFetch({
      "/key": () => json(fixture("openrouter-key-regular.json")),
      "/activity": () => json({ error: "management key required" }, 403),
    });
    const a = new OpenRouterAdapter({ fetch: f });
    const { events, notes } = await a.fetchUsage(KEY, FROM, TO);
    expect(events).toEqual([]);
    expect(notes[0]).toMatch(/Management key/);
    expect(notes[0]).toContain("$12.75");
    expect(notes[0]).not.toContain(KEY);
  });

  it("never leaks the key through an error message", async () => {
    const f = fakeFetch({
      "/key": () => json(fixture("openrouter-key-management.json")),
      "/activity": () => new Response(`upstream exploded while handling Bearer ${KEY}`, { status: 500 }),
    });
    const a = new OpenRouterAdapter({ fetch: f });
    await expect(a.fetchUsage(KEY, FROM, TO)).rejects.toSatisfy((e: Error) => !e.message.includes(KEY) && /500/.test(e.message));

    const dead = new OpenRouterAdapter({ fetch: async () => { throw new Error(`ECONNRESET ${KEY}`); } });
    await expect(dead.fetchUsage(KEY, FROM, TO)).rejects.toSatisfy((e: Error) => !e.message.includes(KEY));
  });

  it("normalizes /models pricing to USD per million tokens and marks free models", async () => {
    const a = new OpenRouterAdapter({ fetch: managementBackend() });
    const prices = await a.fetchPrices();
    const sonnet = prices.find((p) => p.model === "anthropic/claude-sonnet-4.5")!;
    expect(sonnet.inputPerM).toBeCloseTo(3, 9);
    expect(sonnet.outputPerM).toBeCloseTo(15, 9);
    expect(sonnet.cachedPerM).toBeCloseTo(0.3, 9);
    expect(sonnet.isFree).toBe(false);
    const llama = prices.find((p) => p.model === "meta-llama/llama-3.3-70b-instruct")!;
    expect(llama.inputPerM).toBeCloseTo(0.13, 9);
    expect(llama.cachedPerM).toBeNull();
    expect(prices.find((p) => p.model === "qwen/qwen3-coder:free")!.isFree).toBe(true);
  });
});
