/**
 * Diets template helpers.
 *
 * The template is normalized (plan → day → meal → portion) and portions
 * resolve macros LIVE from the pantry (an explicit per-portion override wins).
 * A portion that resolves to null is "needs enrichment" — it renders as
 * unknown and blocks "ate as planned" logging, but never counts as zero.
 */
import type {
  DietPlan,
  DietPlanDay,
  DietPlanMeal,
  DietPlanPortion,
  Macros,
  Pantry,
} from "./types.ts";
import { resolvePortion, sumMacros } from "./food.ts";

// Pick the template day for a calendar date:
//   weekday match → start_date index rotation → first day.
// Mirrors the legacy dayTemplate logic; weekday mode now matches against the
// day's weekdays[] set (one day can run Mon AND Thu).
export function dietDayForDate(plan: DietPlan | null, dateIso: string): DietPlanDay | null {
  const rotation = plan?.rotation ?? [];
  if (!rotation.length) return null;
  const weekday = new Date(dateIso + "T00:00:00")
    .toLocaleDateString("en-US", { weekday: "long" })
    .toLowerCase();
  const byWeekday = rotation.find((d) => d.weekdays.some((w) => w === weekday));
  if (byWeekday) return byWeekday;
  if (plan?.start_date) {
    const ms =
      new Date(dateIso + "T00:00:00").getTime() - new Date(plan.start_date + "T00:00:00").getTime();
    const delta = Math.floor(ms / 86_400_000);
    const idx = ((delta % rotation.length) + rotation.length) % rotation.length;
    return rotation[idx] ?? null;
  }
  return rotation[0] ?? null;
}

// ---- resolved views (template + live pantry macros) ----
//
// What the UI and the agent's get_diet_plan render: each portion carries its
// resolved absolute macros (or null = needs enrichment), each meal/day sums
// the resolvable portions and counts the unresolved ones.

export type ResolvedDietPortion = DietPlanPortion & {
  resolved: Macros | null;
  // True when `resolved` came from an explicit per-portion override rather
  // than the live pantry definition.
  override: boolean;
};

export type ResolvedDietMeal = Omit<DietPlanMeal, "items"> & {
  items: ResolvedDietPortion[];
  totals: Macros;
  unresolved: number;
};

export type ResolvedDietDay = Omit<DietPlanDay, "meals"> & {
  meals: ResolvedDietMeal[];
  totals: Macros;
  unresolved: number;
};

export type ResolvedDietPlan = Omit<DietPlan, "rotation"> & {
  rotation: ResolvedDietDay[];
};

export function resolveDietMeal(meal: DietPlanMeal, pantry: Pantry | null): ResolvedDietMeal {
  const items = meal.items.map((p): ResolvedDietPortion => ({
    ...p,
    resolved: resolvePortion(pantry, p),
    override: p.macros != null,
  }));
  return {
    ...meal,
    items,
    totals: sumMacros(items.map((i) => i.resolved).filter((m): m is Macros => m != null)),
    unresolved: items.filter((i) => i.resolved == null).length,
  };
}

export function resolveDietDay(day: DietPlanDay, pantry: Pantry | null): ResolvedDietDay {
  const meals = day.meals.map((m) => resolveDietMeal(m, pantry));
  return {
    ...day,
    meals,
    totals: sumMacros(meals.map((m) => m.totals)),
    unresolved: meals.reduce((a, m) => a + m.unresolved, 0),
  };
}

export function resolveDietPlan(plan: DietPlan, pantry: Pantry | null): ResolvedDietPlan {
  return { ...plan, rotation: plan.rotation.map((d) => resolveDietDay(d, pantry)) };
}
