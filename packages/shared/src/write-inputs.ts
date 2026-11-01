/**
 * Normalizers for user-data writes, shared by the HTTP routes (after the Zod
 * request schema in ./schemas.ts has checked the shape) and the agent tools
 * (whose model-supplied input arrives untyped). One set of rules for both
 * paths: defaults, trimming, catalog checks and range checks live here rather
 * than being re-implemented — and drifting — in each caller.
 *
 * Every normalizer throws WriteInputError with a caller-fixable message; the
 * server maps it to a 400, the tool executor returns it to the model.
 */
import type { DietPlanWriteInput, Macros, Portion } from "./types.ts";
import { getExercise, getMachine } from "./workout.ts";
import {
  exerciseFields,
  type Weekday,
  type WorkoutPlanWriteInput,
  type WorkoutSetInput,
} from "./workout-types.ts";

export class WriteInputError extends Error {
  override name = "WriteInputError";
}

const fail = (message: string): never => {
  throw new WriteInputError(message);
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const WEEKDAYS: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const WEEKDAY_SET: ReadonlySet<string> = new Set(WEEKDAYS);

function trimmed(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function finite(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A deduped Weekday[] from the canonical array, a legacy single string, or
// null/undefined (unscheduled → []). Case-insensitive; unknown names throw so
// a typo doesn't silently drop a day off the schedule.
export function normalizeWeekdays(value: unknown, field = "weekdays"): Weekday[] {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = new Set<Weekday>();
  for (const v of arr) {
    if (v == null) continue;
    const w = String(v).trim().toLowerCase();
    if (!w) continue;
    if (!WEEKDAY_SET.has(w)) {
      fail(`${field}: '${w}' is not a valid weekday (lowercase monday..sunday)`);
    }
    out.add(w as Weekday);
  }
  return [...out];
}

// A macro block, or null when absent / without kcal (= "no override").
export function normalizeMacros(raw: unknown): Macros | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.kcal == null) return null;
  return {
    kcal: Number(t.kcal),
    p: Number(t.p ?? 0),
    f: Number(t.f ?? 0),
    c: Number(t.c ?? 0),
    ...(t.fiber != null ? { fiber: Number(t.fiber) } : {}),
  };
}

// ---------- diet plan ----------

// One planned portion: food + grams, plus an optional absolute macro override.
export function normalizePortion(raw: Record<string, unknown>): Portion {
  const food = trimmed(raw.food) ?? fail("each portion needs a food name");
  const grams = finite(raw.grams);
  if (grams == null || grams <= 0) fail(`portion '${food}' needs grams > 0`);
  const portion: Portion = { food, grams: grams! };
  const macros = normalizeMacros(raw.macros);
  if (macros) portion.macros = macros;
  if (raw.source === "db" || raw.source === "estimated" || raw.source === "manual") {
    portion.source = raw.source;
  }
  return portion;
}

export function normalizeDietMeal(
  raw: Record<string, unknown>,
  where = "meal",
): DietPlanWriteInput["days"][number]["meals"][number] {
  const slot = trimmed(raw.slot) ?? fail(`${where}: each meal needs a slot`);
  if (raw.items != null && !Array.isArray(raw.items)) fail(`${where}: items must be an array`);
  return {
    slot,
    time: trimmed(raw.time),
    items: ((raw.items as Array<Record<string, unknown>> | undefined) ?? []).map(normalizePortion),
  };
}

export function normalizeDietPlanWrite(input: Record<string, unknown>): DietPlanWriteInput {
  if (!Array.isArray(input.days)) fail("days[] required");
  const startDate = trimmed(input.start_date);
  if (startDate && !DATE_RE.test(startDate)) fail("start_date must be YYYY-MM-DD");
  return {
    name: trimmed(input.name),
    start_date: startDate,
    default_target: normalizeMacros(input.default_target),
    days: (input.days as Array<Record<string, unknown>>).map((d, di) => {
      const where = `day ${di + 1}`;
      if (d.meals != null && !Array.isArray(d.meals)) fail(`${where}: meals must be an array`);
      return {
        name: trimmed(d.name) ?? `Day ${di + 1}`,
        weekdays: normalizeWeekdays(d.weekdays ?? d.weekday, `${where}.weekdays`),
        target: normalizeMacros(d.target),
        meals: ((d.meals as Array<Record<string, unknown>> | undefined) ?? []).map((m) =>
          normalizeDietMeal(m, where),
        ),
      };
    }),
  };
}

// ---------- workout plan ----------

const DEFAULT_TARGET_SETS = 3;

function catalogIds(raw: Record<string, unknown>, where: string) {
  const exercise_id = trimmed(raw.exercise_id) ?? fail(`${where}.exercise_id required`);
  const exercise =
    getExercise(exercise_id) ??
    fail(`${where}: unknown exercise_id '${exercise_id}' — resolve via search_exercises`);
  const machine_id = trimmed(raw.machine_id);
  if (machine_id && !getMachine(machine_id)) fail(`${where}: unknown machine_id '${machine_id}'`);
  return { exercise_id, exercise, machine_id };
}

export function normalizeWorkoutPlanWrite(input: Record<string, unknown>): WorkoutPlanWriteInput {
  const name = trimmed(input.name) ?? fail("name (non-empty string) required");
  if (!Array.isArray(input.days)) fail("days[] required");
  const days = (input.days as unknown[]).map((dRaw, di) => {
    if (!dRaw || typeof dRaw !== "object") fail(`days[${di}]: must be an object`);
    const d = dRaw as Record<string, unknown>;
    if (d.exercises != null && !Array.isArray(d.exercises)) {
      fail(`days[${di}].exercises must be an array`);
    }
    const exercises = ((d.exercises as unknown[] | undefined) ?? []).map((eRaw, ei) => {
      const where = `days[${di}].exercises[${ei}]`;
      if (!eRaw || typeof eRaw !== "object") fail(`${where}: must be an object`);
      const e = eRaw as Record<string, unknown>;
      const { exercise_id, exercise, machine_id } = catalogIds(e, where);
      const target_sets = e.target_sets == null ? DEFAULT_TARGET_SETS : finite(e.target_sets);
      if (target_sets == null || target_sets <= 0) fail(`${where}.target_sets must be > 0`);
      // Reps for lifts, seconds for timed holds and cardio (exerciseFields);
      // the unused target is stored null. A lift without reps gets the
      // storage default.
      const fields = exerciseFields(exercise);
      const reps = fields.reps ? finite(e.target_reps) : null;
      if (fields.reps && e.target_reps != null && (reps == null || reps <= 0)) {
        fail(`${where}.target_reps must be > 0`);
      }
      const duration = fields.duration ? finite(e.target_duration_sec) : null;
      if (fields.duration && e.target_duration_sec != null && (duration == null || duration <= 0)) {
        fail(`${where}.target_duration_sec must be > 0`);
      }
      return {
        exercise_id,
        machine_id,
        order: finite(e.order) ?? ei,
        target_sets: Math.floor(target_sets!),
        target_reps: reps != null ? Math.floor(reps) : null,
        target_duration_sec: duration != null ? Math.round(duration) : null,
        target_weight_kg: finite(e.target_weight_kg),
        notes: trimmed(e.notes),
      };
    });
    return {
      // Canonical weekdays[], or the legacy single `weekday`.
      weekdays: normalizeWeekdays(d.weekdays ?? d.weekday, `days[${di}].weekdays`),
      name: trimmed(d.name) ?? `Day ${di + 1}`,
      focus: trimmed(d.focus),
      exercises,
    };
  });
  return { name, notes: trimmed(input.notes), days };
}

// ---------- workout sets ----------

// One logged set. A positive duration_sec makes it a cardio set, where reps
// and weight default to 0 and the burn comes from duration × MET instead.
export function normalizeWorkoutSet(raw: Record<string, unknown>, where = "set"): WorkoutSetInput {
  const { exercise_id, machine_id } = catalogIds(raw, where);
  const dur = finite(raw.duration_sec);
  const duration_sec = dur != null && dur > 0 ? Math.round(dur) : null;
  const dist = finite(raw.distance_m);
  const distance_m = dist != null && dist >= 0 ? dist : null;
  const reps = raw.reps != null ? finite(raw.reps) : duration_sec != null ? 0 : null;
  const weight_kg = raw.weight_kg != null ? finite(raw.weight_kg) : 0;
  if (reps == null || reps < 0 || (duration_sec == null && reps <= 0)) {
    fail(`${where}.reps must be > 0 (or pass duration_sec for a cardio set)`);
  }
  if (weight_kg == null || weight_kg < 0) fail(`${where}.weight_kg must be ≥ 0`);
  return {
    exercise_id,
    machine_id,
    reps: Math.floor(reps!),
    weight_kg: weight_kg!,
    rpe: finite(raw.rpe),
    duration_sec,
    distance_m,
    completed_at: trimmed(raw.completed_at),
  };
}
