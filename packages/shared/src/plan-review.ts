// Training-plan review: how much weekly work a workout plan gives each body
// part, set against the proportions result's lagging parts. Pure function
// behind the agent's review_training_plan tool, so "is my plan enough for my
// proportions" is one deterministic call instead of the model re-reading the
// plan and the radar card and doing the tally in its head.
//
// Volume is counted in weekly sets: a set counts 1 for a part when the
// exercise's PRIMARY muscles hit that part, 0.5 when only its secondary ones
// do (the usual fractional-set convention). Bands follow the common
// hypertrophy guideline of ~10–20 hard sets per muscle per week; lagging
// (priority) parts are held to the upper half of it.

import type { IdealProportionsResult, ProportionPart } from "./proportions.ts";
import { exerciseFields, type WorkoutPlan } from "./workout-types.ts";
import { MUSCLE_GROUP_LABEL, MUSCLE_TARGET_LABEL } from "./data/muscle-groups.ts";
import { getExercise, muscleGroupsForExercise, targetsForExercise } from "./workout.ts";
import { round1 } from "./food.ts";

// ============================================================================
// Muscle-group totals — the plan's "Muscle totals" panel in the app
// ============================================================================

export type PlanMuscleTotal = {
  group: string;
  sets: number;
  reps: number;
  seconds: number;
  // Distinct plan exercises hitting the group, by exercise type.
  compound: number;
  isolation: number;
};

// Typed loosely so both the plan-builder form draft and a saved WorkoutPlan fit.
export type PlanTotalsDay = {
  weekdays?: readonly string[];
  exercises?: readonly {
    exercise_id?: string;
    target_sets?: number | null;
    target_reps?: number | null;
    target_duration_sec?: number | null;
  }[];
};

// Weekly sets and reps per muscle group, exactly as the app's plan screen
// shows them. Like the server's muscle-group volume (handleMuscleGroupVolume),
// each set counts IN FULL toward every PRIMARY group of its exercise —
// secondary muscles are left out so assistive work isn't double-counted.
// Cardio (walking, treadmill) is left out too: the catalog tags it with leg
// muscles, and counting a walk as a hamstring set made the panel overstate real
// training (half of one user's "12 hamstring sets" were walks). A day runs once
// per assigned weekday (once if it has none). `bucketsFor` picks the grouping
// (muscle groups by default; the web's toggle can pass targets).
export function planMuscleTotals(
  days: readonly PlanTotalsDay[],
  bucketsFor: (exerciseId: string) => string[] = (id) => muscleGroupsForExercise(id),
): PlanMuscleTotal[] {
  const totals = new Map<string, PlanMuscleTotal>();
  // group -> exercise ids already counted, so a lift on two days counts once.
  const seen = new Map<string, Set<string>>();
  for (const day of days) {
    const perWeek = Math.max(1, day.weekdays?.length ?? 0);
    for (const ex of day.exercises ?? []) {
      if (!ex.exercise_id) continue;
      const exercise = getExercise(ex.exercise_id);
      if (exercise?.type === "cardio") continue;
      const sets = (ex.target_sets ?? 0) * perWeek;
      // Reps for lifts, seconds for timed holds (exerciseFields).
      const fields = exerciseFields(exercise);
      const reps = fields.reps ? sets * (ex.target_reps ?? 0) : 0;
      const seconds = fields.duration ? sets * (ex.target_duration_sec ?? 0) : 0;
      for (const group of bucketsFor(ex.exercise_id)) {
        const t = totals.get(group) ?? {
          group,
          sets: 0,
          reps: 0,
          seconds: 0,
          compound: 0,
          isolation: 0,
        };
        t.sets += sets;
        t.reps += reps;
        t.seconds += seconds;
        const ids = seen.get(group) ?? new Set<string>();
        if (!ids.has(ex.exercise_id)) {
          ids.add(ex.exercise_id);
          seen.set(group, ids);
          if (exercise?.type === "compound") t.compound += 1;
          else if (exercise?.type === "isolation") t.isolation += 1;
        }
        totals.set(group, t);
      }
    }
  }
  return [...totals.values()].sort((a, b) => b.sets - a.sets || b.reps - a.reps);
}

export type PartVolumeVerdict = "under" | "ok" | "over";

export type PartVolume = {
  part: ProportionPart;
  pct_of_ideal: number | null;
  // 1-based rank in the proportions priorities; null when not a priority.
  priority_rank: number | null;
  weekly_sets: number;
  target_min: number;
  target_max: number;
  verdict: PartVolumeVerdict;
  // Plan exercises that count toward this part, most sets first.
  exercises: Array<{ exercise_id: string; weekly_sets: number }>;
};

export type PlanDaySummary = {
  name: string;
  weekdays: string[];
  exercises: number;
  sets: number;
  // Strength exercises with no target_weight_kg — nothing to progress against.
  missing_target_weight: number;
};

// Structural problems worth raising before volume: the plan can be well-dosed
// on paper and still hard to follow.
export type PlanIssue =
  | { kind: "unscheduled_days"; days: string[] }
  | { kind: "missing_target_weights"; exercises: number }
  | { kind: "long_sessions"; days: string[]; max_exercises: number };

export type ScreenTotal = { label: string; sets: number; reps: number; seconds: number };
export type PlanScreenTotals = { groups: ScreenTotal[]; targets: ScreenTotal[] };

// The plan screen's "Muscle totals" in both of its views (Groups, and the finer
// Muscles/targets toggle), labelled as the user sees them.
export function planScreenTotals(days: readonly PlanTotalsDay[]): PlanScreenTotals {
  const labelled = (rows: PlanMuscleTotal[], labels: Record<string, string>): ScreenTotal[] =>
    rows.map(({ group, sets, reps, seconds }) => ({
      label: labels[group] ?? group,
      sets,
      reps,
      seconds,
    }));
  return {
    groups: labelled(planMuscleTotals(days), MUSCLE_GROUP_LABEL),
    targets: labelled(planMuscleTotals(days, targetsForExercise), MUSCLE_TARGET_LABEL),
  };
}

export type TrainingPlanReview = {
  plan: { id: number; name: string };
  // The plan screen's "Muscle totals" panel, in both of its views (Groups and
  // the finer Muscles/targets toggle), labelled as the user sees them. Primary
  // muscles only, full credit — a different method from `parts` below.
  screen_totals: PlanScreenTotals;
  sessions_per_week: number;
  total_weekly_sets: number;
  days: PlanDaySummary[];
  issues: PlanIssue[];
  parts: PartVolume[];
  // Priority parts the plan under-doses, in priority order — the headline gaps.
  gaps: ProportionPart[];
  // The waist is a fat-loss lever, not a training one (see proportions.ts).
  waist_priority: boolean;
  unscheduled_days: number;
  unknown_exercise_ids: string[];
  notes: string[];
};

const PRIORITY_MIN_SETS = 12;
const BASE_MIN_SETS = 8;
const MAX_SETS = 22;
// Past this many exercises a session usually runs long and the last lifts get
// rushed.
const LONG_SESSION_EXERCISES = 10;

export function reviewTrainingPlan(
  plan: WorkoutPlan,
  proportions: IdealProportionsResult,
): TrainingPlanReview {
  const rankByPart = new Map<ProportionPart, number>();
  proportions.priorities
    .filter((p) => p.action === "train")
    .forEach((p, i) => rankByPart.set(p.part, i + 1));
  const waistPriority = proportions.priorities.some((p) => p.action === "reduce_waist");

  const unknown = new Set<string>();
  let sessions = 0;
  let totalSets = 0;
  let unscheduled = 0;
  // part → exercise_id → weekly sets
  const byPart = new Map<ProportionPart, Map<string, number>>();
  const days: PlanDaySummary[] = [];

  for (const day of plan.days) {
    // An unscheduled template day still counts once a week — it's in the plan.
    const perWeek = day.weekdays.length || 1;
    if (!day.weekdays.length) unscheduled++;
    sessions += perWeek;
    const summary: PlanDaySummary = {
      name: day.name,
      weekdays: day.weekdays,
      exercises: day.exercises.length,
      sets: 0,
      missing_target_weight: 0,
    };
    days.push(summary);
    for (const pe of day.exercises) {
      summary.sets += pe.target_sets || 0;
      const ex = getExercise(pe.exercise_id);
      if (!ex) {
        unknown.add(pe.exercise_id);
        continue;
      }
      if (ex.type === "cardio") continue;
      if (pe.target_weight_kg == null && ex.equipment !== "bodyweight") {
        summary.missing_target_weight++;
      }
      const sets = (pe.target_sets || 0) * perWeek;
      totalSets += sets;
      for (const row of proportions.rows) {
        if (!row.muscles.length) continue;
        const weight = ex.primary_muscles.some((m) => row.muscles.includes(m))
          ? 1
          : ex.secondary_muscles.some((m) => row.muscles.includes(m))
            ? 0.5
            : 0;
        if (!weight) continue;
        let exMap = byPart.get(row.part);
        if (!exMap) byPart.set(row.part, (exMap = new Map()));
        exMap.set(ex.id, (exMap.get(ex.id) ?? 0) + sets * weight);
      }
    }
  }

  const parts: PartVolume[] = proportions.rows
    .filter((r) => r.muscles.length)
    .map((r) => {
      const exMap = byPart.get(r.part) ?? new Map<string, number>();
      const weekly = round1([...exMap.values()].reduce((s, n) => s + n, 0));
      const rank = rankByPart.get(r.part) ?? null;
      const min = rank != null ? PRIORITY_MIN_SETS : BASE_MIN_SETS;
      return {
        part: r.part,
        pct_of_ideal: r.pct_of_ideal,
        priority_rank: rank,
        weekly_sets: weekly,
        target_min: min,
        target_max: MAX_SETS,
        verdict: weekly < min ? "under" : weekly > MAX_SETS ? "over" : "ok",
        exercises: [...exMap.entries()]
          .map(([exercise_id, s]) => ({ exercise_id, weekly_sets: round1(s) }))
          .sort((a, b) => b.weekly_sets - a.weekly_sets),
      };
    });

  const gaps = parts
    .filter((p) => p.priority_rank != null && p.verdict === "under")
    .sort((a, b) => a.priority_rank! - b.priority_rank!)
    .map((p) => p.part);

  const notes: string[] = [
    "`parts` counts weekly sets per body part (proportion girth): primary-muscle sets count 1, secondary 0.5, so indirect work (rows for traps) is included. Bands follow the ~10–20 hard sets per muscle per week hypertrophy guideline; lagging parts are held to 12+.",
    "`screen_totals` are the numbers on the user's plan screen ('Muscle totals'): primary muscles only, full credit. When the user quotes their screen, answer with these — and explain any gap to `parts` as indirect (secondary) work.",
  ];
  if (waistPriority) {
    notes.push(
      "The waist is the top priority, and that's a nutrition lever (a calorie deficit), not more training volume.",
    );
  }
  if (!proportions.priorities.length) {
    notes.push("No lagging parts in the proportions result — the plan is judged on balance only.");
  }
  if (unscheduled) {
    notes.push(`${unscheduled} plan day(s) have no weekday; each is counted once a week.`);
  }

  const issues: PlanIssue[] = [];
  const unscheduledDays = days.filter((d) => !d.weekdays.length).map((d) => d.name);
  if (unscheduledDays.length) issues.push({ kind: "unscheduled_days", days: unscheduledDays });
  const missingWeights = days.reduce((s, d) => s + d.missing_target_weight, 0);
  if (missingWeights) issues.push({ kind: "missing_target_weights", exercises: missingWeights });
  const longDays = days.filter((d) => d.exercises > LONG_SESSION_EXERCISES);
  if (longDays.length) {
    issues.push({
      kind: "long_sessions",
      days: longDays.map((d) => d.name),
      max_exercises: Math.max(...longDays.map((d) => d.exercises)),
    });
  }

  return {
    plan: { id: plan.id, name: plan.name },
    screen_totals: planScreenTotals(plan.days),
    sessions_per_week: sessions,
    total_weekly_sets: round1(totalSets),
    days,
    issues,
    parts,
    gaps,
    waist_priority: waistPriority,
    unscheduled_days: unscheduled,
    unknown_exercise_ids: [...unknown],
    notes,
  };
}
