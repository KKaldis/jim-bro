// Types and helpers shared by the Nutrition screen's sections.

export type Macros = { kcal: number; p: number; f: number; c: number; fiber?: number };
export type MealItem = Macros & {
  food: string;
  grams: number;
  source?: string;
  category?: string;
  display_name?: string;
  // Set when this item was expanded from a recipe by log_recipe. Items sharing
  // one tag render grouped under a collapsible recipe header in the day list.
  recipe?: { slug: string; name: string; servings: number };
};
export type Meal = { slot: string; time?: string; items: MealItem[] };

export type Day = {
  date: string;
  meals: Meal[];
  eaten: Macros;
  target: Macros | null;
  remaining: Macros | null;
  meal_count: number;
};

// The day's primary target is the goal-adjusted target (recomp/cut/etc.); the
// diet plan's target, when one is active for the day, rides along as a marker.
// Falls back to the diet target as the primary when the goal target can't be
// computed (no weigh-in), so a diet plan still shows something. `dietKcal` is
// only set when it's a SECOND number distinct from the primary.
export function dayTargets(
  day: Day,
  goalTarget: Macros | null,
): {
  target: Macros | null;
  dietKcal: number | null;
} {
  const target = goalTarget ?? day.target;
  const dietKcal = goalTarget && day.target ? day.target.kcal : null;
  return { target, dietKcal };
}

export function sumItems(items: MealItem[]): { total: Macros; grams: number } {
  let fiberSum = 0;
  let anyFiber = false;
  let grams = 0;
  const core = items.reduce(
    (acc, it) => {
      if (it.fiber != null) {
        fiberSum += it.fiber;
        anyFiber = true;
      }
      grams += it.grams;
      return {
        kcal: acc.kcal + it.kcal,
        p: acc.p + it.p,
        f: acc.f + it.f,
        c: acc.c + it.c,
      };
    },
    { kcal: 0, p: 0, f: 0, c: 0 },
  );
  return { total: anyFiber ? { ...core, fiber: fiberSum } : core, grams };
}
