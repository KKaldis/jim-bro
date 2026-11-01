import type { Sex } from "./types.ts";
import { MET_TABLE, kcalForActivity } from "./training.ts";

// =====================================================================
// Water intake — a daily drinking target
// =====================================================================
//
// Base need is 35 ml per kg of bodyweight, the usual clinical rule of thumb,
// plus sweat losses: about 600 ml per hour of exercise and 500 ml for a hot
// day. That is fluid to DRINK; food supplies roughly a fifth of total water on
// top. EFSA's adequate total intake (2.5 L men, 2.0 L women, food included) is
// returned for reference.

export type WaterClimate = "temperate" | "hot";

export type WaterIntakeInput = {
  weight_kg: number;
  exercise_min?: number | null;
  climate?: WaterClimate;
  sex?: Sex | null;
};

export type WaterIntakeResult = {
  total_ml: number;
  base_ml: number;
  exercise_ml: number;
  climate_ml: number;
  // 250 ml glasses, rounded up.
  glasses: number;
  efsa_total_ml: number | null;
  inputs: WaterIntakeInput;
  notes: string[];
};

const round50 = (ml: number) => Math.round(ml / 50) * 50;

export function computeWaterIntake(i: WaterIntakeInput): WaterIntakeResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  const exMin = Math.max(0, i.exercise_min ?? 0);
  const base = round50(35 * i.weight_kg);
  const exercise = round50((exMin / 60) * 600);
  const climate = i.climate === "hot" ? 500 : 0;
  const total = base + exercise + climate;
  const notes: string[] = [
    "35 ml per kg of bodyweight, plus about 600 ml per hour of exercise and 500 ml on a hot day. Food adds roughly a fifth on top.",
    "Pale-straw urine is the simplest check that the target suits you. Heavy sweaters and long sessions need more, and electrolytes as well as water.",
  ];
  return {
    total_ml: total,
    base_ml: base,
    exercise_ml: exercise,
    climate_ml: climate,
    glasses: Math.ceil(total / 250),
    efsa_total_ml: i.sex ? (i.sex === "male" ? 2500 : 2000) : null,
    inputs: i,
    notes,
  };
}

// =====================================================================
// Steps → calories, and a daily step goal
// =====================================================================
//
// Stride is estimated from height (0.415 × height for men, 0.413 for women),
// distance from stride × steps, and time from a walking speed. The burn is the
// MET walking cost over that time. `net_kcal` removes the resting energy you
// would have burned anyway (MET 1), which is what a step count actually adds.
//
// The step goal follows Paluch et al. 2022 (Lancet Public Health): mortality
// benefit levels off around 6,000-8,000 steps a day over 60 and 8,000-10,000
// under 60.

export type WalkPace = "slow" | "brisk";

const PACE: Record<WalkPace, { kmh: number; met: number }> = {
  slow: { kmh: 3.2, met: MET_TABLE.walking_slow },
  brisk: { kmh: 5.6, met: MET_TABLE.walking_brisk },
};

export type StepCaloriesInput = {
  steps: number;
  weight_kg: number;
  height_cm: number;
  sex: Sex;
  pace?: WalkPace;
  age?: number | null;
};

export type StepCaloriesResult = {
  kcal: number;
  net_kcal: number;
  kcal_per_1000: number;
  distance_km: number;
  stride_cm: number;
  minutes: number;
  // Daily goal range for this age (under-60 range when age is unknown).
  step_goal: { low: number; high: number };
  pct_of_goal: number;
  inputs: StepCaloriesInput;
  notes: string[];
};

export function computeStepCalories(i: StepCaloriesInput): StepCaloriesResult {
  if (i.steps < 0) throw new Error("steps must be ≥ 0");
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  const pace = PACE[i.pace ?? "brisk"];
  const strideCm = i.height_cm * (i.sex === "male" ? 0.415 : 0.413);
  const km = (i.steps * strideCm) / 100000;
  const minutes = (km / pace.kmh) * 60;
  const kcal = kcalForActivity(i.weight_kg, pace.met, minutes);
  const net = kcal * ((pace.met - 1) / pace.met);
  const goal =
    i.age != null && i.age >= 60 ? { low: 6000, high: 8000 } : { low: 8000, high: 10000 };
  const notes: string[] = [
    `Stride estimated from height (${Math.round(strideCm)} cm); a measured stride is more accurate.`,
    "Net calories leave out what you would burn at rest anyway — that is the figure to add to your day.",
    `Step goal from Paluch 2022: health benefit levels off around ${goal.low.toLocaleString("en")}–${goal.high.toLocaleString("en")} steps a day${i.age != null ? " at your age" : " under 60"}.`,
  ];
  return {
    kcal: Math.round(kcal),
    net_kcal: Math.round(net),
    kcal_per_1000: i.steps > 0 ? Math.round((net / i.steps) * 1000) : 0,
    distance_km: Math.round(km * 100) / 100,
    stride_cm: Math.round(strideCm),
    minutes: Math.round(minutes),
    step_goal: goal,
    pct_of_goal: Math.round((i.steps / goal.low) * 100),
    inputs: i,
    notes,
  };
}
