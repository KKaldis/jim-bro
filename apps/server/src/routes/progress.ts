/**
 * The dashboard and the logged-metric endpoints behind the progress views:
 * nutrition, body composition, measurements, cardio, steps and water.
 */
import { executeTool } from "@fa/agent";
import { db, schema } from "@fa/db_postgres";
import {
  computeIdealProportions,
  dayTargetFromPlan,
  dayTotals,
  humanizeFoodName,
  type Macros,
  type Meal,
  type MealLog,
  type Pantry,
  type Profile,
} from "@fa/shared";
import {
  BodyLogRequest,
  BodyUpdateRequest,
  CardioLogRequest,
  MeasurementLogRequest,
  StepsLogRequest,
  WaterLogRequest,
} from "@fa/shared/schemas";
import { and, eq } from "drizzle-orm";

import { DATE_RE, eachDate, parseRange, todayIso } from "../dates.ts";
import { authed, type AuthedCtx, jsonError, readBody } from "../http.ts";
import { type Route, route } from "../router.ts";

async function handleDashboard({ url, log, userId, storage }: AuthedCtx): Promise<Response> {
  const today = todayIso();
  // Optional ?date=YYYY-MM-DD lets the dashboard render any day. Falls back
  // to today on missing / malformed input rather than 400-ing — the UI uses
  // this for day-by-day navigation.
  const requested = url.searchParams.get("date");
  const date = requested && DATE_RE.test(requested) ? requested : today;
  const isToday = date === today;

  const [profile, dietPlan, mealLog, bodyComp, pantry] = await Promise.all([
    storage.loadProfile(),
    storage.loadActiveDietPlan(),
    storage.loadMealLog(date),
    storage.readBodyComp(),
    storage.loadPantry(),
  ]);

  const rawTarget = dayTargetFromPlan(dietPlan, date, profile);
  const { meals, totals } = recomputeDayWithFiber(mealLog, rawTarget, date, pantry);

  const weekday = new Date(date + "T00:00:00")
    .toLocaleDateString("en-US", { weekday: "long" })
    .toLowerCase();

  log.debug("dashboard loaded", {
    user_id: userId,
    meals: mealLog?.meals?.length ?? 0,
    body_comp_entries: bodyComp.length,
  });

  return Response.json({
    date,
    is_today: isToday,
    today_iso: today,
    weekday,
    profile,
    today: {
      meals,
      eaten: totals.eaten,
      eaten_from_meals: totals.eaten,
      target: totals.target,
      remaining: totals.remaining,
      meal_count: totals.meal_count,
    },
    // bodyComp rows already carry their computed columns (bmi, ffmi, etc.)
    // from log_body_comp / POST /body — no read-time enrichment needed.
    bodyComp,
  });
}

// ---- fiber backfill on the wire ----
//
// Fiber + category live on pantry items, and legacy diet-plan targets predate
// fiber. To keep the UI honest *without* mutating stored data, the server
// fills in two gaps when serving dashboard/nutrition responses:
//
//   1. Meal items missing a `fiber` value: look up the current pantry item;
//      if it now carries fiber (per-100 g/ml), scale by grams and patch into
//      the item. Items logged with an explicit fiber value are left alone
//      (the historical log wins).
//   2. Targets that lack a fiber field: synthesize `14 g per 1000 kcal`
//      (IOM Adequate Intake, with a 14 g floor — same default that
//      macroSplit uses for fresh targets).
//
// Both are display-time conveniences. Persisted data is unchanged; once the
// user re-runs compute_targets or logs new meals from fiber-bearing foods,
// the real values flow through naturally.

// Enriches each meal item with three display-only fields the frontend uses:
//   - fiber: scaled from the pantry item when missing on the historical row
//   - category: looked up from the pantry item (e.g. "protein", "grain")
//   - display_name: humanized snake_case (e.g. "Chicken breast (raw)")
// Persisted data is untouched — these are wire-side conveniences.
function enrichMealsWithFiber(meals: Meal[], pantry: Pantry | null): Meal[] {
  const items = pantry?.items ?? {};
  return meals.map((m) => ({
    ...m,
    items: m.items.map((it) => {
      const entry = items[it.food];
      const out: typeof it & {
        category?: string;
        display_name?: string;
      } = { ...it };
      if (out.fiber == null && entry?.macros?.fiber != null) {
        out.fiber = Math.round(((entry.macros.fiber * it.grams) / 100) * 10) / 10;
      }
      if (entry?.category) out.category = entry.category;
      out.display_name = humanizeFoodName(it.food);
      return out;
    }),
  }));
}

function ensureFiberTarget(target: Macros | null): Macros | null {
  if (!target) return target;
  if (target.fiber != null) return target;
  if (!Number.isFinite(target.kcal) || target.kcal <= 0) return target;
  return {
    ...target,
    fiber: Math.max(14, Math.round((14 * target.kcal) / 1000)),
  };
}

// Recomputes day totals after enriching items + target so eaten.fiber /
// target.fiber / remaining.fiber all line up.
function recomputeDayWithFiber(
  log: MealLog | null,
  rawTarget: Macros | null,
  date: string,
  pantry: Pantry | null,
) {
  const meals = log ? enrichMealsWithFiber(log.meals, pantry) : [];
  const enrichedLog: MealLog | null = log ? { date: log.date, meals } : null;
  const target = ensureFiberTarget(rawTarget);
  return { meals, totals: dayTotals(enrichedLog, target, date) };
}

// The profile's cached recommendation (loadProfile output) as a day target;
// null until it has a usable kcal figure.
function profileTarget(profile: Profile | null): Macros | null {
  const kcal = profile?.target_kcal;
  if (kcal == null || !(kcal > 0)) return null;
  return {
    kcal,
    p: profile?.target_protein_g ?? 0,
    f: profile?.target_fat_g ?? 0,
    c: profile?.target_carbs_g ?? 0,
    ...(profile?.target_fiber_g != null ? { fiber: profile.target_fiber_g } : {}),
  };
}

async function handleProgressNutrition({
  url,
  log,
  userId,
  storage,
}: AuthedCtx): Promise<Response> {
  const range = parseRange(url);
  if ("error" in range) return range.error;

  const [dietPlan, logs, pantry, profile] = await Promise.all([
    storage.loadActiveDietPlan(),
    storage.loadMealLogsRange(range.from, range.to),
    storage.loadPantry(),
    storage.loadProfile(),
  ]);
  const byDate = new Map(logs.map((l) => [l.date, l]));
  // No active diet plan → judge days against the profile's goal-based
  // recommendation (cut / maintain / recomp / lean_bulk) instead of leaving
  // every day target-less.
  const goalTarget = dietPlan ? null : profileTarget(profile);

  const days = eachDate(range.from, range.to).map((date) => {
    const mealLog = byDate.get(date) ?? null;
    const rawTarget = goalTarget ?? dayTargetFromPlan(dietPlan, date, profile);
    const { meals, totals } = recomputeDayWithFiber(mealLog, rawTarget, date, pantry);
    return {
      date,
      meals,
      eaten: totals.eaten,
      target: totals.target,
      remaining: totals.remaining,
      meal_count: totals.meal_count,
    };
  });

  const daysWithLogs = days.filter((d) => d.meal_count > 0).length;
  // Fiber rides on top of the kcal/p/f/c sum. We only surface a fiber field
  // when at least one day actually carried it (matches sumMacros semantics).
  let sumEatenFiber = 0;
  let anyEatenFiber = false;
  const sumEatenCore = days.reduce(
    (acc, d) => {
      if (d.eaten.fiber != null) {
        sumEatenFiber += d.eaten.fiber;
        anyEatenFiber = true;
      }
      return {
        kcal: acc.kcal + d.eaten.kcal,
        p: acc.p + d.eaten.p,
        f: acc.f + d.eaten.f,
        c: acc.c + d.eaten.c,
      };
    },
    { kcal: 0, p: 0, f: 0, c: 0 },
  );
  const sumEaten = anyEatenFiber ? { ...sumEatenCore, fiber: sumEatenFiber } : sumEatenCore;

  const daysWithTarget = days.filter((d) => d.target).length;
  let sumTargetFiber = 0;
  let anyTargetFiber = false;
  const sumTargetCore = days.reduce(
    (acc, d) => {
      if (!d.target) return acc;
      if (d.target.fiber != null) {
        sumTargetFiber += d.target.fiber;
        anyTargetFiber = true;
      }
      return {
        kcal: acc.kcal + d.target.kcal,
        p: acc.p + d.target.p,
        f: acc.f + d.target.f,
        c: acc.c + d.target.c,
      };
    },
    { kcal: 0, p: 0, f: 0, c: 0 },
  );
  const sumTarget = anyTargetFiber ? { ...sumTargetCore, fiber: sumTargetFiber } : sumTargetCore;

  const avgEaten =
    daysWithLogs > 0
      ? {
          kcal: sumEaten.kcal / daysWithLogs,
          p: sumEaten.p / daysWithLogs,
          f: sumEaten.f / daysWithLogs,
          c: sumEaten.c / daysWithLogs,
          ...(anyEatenFiber ? { fiber: sumEatenFiber / daysWithLogs } : {}),
        }
      : null;
  const avgTarget =
    daysWithTarget > 0
      ? {
          kcal: sumTarget.kcal / daysWithTarget,
          p: sumTarget.p / daysWithTarget,
          f: sumTarget.f / daysWithTarget,
          c: sumTarget.c / daysWithTarget,
          ...(anyTargetFiber ? { fiber: sumTargetFiber / daysWithTarget } : {}),
        }
      : null;

  log.debug("progress/nutrition", {
    user_id: userId,
    from: range.from,
    to: range.to,
    days_with_logs: daysWithLogs,
  });

  return Response.json({
    from: range.from,
    to: range.to,
    days,
    totals: {
      eaten: sumEaten,
      target: daysWithTarget > 0 ? sumTarget : null,
      days_with_logs: daysWithLogs,
    },
    averages: { eaten: avgEaten, target: avgTarget },
  });
}

// ---- steps (daily pedometer aggregate) ----

// Read one day's step total. Missing rows read as 0 / null goal so the client
// never has to special-case "never walked on this day".
async function handleGetSteps({ url, userId }: AuthedCtx): Promise<Response> {
  const requested = url.searchParams.get("date");
  const date = requested && DATE_RE.test(requested) ? requested : todayIso();

  const rows = await db()
    .select()
    .from(schema.dailySteps)
    .where(and(eq(schema.dailySteps.userId, userId), eq(schema.dailySteps.date, date)))
    .limit(1);
  const row = rows[0];
  return Response.json({ date, steps: row?.steps ?? 0, goal: row?.goal ?? null });
}

// Upsert a day's step total. `steps` is absolute (the client owns today's
// running count). `goal` is only touched when present in the body — undefined
// leaves an existing goal alone; explicit null clears it.
async function handleLogSteps({ req, log, userId }: AuthedCtx): Promise<Response> {
  const parsed = await readBody(req, StepsLogRequest);
  if ("error" in parsed) return parsed.error;
  const date = parsed.data.date ?? todayIso();
  const { steps, goal } = parsed.data;

  const onConflictSet: { steps: number; updatedAt: Date; goal?: number | null } = {
    steps,
    updatedAt: new Date(),
  };
  if (goal !== undefined) onConflictSet.goal = goal;

  await db()
    .insert(schema.dailySteps)
    .values({ userId: userId, date, steps, goal: goal ?? null })
    .onConflictDoUpdate({
      target: [schema.dailySteps.userId, schema.dailySteps.date],
      set: onConflictSet,
    });

  const rows = await db()
    .select()
    .from(schema.dailySteps)
    .where(and(eq(schema.dailySteps.userId, userId), eq(schema.dailySteps.date, date)))
    .limit(1);
  const row = rows[0];
  log.info("steps logged via API", { user_id: userId, date, steps });
  return Response.json({
    date,
    steps: row?.steps ?? steps,
    goal: row?.goal ?? null,
  });
}

// ---- water (daily intake aggregate) ----

// Read one day's water total. Missing rows read as 0 ml.
async function handleGetWater({ url, storage }: AuthedCtx): Promise<Response> {
  const requested = url.searchParams.get("date");
  const date = requested && DATE_RE.test(requested) ? requested : todayIso();
  const { ml } = await storage.loadWater(date);
  return Response.json({ date, ml });
}

// Upsert a day's water total. `ml` is absolute (the client owns the running
// total). Shares storage.saveWater with the agent (log_water) so chat and UI
// write through the same path.
async function handleLogWater({ req, log, userId, storage }: AuthedCtx): Promise<Response> {
  const parsed = await readBody(req, WaterLogRequest);
  if ("error" in parsed) return parsed.error;
  const date = parsed.data.date ?? todayIso();
  const { ml } = parsed.data;
  const saved = await storage.saveWater({ date, ml });
  log.info("water logged via API", { user_id: userId, date, ml });
  return Response.json({ date, ml: saved.ml });
}

async function handleProgressBody({ url, log, userId, storage }: AuthedCtx): Promise<Response> {
  const range = parseRange(url);
  if ("error" in range) return range.error;

  const [entries, profile] = await Promise.all([
    storage.readBodyCompRange(range.from, range.to),
    storage.loadProfile(),
  ]);

  // Stats summarize whichever body-fat reading is most authoritative for
  // each entry: user-entered DEXA/BIA wins, Navy estimate fills in otherwise.
  // Same logic the agent uses, so the chart and the assistant agree.
  const effectiveBf = entries.map((e) => e.body_fat_pct ?? e.body_fat_pct_navy ?? null);
  const stats = {
    weight_kg: summarize(entries.map((e) => e.weight_kg).filter((v): v is number => v != null)),
    body_fat_pct: summarize(effectiveBf.filter((v): v is number => v != null)),
    waist_cm: summarize(entries.map((e) => e.waist_cm).filter((v): v is number => v != null)),
    bmi: summarize(entries.map((e) => e.bmi ?? null).filter((v): v is number => v != null)),
    ffmi: summarize(entries.map((e) => e.ffmi ?? null).filter((v): v is number => v != null)),
  };

  log.debug("progress/body", {
    user_id: userId,
    from: range.from,
    to: range.to,
    entries: entries.length,
  });

  return Response.json({
    from: range.from,
    to: range.to,
    entries,
    stats,
    sex: profile?.sex ?? null,
  });
}

// Cardio-fitness (VO₂max) entries + stats over a date range. Mirrors
// handleProgressBody — same range parsing and summarize() stat shape — so the
// Progress chart can reuse the body-progress rendering.
async function handleProgressCardio({ url, log, userId, storage }: AuthedCtx): Promise<Response> {
  const range = parseRange(url);
  if ("error" in range) return range.error;

  const [entries, profile] = await Promise.all([
    storage.readCardioRange(range.from, range.to),
    storage.loadProfile(),
  ]);

  const stats = {
    resting_heart_rate: summarize(
      entries.map((e) => e.resting_heart_rate).filter((v): v is number => v != null),
    ),
    vo2_max: summarize(entries.map((e) => e.vo2_max ?? null).filter((v): v is number => v != null)),
  };

  log.debug("progress/cardio", {
    user_id: userId,
    from: range.from,
    to: range.to,
    entries: entries.length,
  });

  return Response.json({
    from: range.from,
    to: range.to,
    entries,
    stats,
    sex: profile?.sex ?? null,
  });
}

// Log a cardio reading. Reuses the agent's log_cardio tool so the VO₂max
// snapshot is computed and persisted identically whether the entry came from
// chat or the Progress page.
async function handleLogCardio({ req, log, userId, storage }: AuthedCtx): Promise<Response> {
  const parsed = await readBody(req, CardioLogRequest);
  if ("error" in parsed) return parsed.error;
  try {
    const raw = await executeTool("log_cardio", parsed.data as Record<string, unknown>, storage);
    const result = JSON.parse(raw);
    if (result?.error) {
      return jsonError(400, result.error);
    }
    log.info("cardio entry logged via API", { user_id: userId });
    return Response.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // log_cardio throws plain Errors for a missing profile / bad heart rate;
    // surface them as 400s rather than 500s — they're caller fixable.
    return jsonError(400, msg);
  }
}

// Delete a single cardio reading by row id (scoped to the user). 404s when no
// entry with that id belongs to the user.
async function handleDeleteCardioEntry(
  { log, userId, storage }: AuthedCtx,
  id: number,
): Promise<Response> {
  const removed = await storage.deleteCardioEntry(id);
  if (!removed) return jsonError(404, "no cardio entry with that id");
  log.info("cardio entry deleted via API", { user_id: userId, id });
  return new Response(null, { status: 204 });
}

// Tape girths per day over a range. Muscle girths come from the measuring
// sessions; waist / neck / hip from each day's newest weigh-in (the row
// log_measurements edits), so the Measurements view and Navy BF% agree.
// `proportions` is computed from the newest value of every part as of `to`,
// so browsing back in time shows the proportions you had then.
async function handleProgressMeasurements({
  url,
  log,
  userId,
  storage,
}: AuthedCtx): Promise<Response> {
  const range = parseRange(url);
  if ("error" in range) return range.error;

  const [sessions, weighIns, latest, profile] = await Promise.all([
    storage.readMeasurementsRange(range.from, range.to),
    storage.readBodyCompRange(range.from, range.to),
    storage.latestGirths(range.to),
    storage.loadProfile(),
  ]);

  // Newest weigh-in per day (entries arrive oldest first, so last one wins).
  const weighInByDay = new Map<string, (typeof weighIns)[number]>();
  for (const w of weighIns) weighInByDay.set(w.date, w);
  const sessionByDay = new Map(sessions.map((s) => [s.date, s]));
  const days = [...new Set([...sessionByDay.keys(), ...weighInByDay.keys()])].sort();
  const entries = days.flatMap((date) => {
    const s = sessionByDay.get(date);
    const w = weighInByDay.get(date);
    const waist = w?.waist_cm ?? null;
    const neck = w?.neck_cm ?? null;
    const hip = w?.hip_cm ?? null;
    if (!s && waist == null && neck == null && hip == null) return [];
    return [
      {
        date,
        shoulders_cm: s?.shoulders_cm ?? null,
        chest_cm: s?.chest_cm ?? null,
        arm_cm: s?.arm_cm ?? null,
        forearm_cm: s?.forearm_cm ?? null,
        thigh_cm: s?.thigh_cm ?? null,
        calf_cm: s?.calf_cm ?? null,
        waist_cm: waist,
        neck_cm: neck,
        hip_cm: hip,
        ...(s?.notes ? { notes: s.notes } : {}),
        has_session: s != null,
        weigh_in_id: w?.id ?? null,
        time: s?.time ?? w?.time ?? null,
        logged_at: s?.logged_at ?? w?.logged_at ?? null,
      },
    ];
  });

  const sex = profile?.sex ?? null;
  const wrist = profile?.wrist_cm ?? null;
  const proportions =
    sex && wrist != null
      ? computeIdealProportions({
          sex,
          wrist_cm: wrist,
          height_cm: profile?.height_cm ?? null,
          measurements: latest,
        })
      : null;

  log.debug("progress/measurements", {
    user_id: userId,
    from: range.from,
    to: range.to,
    entries: entries.length,
  });

  return Response.json({
    from: range.from,
    to: range.to,
    entries,
    latest,
    proportions,
    sex,
    wrist_cm: wrist,
  });
}

// Save the day's measuring session through the agent's log_measurements tool,
// so chat and the Body page split girths between session and weigh-in the
// same way.
async function handleLogMeasurements(
  { req, log, userId, storage }: AuthedCtx,
  date: string,
): Promise<Response> {
  const parsed = await readBody(req, MeasurementLogRequest);
  if ("error" in parsed) return parsed.error;
  try {
    const raw = await executeTool("log_measurements", { ...parsed.data, date }, storage);
    const result = JSON.parse(raw);
    if (result?.error) return jsonError(400, result.error);
    log.info("measurements saved via API", { user_id: userId, date });
    return Response.json(result, { status: 200 });
  } catch (err) {
    // Missing weight / bad girth are caller-fixable — 400, not 500.
    return jsonError(400, err instanceof Error ? err.message : String(err));
  }
}

// Delete the day's measuring session. Waist / neck / hip belong to the
// weigh-in and are left alone.
async function handleDeleteMeasurements(
  { log, userId, storage }: AuthedCtx,
  date: string,
): Promise<Response> {
  const removed = await storage.deleteMeasurement(date);
  if (!removed) return jsonError(404, "no measurements for that date");
  log.info("measurements deleted via API", { user_id: userId, date });
  return new Response(null, { status: 204 });
}

// Write a body composition entry. Reuses the agent's log_body_comp tool so
// derived metrics (BMI, FFMI, Navy BF%, etc.) are computed and persisted the
// same way whether the entry came from chat or the Body page form.
async function handleLogBody({ req, log, userId, storage }: AuthedCtx): Promise<Response> {
  const body = await readBody(req, BodyLogRequest);
  if ("error" in body) return body.error;
  try {
    const raw = await executeTool("log_body_comp", body.data, storage);
    const result = JSON.parse(raw);
    if (result?.error) {
      return jsonError(400, result.error);
    }
    log.info("body entry logged via API", { user_id: userId });
    return Response.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // log_body_comp throws plain Errors for missing profile / bad weight;
    // surface them as 400s rather than 500s — they're caller fixable.
    return jsonError(400, msg);
  }
}

// Delete every body-composition entry for a date. Reuses the agent's
// delete_body_comp_entry semantics (delete-by-date) so the Body page and chat
// agree on what "remove this weigh-in" means. 404s when nothing matched.
async function handleDeleteBody(
  { log, userId, storage }: AuthedCtx,
  date: string,
): Promise<Response> {
  const removed = await storage.deleteBodyCompEntries(date);
  if (removed === 0) return jsonError(404, "no body entry for that date");
  log.info("body entries deleted via API", {
    user_id: userId,
    date,
    removed,
  });
  return new Response(null, { status: 204 });
}

// Delete a single body-composition entry by its row id. Unlike the
// delete-by-date route, this removes exactly one weigh-in, so the Body page's
// per-row delete leaves any other entries on the same day untouched. 404s when
// no entry with that id belongs to the user.
async function handleDeleteBodyEntry(
  { log, userId, storage }: AuthedCtx,
  id: number,
): Promise<Response> {
  const removed = await storage.deleteBodyCompEntry(id);
  if (!removed) return jsonError(404, "no body entry with that id");
  log.info("body entry deleted via API", { user_id: userId, id });
  return new Response(null, { status: 204 });
}

// Edit an existing body-composition entry. Reuses the agent's
// update_body_comp_entry tool so the merge + metric recompute (BMI/FFMI/Navy)
// matches the chat path. {date} is the locator (the day the entry is logged
// under); the JSON body carries the new field values and may include a new
// `date` to move it.
async function handleUpdateBody(
  { req, log, userId, storage }: AuthedCtx,
  date: string,
): Promise<Response> {
  const body = await readBody(req, BodyUpdateRequest);
  if ("error" in body) return body.error;
  try {
    const raw = await executeTool(
      "update_body_comp_entry",
      { ...body.data, original_date: date },
      storage,
    );
    const result = JSON.parse(raw);
    if (result?.error) return jsonError(400, result.error);
    log.info("body entry updated via API", { user_id: userId, date });
    return Response.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(400, msg);
  }
}

function summarize(
  values: number[],
): { first: number; last: number; min: number; max: number; change: number; count: number } | null {
  if (!values.length) return null;
  const first = values[0];
  const last = values[values.length - 1];
  return {
    first,
    last,
    min: Math.min(...values),
    max: Math.max(...values),
    change: last - first,
    count: values.length,
  };
}

// ---------- routes ----------

export const progressRoutes: Route[] = [
  route("GET", "/dashboard", authed(handleDashboard)),
  route("GET", "/progress/nutrition", authed(handleProgressNutrition)),
  route("GET", "/progress/body", authed(handleProgressBody)),
  route("GET", "/progress/cardio", authed(handleProgressCardio)),
  route("GET", "/progress/measurements", authed(handleProgressMeasurements)),
  route("POST", "/cardio", authed(handleLogCardio)),
  route(
    "DELETE",
    "/cardio/entry/:id(\\d+)",
    authed((c) => handleDeleteCardioEntry(c, Number(c.params.id))),
  ),
  route(
    "PUT",
    "/measurements/:date(\\d{4}-\\d{2}-\\d{2})",
    authed((c) => handleLogMeasurements(c, c.params.date)),
  ),
  route(
    "DELETE",
    "/measurements/:date(\\d{4}-\\d{2}-\\d{2})",
    authed((c) => handleDeleteMeasurements(c, c.params.date)),
  ),
  route("POST", "/body", authed(handleLogBody)),
  route(
    "DELETE",
    "/body/entry/:id(\\d+)",
    authed((c) => handleDeleteBodyEntry(c, Number(c.params.id))),
  ),
  route(
    "DELETE",
    "/body/:date(\\d{4}-\\d{2}-\\d{2})",
    authed((c) => handleDeleteBody(c, c.params.date)),
  ),
  route(
    ["PATCH", "PUT"],
    "/body/:date(\\d{4}-\\d{2}-\\d{2})",
    authed((c) => handleUpdateBody(c, c.params.date)),
  ),
  route("GET", "/steps", authed(handleGetSteps)),
  route("POST", "/steps", authed(handleLogSteps)),
  route("GET", "/water", authed(handleGetWater)),
  route("POST", "/water", authed(handleLogWater)),
];
