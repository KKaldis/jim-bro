import { computeTargets, latestBodyMetrics, type Macros, type Profile } from "@fa/shared";
import { useDayContext, useDaySnapshot } from "./dayContext";

// Today's goal-adjusted daily macro target (recomp/cut/lean-bulk applied to
// TDEE), derived client-side from the profile + latest weigh-in — the same math
// the dashboard + nutrition day view use (useDayEnergy). Null when there's no
// profile / no current weight to compute from. Shared so the recipe card can
// frame a serving's macros against the day's target without re-deriving it.
export function useDailyTarget(): Macros | null {
  const { todayIso } = useDayContext();
  const snap = useDaySnapshot(todayIso);
  const profile = snap.data?.profile ?? null;
  const metrics = latestBodyMetrics(snap.data?.bodyComp ?? []);
  if (!profile || !metrics || !profile.height_cm) return null;
  const targets = computeTargets(profile as unknown as Profile, metrics);
  return targets?.daily_target ?? null;
}
