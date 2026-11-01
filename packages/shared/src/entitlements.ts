/**
 * Feature entitlements: which gated capabilities exist and why one is off.
 *
 * Pure data + helpers, no zod/openapi — safe to import from the server, the
 * agent, and (via the @fa/shared barrel) the web app.
 *
 * The resolved, per-user view is served by `GET /me/entitlements` (registered
 * in ./schemas.ts as EntitlementsResponse) and consumed on the web through the
 * generated React Query hook + the <Feature> wrapper.
 *
 * In the core app every feature is on as long as the server can serve it (the
 * AI features need an LLM provider configured). Server extensions can lock
 * features further per user — see apps/server/src/extensions.ts.
 *
 *   • Add a FEATURE → add its key to FEATURE_KEYS, the `features` / `locks`
 *     shape in EntitlementsResponse (schemas.ts), and a <Feature name="...">
 *     gate on the web.
 */

/** Gated capability keys. Each maps to a <Feature> gate on the web. */
export const FEATURE_KEYS = ["ai_chat", "ai_image", "silhouette_scan"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type FeatureFlags = Record<FeatureKey, boolean>;

/**
 * Why a feature is off. The core reasons are below; extensions may add their
 * own codes (e.g. "upgrade:plus"), which the web renders with a generic badge
 * unless it knows the code.
 */
export const LOCK_NO_LLM = "no_llm";
export const LOCK_NO_VISION = "no_vision";
export type LockReason = string;

export type FeatureLocks = Record<FeatureKey, LockReason | null>;

/** Resolved access: a flag per feature, plus the reason for each one that's off. */
export type Entitlements = {
  features: FeatureFlags;
  locks: FeatureLocks;
};

/** What the server can serve, regardless of who's asking. */
export type ServerCapabilities = {
  /** A chat LLM provider is configured (API key present). */
  llm: boolean;
  /** A vision-capable provider is configured. */
  vision: boolean;
};

/** Core entitlements: everything on, except what the server can't serve. */
export function baseEntitlements(caps: ServerCapabilities): Entitlements {
  const locks: FeatureLocks = {
    ai_chat: caps.llm ? null : LOCK_NO_LLM,
    ai_image: caps.vision ? null : caps.llm ? LOCK_NO_VISION : LOCK_NO_LLM,
    silhouette_scan: null,
  };
  return { features: flagsFromLocks(locks), locks };
}

/** Lock a feature (keeps an earlier lock reason — the first lock wins). */
export function lockFeature(e: Entitlements, key: FeatureKey, reason: LockReason): Entitlements {
  if (e.locks[key]) return e;
  const locks = { ...e.locks, [key]: reason };
  return { features: flagsFromLocks(locks), locks };
}

function flagsFromLocks(locks: FeatureLocks): FeatureFlags {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, locks[k] == null])) as FeatureFlags;
}
