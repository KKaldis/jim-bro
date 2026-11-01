/**
 * Workout catalog helpers + derived computations.
 *
 * The catalog (muscle groups, muscles, exercises, machines) is static — it
 * lives in /data and is re-exported here for convenience. Derived helpers
 * (group of an exercise, Epley 1RM, per-set volume) live here too so the
 * server and the agent can share a single implementation.
 */
import { MACHINES, MACHINE_BY_ID, MACHINE_ICONS, machineIconUrl } from "./data/machines.ts";
import { EXERCISES, EXERCISE_BY_ID } from "./data/exercises.ts";
import { EXERCISE_ICONS, exerciseIconUrl } from "./data/exercise-icons.ts";
import {
  MUSCLES,
  MUSCLE_GROUPS,
  MUSCLE_GROUP_LABEL,
  MUSCLE_LABEL,
  MUSCLE_TARGETS,
  MUSCLE_TARGET_LABEL,
  MUSCLE_TO_GROUP,
  MUSCLE_TO_TARGET,
  type MuscleTarget,
} from "./data/muscle-groups.ts";
import type {
  Exercise,
  ExerciseId,
  Machine,
  MachineId,
  MuscleGroupId,
  WorkoutCatalog,
  WorkoutSet,
} from "./workout-types.ts";

export {
  MUSCLES,
  MUSCLE_GROUPS,
  MUSCLE_GROUP_LABEL,
  MUSCLE_LABEL,
  MUSCLE_TARGETS,
  MUSCLE_TARGET_LABEL,
  MUSCLE_TO_GROUP,
  MUSCLE_TO_TARGET,
  type MuscleTarget,
  EXERCISES,
  EXERCISE_BY_ID,
  MACHINES,
  MACHINE_BY_ID,
  MACHINE_ICONS,
  machineIconUrl,
  EXERCISE_ICONS,
  exerciseIconUrl,
};

export const WORKOUT_CATALOG: WorkoutCatalog = {
  muscle_groups: MUSCLE_GROUPS,
  muscles: MUSCLES,
  exercises: EXERCISES,
  machines: MACHINES,
};

// Lookup helpers — safe (return null) so callers don't have to existence-check.

export function getExercise(id: ExerciseId): Exercise | null {
  return EXERCISE_BY_ID[id] ?? null;
}

export function getMachine(id: MachineId): Machine | null {
  return MACHINE_BY_ID[id] ?? null;
}

// The muscle groups an exercise targets. Primary muscles only by default —
// pass includeSecondary=true to also fold in the assistive groups.
export function muscleGroupsForExercise(
  exercise: Exercise | ExerciseId,
  opts: { includeSecondary?: boolean } = {},
): MuscleGroupId[] {
  const ex = typeof exercise === "string" ? getExercise(exercise) : exercise;
  if (!ex) return [];
  const ids = opts.includeSecondary
    ? [...ex.primary_muscles, ...ex.secondary_muscles]
    : ex.primary_muscles;
  const groups = new Set<MuscleGroupId>();
  for (const m of ids) {
    const g = MUSCLE_TO_GROUP[m];
    if (g) groups.add(g);
  }
  return Array.from(groups);
}

// The finer targets (MUSCLE_TARGETS) an exercise trains — primary muscles only,
// most important first.
export function targetsForExercise(exercise: Exercise | ExerciseId): string[] {
  const ex = typeof exercise === "string" ? getExercise(exercise) : exercise;
  if (!ex) return [];
  const targets = new Set<string>();
  for (const m of ex.primary_muscles) {
    const t = MUSCLE_TO_TARGET[m];
    if (t) targets.add(t);
  }
  return Array.from(targets);
}

// Filter exercises by group / target / equipment / machine / free-text query.
// The query matches name and id case-insensitively. All filters are AND.
export function searchExercises(opts: {
  muscle_group?: MuscleGroupId;
  target?: string;
  equipment?: Exercise["equipment"];
  machine_id?: MachineId;
  query?: string;
  limit?: number;
}): Exercise[] {
  const q = opts.query?.trim().toLowerCase() ?? "";
  let out = EXERCISES;
  if (opts.muscle_group) {
    const target = opts.muscle_group;
    out = out.filter((e) =>
      muscleGroupsForExercise(e, { includeSecondary: false }).includes(target),
    );
  }
  if (opts.target) {
    const target = opts.target;
    out = out.filter((e) => targetsForExercise(e).includes(target));
  }
  if (opts.equipment) {
    out = out.filter((e) => e.equipment === opts.equipment);
  }
  if (opts.machine_id) {
    out = out.filter((e) => e.machine_id === opts.machine_id);
  }
  if (q) {
    out = out.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export type ExerciseRefResolution =
  { ok: true; exercise: Exercise } | { ok: false; candidates: Exercise[] };

// Spelling variants the catalog writes one way ("Cable Fly").
const SPELLING: Record<string, string> = { flye: "fly", flie: "fly", fly: "fly" };

// Lowercased words with a plural "s" dropped, so "pull-ups" = "pullup" and
// "face pulls" = "face pull". Applied to both sides of every comparison, so
// "raises" → "raise" matches and "press" (ends in "ss") is left alone.
const nameTokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((t) => (t.length > 2 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))
    .map((t) => SPELLING[t] ?? t);

// Qualifiers people add to a lift's name that the catalog leaves implicit
// ("conventional deadlift", "barbell bent over row", "standing overhead
// press"). Dropped after the exact-name check, so a catalog name that really
// contains one ("Standing Leg Curl") still matches exactly first.
const FILLER_WORDS = new Set(
  nameTokens(
    "conventional standard regular classic traditional standing bent over flat straight bar",
  ),
);

// Common shorthand for the default variant of a lift, by normalized name.
const EXERCISE_ALIASES: Record<string, ExerciseId> = {
  squat: "back_squat",
  "barbell squat": "back_squat",
  "barbell back squat": "back_squat",
  ohp: "overhead_press_barbell",
  "military press": "overhead_press_barbell",
  rdl: "romanian_deadlift",
  // The 45° sled and parallel-bar dips are what a bare name usually means;
  // a gym-machine filter that rules them out falls through to normal matching.
  "leg press": "sled_leg_press",
  dip: "dip_chest",
  "parallel bar dip": "dip_chest",
};

// Equipment words, most-default first: an unqualified "bench press" or
// "overhead press" conventionally means the barbell version, "lateral raise"
// the dumbbell one. Used only to break ties between variants that differ by
// equipment alone — the user still confirms the pick in the form.
const EQUIPMENT_PREFERENCE: Exercise["equipment"][] = [
  "barbell",
  "dumbbell",
  "cable",
  "machine",
  "smith_machine",
  "kettlebell",
  "bodyweight",
  "band",
];
const EQUIPMENT_WORDS = new Set(EQUIPMENT_PREFERENCE.flatMap((e) => nameTokens(e)));

// Resolve what the agent wrote where an exercise id goes — a real catalog id,
// or a plain name ("barbell bench press", "Lat Pulldown") — to one catalog
// exercise. Exact id / exact name win. Otherwise every query word must appear
// in the exercise's name, id or equipment, and the best match is the one whose
// name adds the fewest words the query didn't say — variant words first
// ("decline", "seated"), then equipment words. A tie on variant words is
// ambiguous ("leg press" → sled / horizontal / vertical) and returns the tied
// candidates; a tie only on equipment goes to EQUIPMENT_PREFERENCE.
// `available` narrows name matching to exercises the user can do (their gym's
// machines); an explicit catalog id is always honoured as written.
export function resolveExerciseRef(
  ref: string,
  opts: { available?: (e: Exercise) => boolean } = {},
): ExerciseRefResolution {
  const raw = ref.trim();
  const byId = getExercise(raw);
  if (byId) return { ok: true, exercise: byId };
  const pool = opts.available ? EXERCISES.filter(opts.available) : EXERCISES;
  // A name that slugifies to an id ("Lat Pulldown") is still a name: it must
  // pass the availability filter like any other.
  const bySlug = getExercise(raw.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  if (bySlug && (!opts.available || opts.available(bySlug))) return { ok: true, exercise: bySlug };
  const q = nameTokens(raw);
  if (!q.length) return { ok: false, candidates: [] };
  // Exact name, also ignoring spacing ("skull crusher" = "Skullcrusher").
  const compact = q.join("");
  const exact = pool.find(
    (e) => nameTokens(e.name).join("") === compact || nameTokens(e.id).join("") === compact,
  );
  if (exact) return { ok: true, exercise: exact };
  const aliased = EXERCISE_ALIASES[q.join(" ")];
  const alias = aliased ? getExercise(aliased) : null;
  if (alias && (!opts.available || opts.available(alias))) return { ok: true, exercise: alias };
  const core = q.filter((t) => !FILLER_WORDS.has(t));
  if (core.length && core.length < q.length) {
    const r = resolveExerciseRef(core.join(" "), opts);
    if (r.ok || r.candidates.length) return r;
  }
  const qs = new Set(q);
  // Once the query names equipment, a different equipment word in a catalog
  // name is a real difference ("barbell squat" is not the Smith machine one).
  const queryHasEquipment = q.some((t) => EQUIPMENT_WORDS.has(t));
  const scored = pool
    .map((e) => {
      const toks = new Set([
        ...nameTokens(e.name),
        ...nameTokens(e.id),
        ...nameTokens(e.equipment),
      ]);
      const extra = [...new Set(nameTokens(e.name))].filter((t) => !qs.has(t));
      return {
        e,
        covers: q.every((t) => toks.has(t)),
        variant: extra.filter((t) => queryHasEquipment || !EQUIPMENT_WORDS.has(t)).length,
        extra: extra.length,
      };
    })
    .filter((s) => s.covers)
    .sort((a, b) => a.variant - b.variant || a.extra - b.extra);
  if (!scored.length) {
    // No full-coverage match: fall back to loose substring hits as suggestions.
    const loose = searchExercises({ query: q[q.length - 1] });
    return {
      ok: false,
      candidates: (opts.available ? loose.filter(opts.available) : loose).slice(0, 5),
    };
  }
  const best = scored.filter((s) => s.variant === scored[0].variant && s.extra === scored[0].extra);
  if (best.length === 1) return { ok: true, exercise: best[0].e };
  if (best[0].variant === 0) {
    const rank = (e: Exercise) => {
      const i = EQUIPMENT_PREFERENCE.indexOf(e.equipment);
      return i < 0 ? EQUIPMENT_PREFERENCE.length : i;
    };
    const byPref = [...best].sort((a, b) => rank(a.e) - rank(b.e));
    if (rank(byPref[0].e) < rank(byPref[1].e)) return { ok: true, exercise: byPref[0].e };
  }
  return { ok: false, candidates: best.map((s) => s.e).slice(0, 5) };
}

// =====================================================================
// Set math — used by progress endpoints + agent suggest_next_weight
// =====================================================================

// Volume = reps × weight. Treat null/missing weight as 0 (bodyweight or
// untracked) — callers can pass an override weight via opts.bodyweight_kg.
export function setVolume(
  set: Pick<WorkoutSet, "reps" | "weight_kg">,
  opts: { bodyweight_kg?: number } = {},
): number {
  const w = set.weight_kg ?? opts.bodyweight_kg ?? 0;
  return set.reps * w;
}

// Epley estimated 1-rep max. The standard back-of-the-envelope used by every
// strength tracker — ±5% accuracy in the 1–10 rep range, diverges above 12.
//   1RM ≈ weight × (1 + reps / 30)
export function epley1RM(reps: number, weight_kg: number): number {
  if (reps <= 0 || weight_kg <= 0) return 0;
  return Math.round(weight_kg * (1 + reps / 30) * 10) / 10;
}

// Naive linear progression suggestion: if the user hit all target reps at
// RPE ≤ 7 on every set last session, bump 2.5 kg. Otherwise hold the
// previous top working weight. Cardio + bodyweight return null.
//
// Intentionally simple — better than nothing for a starting hint. The agent
// can override with smarter logic later if we add per-exercise history.
export function suggestNextWeight(
  history: WorkoutSet[],
  targetReps: number,
): { weight_kg: number; reason: string } | null {
  if (!history.length) return null;
  const last = history.filter((s) => s.weight_kg > 0);
  if (!last.length) return null;
  const topWeight = Math.max(...last.map((s) => s.weight_kg));
  const sameWeightSets = last.filter((s) => s.weight_kg === topWeight);
  const allHitTarget = sameWeightSets.every((s) => s.reps >= targetReps);
  const easyRpe = sameWeightSets.every((s) => (s.rpe ?? 0) > 0 && s.rpe! <= 7);
  if (allHitTarget && easyRpe) {
    return {
      weight_kg: Math.round((topWeight + 2.5) * 10) / 10,
      reason: `hit ${targetReps}+ reps at RPE ≤ 7 last session — +2.5 kg`,
    };
  }
  if (allHitTarget) {
    return {
      weight_kg: topWeight,
      reason: `hit ${targetReps}+ reps but RPE was high — hold weight`,
    };
  }
  return {
    weight_kg: topWeight,
    reason: `missed target reps last session — hold weight`,
  };
}

// Progressive-overload nudge detector. Unlike suggestNextWeight (which only
// looks at the single most recent session), this counts how many *consecutive*
// recent sessions cleared the rep target at the same top working weight, and
// fires `ready` once that streak reaches `sessions` (default 2 — "twice in a
// row"). That conservatism is the whole point: one good day isn't a mandate to
// add weight; two is the classic double-progression signal.
//
// RPE is treated softly: a logged RPE must be ≤ maxRpe to count, but a missing
// RPE does NOT block the nudge (most users don't log it). This differs on
// purpose from suggestNextWeight, which requires an explicit easy RPE.
export type ProgressionReadiness = {
  ready: boolean;
  top_weight_kg: number;
  suggested_weight_kg: number; // top_weight + increment
  target_reps: number;
  increment_kg: number;
  sessions_hit: number; // consecutive qualifying sessions (≥ sessions ⇒ ready)
  sessions_required: number;
  reason: string;
};

type ProgressionSet = Pick<WorkoutSet, "session_id" | "reps" | "weight_kg" | "rpe">;

export function progressionReadiness(
  // Newest-first sets for ONE exercise (as lastSetsForExercise returns). Must
  // carry session_id so we can group sets into sessions and walk them in order.
  history: ProgressionSet[],
  targetReps: number,
  opts: { sessions?: number; increment?: number; maxRpe?: number } = {},
): ProgressionReadiness | null {
  const required = Math.max(1, Math.floor(opts.sessions ?? 2));
  const increment = opts.increment ?? 2.5;
  const maxRpe = opts.maxRpe ?? 7;
  if (!history.length || !Number.isFinite(targetReps) || targetReps <= 0) return null;

  // Group sets by session, preserving newest-first order of first appearance.
  const order: number[] = [];
  const bySession = new Map<number, ProgressionSet[]>();
  for (const s of history) {
    let bucket = bySession.get(s.session_id);
    if (!bucket) {
      bucket = [];
      bySession.set(s.session_id, bucket);
      order.push(s.session_id);
    }
    bucket.push(s);
  }

  // The weight under test is the top working weight in the most recent session.
  // A nudge only makes sense for weighted work — bodyweight/cardio bows out.
  const newest = bySession.get(order[0])!.filter((s) => s.weight_kg > 0);
  if (!newest.length) return null;
  const topWeight = Math.max(...newest.map((s) => s.weight_kg));

  // A session "clears" when every set it logged AT the top weight hit the rep
  // target, and no logged RPE on those sets exceeded maxRpe.
  const clears = (sets: ProgressionSet[]): boolean => {
    const atWeight = sets.filter((s) => s.weight_kg === topWeight);
    if (!atWeight.length) return false;
    const allHitTarget = atWeight.every((s) => s.reps >= targetReps);
    const rpeOk = atWeight.every((s) => s.rpe == null || s.rpe <= maxRpe);
    return allHitTarget && rpeOk;
  };

  // Count the consecutive streak from the most recent session backwards — the
  // moment a session fails to clear, the streak is broken.
  let hit = 0;
  for (const sid of order) {
    if (clears(bySession.get(sid)!)) hit++;
    else break;
  }

  const ready = hit >= required;
  return {
    ready,
    top_weight_kg: topWeight,
    suggested_weight_kg: Math.round((topWeight + increment) * 10) / 10,
    target_reps: targetReps,
    increment_kg: increment,
    sessions_hit: hit,
    sessions_required: required,
    reason: ready
      ? `hit ${targetReps}+ reps at ${topWeight} kg for ${hit} sessions in a row (RPE ≤ ${maxRpe}) — time to add ${increment} kg`
      : `${hit}/${required} qualifying sessions at ${topWeight} kg — keep going`,
  };
}
