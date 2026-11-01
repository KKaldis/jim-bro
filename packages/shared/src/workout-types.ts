/**
 * Workout / strength-training types.
 *
 * Two layers:
 *   1. Catalog (static, shipped in /data): muscles, muscle groups, exercises,
 *      machines. IDs are stable snake_case; UI labels live alongside.
 *   2. User data (in Postgres): workout plans, sessions, and per-set rows.
 *
 * Set rows are flat (one row per set) rather than nested JSONB. That's the
 * shape progress queries want — "top set on bench in the last 90 days",
 * "weekly volume per muscle group" — without parsing JSON on every read.
 */

// =====================================================================
// Catalog
// =====================================================================

export type MuscleId = string; // snake_case, e.g. "pectoralis_major_sternal"
export type MuscleGroupId = string; // snake_case, e.g. "chest"
export type ExerciseId = string; // snake_case, e.g. "barbell_bench_press"
export type MachineId = string; // snake_case, e.g. "lat_pulldown_machine"

export type Muscle = {
  id: MuscleId;
  label: string;
  group: MuscleGroupId;
};

export type MuscleGroup = {
  id: MuscleGroupId;
  label: string;
  muscles: MuscleId[];
};

// Equipment is what you HOLD or stand on. Machine is a *kind* of equipment;
// when equipment === "machine" the exercise will also point at a machine_id.
export type Equipment =
  | "barbell"
  | "dumbbell"
  | "kettlebell"
  | "machine"
  | "cable"
  | "bodyweight"
  | "band"
  | "smith_machine"
  | "cardio";

export type ExerciseType = "compound" | "isolation" | "cardio";

// Optional rich media + explanatory content for an exercise. Purely
// presentational reference material — a how-to video, demo images, and/or a
// prose description of the movement and cues. NOT wired into the agent or UI
// yet (no field is populated in the catalog and nothing reads it); the shape
// is defined up front so values can be filled in later without a schema churn.
export type ExerciseMetadata = {
  // URLs to demonstration images / form stills.
  image_urls?: string[];
  // URL to a demonstration video (e.g. a YouTube/Vimeo link or hosted clip).
  video_url?: string;
  // Free-form text explaining the exercise: setup, execution, common cues.
  description?: string;
};

// Which numeric metrics make sense to log for an exercise. Drives both the UI
// field set on Workout.tsx and the per-set columns the storage layer fills in
// (see exerciseFields for the resulting column set).
//   - "reps_weight":       sets × reps @ weight_kg (strength work)
//   - "duration_distance": duration_sec + optional distance_m (cardio work)
//   - "duration_weight":   duration_sec + optional weight_kg (timed holds: plank)
// A "mixed" exercise lists BOTH — e.g. a rower with intervals where you care
// about distance AND want to track perceived effort by RPE. Default derivation
// from `type` is in trackedMetricsFor() below; specify `tracks` explicitly to
// override (e.g. an "assault bike" cardio session that you ALSO want to track
// reps for during a tabata).
export type WorkoutMetricKind = "reps_weight" | "duration_distance" | "duration_weight";

export type Exercise = {
  id: ExerciseId;
  name: string;
  type: ExerciseType;
  equipment: Equipment;
  // Specific muscle IDs. Group is derived via the muscle → group map.
  primary_muscles: MuscleId[];
  secondary_muscles: MuscleId[];
  // Set when the exercise is performed on a specific machine. Lets the UI
  // filter "what can I do on the lat pulldown?".
  machine_id?: MachineId;
  // Optional override of the default metric set. Omit → derived from `type`
  // via trackedMetricsFor (cardio → ["duration_distance"], else strength).
  tracks?: WorkoutMetricKind[];
  // Free-form coaching note. Optional, short.
  notes?: string;
  // Optional reference media + how-to content (video / images / description).
  // Reserved for future use — not populated in the catalog or surfaced yet.
  metadata?: ExerciseMetadata;
};

// Default metric set for an exercise. Honors an explicit `tracks` override
// and falls back to a type-driven default. Pure-cardio exercises track
// duration+distance; everything else tracks reps+weight. A "mixed" exercise
// must opt in via `tracks: ["reps_weight", "duration_distance"]`.
export function trackedMetricsFor(exercise: Exercise): WorkoutMetricKind[] {
  if (exercise.tracks && exercise.tracks.length > 0) return exercise.tracks;
  return exercise.type === "cardio" ? ["duration_distance"] : ["reps_weight"];
}

// The set / plan columns an exercise uses, from its metric kinds:
//   reps     → reps, target_reps
//   weight   → weight_kg, target_weight_kg
//   duration → duration_sec, target_duration_sec (seconds)
//   distance → distance_m
// An id missing from the catalog is treated as strength (reps + weight).
export type ExerciseFields = {
  reps: boolean;
  weight: boolean;
  duration: boolean;
  distance: boolean;
};

const KIND_FIELDS: Record<WorkoutMetricKind, (keyof ExerciseFields)[]> = {
  reps_weight: ["reps", "weight"],
  duration_distance: ["duration", "distance"],
  duration_weight: ["duration", "weight"],
};

export function exerciseFields(exercise: Exercise | null | undefined): ExerciseFields {
  const out: ExerciseFields = { reps: false, weight: false, duration: false, distance: false };
  const kinds: WorkoutMetricKind[] = exercise ? trackedMetricsFor(exercise) : ["reps_weight"];
  for (const k of kinds) for (const f of KIND_FIELDS[k]) out[f] = true;
  return out;
}

// A timed hold (plank): seconds in duration_sec / target_duration_sec, with
// optional weight. Unknown ids are not timed.
export function isTimedExercise(exercise: Exercise | null | undefined): boolean {
  return !!exercise && trackedMetricsFor(exercise).includes("duration_weight");
}

export type Machine = {
  id: MachineId;
  name: string;
  // Groups this machine targets. The set of exercises performable on it is
  // derived from exercises[].machine_id rather than stored here.
  muscle_groups: MuscleGroupId[];
  notes?: string;
};

export type WorkoutCatalog = {
  muscle_groups: MuscleGroup[];
  muscles: Muscle[];
  exercises: Exercise[];
  machines: Machine[];
};

// =====================================================================
// Persistence: workout plans
// =====================================================================

export type Weekday =
  "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

// One configured exercise inside a plan day. target_weight_kg / duration /
// distance are hints, not constraints — actual logged numbers live on
// WorkoutSet. `target_reps` / `target_duration_sec` / `target_distance_m`
// are nullable because not every exercise tracks every metric (see
// trackedMetricsFor) — a treadmill prescription has duration but no reps;
// a bench press prescription has reps but no duration.
export type WorkoutPlanExercise = {
  id: number;
  exercise_id: ExerciseId;
  machine_id?: MachineId | null;
  order: number;
  target_sets: number;
  target_reps?: number | null;
  target_weight_kg?: number | null;
  target_duration_sec?: number | null;
  target_distance_m?: number | null;
  notes?: string | null;
};

export type WorkoutPlanDay = {
  id: number;
  // Weekdays this day is scheduled on. Empty array = unscheduled template
  // day. Multiple entries let one prescription (e.g. "Chest Day 1") run on
  // several weekdays without duplicating the row.
  weekdays: Weekday[];
  name: string;
  focus?: string | null; // free text: "Push", "Chest + Triceps"
  exercises: WorkoutPlanExercise[];
};

export type WorkoutPlan = {
  id: number;
  name: string;
  notes?: string | null;
  days: WorkoutPlanDay[];
  created_at?: string;
  updated_at?: string;
};

// Shape POSTed by the editor — server assigns ids during the insert. Same
// as WorkoutPlan but with ids omitted at every level of the tree.
export type WorkoutPlanWriteInput = {
  name: string;
  notes?: string | null;
  days: Array<{
    weekdays: Weekday[];
    name: string;
    focus?: string | null;
    exercises: Array<{
      exercise_id: ExerciseId;
      machine_id?: MachineId | null;
      order: number;
      target_sets: number;
      target_reps?: number | null;
      target_weight_kg?: number | null;
      target_duration_sec?: number | null;
      target_distance_m?: number | null;
      notes?: string | null;
    }>;
  }>;
};

// =====================================================================
// Persistence: sessions + sets
// =====================================================================

// One row per set. exercise_id is a plain text reference to the catalog
// (or future user_exercise). No FK — keeps the table simple and lets us
// rename catalog IDs without orphaning history.
export type WorkoutSet = {
  id: number;
  session_id: number;
  exercise_id: ExerciseId;
  machine_id?: MachineId | null;
  set_index: number; // 1-based within the exercise for this session
  reps: number;
  weight_kg: number;
  rpe?: number | null; // 1–10 Rate of Perceived Exertion, optional
  // Cardio work: elapsed seconds + optional distance in metres. Set for
  // duration-tracked exercises (running/cycling/rowing…); null on strength sets.
  duration_sec?: number | null;
  distance_m?: number | null;
  completed_at?: string | null; // ISO timestamp; nullable for retroactive entries
};

export type WorkoutSession = {
  id: number;
  date: string; // YYYY-MM-DD
  plan_day_id?: number | null;
  name?: string | null;
  duration_min?: number | null;
  kcal_burned?: number | null;
  notes?: string | null;
  sets: WorkoutSet[];
  started_at?: string | null;
  updated_at?: string;
};

// Inputs accepted by the "start session" / "append set" / "patch session"
// endpoints. ids and set_index are server-assigned; clients send what they
// know and the server fills the rest.

export type WorkoutSessionStartInput = {
  date: string;
  plan_day_id?: number | null;
  name?: string | null;
  started_at?: string | null;
  // True for retroactive logs (past date) or planned drafts (future date):
  // storage leaves started_at null so the Finish flow asks the user for a
  // duration instead of computing one from wall-clock. Defaults to false.
  backdated?: boolean;
  notes?: string | null;
};

export type WorkoutSessionPatchInput = {
  name?: string | null;
  duration_min?: number | null;
  kcal_burned?: number | null;
  notes?: string | null;
};

export type WorkoutSetInput = {
  exercise_id: ExerciseId;
  machine_id?: MachineId | null;
  reps: number;
  weight_kg: number;
  rpe?: number | null;
  // Cardio work: elapsed seconds + optional distance (metres). For cardio sets
  // reps/weight are 0 and the burn comes from duration × MET instead.
  duration_sec?: number | null;
  distance_m?: number | null;
  // Optional; server uses now() when omitted so the timestamp reflects
  // wall-clock log time and powers the per-exercise chart's x-axis.
  completed_at?: string | null;
};

// "Last time you did X" hint: the most recent N sets of an exercise across
// any session, newest-first. Powers the per-exercise card on the Today tab.
export type LastExerciseSet = {
  set_id: number;
  session_id: number;
  date: string;
  reps: number;
  weight_kg: number;
  rpe: number | null;
  // Seconds, on timed-hold and cardio sets (see exerciseFields).
  duration_sec: number | null;
  completed_at: string | null;
};

// =====================================================================
// Derived: progress
// =====================================================================

// Epley estimated 1-rep max. Used in the progress view to compare sets at
// different rep ranges on the same axis.
//   1RM ≈ weight × (1 + reps / 30)
export type ExerciseProgressPoint = {
  date: string;
  top_weight_kg: number; // heaviest single set that day
  top_reps_at_top_weight: number;
  est_1rm_kg: number; // best Epley 1RM across all sets that day
  total_volume_kg: number; // Σ (reps × weight) across all sets that day
};

export type MuscleGroupVolumePoint = {
  week_start: string; // ISO date of week's Monday
  group_id: MuscleGroupId;
  total_volume_kg: number;
  set_count: number;
};

// One personal record event — surfaced in the Progress tab's "Recent PRs" list.
// We track two kinds: a new heaviest weight ever lifted for an exercise, and a
// new best estimated 1RM (Epley). The same set can satisfy both; we emit the
// stronger signal (`kind: "top_weight"` wins ties since users feel weight PRs
// more viscerally than 1RM PRs at lower reps).
export type WorkoutPRKind = "top_weight" | "est_1rm";

export type WorkoutPR = {
  exercise_id: ExerciseId;
  date: string; // YYYY-MM-DD of the session
  kind: WorkoutPRKind;
  reps: number;
  weight_kg: number;
  est_1rm_kg: number;
};
