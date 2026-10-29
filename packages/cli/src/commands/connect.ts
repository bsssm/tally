import * as p from "@clack/prompts";
import { getAdapter, listAdapterIds, PLANNED_PROVIDERS, toSafeError, upsertProvider } from "@tally/core";
import { ctx } from "../context.js";
import { bold, dim, err, ok, warn } from "../ui.js";

export interface ConnectOpts {
  key?: string;
  keyStdin?: boolean;
  admin?: boolean;
}

export async function connect(providerId: string, opts: ConnectOpts): Promise<void> {
  const adapter = getAdapter(providerId);
  if (!adapter) {
    const planned = PLANNED_PROVIDERS[providerId];
    console.error(
      planned
        ? err(`"${providerId}" is not supported yet (${planned}).`)
        : err(`Unknown provider "${providerId}".`),
    );
    console.error(dim(`Available now: ${listAdapterIds().join(", ")}`));
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
  const { db, keystore } = await ctx();
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
