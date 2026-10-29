import Table from "cli-table3";
import pc from "picocolors";

export const money = (n: number) => `$${n.toFixed(2)}`;
export const int = (n: number) => Math.round(n).toLocaleString("en-US");
export const tokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

export function table(head: string[], rows: (string | number)[][], opts: { right?: number[] } = {}): string {
  const t = new Table({
    head: head.map((h) => pc.bold(pc.cyan(h))),
    style: { head: [], border: [], compact: false },
    colAligns: head.map((_, i) => (opts.right?.includes(i) ? "right" : "left")),
    chars: {
      top: "─", "top-mid": "┬", "top-left": "┌", "top-right": "┐",
      bottom: "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘",
      left: "│", "left-mid": "├", mid: "─", "mid-mid": "┼", right: "│", "right-mid": "┤", middle: "│",
    },
  });
  for (const r of rows) t.push(r.map((c) => (typeof c === "number" ? String(c) : c)));
  return t.toString();
}

export const ok = (s: string) => pc.green(s);
export const warn = (s: string) => pc.yellow(s);
export const err = (s: string) => pc.red(s);
export const dim = (s: string) => pc.dim(s);
export const bold = (s: string) => pc.bold(s);
