/**
 * Server extensions: the seams an add-on package (e.g. a hosted/commercial
 * build) plugs into without editing core files.
 *
 * An extension is a module whose default export is a ServerExtension. They're
 * loaded at startup from SERVER_EXTENSIONS (comma-separated module specifiers)
 * or, when that's unset, `jimBro.serverExtensions` in the root package.json —
 * see ./extension-specs.ts. An extension that adds endpoints registers their
 * OpenAPI paths from a separate, IO-free module listed in
 * `jimBro.openapiExtensions`, so `npm run gen:api` can generate web hooks
 * for them without a database.
 *
 * What an extension can do:
 *   • routes        — extra HTTP routes, dispatched after the core ones.
 *   • entitlements  — lock features per user on top of the core resolution
 *                     (core only locks AI features when no LLM is configured).
 *   • preflight     — veto an AI call before it runs (e.g. out of credits).
 *   • start         — one-time setup: background jobs, and subscribing to core
 *                     hooks such as onUsage (@fa/agent) or onUserCreated
 *                     (@fa/auth).
 *
 * Extensions run in load order; for entitlements each one sees the previous
 * result, and the first preflight block wins.
 */
import { llmStatus } from "@fa/agent";
import { logger, type Logger } from "@fa/logger";
import {
  baseEntitlements,
  type Entitlements,
  type FeatureKey,
  LOCK_NO_LLM,
  LOCK_NO_VISION,
} from "@fa/shared";

import { extensionSpecs } from "./extension-specs.ts";
import type { Route } from "./router.ts";

/** A refused AI call: the HTTP status and message to return. */
export type PreflightBlock = { status: number; error: string };

export type ServerExtension = {
  name: string;
  routes?: Route[];
  entitlements?: (userId: string, current: Entitlements) => Entitlements | Promise<Entitlements>;
  preflight?: (
    userId: string,
    feature: FeatureKey,
    log: Logger,
  ) => PreflightBlock | null | Promise<PreflightBlock | null>;
  start?: (log: Logger) => void | Promise<void>;
};

const loaded: ServerExtension[] = [];

/** Import every configured extension module and run its start(). */
export async function loadExtensions(): Promise<ServerExtension[]> {
  for (const spec of extensionSpecs()) {
    const mod = (await import(spec)) as { default?: ServerExtension };
    const ext = mod.default;
    if (!ext?.name) throw new Error(`server extension '${spec}' has no default ServerExtension`);
    await ext.start?.(logger.child({ ext: ext.name }));
    loaded.push(ext);
    logger.info("server extension loaded", { name: ext.name, spec });
  }
  return loaded;
}

/** Extra routes from every loaded extension, in load order. */
export function extensionRoutes(): Route[] {
  return loaded.flatMap((e) => e.routes ?? []);
}

/** The user's feature access: core capabilities, then each extension's say. */
export async function resolveEntitlements(userId: string): Promise<Entitlements> {
  let e = baseEntitlements(llmStatus());
  for (const ext of loaded) {
    if (ext.entitlements) e = await ext.entitlements(userId, e);
  }
  return e;
}

/**
 * Gate for every AI-backed endpoint: refuses when the feature is locked for
 * this user (503 when the server has no LLM, 403 otherwise) or an extension's
 * preflight vetoes it. null = go ahead. Extension errors fail OPEN — a billing
 * hiccup shouldn't take the coach down.
 */
export async function aiPreflight(
  userId: string,
  feature: FeatureKey,
  log: Logger,
): Promise<PreflightBlock | null> {
  let entitlements: Entitlements;
  try {
    entitlements = await resolveEntitlements(userId);
  } catch (err) {
    log.error("entitlements failed", err instanceof Error ? err : new Error(String(err)));
    entitlements = baseEntitlements(llmStatus());
  }
  const lock = entitlements.locks[feature];
  if (lock) {
    log.info("ai call refused", { feature, lock });
    return lock === LOCK_NO_LLM || lock === LOCK_NO_VISION
      ? { status: 503, error: "no AI model is configured on this server" }
      : { status: 403, error: `${feature} is not available on your plan` };
  }
  for (const ext of loaded) {
    if (!ext.preflight) continue;
    try {
      const block = await ext.preflight(userId, feature, log);
      if (block) return block;
    } catch (err) {
      log.error("extension preflight failed", err instanceof Error ? err : new Error(String(err)), {
        ext: ext.name,
      });
    }
  }
  return null;
}
