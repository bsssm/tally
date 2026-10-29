import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, getProvider, listProviders, summarizeByModel, summarizeByProvider, upsertProvider, type Db } from "./db.js";
import { openKeystore, type Keystore } from "./keystore.js";
import { syncProviders } from "./sync.js";
import { dbPath } from "./paths.js";
import { fakeFetch, fixture, json } from "./adapters/__fixtures__/index.js";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef";
const FROM = new Date("2026-10-01T00:00:00Z");
const TO = new Date("2026-10-28T00:00:00Z");

let home: string;
let db: Db;
let keystore: Keystore;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tally-test-"));
  process.env.TALLY_HOME = home;
  process.env.TALLY_MASTER_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  keystore = await openKeystore();
  db = openDb();
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function connect(fetch = managementBackend()) {
  upsertProvider(db, { id: "openrouter", name: "OpenRouter", keyCiphertext: keystore.seal(KEY), keyType: "admin" });
  return fetch;
}
function managementBackend() {
  return fakeFetch({
    "/key": () => json(fixture("openrouter-key-management.json")),
    "/activity": () => json(fixture("openrouter-activity.json")),
    "/models": () => json(fixture("openrouter-models.json")),
  });
}

describe("connect + sync (OpenRouter, fixtures)", () => {
  it("stores the key encrypted: the DB file never contains it in plaintext", () => {
    connect();
    const row = getProvider(db, "openrouter")!;
    expect(row.key_ciphertext.toString("latin1")).not.toContain("sk-or-v1");
    expect(keystore.open(row.key_ciphertext)).toBe(KEY);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(dbPath()).toString("latin1");
    expect(bytes).not.toContain(KEY);
    expect(bytes).not.toContain("sk-or-v1");
  });

  it("sync writes a correct ledger and summary", async () => {
    const f = connect();
    const reports = await syncProviders(db, keystore, { from: FROM, to: TO, adapterOptions: { fetch: f } });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ providerId: "openrouter", status: "ok", rows: 7, models: 5, requests: 1355 });
    expect(reports[0].costUsd).toBeCloseTo(24.0, 6);
    expect(reports[0].priceRows).toBe(3);

    const [p] = summarizeByProvider(db, "2026-10-01", "2026-10-28");
    expect(p.costUsd).toBeCloseTo(24.0, 6);
    expect(p.inputTokens).toBe(1_800_000 + 1_200_000 + 500_000 + 1_300_000 + 900_000 + 700_000 + 3_000_000);
    expect(p.models).toBe(5);
    const byModel = summarizeByModel(db, "2026-10-01", "2026-10-28");
    expect(byModel[0]).toMatchObject({ model: "anthropic/claude-sonnet-4.5" });
    expect(byModel[0].costUsd).toBeCloseTo(21.5, 6);
    expect(byModel.find((m) => m.model === "meta-llama/llama-3.3-70b-instruct")!.costUsd).toBeCloseTo(1.25, 6);
    expect(listProviders(db)[0].last_synced_at).toBeTruthy();
  });

  it("re-running sync does not double count", async () => {
    const f = connect();
    await syncProviders(db, keystore, { from: FROM, to: TO, adapterOptions: { fetch: f } });
    await syncProviders(db, keystore, { from: FROM, to: TO, adapterOptions: { fetch: f } });
    const [p] = summarizeByProvider(db, "2026-10-01", "2026-10-28");
    expect(p.costUsd).toBeCloseTo(24.0, 6);
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 7 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE status='ok'").get()).toEqual({ n: 2 });
  });

  it("an adapter failure is recorded without the key and does not abort other providers", async () => {
    const f = connect(fakeFetch({
      "/key": () => json(fixture("openrouter-key-management.json")),
      "/activity": () => new Response(`boom ${KEY}`, { status: 502 }),
    }));
    const [r] = await syncProviders(db, keystore, { from: FROM, to: TO, adapterOptions: { fetch: f } });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/502/);
    expect(r.error).not.toContain(KEY);
    const run = db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get() as { status: string; error: string };
    expect(run.status).toBe("error");
    expect(run.error).not.toContain(KEY);
  });
});
