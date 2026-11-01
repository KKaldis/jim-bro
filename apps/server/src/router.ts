/**
 * Minimal route table. Paths use `:name` segments, optionally constrained by a
 * regex in parens (`/diet/plans/:id(\d+)`); an unconstrained param matches one
 * path segment. Matching runs inside the server's fetch wrapper, so request
 * logging and the error boundary stay in one place, and CORS is applied here
 * for every route that doesn't opt out.
 */
import type { Logger } from "@fa/logger";

import { withCors } from "./http.ts";

export type RouteCtx = {
  req: Request;
  url: URL;
  log: Logger;
  params: Record<string, string>;
};

export type RouteHandler = (ctx: RouteCtx) => Response | Promise<Response>;

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Route = {
  methods: readonly Method[] | "*";
  pattern: RegExp;
  handler: RouteHandler;
  // Server-to-server endpoints (webhooks) skip CORS headers.
  cors: boolean;
};

function compile(path: string): RegExp {
  const src = path.replace(
    /:(\w+)(?:\(([^)]+)\))?|[.*+?^${}()|[\]\\]/g,
    (tok, name: string | undefined, re: string | undefined) =>
      name ? `(?<${name}>${re ?? "[^/]+"})` : `\\${tok}`,
  );
  return new RegExp(`^${src}$`);
}

export function route(
  methods: Method | readonly Method[] | "*",
  path: string,
  handler: RouteHandler,
  opts: { cors?: boolean } = {},
): Route {
  return {
    methods: typeof methods === "string" && methods !== "*" ? [methods] : methods,
    pattern: compile(path),
    handler,
    cors: opts.cors ?? true,
  };
}

// The response for the first route matching the request, or null when none
// does (the caller falls through to static files / 404).
export async function dispatch(
  routes: readonly Route[],
  req: Request,
  url: URL,
  log: Logger,
): Promise<Response | null> {
  for (const r of routes) {
    if (r.methods !== "*" && !r.methods.includes(req.method as Method)) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const res = await r.handler({ req, url, log, params: { ...m.groups } });
    return r.cors ? withCors(req, res) : res;
  }
  return null;
}
