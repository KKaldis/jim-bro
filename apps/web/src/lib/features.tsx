import type { ReactNode } from "react";

import { useGetMeEntitlements } from "../api/endpoints/default/default";
import type { EntitlementsResponseFeatures } from "../api/model/entitlementsResponseFeatures";
import { LockBadge } from "../components/LockBadge";
import { cn } from "./utils";

// Feature-access gating for the web app.
//
// The server resolves what the user can do and serves it at GET
// /me/entitlements: a flag per feature, plus a lock reason for each one that's
// off ("no_llm" when no AI model is configured, or a code from a server
// extension). Here we wrap the generated React Query hook (which caches/dedupes
// across the app, so no extra Zustand store or Context is needed) and expose:
//   • useEntitlements() — the flag map + lock reasons + load state
//   • useFeature(key)   — a single boolean
//   • <Feature name=…>  — declarative render gate with a fallback
//
// Gates fail CLOSED: until entitlements load (or if the request errors) every
// flag reads false, so gated UI never flashes before access is confirmed.

export type FeatureKey = keyof EntitlementsResponseFeatures;

const CLOSED: EntitlementsResponseFeatures = {
  ai_chat: false,
  ai_image: false,
  silhouette_scan: false,
};

export function useEntitlements(): {
  features: EntitlementsResponseFeatures;
  locks: Partial<Record<FeatureKey, string | null>>;
  isLoading: boolean;
  isError: boolean;
} {
  const { data, isLoading, isError } = useGetMeEntitlements();
  return {
    features: data?.features ?? CLOSED,
    locks: data?.locks ?? {},
    isLoading,
    isError,
  };
}

/** Whether the current user may use a given feature (false until loaded). */
export function useFeature(key: FeatureKey): boolean {
  return useEntitlements().features[key];
}

type FeatureProps = {
  name: FeatureKey;
  children: ReactNode;
  /** Rendered when the feature is NOT available. */
  fallback?: ReactNode;
  /** Rendered while entitlements are still loading (default: nothing). */
  loading?: ReactNode;
};

/**
 * Renders `children` only when `name` is enabled for the current user.
 * While loading, renders `loading` (nothing by default) to avoid a flash of
 * gated content; once resolved, renders `children` or `fallback`. Use this for
 * show/hide gates; for "show but disabled", use <FeatureLock>.
 */
export function Feature({
  name,
  children,
  fallback = null,
  loading = null,
}: FeatureProps): ReactNode {
  const { features, isLoading } = useEntitlements();
  if (isLoading) return loading;
  return features[name] ? children : fallback;
}

/**
 * Renders `children` always, but when `name` is NOT available the children are
 * shown disabled (greyed, non-interactive) with a <LockBadge> overlaid — so the
 * user sees the feature exists and why it's off.
 *
 * While loading we render children enabled (optimistic) rather than flashing a
 * locked state; the gate settles a moment later.
 */
export function FeatureLock({
  name,
  children,
  className,
  badgeClassName,
}: {
  name: FeatureKey;
  children: ReactNode;
  className?: string;
  badgeClassName?: string;
}): ReactNode {
  const { features, locks, isLoading } = useEntitlements();
  if (isLoading || features[name]) return children;
  const reason = locks[name];
  return (
    <div className={cn("relative", className)}>
      <div className="pointer-events-none opacity-50 select-none" aria-disabled>
        {children}
      </div>
      {reason && (
        <LockBadge
          reason={reason}
          className={cn("absolute inset-e-2 top-2 z-10", badgeClassName)}
        />
      )}
    </div>
  );
}

/**
 * Inline lock badge for a feature: renders nothing when the feature is
 * available, otherwise a <LockBadge> with the reason. Handy next to a control
 * you've disabled by hand (e.g. a send button).
 */
export function FeatureBadge({
  name,
  className,
}: {
  name: FeatureKey;
  className?: string;
}): ReactNode {
  const { features, locks } = useEntitlements();
  if (features[name]) return null;
  const reason = locks[name];
  return reason ? <LockBadge reason={reason} className={className} /> : null;
}
