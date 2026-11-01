/**
 * Training tools: exercises, workout plans & sessions.
 */
import {
  epley1RM,
  estimateTrainingKcal,
  type ExerciseId,
  getExercise,
  getMachine,
  type MachineId,
  MET_TABLE,
  type MuscleGroupId,
  muscleGroupsForExercise,
  normalizeWeekdays,
  normalizeWorkoutPlanWrite,
  normalizeWorkoutSet,
  planScreenTotals,
  progressionReadiness,
  searchExercises,
  setVolume,
  suggestNextWeight,
  type Weekday,
  type WorkoutPlanWriteInput,
  type WorkoutSet,
  type WorkoutSetInput,
} from "@fa/shared";

import { UserStorage } from "../../storage.ts";
import { runBatchEdits, todayIso } from "./shared.ts";

export async function doEstimateTrainingKcal(storage: UserStorage, input: Record<string, unknown>) {
  let weight_kg = input.weight_kg != null ? Number(input.weight_kg) : NaN;
  if (!Number.isFinite(weight_kg) || weight_kg <= 0) {
    const latest = await storage.latestBodyComp();
    if (!latest?.weight_kg) {
      throw new Error(
        "weight_kg not provided and no body composition entry on file — pass weight_kg explicitly or call log_body_comp first",
      );
    }
    weight_kg = latest.weight_kg;
  }
  const rawEntries = input.entries as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rawEntries) || !rawEntries.length) {
    throw new Error("entries[] required (at least one activity)");
  }
  const entries = rawEntries.map((e) => ({
    activity: e.activity != null ? String(e.activity) : undefined,
    met: e.met != null ? Number(e.met) : undefined,
    duration_min: Number(e.duration_min),
    intensity_modifier: e.intensity_modifier != null ? Number(e.intensity_modifier) : undefined,
  }));
  const result = estimateTrainingKcal(weight_kg, entries);
  return {
    ...result,
    table_size: Object.keys(MET_TABLE).length,
  };
}

// ---------- workout handlers ----------

export async function doSearchExercises(storage: UserStorage, input: Record<string, unknown>) {
  const limitRaw = input.limit != null ? Number(input.limit) : 20;
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 20;
  // Filters shared across every query in a batch (muscle_group / equipment /
  // machine_id / limit apply uniformly).
  const filterOpts: {
    muscle_group?: MuscleGroupId;
    equipment?:
      | "barbell"
      | "dumbbell"
      | "kettlebell"
      | "machine"
      | "cable"
      | "bodyweight"
      | "band"
      | "smith_machine"
      | "cardio";
    machine_id?: MachineId;
  } = {};
  if (typeof input.muscle_group === "string" && input.muscle_group.trim()) {
    filterOpts.muscle_group = input.muscle_group.trim();
  }
  if (typeof input.equipment === "string" && input.equipment.trim()) {
    filterOpts.equipment = input.equipment.trim() as typeof filterOpts.equipment;
  }
  if (typeof input.machine_id === "string" && input.machine_id.trim()) {
    filterOpts.machine_id = input.machine_id.trim();
  }

  // Equipment-availability filter. The user's gym machines live on the profile
  // (gym_machine_ids). An exercise is "available" when it needs no machine
  // (free-weight / cable / bodyweight) OR its machine is on the list. When the
  // user hasn't curated a list, everything is available — available_only is a
  // no-op. Loaded ONCE and reused across a batch of queries.
  const availableOnly = input.available_only === true;
  const profile = await storage.loadProfile();
  const gymSet = new Set(profile?.gym_machine_ids ?? []);
  const hasGym = gymSet.size > 0;
  const isAvailable = (machineId?: MachineId | null) =>
    !machineId || !hasGym || gymSet.has(machineId);

  // Run one search (optionally with a text query) against the shared filters.
  const runOne = (query?: string) => {
    // Fetch the full match set (cap high) so the availability filter applies
    // before paging — a low catalog limit must not slice off available hits.
    const all = searchExercises({ ...filterOpts, ...(query ? { query } : {}), limit: 1000 });
    const filtered = availableOnly && hasGym ? all.filter((e) => isAvailable(e.machine_id)) : all;
    const matches = filtered.slice(0, limit);
    return {
      count: matches.length,
      truncated: filtered.length > limit,
      exercises: matches.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        equipment: e.equipment,
        machine_id: e.machine_id ?? null,
        machine_name: e.machine_id ? (getMachine(e.machine_id)?.name ?? null) : null,
        primary_muscles: e.primary_muscles,
        secondary_muscles: e.secondary_muscles,
        muscle_groups: muscleGroupsForExercise(e, { includeSecondary: false }),
        notes: e.notes ?? null,
      })),
    };
  };

  // The user's saved gym machines, surfaced as context so the agent knows what
  // equipment is on file (to plan around, mention, or offer to curate) without
  // a separate profile read. Empty array = none saved (no availability filter).
  const gymMachines = [...gymSet].map((id) => ({
    id,
    name: getMachine(id)?.name ?? id,
  }));

  // Batch path: resolve MANY exercise searches in one call (workout building)
  // so the agent doesn't spend one tool-loop iteration per exercise and hit
  // MAX_ITERATIONS on a multi-exercise plan. The catalog + profile are shared.
  if (Array.isArray(input.queries)) {
    const queries = input.queries.map((q) => String(q ?? "").trim()).filter(Boolean);
    return {
      batch: true,
      gym_machines: gymMachines,
      results: queries.map((query) => ({ query, ...runOne(query) })),
    };
  }

  const query =
    typeof input.query === "string" && input.query.trim() ? input.query.trim() : undefined;
  return { ...runOne(query), gym_machines: gymMachines };
}

// Attached to every plan read that carries `muscle_totals`, so the model quotes
// the app's own tally instead of adding sets up itself (it once miscounted,
// then told the user their correct screen was wrong).
const MUSCLE_TOTALS_NOTE =
  "muscle_totals are EXACTLY the weekly 'Muscle totals' on the user's plan screen (groups and targets views): each set counts in full for every primary muscle of its exercise; cardio (walking, treadmill) is not counted. Quote these — NEVER add up sets or reps yourself. If the user's numbers match these, they are right.";

export async function doGetWorkoutPlans(storage: UserStorage, input: Record<string, unknown>) {
  const planIdRaw = input.plan_id;
  if (planIdRaw != null && planIdRaw !== "") {
    const id = Number(planIdRaw);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("plan_id must be a positive integer");
    }
    const plan = await storage.loadWorkoutPlan(id);
    if (!plan) return { plan: null, error: `plan ${id} not found` };
    return {
      plan,
      muscle_totals: planScreenTotals(plan.days),
      muscle_totals_note: MUSCLE_TOTALS_NOTE,
    };
  }
  const [plans, profile] = await Promise.all([storage.listWorkoutPlans(), storage.loadProfile()]);
  const activeId = profile?.active_workout_plan_id ?? null;
  return {
    active_plan_id: activeId,
    // Totals for every plan would bloat the listing; the active plan is the
    // one the user is looking at. Read another by plan_id to get its totals.
    plans: plans.map((p) =>
      p.id === activeId
        ? { ...p, active: true, muscle_totals: planScreenTotals(p.days) }
        : { ...p, active: false },
    ),
    ...(activeId != null ? { muscle_totals_note: MUSCLE_TOTALS_NOTE } : {}),
    total: plans.length,
  };
}

export async function doActivateWorkoutPlan(storage: UserStorage, input: Record<string, unknown>) {
  const planId = Number(input.plan_id);
  if (!Number.isFinite(planId)) {
    throw new Error("plan_id required — get it from get_workout_plans");
  }
  const ok = await storage.setActiveWorkoutPlan(planId);
  if (!ok) {
    return { error: `workout plan ${planId} not found — call get_workout_plans for current ids` };
  }
  return { activated: planId };
}

// Normalize the agent's plan input into the storage layer's
// WorkoutPlanWriteInput. Rejects unknown exercise_ids up front so we surface
// a useful error to the model instead of a generic DB failure later.
function parseWorkoutPlanInput(input: Record<string, unknown>): WorkoutPlanWriteInput {
  if (!Array.isArray(input.days) || input.days.length === 0) {
    throw new Error("days[] required (at least one day)");
  }
  return normalizeWorkoutPlanWrite(input);
}

export async function doSaveWorkoutPlan(storage: UserStorage, input: Record<string, unknown>) {
  const parsed = parseWorkoutPlanInput(input);
  const planIdRaw = input.plan_id;
  if (planIdRaw != null && planIdRaw !== "") {
    const id = Number(planIdRaw);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("plan_id must be a positive integer");
    }
    const updated = await storage.updateWorkoutPlan(id, parsed);
    if (!updated) {
      return { saved: false, error: `plan ${id} not found` };
    }
    return { saved: true, mode: "updated" as const, plan: updated };
  }
  const created = await storage.createWorkoutPlan(parsed);
  return { saved: true, mode: "created" as const, plan: created };
}

export async function doDeleteWorkoutPlan(storage: UserStorage, input: Record<string, unknown>) {
  const id = Number(input.plan_id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("plan_id must be a positive integer");
  }
  const removed = await storage.deleteWorkoutPlan(id);
  return { removed, plan_id: id };
}

// ---- granular workout plan mutations ----

function requirePlanDayId(input: Record<string, unknown>): number {
  const v = Number(input.plan_day_id);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error("plan_day_id must be a positive integer");
  }
  return v;
}

function requireExerciseRowId(input: Record<string, unknown>): number {
  const v = Number(input.exercise_row_id);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error("exercise_row_id must be a positive integer");
  }
  return v;
}

// Coerce a model-supplied weekdays value into a deduped, validated Weekday[].
// Throws on unknown weekday names so the model gets a clear error instead of
// silently dropping the bad entry.
function parseWeekdaysOrThrow(value: unknown, field: string): Weekday[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of weekday names`);
  }
  return normalizeWeekdays(value, field);
}

export async function doUpdateWorkoutPlanDay(storage: UserStorage, input: Record<string, unknown>) {
  const planDayId = requirePlanDayId(input);
  const patch: { name?: string; focus?: string | null; weekdays?: Weekday[] } = {};
  if (typeof input.name === "string") {
    if (!input.name.trim()) throw new Error("name cannot be empty");
    patch.name = input.name.trim();
  }
  if (input.focus !== undefined) {
    patch.focus = typeof input.focus === "string" ? input.focus.trim() : "";
  }
  if (input.weekdays !== undefined) {
    patch.weekdays = parseWeekdaysOrThrow(input.weekdays, "weekdays");
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("nothing to update — pass at least one of name/focus/weekdays");
  }
  const plan = await storage.updateWorkoutPlanDay(planDayId, patch);
  if (!plan) {
    return { updated: false, error: `plan_day ${planDayId} not found` };
  }
  return { updated: true, plan };
}

export async function doAddExerciseToPlanDay(
  storage: UserStorage,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Array.isArray(input.edits)) {
    return runBatchEdits(input.edits, (one) => doAddExerciseToPlanDay(storage, one));
  }
  const planDayId = requirePlanDayId(input);
  const exercise_id = typeof input.exercise_id === "string" ? input.exercise_id.trim() : "";
  if (!exercise_id) throw new Error("exercise_id required");
  if (!getExercise(exercise_id)) {
    throw new Error(`unknown exercise_id '${exercise_id}' — resolve via search_exercises`);
  }
  const machine_id =
    typeof input.machine_id === "string" && input.machine_id.trim()
      ? input.machine_id.trim()
      : null;
  if (machine_id && !getMachine(machine_id)) {
    throw new Error(`unknown machine_id '${machine_id}'`);
  }
  const target_sets =
    input.target_sets != null && Number.isFinite(Number(input.target_sets))
      ? Math.floor(Number(input.target_sets))
      : 3;
  const target_reps =
    input.target_reps != null && Number.isFinite(Number(input.target_reps))
      ? Math.floor(Number(input.target_reps))
      : 8;
  if (target_sets <= 0) throw new Error("target_sets must be > 0");
  if (target_reps <= 0) throw new Error("target_reps must be > 0");
  const target_duration_sec =
    input.target_duration_sec != null && Number.isFinite(Number(input.target_duration_sec))
      ? Math.round(Number(input.target_duration_sec))
      : null;
  if (target_duration_sec != null && target_duration_sec <= 0) {
    throw new Error("target_duration_sec must be > 0");
  }
  const target_weight_kg =
    input.target_weight_kg != null && Number.isFinite(Number(input.target_weight_kg))
      ? Number(input.target_weight_kg)
      : null;
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null;
  const order =
    input.order != null && Number.isFinite(Number(input.order))
      ? Math.floor(Number(input.order))
      : undefined;
  const plan = await storage.addExerciseToPlanDay(planDayId, {
    exercise_id,
    machine_id,
    target_sets,
    // Storage keeps only the target this exercise uses (planTargetColumns).
    target_reps,
    target_duration_sec,
    target_weight_kg,
    notes,
    order,
  });
  if (!plan) {
    return { added: false, error: `plan_day ${planDayId} not found` };
  }
  return { added: true, plan };
}

export async function doRemoveExerciseFromPlanDay(
  storage: UserStorage,
  input: Record<string, unknown>,
) {
  const planDayId = requirePlanDayId(input);
  const exerciseRowId = requireExerciseRowId(input);
  const plan = await storage.removeExerciseFromPlanDay(planDayId, exerciseRowId);
  if (!plan) {
    return {
      removed: false,
      error: `exercise ${exerciseRowId} not found on plan_day ${planDayId}`,
    };
  }
  return { removed: true, plan };
}

export async function doUpdatePlanExercise(
  storage: UserStorage,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Array.isArray(input.edits)) {
    return runBatchEdits(input.edits, (one) => doUpdatePlanExercise(storage, one));
  }
  const planDayId = requirePlanDayId(input);
  const exerciseRowId = requireExerciseRowId(input);
  const patch: {
    exercise_id?: ExerciseId;
    machine_id?: MachineId | null;
    target_sets?: number;
    target_reps?: number;
    target_duration_sec?: number | null;
    target_weight_kg?: number | null;
    notes?: string | null;
    order?: number;
  } = {};
  if (typeof input.exercise_id === "string" && input.exercise_id.trim()) {
    const ex = input.exercise_id.trim();
    if (!getExercise(ex)) {
      throw new Error(`unknown exercise_id '${ex}' — resolve via search_exercises`);
    }
    patch.exercise_id = ex;
  }
  if (input.machine_id !== undefined) {
    if (typeof input.machine_id === "string" && input.machine_id.trim()) {
      const m = input.machine_id.trim();
      if (!getMachine(m)) throw new Error(`unknown machine_id '${m}'`);
      patch.machine_id = m;
    } else {
      patch.machine_id = null;
    }
  }
  if (input.target_sets !== undefined) {
    const n = Number(input.target_sets);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("target_sets must be > 0");
    }
    patch.target_sets = Math.floor(n);
  }
  if (input.target_reps !== undefined) {
    const n = Number(input.target_reps);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("target_reps must be > 0");
    }
    patch.target_reps = Math.floor(n);
  }
  if (input.target_duration_sec !== undefined) {
    const n = input.target_duration_sec === null ? null : Number(input.target_duration_sec);
    if (n !== null && (!Number.isFinite(n) || n <= 0)) {
      throw new Error("target_duration_sec must be > 0");
    }
    patch.target_duration_sec = n === null ? null : Math.round(n);
  }
  if (input.target_weight_kg !== undefined) {
    patch.target_weight_kg =
      input.target_weight_kg === null
        ? null
        : Number.isFinite(Number(input.target_weight_kg))
          ? Number(input.target_weight_kg)
          : null;
  }
  if (input.notes !== undefined) {
    patch.notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null;
  }
  if (input.order !== undefined) {
    const n = Number(input.order);
    if (Number.isFinite(n)) patch.order = Math.floor(n);
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("nothing to update — pass at least one field to change");
  }
  const plan = await storage.updatePlanExercise(planDayId, exerciseRowId, patch);
  if (!plan) {
    return {
      updated: false,
      error: `exercise ${exerciseRowId} not found on plan_day ${planDayId}`,
    };
  }
  return { updated: true, plan };
}

export async function doReplacePlanExercise(storage: UserStorage, input: Record<string, unknown>) {
  const planDayId = requirePlanDayId(input);
  const exerciseRowId = requireExerciseRowId(input);
  const newId = typeof input.new_exercise_id === "string" ? input.new_exercise_id.trim() : "";
  if (!newId) throw new Error("new_exercise_id required");
  const newEx = getExercise(newId);
  if (!newEx) {
    throw new Error(`unknown new_exercise_id '${newId}' — resolve via search_exercises`);
  }
  // Carry the replacement's default machine_id forward so 'replace bench
  // with lat pulldown' attaches the right machine without a follow-up call.
  // The user can override later via update_plan_exercise.
  const plan = await storage.updatePlanExercise(planDayId, exerciseRowId, {
    exercise_id: newId,
    machine_id: newEx.machine_id ?? null,
  });
  if (!plan) {
    return {
      replaced: false,
      error: `exercise ${exerciseRowId} not found on plan_day ${planDayId}`,
    };
  }
  return { replaced: true, plan };
}

export async function doLogWorkoutSession(storage: UserStorage, input: Record<string, unknown>) {
  const date = (() => {
    const raw = typeof input.date === "string" ? input.date.trim() : "";
    if (!raw) return todayIso();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error("date must be YYYY-MM-DD");
    }
    return raw;
  })();

  const rawExercises = input.exercises;
  if (!Array.isArray(rawExercises) || rawExercises.length === 0) {
    throw new Error("exercises[] required (at least one)");
  }

  // Validate everything BEFORE creating the session so we don't leave an
  // empty session row behind on a bad input.
  type PreparedSet = WorkoutSetInput;
  type PreparedExercise = { exercise_id: ExerciseId; sets: PreparedSet[] };
  const prepared: PreparedExercise[] = rawExercises.map((eRaw, ei) => {
    if (!eRaw || typeof eRaw !== "object") {
      throw new Error(`exercises[${ei}]: must be an object`);
    }
    const e = eRaw as Record<string, unknown>;
    const rawSets = e.sets;
    if (!Array.isArray(rawSets) || rawSets.length === 0) {
      throw new Error(`exercises[${ei}].sets[] required (at least one)`);
    }
    const sets: PreparedSet[] = rawSets.map((sRaw, si) => {
      if (!sRaw || typeof sRaw !== "object") {
        throw new Error(`exercises[${ei}].sets[${si}]: must be an object`);
      }
      return normalizeWorkoutSet(
        {
          ...(sRaw as Record<string, unknown>),
          exercise_id: e.exercise_id,
          machine_id: e.machine_id,
        },
        `exercises[${ei}].sets[${si}]`,
      );
    });
    return { exercise_id: sets[0].exercise_id, sets };
  });

  const planDayId =
    input.plan_day_id != null && Number.isFinite(Number(input.plan_day_id))
      ? Number(input.plan_day_id)
      : null;

  const session = await storage.startWorkoutSession({
    date,
    plan_day_id: planDayId,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : null,
    notes: typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null,
    started_at:
      typeof input.started_at === "string" && input.started_at.trim()
        ? input.started_at.trim()
        : null,
    // Retroactive logs (date != today) skip the wall-clock timer — the
    // session ships fully populated, so started_at is meaningless.
    backdated: date !== todayIso(),
  });

  const appendedSets: WorkoutSet[] = [];
  for (const ex of prepared) {
    for (const s of ex.sets) {
      const row = await storage.appendWorkoutSet(session.id, s);
      if (row) appendedSets.push(row);
    }
  }

  // Patch duration_min / kcal_burned if the caller passed them. Done after
  // the sets so partial-failure on a set still records what we have.
  const hasDuration = input.duration_min != null && Number.isFinite(Number(input.duration_min));
  const hasKcal = input.kcal_burned != null && Number.isFinite(Number(input.kcal_burned));
  let finalized = session;
  if (hasDuration || hasKcal) {
    const patched = await storage.patchWorkoutSession(session.id, {
      duration_min: hasDuration ? Number(input.duration_min) : undefined,
      kcal_burned: hasKcal ? Number(input.kcal_burned) : undefined,
    });
    if (patched) finalized = patched;
  }

  const totalVolumeKg = appendedSets.reduce(
    (acc, s) => acc + setVolume({ reps: s.reps, weight_kg: s.weight_kg }),
    0,
  );

  // Progressive-overload nudges: now that this session is logged, check each
  // exercise for the "hit target reps 2 sessions in a row" signal. The just-
  // logged sets are already in lastSetsForExercise, so the streak includes
  // today. Target reps come from the linked plan day when present, else the
  // catalog default. Best-effort — a detection failure never fails the log.
  const nudges = await detectProgressionNudges(storage, planDayId, prepared);

  return {
    logged: true,
    session: { ...finalized, sets: appendedSets },
    summary: {
      exercise_count: prepared.length,
      set_count: appendedSets.length,
      total_volume_kg: Math.round(totalVolumeKg * 10) / 10,
    },
    ...(nudges.length ? { progression_nudges: nudges } : {}),
  };
}

// Default rep target when an exercise isn't part of a prescribed plan day —
// mirrors workout_plan_exercise.target_reps' DB default.
const DEFAULT_TARGET_REPS = 8;

// For each distinct exercise just logged, decide whether the user is ready to
// add weight (target reps cleared on `sessions` consecutive sessions). Returns
// one entry per READY exercise; non-ready exercises are silently dropped so the
// agent only ever sees actionable nudges.
async function detectProgressionNudges(
  storage: UserStorage,
  planDayId: number | null,
  prepared: Array<{ exercise_id: ExerciseId }>,
): Promise<
  Array<{
    exercise_id: ExerciseId;
    exercise_name: string | null;
    top_weight_kg: number;
    suggested_weight_kg: number;
    target_reps: number;
    increment_kg: number;
    sessions_hit: number;
    reason: string;
  }>
> {
  try {
    const targetByExercise = planDayId
      ? await storage.targetRepsForPlanDay(planDayId)
      : new Map<string, number>();
    const seen = new Set<string>();
    const out = [] as Awaited<ReturnType<typeof detectProgressionNudges>>;
    for (const ex of prepared) {
      if (seen.has(ex.exercise_id)) continue;
      seen.add(ex.exercise_id);
      // Pull enough history to span at least the last two sessions of this
      // exercise (cap covers ~3 sessions of typical 3-5 set work).
      const history = await storage.lastSetsForExercise(ex.exercise_id, 20);
      const targetReps = targetByExercise.get(ex.exercise_id) ?? DEFAULT_TARGET_REPS;
      const readiness = progressionReadiness(history, targetReps, { sessions: 2 });
      if (readiness?.ready) {
        out.push({
          exercise_id: ex.exercise_id,
          exercise_name: getExercise(ex.exercise_id)?.name ?? null,
          top_weight_kg: readiness.top_weight_kg,
          suggested_weight_kg: readiness.suggested_weight_kg,
          target_reps: readiness.target_reps,
          increment_kg: readiness.increment_kg,
          sessions_hit: readiness.sessions_hit,
          reason: readiness.reason,
        });
      }
    }
    return out;
  } catch {
    // Best-effort: a nudge is a bonus, never a reason to fail the workout log.
    return [];
  }
}

export async function doListWorkoutSessions(storage: UserStorage, input: Record<string, unknown>) {
  const today = todayIso();
  // 14-day default window — matches the dashboard's progress card so the
  // agent and UI tell consistent stories about "recent" training.
  const from = (() => {
    const raw = typeof input.from === "string" ? input.from.trim() : "";
    if (!raw) {
      const d = new Date();
      d.setDate(d.getDate() - 14);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error("from must be YYYY-MM-DD");
    }
    return raw;
  })();
  const to = (() => {
    const raw = typeof input.to === "string" ? input.to.trim() : "";
    if (!raw) return today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new Error("to must be YYYY-MM-DD");
    }
    return raw;
  })();
  const sessions = await storage.listWorkoutSessions(from, to);
  return { from, to, total: sessions.length, sessions };
}

export async function doDeleteWorkoutSession(storage: UserStorage, input: Record<string, unknown>) {
  const id = Number(input.session_id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("session_id must be a positive integer");
  }
  const removed = await storage.deleteWorkoutSession(id);
  return { removed, session_id: id };
}

export async function doLastSetsForExercise(storage: UserStorage, input: Record<string, unknown>) {
  const exercise_id = typeof input.exercise_id === "string" ? input.exercise_id.trim() : "";
  if (!exercise_id) throw new Error("exercise_id required");
  if (!getExercise(exercise_id)) {
    throw new Error(`unknown exercise_id '${exercise_id}' — resolve via search_exercises`);
  }
  const limitRaw = input.limit != null ? Number(input.limit) : 10;
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 10;
  const sets = await storage.lastSetsForExercise(exercise_id, limit);
  // Augment each set with its Epley 1RM estimate so the agent can talk about
  // strength progression without re-deriving the formula.
  const enriched = sets.map((s) => ({
    ...s,
    est_1rm_kg: epley1RM(s.reps, s.weight_kg),
  }));
  // Suggest next-session weight if a target_reps was passed. The naive rule
  // (suggestNextWeight in shared) wants the previous session's sets only —
  // group by session_id and take the newest.
  let suggestion: { weight_kg: number; reason: string } | null = null;
  const target_reps =
    input.target_reps != null && Number.isFinite(Number(input.target_reps))
      ? Math.floor(Number(input.target_reps))
      : null;
  if (target_reps && sets.length) {
    const lastSessionId = sets[0].session_id;
    const lastSessionSets = sets
      .filter((s) => s.session_id === lastSessionId)
      .map((s) => ({
        id: s.set_id,
        session_id: s.session_id,
        exercise_id,
        machine_id: null,
        set_index: 0,
        reps: s.reps,
        weight_kg: s.weight_kg,
        rpe: s.rpe,
        completed_at: s.completed_at,
      })) as WorkoutSet[];
    suggestion = suggestNextWeight(lastSessionSets, target_reps);
  }
  // Progressive-overload readiness across the last 2 sessions (the proactive
  // "time to add weight" signal). Only meaningful with a rep target.
  const progression = target_reps ? progressionReadiness(sets, target_reps, { sessions: 2 }) : null;
  return {
    exercise_id,
    exercise_name: getExercise(exercise_id)?.name ?? null,
    count: enriched.length,
    sets: enriched,
    ...(suggestion ? { suggested_next: suggestion } : {}),
    ...(progression ? { progression } : {}),
  };
}
