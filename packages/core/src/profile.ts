import type { Db } from "./db.js";

export interface Profile {
  plan?: "api" | "pro" | "max5" | "max20";
  creditsClaimed?: boolean;
  stage?: "solo" | "bootstrapped" | "preseed" | "seed" | "series-a+";
  funded?: boolean;
  aiNative?: boolean;
  monthlySpendUsd?: number;
}

export function getProfile(db: Db): Profile {
  const rows = db.prepare("SELECT key, value FROM profile").all() as { key: string; value: string }[];
  const p: Record<string, unknown> = {};
  for (const r of rows) p[r.key] = JSON.parse(r.value);
  return p as Profile;
}

export function setProfile(db: Db, patch: Partial<Profile>): Profile {
  const ins = db.prepare("INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) ins.run(k, JSON.stringify(v));
  })();
  return getProfile(db);
}
