import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  getProvider,
  insertRouteEvent,
  listCreditPools,
  listRouteEvents,
  redact,
  sumPoolSpend,
  toSafeError,
  type CreditPoolRow,
  type Db,
  type FetchLike,
  type Keystore,
  type RouteEventRow,
} from "@tally/core";
import { choose, type Decision, type Policy, type Shape, type Upstream } from "./policy.js";
import { poolBalance, type PoolBalance } from "./pools.js";
import { estimateCostUsd, expectedPrice, usageFromAnthropic, usageFromOpenAI, type Usage } from "./pricing.js";
import { anthropicMessageToSSE, anthropicToOpenAIRequest, openAIToAnthropicResponse, type AnthropicRequest } from "./translate.js";
import { SSEUsageSniffer } from "./sse.js";
import { reconcileAnthropicPool } from "./reconcile.js";

export const DEFAULT_PORT = 7411;
const DEFAULT_UPSTREAMS: Record<Upstream, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  openrouter: "https://openrouter.ai",
};
const MAX_BODY = 64 * 1024 * 1024;

export interface RouterOptions {
  db: Db;
  keystore: Keystore;
  port?: number;
  /** Loopback only. Anything else is refused: the router holds decrypted keys. */
  host?: "127.0.0.1" | "::1" | "localhost";
  policy?: Policy;
  upstreams?: Partial<Record<Upstream, string>>;
  fetch?: FetchLike;
  now?: () => Date;
  /** Reconcile Anthropic pools from the Admin API cost report on this interval. Default 1h; 0 disables. */
  reconcileIntervalMs?: number;
  /** One line per request, already redacted. Default: silent. */
  log?: (line: string) => void;
}

export interface RouterStatus {
  listening: string | null;
  keys: string[];
  adminKey: boolean;
  pools: PoolBalance[];
  events: RouteEventRow[];
  /** "N days left, $X unused" per pool. */
  headline: string[];
}

export interface RouterHandle {
  url: string;
  port: number;
  status(): RouterStatus;
  reconcileNow(): Promise<void>;
  close(): Promise<void>;
}

type J = Record<string, unknown>;

/** Pools with balances, the way both the server and the CLI read them. */
export function readPools(db: Db, now: Date = new Date()): PoolBalance[] {
  return listCreditPools(db).map((p) => poolBalance(p, now, (since) => sumPoolSpend(db, p.id, since)));
}

export function headline(b: PoolBalance): string {
  const left = b.expired ? "expired" : b.daysLeft == null ? "no expiry" : `${b.daysLeft} day${b.daysLeft === 1 ? "" : "s"} left`;
  return `${b.pool.provider}${b.pool.label ? ` (${b.pool.label})` : ""}: ${left}, $${b.unusedUsd.toFixed(2)} unused of $${b.pool.amount_usd.toFixed(2)}`;
}

export function routerStatus(db: Db, opts: { listening?: string | null; keys?: string[]; adminKey?: boolean; now?: Date; limit?: number } = {}): RouterStatus {
  const pools = readPools(db, opts.now);
  return {
    listening: opts.listening ?? null,
    keys: opts.keys ?? ["anthropic", "openai", "openrouter"].filter((id) => getProvider(db, id)),
    adminKey: opts.adminKey ?? Boolean(getProvider(db, "anthropic-admin")),
    pools,
    events: listRouteEvents(db, opts.limit ?? 20),
    headline: pools.map(headline),
  };
}

export async function startRouter(opts: RouterOptions): Promise<RouterHandle> {
  const host = opts.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("The router binds to loopback only");
  const db = opts.db;
  const now = opts.now ?? (() => new Date());
  const fetchFn: FetchLike = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const upstreams = { ...DEFAULT_UPSTREAMS, ...opts.upstreams };
  const policy = opts.policy ?? {};
  const log = opts.log ?? (() => {});

  // Decrypt once. These never leave this closure except as request headers to the upstream.
  const keys = new Map<string, string>();
  for (const id of ["anthropic", "openai", "openrouter", "anthropic-admin"]) {
    const row = getProvider(db, id);
    if (row) keys.set(id, opts.keystore.open(row.key_ciphertext));
  }
  const secrets = [...keys.values()];
  const safe = (s: string) => redact(s, secrets);

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const e = toSafeError(err, secrets, "router");
      log(`error ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "tally_router", message: e.message } }));
      } else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/status" || path === "/health")) {
      const body = path === "/health" ? { ok: true } : routerStatus(db, { listening: handle_.url, keys: [...keys.keys()].filter((k) => k !== "anthropic-admin"), adminKey: keys.has("anthropic-admin"), now: now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found", message: `No route for ${req.method} ${path}` } }));
      return;
    }

    const shape: Shape | undefined = path === "/v1/chat/completions" ? "openai" : path === "/v1/messages" || path === "/v1/messages/count_tokens" ? "anthropic" : undefined;
    if (!shape) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found", message: `No route for POST ${path}. Use /v1/chat/completions or /v1/messages.` } }));
      return;
    }

    const raw = await readBody(req);
    let body: J;
    try {
      body = JSON.parse(raw) as J;
    } catch {
      fail(res, shape, 400, "Request body is not JSON");
      return;
    }
    const model = typeof body.model === "string" ? body.model : "";
    if (!model) {
      fail(res, shape, 400, "Missing `model`");
      return;
    }
    const job = (firstHeader(req, "x-tally-job") ?? url.searchParams.get("job") ?? null)?.slice(0, 120) ?? null;
    const stream = body.stream === true;

    // count_tokens: a convenience for Claude Code's /context. Anthropic only; 404 otherwise so the client estimates.
    if (path === "/v1/messages/count_tokens") {
      const key = keys.get("anthropic");
      if (!key) {
        fail(res, shape, 404, "count_tokens needs an anthropic key (tally connect anthropic)");
        return;
      }
      const up = await fetchFn(`${upstreams.anthropic}/v1/messages/count_tokens${url.search}`, {
        method: "POST",
        headers: anthropicHeaders(req, key),
        body: raw,
      });
      await relay(up, res, null);
      return;
    }

    const t = now();
    const pools = readPools(db, t);
    const decision = choose(policy, { model, shape, stream, job }, {
      pools,
      keys: new Set([...keys.keys()].filter((k) => k !== "anthropic-admin")),
      price: (u, m) => expectedPrice(db, u, m),
    });
    if (decision.blocked) {
      insertRouteEvent(db, { ts: t.toISOString(), model, upstream: decision.upstream, reason: decision.reason, job, status: 503 });
      fail(res, shape, 503, decision.blocked);
      return;
    }
    const key = keys.get(decision.upstream)!;
    const target = buildUpstream(decision, shape, body, raw, req, key, stream);

    const record = (r: { status: number; usage?: Usage }) => {
      const ok = r.status >= 200 && r.status < 300;
      const est = ok && r.usage ? estimateCostUsd(db, decision.upstream, decision.upstreamModel, r.usage) : null;
      insertRouteEvent(db, {
        ts: t.toISOString(),
        model,
        upstream: decision.upstream,
        upstreamModel: decision.upstreamModel,
        reason: decision.reason,
        inputTokens: r.usage?.inputTokens ?? 0,
        outputTokens: r.usage?.outputTokens ?? 0,
        cachedTokens: r.usage?.cachedTokens ?? 0,
        estCostUsd: est,
        poolId: ok ? decision.poolId : null,
        job,
        status: r.status,
      });
      log(safe(`${r.status} ${model} → ${decision.upstream}/${decision.upstreamModel} ${decision.reason}${job ? ` job=${job}` : ""}${est != null ? ` $${est < 0.01 ? est.toFixed(6) : est.toFixed(4)}` : ""}`));
    };

    const ac = new AbortController();
    req.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    let up: Response;
    try {
      up = await fetchFn(target.url, { method: "POST", headers: target.headers, body: target.body, signal: ac.signal });
    } catch (err) {
      const e = toSafeError(err, secrets, "upstream");
      record({ status: 502, usage: undefined });
      fail(res, shape, 502, `Upstream ${decision.upstream} unreachable: ${e.message}`);
      return;
    }


    if (target.translate === "anthropic-from-openai") {
      // Non-streaming upstream call; re-shape, and if the client asked for a stream, synthesize one.
      const text = await up.text();
      if (!up.ok) {
        record({ status: up.status });
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return;
      }
      let parsed: J;
      try {
        parsed = JSON.parse(text) as J;
      } catch {
        record({ status: 502 });
        fail(res, shape, 502, "Upstream returned non-JSON");
        return;
      }
      const msg = openAIToAnthropicResponse(parsed, model);
      record({ status: up.status, usage: usageFromOpenAI(parsed.usage) });
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(anthropicMessageToSSE(msg));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(msg));
      }
      return;
    }

    await relay(up, res, (usage) => record({ status: up.status, usage }), stream ? target.responseShape : undefined, up.ok ? target.responseShape : undefined);
  }

  /** Pass an upstream response through unchanged, sniffing usage from JSON or SSE. */
  async function relay(up: Response, res: ServerResponse, onDone: ((usage?: Usage) => void) | null, streamShape?: Shape, jsonShape?: Shape): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [k, v] of up.headers) {
      if (k === "content-length" || k === "transfer-encoding" || k === "connection" || k === "content-encoding") continue;
      headers[k] = v;
    }
    const isSSE = (up.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isSSE) {
      const text = await up.text();
      let usage: Usage | undefined;
      if (jsonShape && up.ok) {
        try {
          const j = JSON.parse(text) as J;
          usage = jsonShape === "openai" ? usageFromOpenAI(j.usage) : usageFromAnthropic(j.usage);
        } catch {
          /* not JSON: nothing to price */
        }
      }
      res.writeHead(up.status, headers);
      res.end(text);
      onDone?.(usage);
      return;
    }

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let seen = false;
    const sniff = new SSEUsageSniffer((j) => {
      if (streamShape === "openai") {
        const u = usageFromOpenAI(j.usage);
        if (u) {
          Object.assign(usage, u);
          seen = true;
        }
      } else if (streamShape === "anthropic") {
        const type = j.type;
        if (type === "message_start") {
          const u = usageFromAnthropic((j.message as J | undefined)?.usage);
          if (u) {
            Object.assign(usage, u);
            seen = true;
          }
        } else if (type === "message_delta" && j.usage) {
          const u = j.usage as J;
          if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
          if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
          if (typeof u.cache_read_input_tokens === "number") usage.cachedTokens = u.cache_read_input_tokens;
          seen = true;
        }
      }
    });
    res.writeHead(up.status, headers);
    const decoder = new TextDecoder();
    try {
      if (up.body) {
        for await (const chunk of up.body as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          if (streamShape) sniff.push(decoder.decode(chunk, { stream: true }));
        }
      }
    } finally {
      res.end();
      onDone?.(seen ? usage : undefined);
    }
  }

  function buildUpstream(d: Decision, shape: Shape, body: J, raw: string, req: IncomingMessage, key: string, stream: boolean) {
    const base = upstreams[d.upstream];
    const incomingQuery = new URL(req.url ?? "/", "http://x").search;
    const bearer = { Authorization: `Bearer ${key}`, "content-type": "application/json", Accept: stream ? "text/event-stream" : "application/json" };

    if (shape === "anthropic") {
      if (d.upstream === "anthropic") {
        // Pass through unchanged: same body (model re-written only if the client used a slug), same anthropic-* headers.
        const out = body.model === d.upstreamModel ? raw : JSON.stringify({ ...body, model: d.upstreamModel });
        return { url: `${base}/v1/messages${incomingQuery}`, headers: anthropicHeaders(req, key), body: out, responseShape: "anthropic" as Shape };
      }
      if (d.upstream === "openrouter") {
        const headers: Record<string, string> = { ...bearer, "anthropic-version": firstHeader(req, "anthropic-version") ?? "2023-06-01" };
        const beta = firstHeader(req, "anthropic-beta");
        if (beta) headers["anthropic-beta"] = beta;
        return { url: `${base}/api/v1/messages`, headers, body: JSON.stringify({ ...body, model: d.upstreamModel }), responseShape: "anthropic" as Shape };
      }
      // openai direct only speaks chat completions: translate, non-streaming upstream.
      const translated = anthropicToOpenAIRequest(body as AnthropicRequest, d.upstreamModel);
      translated.stream = false;
      delete translated.stream_options;
      return { url: `${base}/v1/chat/completions`, headers: { ...bearer, Accept: "application/json" }, body: JSON.stringify(translated), responseShape: "anthropic" as Shape, translate: "anthropic-from-openai" as const };
    }

    // OpenAI shape. Every upstream has a chat completions endpoint.
    const out: J = { ...body, model: d.upstreamModel };
    if (stream) out.stream_options = { ...(body.stream_options as J | undefined), include_usage: true };
    if (d.upstream === "openrouter") {
      out.usage = { include: true };
      if (d.openrouterProvider) {
        const prov: J = { ...((body.provider as J | undefined) ?? {}) };
        if (d.openrouterProvider.sort) prov.sort = d.openrouterProvider.sort;
        if (d.openrouterProvider.order?.length) prov.order = d.openrouterProvider.order;
        out.provider = prov;
      }
      return { url: `${base}/api/v1/chat/completions`, headers: { ...bearer, "HTTP-Referer": "https://github.com/bsssm/tally", "X-OpenRouter-Title": "Tally router" }, body: JSON.stringify(out), responseShape: "openai" as Shape };
    }
    if (d.upstream === "anthropic") {
      const headers: Record<string, string> = { ...bearer, "x-api-key": key };
      return { url: `${base}/v1/chat/completions`, headers, body: JSON.stringify(out), responseShape: "openai" as Shape };
    }
    return { url: `${base}/v1/chat/completions`, headers: bearer, body: JSON.stringify(out), responseShape: "openai" as Shape };
  }

  // --- reconcile loop -------------------------------------------------
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> | undefined;
  /** One reconcile at a time: a startup run and an explicit call share the same promise. */
  function reconcileNow(): Promise<void> {
    if (!inflight) inflight = reconcileAll().finally(() => (inflight = undefined));
    return inflight;
  }
  async function reconcileAll(): Promise<void> {
    const admin = keys.get("anthropic-admin");
    if (!admin) return;
    for (const pool of listCreditPools(db).filter((p: CreditPoolRow) => p.provider === "anthropic")) {
      try {
        const r = await reconcileAnthropicPool(db, pool, admin, { fetch: fetchFn, baseUrl: upstreams.anthropic, now: now(), minIntervalMs: opts.reconcileIntervalMs ?? 3_600_000 });
        if (!r.skipped) log(`reconciled pool ${pool.id} from the Admin API: $${r.spentUsd.toFixed(2)} spent this period`);
      } catch (err) {
        log(`reconcile pool ${pool.id} failed: ${toSafeError(err, secrets).message}`);
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? DEFAULT_PORT);
  const handle_: RouterHandle = {
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    port,
    status: () => routerStatus(db, { listening: handle_.url, keys: [...keys.keys()].filter((k) => k !== "anthropic-admin"), adminKey: keys.has("anthropic-admin"), now: now() }),
    reconcileNow,
    close: () =>
      new Promise<void>((resolve) => {
        if (timer) clearInterval(timer);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
  const every = opts.reconcileIntervalMs ?? 3_600_000;
  if (keys.has("anthropic-admin") && every > 0) {
    void reconcileNow();
    timer = setInterval(() => void reconcileNow(), every);
    timer.unref();
  }
  return handle_;
}

// --- helpers --------------------------------------------------------

function anthropicHeaders(req: IncomingMessage, key: string): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": firstHeader(req, "anthropic-version") ?? "2023-06-01",
    Accept: firstHeader(req, "accept") ?? "application/json",
  };
  const beta = firstHeader(req, "anthropic-beta");
  if (beta) h["anthropic-beta"] = beta;
  return h;
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function fail(res: ServerResponse, shape: Shape, status: number, message: string): void {
  const body =
    shape === "openai"
      ? { error: { message, type: "tally_router", code: status } }
      : { type: "error", error: { type: status === 404 ? "not_found_error" : "api_error", message } };
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
