import * as p from "@clack/prompts";
import { getAdapter, listAdapterIds, PLANNED_PROVIDERS, TallyError, toSafeError, upsertProvider, type KeyType } from "@tally/core";
import { ctx } from "../context.js";
import { bold, dim, err, ok, warn } from "../ui.js";

export interface ConnectOpts {
  key?: string;
  keyStdin?: boolean;
  admin?: boolean;
}

/**
 * Providers whose key the router needs but that have no usage adapter yet (M2).
 * Validation is one cheap read; the key is stored encrypted like any other and
 * `tally providers` lists it. `tally connect anthropic --admin` stores an Admin API key
 * under `anthropic-admin` so the router can reconcile pool spend from the cost report.
 */
interface KeyOnlyProvider {
  id: string;
  displayName: string;
  keyType: KeyType;
  keyHelpUrl: string;
  validate(key: string): Promise<boolean>;
}

async function probe(url: string, headers: Record<string, string>, key: string, who: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  } catch (e) {
    throw new TallyError("network", `${who}: ${e instanceof Error ? e.message : String(e)}`, undefined, [key]);
  }
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new TallyError("http", `${who}: HTTP ${res.status}`, undefined, [key]);
  return true;
}

const KEY_ONLY: Record<string, KeyOnlyProvider> = {
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    keyType: "api",
    keyHelpUrl: "https://platform.claude.com/settings/keys",
    validate: (key) => probe("https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }, key, "Anthropic /v1/models"),
  },
  "anthropic-admin": {
    id: "anthropic-admin",
    displayName: "Anthropic (Admin API)",
    keyType: "admin",
    keyHelpUrl: "https://platform.claude.com/settings/admin-keys",
    validate: (key) => probe("https://api.anthropic.com/v1/organizations/me", { "x-api-key": key, "anthropic-version": "2023-06-01" }, key, "Anthropic /v1/organizations/me"),
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    keyType: "api",
    keyHelpUrl: "https://platform.openai.com/api-keys",
    validate: (key) => probe("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` }, key, "OpenAI /v1/models"),
  },
};

export async function connect(providerId: string, opts: ConnectOpts): Promise<void> {
  const keyOnly = KEY_ONLY[providerId === "anthropic" && opts.admin ? "anthropic-admin" : providerId];
  if (keyOnly) {
    await connectKeyOnly(keyOnly, opts);
    return;
  }
  const adapter = getAdapter(providerId);
  if (!adapter) {
    const planned = PLANNED_PROVIDERS[providerId];
    console.error(
      planned
        ? err(`"${providerId}" is not supported yet (${planned}).`)
        : err(`Unknown provider "${providerId}".`),
    );
    console.error(dim(`Available now: ${[...listAdapterIds(), "anthropic", "anthropic --admin", "openai"].join(", ")}`));
    process.exit(1);
  }

  p.intro(`Connect ${bold(adapter.displayName)}`);
  const key = await readKey(opts, adapter.keyType === "admin" || opts.admin ? "admin" : "api", adapter.keyHelpUrl);

  const s = p.spinner();
  s.start("Validating key");
  let valid = false;
  try {
    valid = await adapter.validateKey(key);
  } catch (e) {
    s.stop(err("Could not reach the provider"));
    console.error(err(toSafeError(e, [key]).message));
    process.exit(1);
  }
  if (!valid) {
    s.stop(err("Key rejected"));
    console.error(dim(`Check it at ${adapter.keyHelpUrl}`));
    process.exit(1);
  }
  const info = adapter.describeKey ? await adapter.describeKey(key).catch(() => undefined) : undefined;
  s.stop(ok(`Key accepted${info?.label ? ` (${info.label})` : ""}`));

  const keyType = info ? (info.isAdmin ? "admin" : "api") : opts.admin ? "admin" : adapter.keyType;
  const { db, keystore } = await ctx({ keys: "create" });
  upsertProvider(db, {
    id: adapter.id,
    name: adapter.displayName,
    keyCiphertext: keystore.seal(key),
    keyType,
    meta: info ? { label: info.label ?? null, isAdmin: info.isAdmin, usageMonthlyUsd: info.usageMonthlyUsd ?? null, ...info.extra } : undefined,
  });
  db.close();

  if (adapter.keyType === "admin" && info && !info.isAdmin) {
    p.log.warn(
      warn(`This is a regular API key. ${adapter.displayName} only exposes the per-model ledger to an admin / management key.`) +
        `\n${dim(`Create one at ${adapter.keyHelpUrl}, then run this command again. Until then, \`tally sync\` reports aggregate spend only.`)}`,
    );
  }
  p.outro(`${ok("Stored")} ${dim(`(encrypted with the ${keystore.source} master key)`)}. Next: ${bold("tally sync")}`);
}

async function connectKeyOnly(kp: KeyOnlyProvider, opts: ConnectOpts): Promise<void> {
  p.intro(`Connect ${bold(kp.displayName)}`);
  const key = await readKey(opts, kp.keyType, kp.keyHelpUrl);
  const s = p.spinner();
  s.start("Validating key");
  let valid = false;
  try {
    valid = await kp.validate(key);
  } catch (e) {
    s.stop(err("Could not reach the provider"));
    console.error(err(toSafeError(e, [key]).message));
    process.exit(1);
  }
  if (!valid) {
    s.stop(err("Key rejected"));
    console.error(dim(`Check it at ${kp.keyHelpUrl}`));
    process.exit(1);
  }
  s.stop(ok("Key accepted"));
  const { db, keystore } = await ctx({ keys: "create" });
  upsertProvider(db, { id: kp.id, name: kp.displayName, keyCiphertext: keystore.seal(key), keyType: kp.keyType, meta: { routerOnly: true } });
  db.close();
  const next = kp.id === "anthropic-admin" ? "tally route (pool spend reconciles hourly from the cost report)" : kp.id === "anthropic" ? "tally route pool add anthropic --usd 200 --resets <day>, then tally route" : "tally route";
  p.outro(`${ok("Stored")} ${dim(`(encrypted with the ${keystore.source} master key)`)}. Next: ${bold(next)}`);
}

async function readKey(opts: ConnectOpts, kind: "api" | "admin", helpUrl: string): Promise<string> {
  if (opts.key) return opts.key.trim();
  if (opts.keyStdin) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const k = Buffer.concat(chunks).toString("utf8").trim();
    if (!k) {
      console.error(err("No key on stdin"));
      process.exit(1);
    }
    return k;
  }
  const v = await p.password({
    message: kind === "admin" ? `Admin / management key ${dim(`(${helpUrl})`)}` : `API key ${dim(`(${helpUrl})`)}`,
    validate: (s) => (s && s.trim().length > 8 ? undefined : "That does not look like a key"),
  });
  if (p.isCancel(v)) {
    p.cancel("Cancelled");
    process.exit(1);
  }
  return v.trim();
}
