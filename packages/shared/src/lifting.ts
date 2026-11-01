import { computePlateRacking, DEFAULT_PLATES_KG, DEFAULT_PLATES_LB } from "./strength.ts";
import { MUSCLE_GROUP_LABEL } from "./data/muscle-groups.ts";
import { getExercise, muscleGroupsForExercise } from "./workout.ts";

// =====================================================================
// RPE ↔ %1RM ↔ reps in reserve
// =====================================================================
//
// The RTS-style chart (Tuchscherer): the % of 1RM a set uses depends only on
// how many reps it is from failure, i.e. reps + RIR where RIR = 10 − RPE.
// Indexed by that total in half-rep steps from 1 (a true single) to 16
// (12 reps @ RPE 6). The chart runs to 12 @ 10; the tail is extended at the
// same ~1.3% per half rep.
const RPE_PCT_BY_HALF_REP = [
  100, 97.8, 95.5, 93.9, 92.2, 90.7, 89.2, 87.8, 86.3, 85.0, 83.7, 82.4, 81.1, 79.9, 78.6, 77.4,
  76.2, 75.1, 73.9, 72.3, 70.7, 69.4, 68.0, 66.7, 65.3, 64.0, 62.6, 61.3, 59.9, 58.6, 57.4,
];

// % of 1RM for a set of `reps` at `rpe` (reps 1-12, RPE 6-10 in half steps).
export function rpePercent(reps: number, rpe: number): number {
  if (!Number.isInteger(reps) || reps < 1 || reps > 12)
    throw new Error("reps must be a whole number from 1 to 12");
  if (rpe < 6 || rpe > 10 || Math.round(rpe * 2) !== rpe * 2) {
    throw new Error("rpe must be between 6 and 10 in steps of 0.5");
  }
  const toFailure = reps + (10 - rpe);
  return RPE_PCT_BY_HALF_REP[Math.round((toFailure - 1) * 2)];
}

export type RpeInput = {
  weight_kg: number;
  reps: number;
  rpe: number;
  // The set you want to plan; defaults to a single at RPE 8.
  target_reps?: number;
  target_rpe?: number;
};

export type RpeResult = {
  e1rm_kg: number;
  pct_of_1rm: number;
  rir: number;
  target_reps: number;
  target_rpe: number;
  target_pct: number;
  target_kg: number;
  // Loads for 1-10 reps at the target RPE.
  rep_loads: { reps: number; pct: number; kg: number }[];
  inputs: RpeInput;
  notes: string[];
};

export function computeRpe(i: RpeInput): RpeResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  const pct = rpePercent(i.reps, i.rpe);
  const e1rm = i.weight_kg / (pct / 100);
  const tReps = i.target_reps ?? 1;
  const tRpe = i.target_rpe ?? 8;
  const tPct = rpePercent(tReps, tRpe);
  const at = (p: number) => Math.round(e1rm * (p / 100) * 2) / 2;
  return {
    e1rm_kg: Math.round(e1rm * 10) / 10,
    pct_of_1rm: pct,
    rir: 10 - i.rpe,
    target_reps: tReps,
    target_rpe: tRpe,
    target_pct: tPct,
    target_kg: at(tPct),
    rep_loads: Array.from({ length: 10 }, (_, k) => {
      const p = rpePercent(k + 1, tRpe);
      return { reps: k + 1, pct: p, kg: at(p) };
    }),
    inputs: i,
    notes: [
      "RTS-style RPE chart: the load depends on how many reps the set is from failure (reps + reps in reserve).",
      "RPE is a self-rating, so the estimate is only as honest as the rating. It is least reliable for beginners and above 10 reps.",
    ],
  };
}

// =====================================================================
// Warm-up sets — a ramp to the top set, with plates per side
// =====================================================================
//
// Empty bar for 10, then 40% × 5, 60% × 3, 75% × 2 and 85% × 1 of the top set,
// plus 92% × 1 when the top set is 3 reps or fewer. Each load rounds down to
// what the plates can make (2.5 kg / 5 lb steps), and sets that would repeat a
// load or sit at the bar are dropped.

const WARMUP_SCHEME = [
  { pct: 40, reps: 5 },
  { pct: 60, reps: 3 },
  { pct: 75, reps: 2 },
  { pct: 85, reps: 1 },
];

export type WarmupInput = {
  top_kg: number;
  top_reps?: number;
  bar_kg?: number;
  unit?: "kg" | "lb";
};

export type WarmupSet = {
  pct: number;
  reps: number;
  load: number;
  per_side: { plate_kg: number; count: number }[];
};

export type WarmupResult = {
  sets: WarmupSet[];
  top: WarmupSet;
  unit: "kg" | "lb";
  bar: number;
  inputs: WarmupInput;
  notes: string[];
};

export function computeWarmupSets(i: WarmupInput): WarmupResult {
  const unit = i.unit ?? "kg";
  const bar = i.bar_kg ?? (unit === "lb" ? 45 : 20);
  if (i.top_kg <= bar) throw new Error(`top set must be heavier than the bar (${bar} ${unit})`);
  const step = unit === "lb" ? 5 : 2.5;
  const plates = unit === "lb" ? DEFAULT_PLATES_LB : DEFAULT_PLATES_KG;
  const rack = (load: number) =>
    computePlateRacking({ target_kg: load, bar_kg: bar, available_plates_kg: plates }, unit);

  const topReps = i.top_reps ?? 5;
  const scheme = topReps <= 3 ? [...WARMUP_SCHEME, { pct: 92, reps: 1 }] : WARMUP_SCHEME;
  const sets: WarmupSet[] = [
    { pct: Math.round((bar / i.top_kg) * 100), reps: 10, load: bar, per_side: [] },
  ];
  for (const s of scheme) {
    const load = Math.floor((i.top_kg * s.pct) / 100 / step) * step;
    if (load <= sets[sets.length - 1].load || load >= i.top_kg) continue;
    const r = rack(load);
    sets.push({ pct: s.pct, reps: s.reps, load: r.loaded_kg, per_side: r.per_side });
  }
  const top = rack(i.top_kg);
  return {
    sets,
    top: { pct: 100, reps: topReps, load: top.loaded_kg, per_side: top.per_side },
    unit,
    bar,
    inputs: i,
    notes: [
      "Warm-up reps fall as the load rises, so the ramp primes you without tiring you before the top set.",
      "Rest a minute or so between the light sets and two before the heaviest one.",
      ...(top.exact
        ? []
        : [
            `${i.top_kg} ${unit} isn't loadable exactly with standard plates — closest is ${top.loaded_kg} ${unit}.`,
          ]),
    ],
  };
}

// =====================================================================
// Training volume — tonnage and weekly hard sets per muscle group
// =====================================================================
//
// Tonnage is sets × reps × load. Weekly sets count in full toward every
// PRIMARY muscle group of the exercise, the same rule as the app's plan screen
// (planMuscleTotals). Each group is judged against the 10-20 hard sets a week
// where the Schoenfeld 2017 dose-response meta-analysis puts most hypertrophy.

export const WEEKLY_SETS_TARGET = { min: 10, max: 20 } as const;

export type VolumeEntry = { exercise_id: string; sets: number; reps: number; weight_kg: number };

export type TrainingVolumeInput = {
  entries: VolumeEntry[];
  sessions_per_week?: number;
};

export type MuscleVolume = {
  group: string;
  label: string;
  weekly_sets: number;
  verdict: "under" | "ok" | "over";
};

export type TrainingVolumeResult = {
  session_tonnage_kg: number;
  weekly_tonnage_kg: number;
  session_sets: number;
  session_reps: number;
  sessions_per_week: number;
  exercises: { exercise_id: string; name: string; tonnage_kg: number; groups: string[] }[];
  muscles: MuscleVolume[];
  target: { min: number; max: number };
  inputs: TrainingVolumeInput;
  notes: string[];
};

export function computeTrainingVolume(i: TrainingVolumeInput): TrainingVolumeResult {
  if (!i.entries.length) throw new Error("add at least one exercise");
  const perWeek = Math.max(1, Math.round(i.sessions_per_week ?? 1));
  const sets = new Map<string, number>();
  let tonnage = 0;
  let totalSets = 0;
  let totalReps = 0;
  const exercises = i.entries.map((e) => {
    if (e.sets <= 0 || e.reps <= 0) throw new Error("sets and reps must be > 0");
    const ex = getExercise(e.exercise_id);
    if (!ex) throw new Error(`unknown exercise ${e.exercise_id}`);
    const t = e.sets * e.reps * Math.max(0, e.weight_kg);
    tonnage += t;
    totalSets += e.sets;
    totalReps += e.sets * e.reps;
    const groups = ex.type === "cardio" ? [] : muscleGroupsForExercise(ex);
    for (const g of groups) sets.set(g, (sets.get(g) ?? 0) + e.sets * perWeek);
    return { exercise_id: e.exercise_id, name: ex.name, tonnage_kg: Math.round(t), groups };
  });
  const muscles = [...sets.entries()]
    .map(([group, weekly]) => ({
      group,
      label: MUSCLE_GROUP_LABEL[group] ?? group,
      weekly_sets: weekly,
      verdict:
        weekly < WEEKLY_SETS_TARGET.min
          ? ("under" as const)
          : weekly > WEEKLY_SETS_TARGET.max
            ? ("over" as const)
            : ("ok" as const),
    }))
    .sort((a, b) => b.weekly_sets - a.weekly_sets);
  return {
    session_tonnage_kg: Math.round(tonnage),
    weekly_tonnage_kg: Math.round(tonnage * perWeek),
    session_sets: totalSets,
    session_reps: totalReps,
    sessions_per_week: perWeek,
    exercises,
    muscles,
    target: { ...WEEKLY_SETS_TARGET },
    inputs: i,
    notes: [
      "Weekly sets count in full toward each exercise's primary muscle groups, the same rule as the app's plan screen.",
      "10-20 hard sets per muscle a week is where most growth happens (Schoenfeld 2017). Only sets taken within a few reps of failure count as hard.",
      "Tonnage tracks how much work you did, but it is a poor guide to growth on its own — sets close to failure matter more.",
    ],
  };
}
