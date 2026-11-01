/**
 * Account: profile, entitlements, deletion and the AI usage report.
 */
import { executeTool, getUsageReport, llmStatus } from "@fa/agent";
import { db, schema } from "@fa/db_postgres";
import { ProfileUpdateRequest } from "@fa/shared/schemas";
import { eq } from "drizzle-orm";

import { resolveEntitlements } from "../extensions.ts";
import { authed, type AuthedCtx, jsonError, readBody } from "../http.ts";
import { type Route, route } from "../router.ts";

async function handleDeleteMe({ log, userId }: AuthedCtx): Promise<Response> {
  // ON DELETE CASCADE on every app table tears the user's data down in one go.
  await db().delete(schema.user).where(eq(schema.user.id, userId));
  log.warn("account deleted", { user_id: userId });
  return Response.json({ deleted: true });
}

async function handleGetProfile({ storage }: AuthedCtx): Promise<Response> {
  const profile = await storage.loadProfile();
  return Response.json({ profile });
}

// The feature flags the web app gates on, with a reason for each locked one
// (see ../extensions.ts for how they're resolved).
async function handleGetEntitlements({ userId }: AuthedCtx): Promise<Response> {
  return Response.json(await resolveEntitlements(userId));
}

// The current (or ?month=YYYY-MM) month's AI usage and estimated cost.
async function handleGetUsage({ url, userId }: AuthedCtx): Promise<Response> {
  const month = url.searchParams.get("month") ?? undefined;
  const report = await getUsageReport(userId, month);
  if (!report) return jsonError(400, "month must be YYYY-MM");
  return Response.json({ ...report, llm: llmStatus().chat });
}

async function handleUpdateProfile({ req, log, userId, storage }: AuthedCtx): Promise<Response> {
  const body = await readBody(req, ProfileUpdateRequest);
  if ("error" in body) return body.error;
  // Reuse the same validation + partial-merge logic the agent's update_profile
  // tool uses — single source of truth for profile mutations.
  const raw = await executeTool("update_profile", body.data, storage);
  const result = JSON.parse(raw);
  if (result?.error) {
    log.warn("profile update rejected", { user_id: userId, err: result.error });
    return jsonError(400, result.error);
  }
  log.info("profile updated via API", { user_id: userId });
  return Response.json(result);
}

// ---------- routes ----------

export const accountRoutes: Route[] = [
  route("DELETE", "/me", authed(handleDeleteMe)),
  route("GET", "/me/entitlements", authed(handleGetEntitlements)),
  route("GET", "/me/profile", authed(handleGetProfile)),
  route("PATCH", "/me/profile", authed(handleUpdateProfile)),
  route("GET", "/me/usage", authed(handleGetUsage)),
];
