/**
 * Diet plans (plan → day → meal → portion), recipes, and logging a planned
 * meal.
 */
import { UserStorage } from "@fa/agent";
import {
  dayTargetFromPlan,
  dayTotals,
  dietDayForDate,
  type DietPlan,
  type Meal,
  type MealLog,
  normalizeDietMeal,
  normalizeDietPlanWrite,
  normalizeMacros,
  normalizePortion,
  normalizeWeekdays,
  resolveDietMeal,
  resolveDietPlan,
  resolveRecipe,
} from "@fa/shared";
import {
  DietDayPatchRequest,
  DietMealAddRequest,
  DietMealPatchRequest,
  DietPlanWriteRequest,
  DietPortionAddRequest,
  DietPortionPatchRequest,
  LogPlannedRequest,
} from "@fa/shared/schemas";

import { todayIso } from "../dates.ts";
import { authed, type AuthedCtx, jsonError, normalized, readBody } from "../http.ts";
import { type Route, route } from "../router.ts";

// ---- diet plan (normalized template: plan → day → meal → portion) ----
//
// Same storage mutations the agent tools use — one backend surface for both
// (exactly like the workout editor). Responses carry the hydrated plan with
// per-portion macros LIVE-resolved against the pantry plus today's template
// day id, so the UI can highlight "today" and offer one-tap "ate as planned".

async function dietPlanResponse(
  storage: UserStorage,
  plan: DietPlan | null,
): Promise<{ plan: unknown; today_day_id: number | null }> {
  if (!plan) return { plan: null, today_day_id: null };
  const pantry = await storage.loadPantry();
  return {
    plan: resolveDietPlan(plan, pantry),
    today_day_id: dietDayForDate(plan, todayIso())?.id ?? null,
  };
}

async function handleGetActiveDietPlan({ storage }: AuthedCtx): Promise<Response> {
  const plan = await storage.loadActiveDietPlan();
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleGetDietPlan({ storage }: AuthedCtx, planId: number): Promise<Response> {
  const plan = await storage.loadDietPlan(planId);
  if (!plan) return jsonError(404, "diet plan not found");
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleListDietPlans({ storage }: AuthedCtx): Promise<Response> {
  const [plans, profile] = await Promise.all([storage.listDietPlans(), storage.loadProfile()]);
  const activeId = profile?.active_diet_plan_id ?? null;
  return Response.json({
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      active: p.id === activeId,
      day_count: p.rotation.length,
    })),
    active_plan_id: activeId,
  });
}

// ---- recipes (reads only; writes go through POST /tools/run) ----

async function handleListRecipes({ storage }: AuthedCtx): Promise<Response> {
  const [recipes, pantry] = await Promise.all([storage.listRecipes(), storage.loadPantry()]);
  return Response.json({
    recipes: recipes.map((r) => {
      const resolved = resolveRecipe(r, pantry);
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        servings: r.servings,
        favorite: r.favorite,
        ingredient_count: r.ingredients.length,
        kcal_per_serving: resolved.per_serving.kcal,
        unresolved: resolved.unresolved,
      };
    }),
  });
}

async function handleGetRecipe({ storage }: AuthedCtx, recipeId: number): Promise<Response> {
  const recipe = await storage.loadRecipe(recipeId);
  if (!recipe) return jsonError(404, "recipe not found");
  const pantry = await storage.loadPantry();
  return Response.json({ recipe: resolveRecipe(recipe, pantry) });
}

async function handleCreateDietPlan({ req, log, userId, storage }: AuthedCtx): Promise<Response> {
  const body = await readBody(req, DietPlanWriteRequest);
  if ("error" in body) return body.error;
  const parsed = normalized(() => normalizeDietPlanWrite(body.data));
  if ("error" in parsed) return parsed.error;
  const plan = await storage.createDietPlan(parsed.data);
  log.info("diet plan created", {
    user_id: userId,
    plan_id: plan.id,
    days: plan.rotation.length,
  });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleUpdateDietPlan(
  { req, log, userId, storage }: AuthedCtx,
  planId: number,
): Promise<Response> {
  const body = await readBody(req, DietPlanWriteRequest);
  if ("error" in body) return body.error;
  const parsed = normalized(() => normalizeDietPlanWrite(body.data));
  if ("error" in parsed) return parsed.error;
  const plan = await storage.updateDietPlan(planId, parsed.data);
  if (!plan) return jsonError(404, "diet plan not found");
  log.info("diet plan saved", {
    user_id: userId,
    plan_id: plan.id,
    days: plan.rotation.length,
  });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleActivateDietPlan(
  { log, userId, storage }: AuthedCtx,
  planId: number,
): Promise<Response> {
  const ok = await storage.setActiveDietPlan(planId);
  if (!ok) return jsonError(404, "diet plan not found");
  log.info("diet plan activated", { user_id: userId, plan_id: planId });
  const plan = await storage.loadDietPlan(planId);
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleDeleteDietPlan(
  { log, userId, storage }: AuthedCtx,
  planId: number,
): Promise<Response> {
  const ok = await storage.deleteDietPlan(planId);
  if (!ok) return jsonError(404, "diet plan not found");
  log.info("diet plan deleted", { user_id: userId, plan_id: planId });
  return new Response(null, { status: 204 });
}

async function handlePatchDietDay(
  { req, log, userId, storage }: AuthedCtx,
  dayId: number,
): Promise<Response> {
  const body = await readBody(req, DietDayPatchRequest);
  if ("error" in body) return body.error;
  const b = body.data;
  const patch = normalized(() => ({
    ...(b.name?.trim() ? { name: b.name.trim() } : {}),
    ...("weekdays" in b ? { weekdays: normalizeWeekdays(b.weekdays) } : {}),
    // `target: null` clears the per-day override; absent leaves it alone.
    ...("target" in b ? { target: normalizeMacros(b.target) } : {}),
  }));
  if ("error" in patch) return patch.error;
  const plan = await storage.updateDietPlanDay(dayId, patch.data);
  if (!plan) return jsonError(404, "diet day not found");
  log.info("diet day patched", { user_id: userId, day_id: dayId });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleAddDietMeal(
  { req, log, userId, storage }: AuthedCtx,
  dayId: number,
): Promise<Response> {
  const body = await readBody(req, DietMealAddRequest);
  if ("error" in body) return body.error;
  const meal = normalized(() => normalizeDietMeal(body.data));
  if ("error" in meal) return meal.error;
  const plan = await storage.addDietMeal(dayId, meal.data);
  if (!plan) return jsonError(404, "diet day not found");
  log.info("diet meal added", { user_id: userId, day_id: dayId });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handlePatchDietMeal(
  { req, log, userId, storage }: AuthedCtx,
  mealId: number,
): Promise<Response> {
  const body = await readBody(req, DietMealPatchRequest);
  if ("error" in body) return body.error;
  const b = body.data;
  const plan = await storage.updateDietMeal(mealId, {
    ...(b.slot?.trim() ? { slot: b.slot.trim() } : {}),
    // time: "" or null clears the pinned time; absent leaves it alone.
    ...("time" in b ? { time: b.time?.trim() || null } : {}),
  });
  if (!plan) return jsonError(404, "planned meal not found");
  log.info("diet meal patched", { user_id: userId, meal_id: mealId });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleDeleteDietMeal(
  { log, userId, storage }: AuthedCtx,
  mealId: number,
): Promise<Response> {
  const plan = await storage.removeDietMeal(mealId);
  if (!plan) return jsonError(404, "planned meal not found");
  log.info("diet meal removed", { user_id: userId, meal_id: mealId });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleAddDietPortion(
  { req, log, userId, storage }: AuthedCtx,
  mealId: number,
): Promise<Response> {
  const body = await readBody(req, DietPortionAddRequest);
  if ("error" in body) return body.error;
  const portion = normalized(() => normalizePortion(body.data));
  if ("error" in portion) return portion.error;
  const plan = await storage.addDietPortion(mealId, portion.data);
  if (!plan) return jsonError(404, "planned meal not found");
  log.info("diet portion added", { user_id: userId, meal_id: mealId });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handlePatchDietPortion(
  { req, log, userId, storage }: AuthedCtx,
  portionId: number,
): Promise<Response> {
  const body = await readBody(req, DietPortionPatchRequest);
  if ("error" in body) return body.error;
  const b = body.data;
  const patch: Parameters<UserStorage["updateDietPortion"]>[1] = {};
  if (b.food?.trim()) patch.food = b.food.trim();
  if (b.grams !== undefined) patch.grams = b.grams;
  if ("macros" in b) {
    // macros: null clears the override (live pantry resolution again).
    patch.macros = normalizeMacros(b.macros);
    if (patch.macros == null) patch.source = null;
  }
  const plan = await storage.updateDietPortion(portionId, patch);
  if (!plan) return jsonError(404, "portion not found");
  log.info("diet portion patched", {
    user_id: userId,
    portion_id: portionId,
  });
  return Response.json(await dietPlanResponse(storage, plan));
}

async function handleDeleteDietPortion(
  { log, userId, storage }: AuthedCtx,
  portionId: number,
): Promise<Response> {
  const plan = await storage.removeDietPortion(portionId);
  if (!plan) return jsonError(404, "portion not found");
  log.info("diet portion removed", {
    user_id: userId,
    portion_id: portionId,
  });
  return Response.json(await dietPlanResponse(storage, plan));
}

// "Ate as planned": resolve a planned meal against the pantry NOW and freeze
// the result into the meal log. Mirrors the agent's log_planned_meal tool.
// Body: { meal_id, date? } — the UI sends the meal ids of today's template
// day. 409 with needs_enrichment when a portion can't resolve macros.
async function handleLogPlannedMeal({ req, log, userId, storage }: AuthedCtx): Promise<Response> {
  const body = await readBody(req, LogPlannedRequest);
  if ("error" in body) return body.error;
  const mealId = body.data.meal_id;
  const date = body.data.date ?? todayIso();

  const plan = await storage.loadActiveDietPlan();
  if (!plan?.rotation?.length) return jsonError(404, "no diet plan yet");
  const day = dietDayForDate(plan, date);
  const meal = day?.meals.find((m) => m.id === mealId);
  if (!day || !meal) {
    return jsonError(404, `planned meal ${mealId} is not on the template day for ${date}`);
  }

  const pantry = await storage.loadPantry();
  const resolved = resolveDietMeal(meal, pantry);
  const unresolvable = resolved.items.filter((i) => i.resolved == null);
  if (unresolvable.length) {
    return Response.json(
      {
        error: "some planned portions can't resolve macros",
        needs_enrichment: unresolvable.map((i) => i.food),
      },
      { status: 409 },
    );
  }

  const items: Meal["items"] = resolved.items.map((i) => ({
    food: i.food,
    grams: i.grams,
    ...i.resolved!,
    source: i.override ? (i.source ?? "manual") : ("db" as const),
  }));
  const mealLog: MealLog = (await storage.loadMealLog(date)) ?? { date, meals: [] };
  mealLog.meals.push({
    slot: meal.slot,
    items,
    ...(meal.time ? { time: meal.time } : {}),
  });
  await storage.saveMealLog(mealLog);
  log.info("planned meal logged", {
    user_id: userId,
    meal_id: mealId,
    date,
  });

  const profile = await storage.loadProfile();
  const target = dayTargetFromPlan(plan, date, profile);
  return Response.json({
    logged: { date, slot: meal.slot, item_count: items.length },
    day_totals: dayTotals(mealLog, target, date),
  });
}

// ---------- routes ----------

export const dietRoutes: Route[] = [
  route("GET", "/diet/plan", authed(handleGetActiveDietPlan)),
  route("GET", "/diet/plans", authed(handleListDietPlans)),
  route("POST", "/diet/plans", authed(handleCreateDietPlan)),
  route(
    "POST",
    "/diet/plans/:id(\\d+)/activate",
    authed((c) => handleActivateDietPlan(c, Number(c.params.id))),
  ),
  route(
    "GET",
    "/diet/plans/:id(\\d+)",
    authed((c) => handleGetDietPlan(c, Number(c.params.id))),
  ),
  route(
    ["PUT", "PATCH"],
    "/diet/plans/:id(\\d+)",
    authed((c) => handleUpdateDietPlan(c, Number(c.params.id))),
  ),
  route(
    "DELETE",
    "/diet/plans/:id(\\d+)",
    authed((c) => handleDeleteDietPlan(c, Number(c.params.id))),
  ),
  route(
    "PATCH",
    "/diet/days/:id(\\d+)",
    authed((c) => handlePatchDietDay(c, Number(c.params.id))),
  ),
  route(
    "POST",
    "/diet/days/:id(\\d+)/meals",
    authed((c) => handleAddDietMeal(c, Number(c.params.id))),
  ),
  route(
    "PATCH",
    "/diet/meals/:id(\\d+)",
    authed((c) => handlePatchDietMeal(c, Number(c.params.id))),
  ),
  route(
    "DELETE",
    "/diet/meals/:id(\\d+)",
    authed((c) => handleDeleteDietMeal(c, Number(c.params.id))),
  ),
  route(
    "POST",
    "/diet/meals/:id(\\d+)/portions",
    authed((c) => handleAddDietPortion(c, Number(c.params.id))),
  ),
  route(
    "PATCH",
    "/diet/portions/:id(\\d+)",
    authed((c) => handlePatchDietPortion(c, Number(c.params.id))),
  ),
  route(
    "DELETE",
    "/diet/portions/:id(\\d+)",
    authed((c) => handleDeleteDietPortion(c, Number(c.params.id))),
  ),
  route("POST", "/diet/log-planned", authed(handleLogPlannedMeal)),
  // Recipes: reads over REST; writes via POST /tools/run (mutating tools).
  route("GET", "/recipes", authed(handleListRecipes)),
  route(
    "GET",
    "/recipes/:id(\\d+)",
    authed((c) => handleGetRecipe(c, Number(c.params.id))),
  ),
];
