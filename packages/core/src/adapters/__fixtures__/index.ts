import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FetchLike } from "../../types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, name), "utf8"));
}

export type Route = (req: { path: string; headers: Record<string, string> }) => Response | Promise<Response>;

/** A fetch that answers from fixtures; records every request so tests can assert on headers. */
export function fakeFetch(routes: Record<string, Route>): FetchLike & { calls: { path: string; headers: Record<string, string> }[] } {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    calls.push({ path, headers });
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    return route({ path, headers });
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
