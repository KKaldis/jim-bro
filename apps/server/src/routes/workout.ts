/**
 * Workout plans, sessions + sets, and training progress.
 */
import {
  epley1RM,
  type ExerciseProgressPoint,
  type MuscleGroupId,
  muscleGroupsForExercise,
  type MuscleGroupVolumePoint,
  normalizeWorkoutPlanWrite,
  normalizeWorkoutSet,
  setVolume,
  targetsForExercise,
  WORKOUT_CATALOG,
  type WorkoutPR,
} from "@fa/shared";
import {
  WorkoutPlanWriteRequest,
  WorkoutSessionPatchRequest,
  WorkoutSessionStartRequest,
  WorkoutSetRequest,
} from "@fa/shared/schemas";

import { DATE_RE, shiftIso, todayIso } from "../dates.ts";
import { authed, type AuthedCtx, jsonError, normalized, readBody } from "../http.ts";
import { type Route, route } from "../router.ts";

// Static workout catalog (muscle groups + muscles + exercises + machines).
// No auth required — it's the same payload for every user, immutable until a
// deploy. One-hour browser cache; an etag would be marginal here since the
// payload is small (~30KB).
function handleWorkoutCatalog(): Response {
  return Response.json(WORKOUT_CATALOG, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}

async function handleListWorkoutPlans({ log, userId, storage }: AuthedCtx): Promise<Response> {
  const [plans, profile] = await Promise.all([storage.listWorkoutPlans(), storage.loadProfile()]);
  const activeId = profile?.active_workout_plan_id ?? null;
  log.debug("workout plans listed", {
    user_id: userId,
    count: plans.length,
  });
  return Response.json({ plans, active_plan_id: activeId });
}

async function handleActivateWorkoutPlan(
  { log, userId, storage }: AuthedCtx,
  planId: number,
): Promise<Response> {
  const ok = await storage.setActiveWorkoutPlan(planId);
  if (!ok) return jsonError(404, "plan not found");
  log.info("workout plan activated", {
    user_id: userId,
    plan_id: planId,
  });
  const plan = await storage.loadWorkoutPlan(planId);
  return Response.json({ plan });
}

async function handleGetWorkoutPlan({ storage }: AuthedCtx, planId: number): Promise<Response> {
  const plan = await storage.loadWorkoutPlan(planId);
  if (!plan) return jsonError(404, "plan not found");
  return Response.json({ plan });
}

// Body shape mirrors WorkoutPlan minus server-assigned fields. We parse
// loosely (no zod yet) and rely on Drizzle's type errors to catch missing
// columns — bad inputs surface as 400s via the catch-all error handler.
async function handleCreateWorkoutPlan({
  req,
  log,
  userId,
  storage,
}: AuthedCtx): Promise<Response> {
  const body = await readBody(req, WorkoutPlanWriteRequest);
  if ("error" in body) return body.error;
  const parsed = normalized(() => normalizeWorkoutPlanWrite(body.data));
  if ("error" in parsed) return parsed.error;
  const plan = await storage.createWorkoutPlan(parsed.data);
  log.info("workout plan created", {
    user_id: userId,
    plan_id: plan.id,
  });
  return Response.json({ plan }, { status: 201 });
}

async function handleUpdateWorkoutPlan(
  { req, log, userId, storage }: AuthedCtx,
  planId: number,
): Promise<Response> {
  const body = await readBody(req, WorkoutPlanWriteRequest);
  if ("error" in body) return body.error;
  const parsed = normalized(() => normalizeWorkoutPlanWrite(body.data));
  if ("error" in parsed) return parsed.error;
  const plan = await storage.updateWorkoutPlan(planId, parsed.data);
  if (!plan) return jsonError(404, "plan not found");
  log.info("workout plan updated", {
    user_id: userId,
    plan_id: planId,
  });
  return Response.json({ plan });
}

async function handleDeleteWorkoutPlan(
  { log, userId, storage }: AuthedCtx,
  planId: number,
): Promise<Response> {
  const ok = await storage.deleteWorkoutPlan(planId);
  if (!ok) return jsonError(404, "plan not found");
  log.info("workout plan deleted", {
    user_id: userId,
    plan_id: planId,
  });
  return new Response(null, { status: 204 });
}

// ---- workout sessions + sets ----

async function handleListWorkoutSessions({ url, storage }: AuthedCtx): Promise<Response> {
  const today = todayIso();
  // Default range: last 7 days through today. UI passes explicit from/to
  // for the history view.
  const from = url.searchParams.get("from") ?? shiftIso(today, -7);
  const to = url.searchParams.get("to") ?? today;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return jsonError(400, "from/to must be YYYY-MM-DD");
  }
  const sessions = await storage.listWorkoutSessions(from, to);
  return Response.json({ from, to, sessions });
}

async function handleGetWorkoutSession({ storage }: AuthedCtx, id: number): Promise<Response> {
  const row = await storage.loadWorkoutSession(id);
  if (!row) return jsonError(404, "session not found");
  return Response.json({ session: row });
}

async function handleStartWorkoutSession({
  req,
  log,
  userId,
  storage,
}: AuthedCtx): Promise<Response> {
  const body = await readBody(req, WorkoutSessionStartRequest);
  if ("error" in body) return body.error;
  const b = body.data;
  const date = b.date ?? todayIso();
  // Any non-today session (retroactive log or future plan) skips the
  // wall-clock timer — Finish will collect duration from the user instead.
  const backdated = date !== todayIso();
  const created = await storage.startWorkoutSession({
    date,
    plan_day_id: b.plan_day_id ?? null,
    name: b.name ?? null,
    started_at: b.started_at ?? null,
    backdated,
    notes: b.notes ?? null,
  });
  log.info("workout session started", {
    user_id: userId,
    session_id: created.id,
    date,
  });
  return Response.json({ session: created }, { status: 201 });
}

async function handlePatchWorkoutSession(
  { req, log, userId, storage }: AuthedCtx,
  id: number,
): Promise<Response> {
  const body = await readBody(req, WorkoutSessionPatchRequest);
  if ("error" in body) return body.error;
  const b = body.data;
  // Present (incl. null) sets/clears a field; absent leaves it alone.
  const field = <K extends keyof typeof b>(k: K) => (k in b ? (b[k] ?? null) : undefined);
  const updated = await storage.patchWorkoutSession(id, {
    name: field("name"),
    duration_min: field("duration_min"),
    kcal_burned: field("kcal_burned"),
    notes: field("notes"),
  });
  if (!updated) return jsonError(404, "session not found");
  log.info("workout session patched", {
    user_id: userId,
    session_id: id,
  });
  return Response.json({ session: updated });
}

async function handleDeleteWorkoutSession(
  { log, userId, storage }: AuthedCtx,
  id: number,
): Promise<Response> {
  const ok = await storage.deleteWorkoutSession(id);
  if (!ok) return jsonError(404, "session not found");
  log.info("workout session deleted", {
    user_id: userId,
    session_id: id,
  });
  return new Response(null, { status: 204 });
}

async function handleAppendWorkoutSet(
  { req, log, userId, storage }: AuthedCtx,
  sessionId: number,
): Promise<Response> {
  const body = await readBody(req, WorkoutSetRequest);
  if ("error" in body) return body.error;
  const input = normalized(() => normalizeWorkoutSet(body.data));
  if ("error" in input) return input.error;
  const exercise_id = input.data.exercise_id;
  const set = await storage.appendWorkoutSet(sessionId, input.data);
  if (!set) return jsonError(404, "session not found");
  log.info("workout set logged", {
    user_id: userId,
    session_id: sessionId,
    exercise_id,
    set_id: set.id,
  });
  return Response.json({ set }, { status: 201 });
}

async function handleDeleteWorkoutSet(
  { storage }: AuthedCtx,
  sessionId: number,
  setId: number,
): Promise<Response> {
  const ok = await storage.deleteWorkoutSet(sessionId, setId);
  if (!ok) return jsonError(404, "set not found");
  return new Response(null, { status: 204 });
}

async function handleLastSetsForExercise(
  { url, storage }: AuthedCtx,
  exerciseId: string,
): Promise<Response> {
  const rawLimit = Number(url.searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 10;
  const sets = await storage.lastSetsForExercise(exerciseId, limit);
  return Response.json({ exercise_id: exerciseId, sets });
}

// Per-exercise progress: one row per calendar date the user trained this
// exercise. Aggregates: heaviest single set (top weight + the reps at that
// weight), best Epley est-1RM across all sets that day, and total volume
// (Σ reps × weight). Default window: last 180 days.
async function handleExerciseProgress(
  { url, storage }: AuthedCtx,
  exerciseId: string,
): Promise<Response> {
  const today = todayIso();
  const from = url.searchParams.get("from") ?? shiftIso(today, -180);
  const to = url.searchParams.get("to") ?? today;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return jsonError(400, "from/to must be YYYY-MM-DD");
  }
  const sets = await storage.loadSetsForProgress({ exerciseId, from, to });

  // Group by date, then derive the four metrics. Sets arrive oldest-first so
  // per-date arrays preserve chronological order — irrelevant to the math but
  // means the "top set" is reproducible when multiple sets tie on weight.
  const byDate = new Map<string, Array<(typeof sets)[number]>>();
  for (const s of sets) {
    const arr = byDate.get(s.date) ?? [];
    arr.push(s);
    byDate.set(s.date, arr);
  }
  const points: ExerciseProgressPoint[] = [];
  for (const [date, daySets] of byDate) {
    let topWeight = 0;
    let topReps = 0;
    let best1RM = 0;
    let totalVolume = 0;
    for (const s of daySets) {
      if (s.weight_kg > topWeight) {
        topWeight = s.weight_kg;
        topReps = s.reps;
      }
      const oneRm = epley1RM(s.reps, s.weight_kg);
      if (oneRm > best1RM) best1RM = oneRm;
      totalVolume += setVolume({ reps: s.reps, weight_kg: s.weight_kg });
    }
    points.push({
      date,
      top_weight_kg: topWeight,
      top_reps_at_top_weight: topReps,
      est_1rm_kg: best1RM,
      total_volume_kg: Math.round(totalVolume * 10) / 10,
    });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return Response.json({ exercise_id: exerciseId, from, to, points });
}

// ISO Monday for an arbitrary YYYY-MM-DD. Used to bucket sets into weeks for
// the volume-by-muscle-group view. Treats Monday as the start of the week
// (matches the WEEKDAYS array used everywhere else).
function isoWeekStart(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const offset = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Weekly training volume by muscle group. Each set's volume is attributed
// to EVERY primary muscle group the exercise targets (a bench press counts
// for chest, shoulders, and triceps) — matches how strength coaches think
// about volume distribution. Secondary muscles are excluded to avoid double-
// counting assistive work. Default window: last 12 weeks. `by=target` buckets
// by the finer targets (biceps, calves…) instead, the id in group_id.
async function handleMuscleGroupVolume({ url, storage }: AuthedCtx): Promise<Response> {
  const bucketsFor =
    url.searchParams.get("by") === "target" ? targetsForExercise : muscleGroupsForExercise;
  const today = todayIso();
  const from = url.searchParams.get("from") ?? shiftIso(today, -7 * 12);
  const to = url.searchParams.get("to") ?? today;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return jsonError(400, "from/to must be YYYY-MM-DD");
  }
  const sets = await storage.loadSetsForProgress({ from, to });

  // Key = `${week_start}|${group_id}`. Lets us accumulate volume + set count
  // in one pass and emit a flat array at the end.
  const buckets = new Map<
    string,
    { week_start: string; group_id: MuscleGroupId; total_volume_kg: number; set_count: number }
  >();
  for (const s of sets) {
    const groups = bucketsFor(s.exercise_id);
    if (groups.length === 0) continue;
    const week = isoWeekStart(s.date);
    const vol = setVolume({ reps: s.reps, weight_kg: s.weight_kg });
    for (const g of groups) {
      const key = `${week}|${g}`;
      const cur = buckets.get(key) ?? {
        week_start: week,
        group_id: g,
        total_volume_kg: 0,
        set_count: 0,
      };
      cur.total_volume_kg += vol;
      cur.set_count += 1;
      buckets.set(key, cur);
    }
  }
  const points: MuscleGroupVolumePoint[] = Array.from(buckets.values())
    .map((p) => ({
      ...p,
      total_volume_kg: Math.round(p.total_volume_kg * 10) / 10,
    }))
    .sort((a, b) =>
      a.week_start === b.week_start
        ? a.group_id.localeCompare(b.group_id)
        : a.week_start.localeCompare(b.week_start),
    );
  return Response.json({ from, to, points });
}

// Recent personal records. Walks sets oldest-first per exercise, tracking
// running top-weight and best Epley est-1RM. Every time either record is
// beaten, emit a PR event. The same set can beat both records; we emit one
// event with `kind: "top_weight"` in that case (top weight is the more
// viscerally felt PR — users care about "I lifted heavier" first).
async function handleRecentPRs({ url, storage }: AuthedCtx): Promise<Response> {
  const rawLimit = Number(url.searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
  const sets = await storage.loadSetsForProgress({}); // full history, oldest-first

  type Best = { weight: number; oneRm: number };
  const bestByExercise = new Map<string, Best>();
  const prs: WorkoutPR[] = [];
  for (const s of sets) {
    if (s.weight_kg <= 0 || s.reps <= 0) continue; // skip bodyweight / empty
    const prev = bestByExercise.get(s.exercise_id) ?? { weight: 0, oneRm: 0 };
    const oneRm = epley1RM(s.reps, s.weight_kg);
    const beatsWeight = s.weight_kg > prev.weight;
    const beatsOneRm = oneRm > prev.oneRm;
    if (beatsWeight || beatsOneRm) {
      prs.push({
        exercise_id: s.exercise_id,
        date: s.date,
        kind: beatsWeight ? "top_weight" : "est_1rm",
        reps: s.reps,
        weight_kg: s.weight_kg,
        est_1rm_kg: oneRm,
      });
      bestByExercise.set(s.exercise_id, {
        weight: Math.max(prev.weight, s.weight_kg),
        oneRm: Math.max(prev.oneRm, oneRm),
      });
    }
  }
  // Most-recent first, cap at limit. Stable within a date: keep insertion
  // order (which is set-order within the day from the storage query).
  prs.reverse();
  return Response.json({ prs: prs.slice(0, limit) });
}

// ---------- routes ----------

export const workoutRoutes: Route[] = [
  route("GET", "/workout/catalog", () => handleWorkoutCatalog()),
  route("GET", "/workout/plans", authed(handleListWorkoutPlans)),
  route("POST", "/workout/plans", authed(handleCreateWorkoutPlan)),
  route(
    "POST",
    "/workout/plans/:id(\\d+)/activate",
    authed((c) => handleActivateWorkoutPlan(c, Number(c.params.id))),
  ),
  route(
    "GET",
    "/workout/plans/:id(\\d+)",
    authed((c) => handleGetWorkoutPlan(c, Number(c.params.id))),
  ),
  route(
    ["PATCH", "PUT"],
    "/workout/plans/:id(\\d+)",
    authed((c) => handleUpdateWorkoutPlan(c, Number(c.params.id))),
  ),
  route(
    "DELETE",
    "/workout/plans/:id(\\d+)",
    authed((c) => handleDeleteWorkoutPlan(c, Number(c.params.id))),
  ),
  route("GET", "/workout/sessions", authed(handleListWorkoutSessions)),
  route("POST", "/workout/sessions", authed(handleStartWorkoutSession)),
  route(
    "GET",
    "/workout/sessions/:id(\\d+)",
    authed((c) => handleGetWorkoutSession(c, Number(c.params.id))),
  ),
  route(
    ["PATCH", "PUT"],
    "/workout/sessions/:id(\\d+)",
    authed((c) => handlePatchWorkoutSession(c, Number(c.params.id))),
  ),
  route(
    "DELETE",
    "/workout/sessions/:id(\\d+)",
    authed((c) => handleDeleteWorkoutSession(c, Number(c.params.id))),
  ),
  route(
    "POST",
    "/workout/sessions/:id(\\d+)/sets",
    authed((c) => handleAppendWorkoutSet(c, Number(c.params.id))),
  ),
  route(
    "DELETE",
    "/workout/sessions/:id(\\d+)/sets/:setId(\\d+)",
    authed((c) => handleDeleteWorkoutSet(c, Number(c.params.id), Number(c.params.setId))),
  ),
  route(
    "GET",
    "/workout/exercises/:id/last-sets",
    authed((c) => handleLastSetsForExercise(c, c.params.id)),
  ),
  route(
    "GET",
    "/workout/progress/exercise/:id",
    authed((c) => handleExerciseProgress(c, c.params.id)),
  ),
  route("GET", "/workout/progress/muscle-groups", authed(handleMuscleGroupVolume)),
  route("GET", "/workout/progress/prs", authed(handleRecentPRs)),
];
