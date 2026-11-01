/**
 * Diet tools: the recurring meal template (plan → day → meal → portion).
 */
import {
  dayTargetFromPlan,
  dayTotals,
  dietDayForDate,
  type DietPlan,
  type DietPlanWriteInput,
  type Meal,
  type MealLog,
  normalizeDietMeal,
  normalizeDietPlanWrite,
  normalizeMacros,
  normalizeWeekdays,
  resolveDietMeal,
  resolveDietPlan,
  sumMacros,
} from "@fa/shared";

import { UserStorage } from "../../storage.ts";
import { nestPortion, parsePortionInput, runBatchEdits, todayIso } from "./shared.ts";

// ---------- diet plan (normalized template) ----------

// The view every diet tool returns: the hydrated tree with row ids plus
// per-portion macros LIVE-resolved from the pantry, and a needs_enrichment
// list so the agent can offer to fix unresolvable foods.
async function dietPlanView(storage: UserStorage, plan: DietPlan | null) {
  if (!plan) {
    return {
      plan: null,
      note: "no diet plan yet — save_diet_plan creates one",
    };
  }
  const pantry = await storage.loadPantry();
  const resolved = resolveDietPlan(plan, pantry);
  const needsEnrichment = new Set<string>();
  for (const day of resolved.rotation) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        if (item.resolved == null) needsEnrichment.add(item.food);
      }
    }
  }
  return {
    plan: resolved,
    ...(needsEnrichment.size
      ? {
          needs_enrichment: [...needsEnrichment],
          note: "needs_enrichment foods aren't in the pantry (or lack macros), so their planned meals can't total or be logged as planned. Offer to add/enrich them (lookup_product / web_search → add_food).",
        }
      : {}),
  };
}

// Resolve the plan a tool should act on: explicit plan_id, else the active
// plan. Returns null when nothing resolves (no such plan / none active).
async function planForInput(storage: UserStorage, input: Record<string, unknown>) {
  if (input.plan_id != null) {
    return storage.loadDietPlan(Number(input.plan_id));
  }
  return storage.loadActiveDietPlan();
}

export async function doGetDietPlan(storage: UserStorage, input: Record<string, unknown>) {
  return dietPlanView(storage, await planForInput(storage, input));
}

export async function doListDietPlans(storage: UserStorage) {
  const [plans, profile] = await Promise.all([storage.listDietPlans(), storage.loadProfile()]);
  const activeId = profile?.active_diet_plan_id ?? null;
  return {
    active_plan_id: activeId,
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      active: p.id === activeId,
      day_count: p.rotation.length,
    })),
  };
}

export async function doActivateDietPlan(storage: UserStorage, input: Record<string, unknown>) {
  const planId = Number(input.plan_id);
  if (!Number.isFinite(planId)) throw new Error("plan_id required — get it from list_diet_plans");
  const ok = await storage.setActiveDietPlan(planId);
  if (!ok) return { error: `diet plan ${planId} not found — call list_diet_plans for current ids` };
  return { activated: planId };
}

export async function doDeleteDietPlan(storage: UserStorage, input: Record<string, unknown>) {
  const planId = Number(input.plan_id);
  if (!Number.isFinite(planId)) throw new Error("plan_id required — get it from list_diet_plans");
  const removed = await storage.deleteDietPlan(planId);
  return { removed };
}

function parseDietPlanWrite(input: Record<string, unknown>): DietPlanWriteInput {
  const rawDays = input.days as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rawDays) || !rawDays.length) {
    throw new Error("days[] required (at least one rotation day)");
  }
  return normalizeDietPlanWrite({
    ...input,
    days: rawDays.map((d) => ({
      ...d,
      meals: Array.isArray(d.meals)
        ? (d.meals as Array<Record<string, unknown>>).map((m) => ({
            ...m,
            items: Array.isArray(m.items) ? m.items.map(nestPortion) : m.items,
          }))
        : d.meals,
    })),
  });
}

export async function doSaveDietPlan(storage: UserStorage, input: Record<string, unknown>) {
  const write = parseDietPlanWrite(input);
  // plan_id present → replace that plan; absent → create a new one.
  if (input.plan_id != null) {
    const planId = Number(input.plan_id);
    const plan = await storage.updateDietPlan(planId, write);
    if (!plan)
      return { error: `diet plan ${planId} not found — call list_diet_plans for current ids` };
    return { saved: true, ...(await dietPlanView(storage, plan)) };
  }
  const plan = await storage.createDietPlan(write);
  return { saved: true, created: true, ...(await dietPlanView(storage, plan)) };
}

export async function doUpdateDietDay(storage: UserStorage, input: Record<string, unknown>) {
  const dayId = Number(input.day_id);
  if (!Number.isFinite(dayId)) throw new Error("day_id required — get it from get_diet_plan");
  const patch: Parameters<UserStorage["updateDietPlanDay"]>[1] = {};
  if (input.name !== undefined) patch.name = String(input.name);
  if (input.weekdays !== undefined) patch.weekdays = normalizeWeekdays(input.weekdays);
  if (input.clear_target === true) patch.target = null;
  else if (input.target !== undefined) patch.target = normalizeMacros(input.target);
  const plan = await storage.updateDietPlanDay(dayId, patch);
  if (!plan) return { error: `diet day ${dayId} not found — call get_diet_plan for current ids` };
  return { updated: true, ...(await dietPlanView(storage, plan)) };
}

export async function doAddDietMeal(storage: UserStorage, input: Record<string, unknown>) {
  const dayId = Number(input.day_id);
  if (!Number.isFinite(dayId)) throw new Error("day_id required — get it from get_diet_plan");
  const meal = normalizeDietMeal({ slot: input.slot, time: input.time });
  meal.items = Array.isArray(input.items)
    ? (input.items as Array<Record<string, unknown>>).map(parsePortionInput)
    : [];
  const plan = await storage.addDietMeal(dayId, meal);
  if (!plan) return { error: `diet day ${dayId} not found — call get_diet_plan for current ids` };
  return { added: true, ...(await dietPlanView(storage, plan)) };
}

export async function doUpdateDietMeal(storage: UserStorage, input: Record<string, unknown>) {
  const mealId = Number(input.meal_id);
  if (!Number.isFinite(mealId)) throw new Error("meal_id required — get it from get_diet_plan");
  const patch: Parameters<UserStorage["updateDietMeal"]>[1] = {};
  if (input.slot !== undefined) patch.slot = String(input.slot);
  if (input.time !== undefined) {
    const t = String(input.time ?? "").trim();
    patch.time = t === "" ? null : t;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("nothing to update — pass slot and/or time");
  }
  const plan = await storage.updateDietMeal(mealId, patch);
  if (!plan)
    return { error: `planned meal ${mealId} not found — call get_diet_plan for current ids` };
  return { updated: true, ...(await dietPlanView(storage, plan)) };
}

export async function doRemoveDietMeal(storage: UserStorage, input: Record<string, unknown>) {
  const mealId = Number(input.meal_id);
  if (!Number.isFinite(mealId)) throw new Error("meal_id required — get it from get_diet_plan");
  const plan = await storage.removeDietMeal(mealId);
  if (!plan)
    return { error: `planned meal ${mealId} not found — call get_diet_plan for current ids` };
  return { removed: true, ...(await dietPlanView(storage, plan)) };
}

export async function doAddDietPortion(
  storage: UserStorage,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Array.isArray(input.edits)) {
    return runBatchEdits(input.edits, (one) => doAddDietPortion(storage, one));
  }
  const mealId = Number(input.meal_id);
  if (!Number.isFinite(mealId)) throw new Error("meal_id required — get it from get_diet_plan");
  const plan = await storage.addDietPortion(mealId, parsePortionInput(input));
  if (!plan)
    return { error: `planned meal ${mealId} not found — call get_diet_plan for current ids` };
  return { added: true, ...(await dietPlanView(storage, plan)) };
}

export async function doUpdateDietPortion(
  storage: UserStorage,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Array.isArray(input.edits)) {
    return runBatchEdits(input.edits, (one) => doUpdateDietPortion(storage, one));
  }
  const portionId = Number(input.portion_id);
  if (!Number.isFinite(portionId)) {
    throw new Error("portion_id required — get it from get_diet_plan");
  }
  const patch: Parameters<UserStorage["updateDietPortion"]>[1] = {};
  if (input.food !== undefined) patch.food = String(input.food);
  if (input.grams !== undefined) {
    const grams = Number(input.grams);
    if (!Number.isFinite(grams) || grams <= 0) throw new Error("grams must be > 0");
    patch.grams = grams;
  }
  if (input.clear_override === true) {
    patch.macros = null;
    patch.source = null;
  } else if (input.kcal != null) {
    patch.macros = {
      kcal: Number(input.kcal),
      p: Number(input.p ?? 0),
      f: Number(input.f ?? 0),
      c: Number(input.c ?? 0),
      ...(input.fiber != null ? { fiber: Number(input.fiber) } : {}),
    };
    patch.source = "manual";
  } else if (patch.food !== undefined) {
    // Swapping the food without an explicit override: drop any stale
    // override so the new food resolves live from the pantry.
    patch.macros = null;
    patch.source = null;
  }
  const plan = await storage.updateDietPortion(portionId, patch);
  if (!plan)
    return { error: `portion ${portionId} not found — call get_diet_plan for current ids` };
  return { updated: true, ...(await dietPlanView(storage, plan)) };
}

export async function doRemoveDietPortion(storage: UserStorage, input: Record<string, unknown>) {
  const portionId = Number(input.portion_id);
  if (!Number.isFinite(portionId)) {
    throw new Error("portion_id required — get it from get_diet_plan");
  }
  const plan = await storage.removeDietPortion(portionId);
  if (!plan)
    return { error: `portion ${portionId} not found — call get_diet_plan for current ids` };
  return { removed: true, ...(await dietPlanView(storage, plan)) };
}

// "Ate as planned": resolve the planned meal against the pantry NOW and
// freeze the result into the meal log (same write path as log_meal).
export async function doLogPlannedMeal(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? todayIso());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: `date must be YYYY-MM-DD (got: ${JSON.stringify(date)})` };
  }
  const plan = await storage.loadActiveDietPlan();
  if (!plan?.rotation?.length) {
    return { error: "no diet plan yet — save_diet_plan first" };
  }
  const day = dietDayForDate(plan, date);
  if (!day) return { error: `no template day for ${date}` };

  const mealId = input.meal_id != null ? Number(input.meal_id) : null;
  const slot = input.slot != null ? String(input.slot).trim() : "";
  let meal = null;
  if (mealId != null) {
    meal = day.meals.find((m) => m.id === mealId) ?? null;
    if (!meal) {
      return {
        error: `planned meal ${mealId} is not on ${day.name} (${date}) — call get_diet_plan`,
      };
    }
  } else if (slot) {
    const matches = day.meals.filter((m) => m.slot === slot);
    if (!matches.length) {
      return {
        error: `no planned '${slot}' on ${day.name} — slots: ${
          day.meals.map((m) => m.slot).join(", ") || "(none)"
        }`,
      };
    }
    if (matches.length > 1) {
      return {
        error: `${matches.length} planned meals share slot '${slot}' on ${day.name} — pass meal_id (${matches
          .map((m) => `${m.id} @ ${m.time ?? "no time"}`)
          .join(", ")})`,
      };
    }
    meal = matches[0];
  } else {
    return { error: "pass slot or meal_id (see get_diet_plan)" };
  }

  const pantry = await storage.loadPantry();
  const resolved = resolveDietMeal(meal, pantry);
  const unresolvable = resolved.items.filter((i) => i.resolved == null);
  if (unresolvable.length) {
    return {
      error:
        "some planned portions can't resolve macros — fix them before logging (never log zeros)",
      needs_enrichment: unresolvable.map((i) => i.food),
      hint: "add/enrich these foods (lookup_product / web_search → add_food or update_food), then retry",
    };
  }

  const items: Meal["items"] = resolved.items.map((i) => ({
    food: i.food,
    grams: i.grams,
    ...i.resolved!,
    source: i.override ? (i.source ?? "manual") : ("db" as const),
  }));
  const log: MealLog = (await storage.loadMealLog(date)) ?? { date, meals: [] };
  const entry: Meal = {
    slot: meal.slot,
    items,
    ...(meal.time ? { time: meal.time } : {}),
  };
  log.meals.push(entry);
  await storage.saveMealLog(log);

  const profile = await storage.loadProfile();
  const target = dayTargetFromPlan(plan, date, profile);
  const totals = dayTotals(log, target, date);
  return {
    logged: {
      date,
      slot: meal.slot,
      ...(meal.time ? { time: meal.time } : {}),
      from_plan_day: day.name,
      item_count: items.length,
      macros_added: sumMacros(items),
    },
    day_totals: totals,
  };
}
