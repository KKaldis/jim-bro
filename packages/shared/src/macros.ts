import type { DietPlan, Macros, MealLog, Profile } from "./types.ts";
import { dietDayForDate } from "./diet.ts";
import { remainingMacros, sumMacros } from "./food.ts";

// The profile's cached macro recommendation (computeTargets output, populated
// by loadProfile). Used to backfill the macro caps a diet plan leaves unset.
type ProfileMacroTargets = Pick<Profile, "target_protein_g" | "target_fat_g" | "target_carbs_g">;

// A diet plan can define only a calorie target, leaving its macro columns NULL —
// which storage flattens to 0 on load (see macrosFromColumns). A 0 g protein/
// fat/carb *cap* is never meaningful, so a kcal-only plan would otherwise show
// the user "over" against zeros. Backfill any unset (≤ 0) macro from the
// profile's cached recommendation so the user still gets real macro guardrails.
// Returns the target untouched when there's no target or no recommendation.
// Display-time only — mirrors the server's fiber backfill; stored plan data is
// never mutated. kcal is left as-is (it's the plan's explicit calorie cap).
export function fillTargetMacrosFromProfile(
  target: Macros | null,
  profile: ProfileMacroTargets | null | undefined,
): Macros | null {
  if (!target || !profile) return target;
  const filled = { ...target };
  if (!(filled.p > 0) && profile.target_protein_g != null) filled.p = profile.target_protein_g;
  if (!(filled.f > 0) && profile.target_fat_g != null) filled.f = profile.target_fat_g;
  if (!(filled.c > 0) && profile.target_carbs_g != null) filled.c = profile.target_carbs_g;
  return filled;
}

// Daily macro target for a date: the template day's target (weekday match →
// index rotation → first day, via dietDayForDate), falling back to the
// plan's default target. Pass `profile` to backfill any macro cap the plan
// leaves unset from the user's cached recommendation (see
// fillTargetMacrosFromProfile) — without it, behaviour is unchanged.
export function dayTargetFromPlan(
  plan: DietPlan | null,
  d: string,
  profile?: ProfileMacroTargets | null,
): Macros | null {
  const day = dietDayForDate(plan, d);
  const base = day?.target ?? plan?.default_target ?? null;
  return fillTargetMacrosFromProfile(base, profile);
}

export type DayTotals = {
  date: string;
  eaten: Macros;
  target: Macros | null;
  remaining: Macros | null;
  meal_count: number;
};

export function dayTotals(log: MealLog | null, target: Macros | null, date: string): DayTotals {
  const items = (log?.meals ?? []).flatMap((m) => m.items);
  const eaten = sumMacros(items);
  return {
    date,
    eaten,
    target,
    remaining: target ? remainingMacros(target, eaten) : null,
    meal_count: log?.meals?.length ?? 0,
  };
}
