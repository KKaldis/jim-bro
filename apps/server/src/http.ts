/**
 * Request/response helpers shared by the route modules: JSON errors, Zod body
 * parsing, CORS, and the session boundary (`authed`).
 */
import { UserStorage } from "@fa/agent";
import { auth } from "@fa/auth";
import { WriteInputError } from "@fa/shared";

import type { RouteCtx, RouteHandler } from "./router.ts";

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

// ---------- request bodies ----------

// The slice of a Zod schema readBody needs (the server takes zod only
// transitively, through @fa/shared/schemas).
type RequestSchema<T> = {
  safeParse(raw: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> };
      };
};

// Parse a JSON body against its Zod request schema — the same schema the
// OpenAPI spec and the web client are generated from, so the documented
// contract is the enforced one. 400 on bad JSON or a shape mismatch.
export async function readBody<T>(
  req: Request,
  schema: RequestSchema<T>,
): Promise<{ data: T } | { error: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { error: jsonError(400, "body must be JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
    return { error: jsonError(400, `${where}${issue?.message ?? "invalid request"}`) };
  }
  return { data: parsed.data };
}

// Run a @fa/shared write normalizer, mapping its WriteInputError (a
// caller-fixable rule violation) to a 400. Anything else is a real bug and
// propagates.
export function normalized<T>(fn: () => T): { data: T } | { error: Response } {
  try {
    return { data: fn() };
  } catch (err) {
    if (err instanceof WriteInputError) return { error: jsonError(400, err.message) };
    throw err;
  }
}

// ---------- CORS ----------

export const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.length) return {};
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    vary: "Origin",
  };
}

export function withCors(req: Request, res: Response): Response {
  const headers = corsHeaders(req);
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }
  return res;
}

// ---------- session ----------

export async function requireSession(
  req: Request,
): Promise<{ userId: string } | { error: Response }> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return { error: jsonError(401, "not signed in") };
  }
  return { userId: session.user.id };
}

// Everything a signed-in route needs. userId always comes from the session
// cookie — never from the request body.
export type AuthedCtx = RouteCtx & { userId: string; storage: UserStorage };

// Wrap a handler so it only runs for a signed-in user (401 otherwise).
export function authed(handler: (ctx: AuthedCtx) => Promise<Response>): RouteHandler {
  return async (ctx) => {
    const session = await requireSession(ctx.req);
    if ("error" in session) return session.error;
    return handler({ ...ctx, userId: session.userId, storage: new UserStorage(session.userId) });
  };
}
