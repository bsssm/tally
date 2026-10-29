import { listProviders, removeProvider } from "@tally/core";
import { ctx } from "../context.js";
import { dim, ok, table, warn } from "../ui.js";

export async function providers(opts: { json?: boolean }): Promise<void> {
  const { db } = await ctx();
  const rows = listProviders(db);
  db.close();
  if (opts.json) {
    console.log(JSON.stringify(rows.map(({ key_ciphertext: _k, ...r }) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null })), null, 2));
    return;
  }
  if (!rows.length) {
    console.log(dim("No providers connected. Start with: tally connect openrouter"));
    return;
  }
  console.log(
    table(
      ["Provider", "Key", "Label", "Connected", "Last sync"],
      rows.map((r) => {
        const meta = r.meta ? (JSON.parse(r.meta) as { label?: string }) : {};
        return [r.id, r.key_type === "admin" ? ok("admin") : warn("api"), meta.label ?? "", r.connected_at.slice(0, 16).replace("T", " "), r.last_synced_at ? r.last_synced_at.slice(0, 16).replace("T", " ") : dim("never")];
      }),
    ),
  );
}

export async function disconnect(providerId: string): Promise<void> {
  const { db } = await ctx();
  removeProvider(db, providerId);
  db.close();
  console.log(ok(`Removed ${providerId} and its ledger rows.`));
}
