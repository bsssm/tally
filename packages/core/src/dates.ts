/** YYYY-MM-DD in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number, now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** The default window: the last `days` days up to today (UTC), inclusive. */
export function defaultWindow(days = 30, now: Date = new Date()): { from: Date; to: Date } {
  return { from: daysAgo(days, now), to: daysAgo(0, now) };
}
