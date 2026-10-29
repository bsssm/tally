import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCreditPool, dbPath, getCreditPool, listRouteEvents, openDb, openKeystore, upsertPrices, upsertProvider, type Db, type Keystore,
} from "@tally/core";
import { startRouter, type RouterHandle } from "./server.js";

const ANTHROPIC_KEY = "sk-ant-api03-ROUTERTESTKEYabcdefghijklmnopqrstuvwxyz0123456789";
const ADMIN_KEY = "sk-ant-admin01-ROUTERADMINKEYabcdefghijklmnopqrstuvwxyz0123";
const OR_KEY = "sk-or-v1-ROUTERTESTKEY0123456789abcdef0123456789abcdef";
const OPENAI_KEY = "sk-proj-ROUTERTESTKEY0123456789abcdefghijklmnopqrstuvwxyz";
const NOW = new Date("2026-10-29T18:00:00Z");

interface Seen { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/** A fake upstream that records what it receives and answers in whichever shape the path implies. */
function mockUpstream(): Promise<{ url: string; seen: Seen[]; server: Server; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const path = req.url ?? "/";
      seen.push({ method: req.method ?? "", path, headers: req.headers as Record<string, string>, body });
      const stream = body?.stream === true;
      const sse = (events: string) => {
        res.writeHead(200, { "content-type": "text/event-stream", "x-should-retry": "false" });
        res.end(events);
      };
      if ((body?.model as string | undefined)?.includes("boom")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"model boom: Extra inputs are not permitted"}}');
        return;
      }
      if (path.startsWith("/v1/organizations/cost_report")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ starting_at: "2026-10-07T00:00:00Z", ending_at: "2026-10-08T00:00:00Z", results: [{ currency: "USD", amount: "1234.5" }, { currency: "USD", amount: "100" }] }], has_more: false, next_page: null }));
        return;
      }
      if (path.startsWith("/v1/messages") || path.startsWith("/api/v1/messages")) {
        if (stream) {
          return sse(
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body?.model, content: [], usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 } } })}\n\n` +
              `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
              `event: ping\ndata: {"type":"ping"}\n\n` +
              `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
              `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
              `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":500}}\n\n` +
              `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
          );
        }
        res.writeHead(200, { "content-type": "application/json", "request-id": "req_123" });
        res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body?.model, content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
        return;
      }
      // chat completions (anthropic compat, openrouter, openai)
      const isOpenRouter = path.startsWith("/api/");
      const usage = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 }, ...(isOpenRouter ? { cost: 0.0123 } : {}) };
      if (stream) {
        return sse(
          `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n` +
            `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
            `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage })}\n\n` +
            `data: [DONE]\n\n`,
        );
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", model: body?.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }], usage }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, seen, server, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let home: string;
let db: Db;
let keystore: Keystore;
let up: Awaited<ReturnType<typeof mockUpstream>>;
let openaiUp: Awaited<ReturnType<typeof mockUpstream>>;
let router: RouterHandle | undefined;
const logs: string[] = [];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tally-router-"));
  process.env.TALLY_HOME = home;
  process.env.TALLY_MASTER_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  keystore = await openKeystore();
  db = openDb();
  up = await mockUpstream();
  openaiUp = await mockUpstream();
  logs.length = 0;
});
afterEach(async () => {
  await router?.close();
  router = undefined;
  await up.close();
  await openaiUp.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function storeKey(id: string, key: string, keyType: "api" | "admin" = "api") {
  upsertProvider(db, { id, name: id, keyCiphertext: keystore.seal(key), keyType });
}
async function start(extra: Partial<Parameters<typeof startRouter>[0]> = {}) {
  router = await startRouter({
    db, keystore, port: 0, now: () => NOW, log: (l) => logs.push(l),
    upstreams: { anthropic: up.url, openrouter: up.url, openai: openaiUp.url },
    reconcileIntervalMs: 0,
    ...extra,
  });
  return router;
}
const post = (r: RouterHandle, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${r.url}${path}`, { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer tally", ...headers }, body: JSON.stringify(body) });

describe("router round trips (mock upstream, no network)", () => {
  it("OpenAI-shaped Claude call rides the Anthropic pool through the compat endpoint, priced and logged", async () => {
    storeKey("anthropic", ANTHROPIC_KEY);
    storeKey("openrouter", OR_KEY);
    const pool = addCreditPool(db, { provider: "anthropic", amountUsd: 200, resetsOn: 7, label: "Max credits" });
    const r = await start();

    const res = await post(r, "/v1/chat/completions", { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] }, { "X-Tally-Job": "nightly-evals" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0].message.content).toBe("hi");

    const [s] = up.seen;
    expect(s.path).toBe("/v1/chat/completions");
    expect(s.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(s.headers.authorization).toBe(`Bearer ${ANTHROPIC_KEY}`);
    expect(s.body?.model).toBe("claude-opus-5-5");
    expect(s.headers["x-tally-job"]).toBeUndefined();

    const [ev] = listRouteEvents(db);
    expect(ev).toMatchObject({ model: "claude-opus-5-5", upstream: "anthropic", pool_id: pool.id, job: "nightly-evals", input_tokens: 1000, output_tokens: 500, status: 200 });
    expect(ev.est_cost_usd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 8);
    expect(ev.reason).toContain("anthropic credits");

    const st = r.status();
    expect(st.pools[0].unusedUsd).toBeCloseTo(200 - 0.014, 6);
    expect(st.headline[0]).toBe("anthropic (Max credits): 9 days left, $199.99 unused of $200.00");
    expect(st.keys).toEqual(["anthropic", "openrouter"]);
  });

  it("Anthropic-shaped streaming call passes through byte-for-byte and the usage is sniffed from the SSE", async () => {
    storeKey("anthropic", ANTHROPIC_KEY);
    addCreditPool(db, { provider: "anthropic", amountUsd: 200, resetsOn: 7 });
    const r = await start();

    const res = await fetch(`${r.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "tally", "anthropic-version": "2023-06-01", "anthropic-beta": "context-1m-2025-08-07,effort-2025-11-24" },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-should-retry")).toBe("false");
    const text = await res.text();
    expect(text).toContain("event: ping");
    expect(text).toContain('"text":"hi"');
    expect(text.endsWith(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)).toBe(true);

    const [s] = up.seen;
    expect(s.path).toBe("/v1/messages?beta=true");
    expect(s.headers["anthropic-beta"]).toBe("context-1m-2025-08-07,effort-2025-11-24");
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    expect(s.headers["x-api-key"]).toBe(ANTHROPIC_KEY);

    const [ev] = listRouteEvents(db);
    expect(ev).toMatchObject({ input_tokens: 1000, output_tokens: 500, cached_tokens: 4000, upstream: "anthropic" });
    // 1000 uncached @ $4 + 500 out @ $20 + 4000 cache reads @ $0.20 + 2000 cache writes @ $5, per MTok
    expect(ev.est_cost_usd).toBeCloseTo((1000 * 4 + 500 * 20 + 4000 * 0.2 + 2000 * 5) / 1e6, 8);
  });

  it("Anthropic-shaped open model goes to OpenRouter's /api/v1/messages with the slug and a bearer key", async () => {
    storeKey("openrouter", OR_KEY);
    const r = await start();
    const res = await post(r, "/v1/messages", { model: "meta-llama/llama-3.3-70b-instruct", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, { "anthropic-version": "2023-06-01" });
    expect(res.status).toBe(200);
    expect(res.headers.get("request-id")).toBe("req_123");
    const [s] = up.seen;
    expect(s.path).toBe("/api/v1/messages");
    expect(s.headers.authorization).toBe(`Bearer ${OR_KEY}`);
    expect(s.headers["anthropic-version"]).toBe("2023-06-01");
    expect(s.body?.model).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(listRouteEvents(db)[0]).toMatchObject({ upstream: "openrouter", pool_id: null, reason: "cheapest: openrouter sort=price" });
  });

  it("OpenAI-shaped open model: OpenRouter sort=price, usage.cost preferred, ?job= tag, expected price from the ledger", async () => {
    storeKey("openrouter", OR_KEY);
    upsertPrices(db, [{ providerId: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", inputPerM: 0.13, outputPerM: 0.39, cachedPerM: null, isFree: false, source: "test", updatedAt: "2026-10-28T00:00:00Z" }]);
    const r = await start({ policy: { openrouterOrder: ["deepinfra", "together"] } });
    const res = await post(r, "/v1/chat/completions?job=backfill", { model: "meta-llama/llama-3.3-70b-instruct", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
    const [s] = up.seen;
    expect(s.path).toBe("/api/v1/chat/completions");
    expect(s.body?.provider).toEqual({ sort: "price", order: ["deepinfra", "together"] });
    expect(s.body?.usage).toEqual({ include: true });
    expect(s.body?.stream_options).toEqual({ include_usage: true });
    const [ev] = listRouteEvents(db);
    expect(ev).toMatchObject({ job: "backfill", input_tokens: 1000, output_tokens: 500, upstream: "openrouter" });
    expect(ev.est_cost_usd).toBeCloseTo(0.0123, 8);
    expect(logs[0]).toContain("job=backfill");
  });

  it("Anthropic-shaped GPT call with an OpenAI key is translated both ways, streaming synthesized", async () => {
    storeKey("openai", OPENAI_KEY);
    const r = await start();
    const res = await post(r, "/v1/messages", { model: "gpt-4o", max_tokens: 50, system: "terse", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg).toMatchObject({ type: "message", model: "gpt-4o", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] });
    expect(msg.usage).toEqual({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    const [s] = openaiUp.seen;
    expect(s.path).toBe("/v1/chat/completions");
    expect(s.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(s.body?.messages).toEqual([{ role: "system", content: "terse" }, { role: "user", content: "hi" }]);
    expect(s.body?.max_completion_tokens).toBe(50);

    const streamed = await post(r, "/v1/messages", { model: "gpt-4o", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");
    const sse = await streamed.text();
    expect(sse.startsWith("event: message_start")).toBe(true);
    expect(sse).toContain('"text_delta","text":"hi"');
    expect(openaiUp.seen[1].body?.stream).toBe(false);
    expect(listRouteEvents(db)).toHaveLength(2);
    expect(listRouteEvents(db)[0]).toMatchObject({ upstream: "openai", reason: "openai direct (closed model, key stored, no credits left)" });
  });

  it("no key for the route → 503 with a connect hint, logged, and no secret ever reaches the DB or the log", async () => {
    storeKey("anthropic", ANTHROPIC_KEY);
    const r = await start();
    const res = await post(r, "/v1/chat/completions", { model: "qwen/qwen3-32b", messages: [] });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("tally connect openrouter");
    expect(listRouteEvents(db)[0]).toMatchObject({ status: 503, reason: "no key", model: "qwen/qwen3-32b" });

    await post(r, "/v1/chat/completions", { model: "claude-opus-5-5", messages: [] });
    db.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(dbPath()).toString("latin1");
    expect(bytes).not.toContain(ANTHROPIC_KEY);
    expect(logs.join("\n")).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(r.status())).not.toContain(ANTHROPIC_KEY);
  });

  it("forwards upstream errors unmodified so clients can match the wording", async () => {
    storeKey("anthropic", ANTHROPIC_KEY);
    addCreditPool(db, { provider: "anthropic", amountUsd: 200, resetsOn: 7 });
    const r = await start();
    const res = await post(r, "/v1/messages", { model: "claude-boom", max_tokens: 1, messages: [] });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"type":"error","error":{"type":"invalid_request_error","message":"model boom: Extra inputs are not permitted"}}');
    const [ev] = listRouteEvents(db);
    expect(ev.status).toBe(400);
    expect(ev.pool_id).toBeNull(); // a failed call does not draw down the pool
    expect(ev.est_cost_usd).toBeNull();
  });

  it("reconciles the Anthropic pool from the Admin API cost report (cents → USD) and reports admin-api accounting", async () => {
    storeKey("anthropic", ANTHROPIC_KEY);
    storeKey("anthropic-admin", ADMIN_KEY, "admin");
    const pool = addCreditPool(db, { provider: "anthropic", amountUsd: 200, resetsOn: 7 });
    const r = await start({ reconcileIntervalMs: 3_600_000 });
    await r.reconcileNow();
    const [call] = up.seen.filter((s) => s.path.startsWith("/v1/organizations/cost_report"));
    expect(call.headers["x-api-key"]).toBe(ADMIN_KEY);
    expect(call.path).toContain("starting_at=2026-10-07T00%3A00%3A00Z");
    expect(getCreditPool(db, pool.id)!.reconciled_spent_usd).toBeCloseTo(13.35, 6); // "1234.5" + "100" cents
    const st = r.status();
    expect(st.pools[0].accounting).toBe("admin-api");
    expect(st.pools[0].unusedUsd).toBeCloseTo(186.65, 6);
    expect(st.adminKey).toBe(true);
    // A second call inside the hour is skipped (cached in the pool row).
    await r.reconcileNow();
    expect(up.seen.filter((s) => s.path.startsWith("/v1/organizations/cost_report"))).toHaveLength(1);
  });

  it("GET /status serves pools + events for the dashboard; unknown routes 404; binds loopback only", async () => {
    storeKey("openrouter", OR_KEY);
    const r = await start();
    expect(r.url.startsWith("http://127.0.0.1:")).toBe(true);
    const st = (await (await fetch(`${r.url}/status`)).json()) as { pools: unknown[]; events: unknown[]; keys: string[] };
    expect(st).toMatchObject({ pools: [], events: [], keys: ["openrouter"] });
    expect((await fetch(`${r.url}/v1/embeddings`, { method: "POST", body: "{}" })).status).toBe(404);
    await expect(startRouter({ db, keystore, host: "0.0.0.0" as never, port: 0 })).rejects.toThrow(/loopback/);
  });
});
