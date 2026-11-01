/**
 * Stateless calculators: body math and StrengthLevel strength tools.
 */
import {
  ACTIVITY,
  type ActivityLevel,
  ageFromBirthYear,
  ageFromDob,
  type BodyCompEntry,
  type BodyMeasurementEntry,
  buildProgress,
  type CardioEntry,
  classifyBodyShape,
  computeBmi,
  computeBmrFromInputs,
  computeBodyMetrics,
  computeCalorieDeficit,
  computeFfmi,
  computeHeartRateZones,
  computeIdealProportions,
  computeIdealWeight,
  computeLeanBodyMass,
  computeMacroSplit,
  computeMaxPotential,
  computeOneRepMax,
  computePlateRacking,
  computePotentialProgress,
  computePowerliftingScore,
  computeProteinTarget,
  computeRpe,
  computeStepCalories,
  computeStrengthStandards,
  computeStrengthSymmetry,
  computeTargets,
  computeTrainingVolume,
  computeVo2Max,
  computeWarmupSets,
  computeWaterIntake,
  DEFAULT_PLATES_LB,
  estimateBodyFatArmy,
  estimateBodyFatDeurenberg,
  estimateBodyFatNavy,
  type Goal,
  MUSCLE_GIRTHS,
  type ProportionPart,
  resolveExerciseRef,
  reviewTrainingPlan,
  type Sex,
} from "@fa/shared";

import { UserStorage } from "../../storage.ts";
import { doLogBodyComp, doUpdateBodyCompEntry } from "./body.ts";
import { readLength, readTime, todayIso } from "./shared.ts";

// Unit helpers. Centralized so the conversion factor lives in one place and
// the formulas downstream stay cm/kg-native.
const LB_PER_KG = 2.2046226218;

function readMass(
  input: Record<string, unknown>,
  kgKey: string,
  lbKey: string,
  units: "metric" | "imperial",
  required: boolean,
  label: string,
): { kg: number | null; converted_from_lb?: number } {
  const kgRaw = input[kgKey];
  const lbRaw = input[lbKey];
  if (kgRaw != null) {
    const v = Number(kgRaw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${kgKey} must be > 0`);
    return { kg: v };
  }
  if (lbRaw != null) {
    const v = Number(lbRaw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${lbKey} must be > 0`);
    return { kg: v / LB_PER_KG, converted_from_lb: v };
  }
  if (required) {
    throw new Error(
      `${label} required — pass ${kgKey} (metric) or ${lbKey} (imperial; units=${units})`,
    );
  }
  return { kg: null };
}

export async function doComputeBmi(input: Record<string, unknown>) {
  const units = (input.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  const result = computeBmi({ weight_kg: weight.kg!, height_cm: height.cm! });
  const conversions: Record<string, string> = {};
  if (weight.converted_from_lb != null) {
    conversions.weight = `${weight.converted_from_lb} lb → ${weight.kg!.toFixed(2)} kg`;
  }
  if (height.converted_from_in != null) {
    conversions.height = `${height.converted_from_in} in → ${height.cm!.toFixed(2)} cm`;
  }
  return { ...result, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
}

export async function doComputeFfmi(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  const units = (input.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  const bf = Number(input.body_fat_pct);
  if (!Number.isFinite(bf)) {
    throw new Error("body_fat_pct required (e.g. 18.5). Run estimate_body_fat first if unknown.");
  }
  const result = computeFfmi({
    sex,
    weight_kg: weight.kg!,
    height_cm: height.cm!,
    body_fat_pct: bf,
  });
  const conversions: Record<string, string> = {};
  if (weight.converted_from_lb != null) {
    conversions.weight = `${weight.converted_from_lb} lb → ${weight.kg!.toFixed(2)} kg`;
  }
  if (height.converted_from_in != null) {
    conversions.height = `${height.converted_from_in} in → ${height.cm!.toFixed(2)} cm`;
  }
  return { ...result, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
}

export async function doComputeBmr(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  const units = (input.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";

  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const height = readLength(input, "height_cm", "height_in", units, true, "height");

  let age: number;
  if (input.dob !== undefined && input.dob !== null) {
    const dob = String(input.dob);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new Error("dob must be YYYY-MM-DD");
    }
    age = ageFromDob(dob);
  } else if (input.age !== undefined) {
    age = Number(input.age);
  } else {
    throw new Error("either age or dob is required");
  }

  const result = computeBmrFromInputs({
    sex,
    weight_kg: weight.kg!,
    height_cm: height.cm!,
    age,
    body_fat_pct: input.body_fat_pct != null ? Number(input.body_fat_pct) : null,
    activity_level: input.activity_level
      ? (String(input.activity_level) as ActivityLevel)
      : undefined,
    goal: input.goal ? (String(input.goal) as Goal) : undefined,
  });

  const conversions: Record<string, string> = {};
  if (weight.converted_from_lb != null) {
    conversions.weight = `${weight.converted_from_lb} lb → ${weight.kg!.toFixed(2)} kg`;
  }
  if (height.converted_from_in != null) {
    conversions.height = `${height.converted_from_in} in → ${height.cm!.toFixed(2)} cm`;
  }
  return { ...result, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
}

type MassRead = { kg: number | null; converted_from_lb?: number };
type LengthRead = { cm: number | null; converted_from_in?: number };

// Echoes each lb/in → kg/cm conversion back on the result, as the BMI / BMR
// handlers do, so the model can show the user what it converted.
function withConversions<T extends object>(
  result: T,
  units: "metric" | "imperial",
  reads: Record<string, MassRead | LengthRead>,
) {
  const conversions: Record<string, string> = {};
  for (const [k, r] of Object.entries(reads)) {
    if ("kg" in r && r.converted_from_lb != null) {
      conversions[k] = `${r.converted_from_lb} lb → ${r.kg!.toFixed(2)} kg`;
    }
    if ("cm" in r && r.converted_from_in != null) {
      conversions[k] = `${r.converted_from_in} in → ${r.cm!.toFixed(2)} cm`;
    }
  }
  return { ...result, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
}

function goalOf(input: Record<string, unknown>): Goal {
  const g = String(input.goal ?? "");
  if (g !== "cut" && g !== "maintain" && g !== "recomp" && g !== "lean_bulk") {
    throw new Error("goal must be one of cut, maintain, recomp, lean_bulk");
  }
  return g;
}

const optNum = (v: unknown) => (v != null && v !== "" ? Number(v) : null);

export async function doComputeMacroSplit(input: Record<string, unknown>) {
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const kcal = Number(input.kcal);
  if (!Number.isFinite(kcal)) throw new Error("kcal is required");
  const result = computeMacroSplit({
    kcal,
    weight_kg: weight.kg!,
    body_fat_pct: optNum(input.body_fat_pct),
    goal: goalOf(input),
  });
  return withConversions(result, units, { weight });
}

export async function doComputeProteinTarget(input: Record<string, unknown>) {
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const result = computeProteinTarget({
    weight_kg: weight.kg!,
    body_fat_pct: optNum(input.body_fat_pct),
    goal: goalOf(input),
    meals: optNum(input.meals) ?? undefined,
  });
  return withConversions(result, units, { weight });
}

export async function doComputeCalorieDeficit(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  const age = Number(input.age);
  if (!Number.isFinite(age)) throw new Error("age is required (years)");
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  const goal = readMass(input, "goal_weight_kg", "goal_weight_lb", units, true, "goal weight");
  const activity = String(input.activity_level ?? "");
  if (!(activity in ACTIVITY)) {
    throw new Error("activity_level must be one of sedentary, light, moderate, very, extreme");
  }
  const result = computeCalorieDeficit({
    sex,
    age,
    weight_kg: weight.kg!,
    height_cm: height.cm!,
    body_fat_pct: optNum(input.body_fat_pct),
    activity_level: activity as ActivityLevel,
    goal_weight_kg: goal.kg!,
    weekly_loss_pct: optNum(input.weekly_loss_pct) ?? 0.5,
  });
  return withConversions(result, units, { weight, height, goal_weight: goal });
}

export async function doComputeIdealWeight(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  const units = unitsOf(input);
  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  return withConversions(computeIdealWeight({ sex, height_cm: height.cm! }), units, { height });
}

export async function doComputeHeartRateZones(input: Record<string, unknown>) {
  const age = Number(input.age);
  if (!Number.isFinite(age)) throw new Error("age is required (years)");
  return computeHeartRateZones({
    age,
    resting_heart_rate: optNum(input.resting_heart_rate),
    max_heart_rate: optNum(input.max_heart_rate),
  });
}

function sexOf(input: Record<string, unknown>): Sex {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  return sex;
}

// Loads (not bodyweight) in the user's unit → kg. `units=imperial` means lb.
const loadKg = (v: number, units: "metric" | "imperial") =>
  units === "imperial" ? v / LB_PER_KG : v;

export async function doComputeLeanBodyMass(input: Record<string, unknown>) {
  const sex = sexOf(input);
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  const result = computeLeanBodyMass({
    sex,
    weight_kg: weight.kg!,
    height_cm: height.cm!,
    body_fat_pct: optNum(input.body_fat_pct),
  });
  return withConversions(result, units, { weight, height });
}

export async function doComputeWaterIntake(input: Record<string, unknown>) {
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const sex = input.sex === "male" || input.sex === "female" ? input.sex : null;
  const result = computeWaterIntake({
    weight_kg: weight.kg!,
    exercise_min: optNum(input.exercise_min),
    climate: input.climate === "hot" ? "hot" : "temperate",
    sex,
  });
  return withConversions(result, units, { weight });
}

export async function doComputeStepCalories(input: Record<string, unknown>) {
  const sex = sexOf(input);
  const steps = Number(input.steps);
  if (!Number.isFinite(steps)) throw new Error("steps is required");
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  const result = computeStepCalories({
    steps,
    sex,
    weight_kg: weight.kg!,
    height_cm: height.cm!,
    pace: input.pace === "slow" ? "slow" : "brisk",
    age: optNum(input.age),
  });
  return withConversions(result, units, { weight, height });
}

export async function doConvertRpe(input: Record<string, unknown>) {
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const result = computeRpe({
    weight_kg: weight.kg!,
    reps: Number(input.reps),
    rpe: Number(input.rpe),
    target_reps: optNum(input.target_reps) ?? undefined,
    target_rpe: optNum(input.target_rpe) ?? undefined,
  });
  return withConversions(result, units, { weight });
}

export async function doPlanWarmupSets(input: Record<string, unknown>) {
  const top = Number(input.top_weight);
  if (!Number.isFinite(top)) throw new Error("top_weight is required");
  // The ramp works in whatever unit it is given (like plate_barbell_racking).
  return computeWarmupSets({
    top_kg: top,
    top_reps: optNum(input.top_reps) ?? undefined,
    bar_kg: optNum(input.bar_weight) ?? undefined,
    unit: input.unit === "lb" ? "lb" : "kg",
  });
}

export async function doComputeTrainingVolume(input: Record<string, unknown>) {
  const units = unitsOf(input);
  const raw = Array.isArray(input.exercises) ? (input.exercises as Record<string, unknown>[]) : [];
  if (!raw.length)
    throw new Error("exercises is required — at least one { exercise, sets, reps, weight }");
  const entries = raw.map((e) => {
    const ref = String(e.exercise ?? "");
    const r = resolveExerciseRef(ref);
    if (!r.ok) {
      const options = r.candidates
        .slice(0, 5)
        .map((c) => c.id)
        .join(", ");
      throw new Error(
        `couldn't match exercise "${ref}"${options ? ` — did you mean one of: ${options}` : ""}`,
      );
    }
    return {
      exercise_id: r.exercise.id,
      sets: Number(e.sets),
      reps: Number(e.reps),
      weight_kg: loadKg(Number(e.weight ?? 0) || 0, units),
    };
  });
  const result = computeTrainingVolume({
    entries,
    sessions_per_week: optNum(input.sessions_per_week) ?? undefined,
  });
  return { ...result, units };
}

export async function doEstimateBodyFat(input: Record<string, unknown>) {
  const method = String(input.method ?? "");
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  const units = (input.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";
  const conversions: Record<string, string> = {};

  // The Army one-site method needs no height, so it runs before height is read.
  if (method === "army") {
    const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
    const waist = readLength(input, "waist_cm", "waist_in", units, true, "waist");
    if (weight.converted_from_lb != null) {
      conversions.weight = `${weight.converted_from_lb} lb → ${weight.kg!.toFixed(2)} kg`;
    }
    if (waist.converted_from_in != null) {
      conversions.waist = `${waist.converted_from_in} in → ${waist.cm!.toFixed(2)} cm`;
    }
    const out = estimateBodyFatArmy({ sex, weight_kg: weight.kg!, waist_cm: waist.cm! });
    return { ...out, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
  }

  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  if (height.converted_from_in != null) {
    conversions.height = `${height.converted_from_in} in → ${height.cm!.toFixed(2)} cm`;
  }

  if (method === "navy") {
    const neck = readLength(input, "neck_cm", "neck_in", units, true, "neck");
    const waist = readLength(input, "waist_cm", "waist_in", units, true, "waist");
    const hip = readLength(input, "hip_cm", "hip_in", units, sex === "female", "hip");
    if (neck.converted_from_in != null) {
      conversions.neck = `${neck.converted_from_in} in → ${neck.cm!.toFixed(2)} cm`;
    }
    if (waist.converted_from_in != null) {
      conversions.waist = `${waist.converted_from_in} in → ${waist.cm!.toFixed(2)} cm`;
    }
    if (hip.converted_from_in != null) {
      conversions.hip = `${hip.converted_from_in} in → ${hip.cm!.toFixed(2)} cm`;
    }
    const out = estimateBodyFatNavy({
      sex,
      height_cm: height.cm!,
      neck_cm: neck.cm!,
      waist_cm: waist.cm!,
      hip_cm: hip.cm,
    });
    return { ...out, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
  }

  if (method === "deurenberg") {
    const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
    const age = Number(input.age);
    if (!Number.isFinite(age) || age <= 0) {
      throw new Error("deurenberg method requires age");
    }
    if (weight.converted_from_lb != null) {
      conversions.weight = `${weight.converted_from_lb} lb → ${weight.kg!.toFixed(2)} kg`;
    }
    const out = estimateBodyFatDeurenberg({
      sex,
      weight_kg: weight.kg!,
      height_cm: height.cm!,
      age,
    });
    return { ...out, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
  }

  throw new Error(`unknown method: ${method} (use 'navy', 'deurenberg' or 'army')`);
}

// Read the user's CURRENT body composition from their latest weigh-in and shape
// it for the summary card (BF% / BMI / FFMI+lean / weight, each with a gauge).
// Reuses computeBodyMetrics — the same math log_body_comp snapshots — so the
// card always agrees with the stored entry. Body fat is the user-entered reading
// when present, else the Navy estimate. The trend block reuses buildProgress.
export async function doGetBodyComposition(storage: UserStorage, input: Record<string, unknown>) {
  const profile = await storage.loadProfile();
  if (!profile) {
    return {
      error:
        "no profile yet — call update_profile first (need sex + height_cm to derive BMI/FFMI from a weigh-in)",
    };
  }
  const latest = await storage.latestBodyComp();
  if (!latest || latest.weight_kg == null) {
    return {
      error:
        "no body composition entry yet — call log_body_comp first (need current weight_kg; body_fat_pct optional but improves accuracy)",
    };
  }
  const computed = computeBodyMetrics({
    sex: profile.sex,
    height_cm: profile.height_cm,
    weight_kg: latest.weight_kg,
    body_fat_pct: latest.body_fat_pct,
    waist_cm: latest.waist_cm ?? null,
    neck_cm: latest.neck_cm ?? null,
    hip_cm: latest.hip_cm ?? null,
  });
  // Mirror the body_fat_source labelling get_todays_macros uses: a real reading
  // (with its method) beats the Navy estimate.
  const bodyFatSource =
    latest.body_fat_pct != null
      ? (latest.body_fat_method ?? "entered")
      : computed.body_fat_pct_navy != null
        ? "navy_estimate"
        : null;
  const FOCUS_METRICS = new Set(["body_fat", "bmi", "ffmi", "weight"]);
  const focus =
    typeof input.focus === "string" && FOCUS_METRICS.has(input.focus) ? input.focus : null;
  const windowDays = input.window_days != null ? Number(input.window_days) : 14;
  const entries = await storage.readBodyComp();
  const progress = buildProgress(entries, windowDays);
  const trend =
    "delta" in progress
      ? {
          window_days: windowDays,
          weight_kg: progress.delta.weight_kg,
          body_fat_pct: progress.delta.body_fat_pct,
          fat_free_mass_kg: progress.delta.fat_free_mass_kg,
        }
      : null;
  return {
    date: latest.date,
    focus,
    sex: profile.sex,
    height_cm: profile.height_cm,
    weight_kg: latest.weight_kg,
    body_fat_pct: computed.effective_body_fat_pct,
    body_fat_source: bodyFatSource,
    body_fat_method: latest.body_fat_method ?? null,
    bmi: computed.bmi,
    ffmi: computed.ffmi,
    ffmi_normalized: computed.ffmi_normalized,
    fat_free_mass_kg: computed.fat_free_mass_kg,
    fat_mass_kg: computed.fat_mass_kg,
    trend,
    total_entries: entries.length,
  };
}

// ---------- Strength · StrengthLevel calculators ----------

// Optional signed mass reader — unlike readMass, allows zero/negatives (weighted
// calisthenics can be assisted, i.e. a negative "added" load). Returns kg.
function readSignedMass(
  input: Record<string, unknown>,
  kgKey: string,
  lbKey: string,
): { kg: number | null; converted_from_lb?: number } {
  const kgRaw = input[kgKey];
  const lbRaw = input[lbKey];
  if (kgRaw != null && Number.isFinite(Number(kgRaw))) return { kg: Number(kgRaw) };
  if (lbRaw != null && Number.isFinite(Number(lbRaw))) {
    const v = Number(lbRaw);
    return { kg: v / LB_PER_KG, converted_from_lb: v };
  }
  return { kg: null };
}

function unitsOf(input: Record<string, unknown>): "metric" | "imperial" {
  return input.units === "imperial" ? "imperial" : "metric";
}

export async function doComputeOneRepMax(input: Record<string, unknown>) {
  const units = unitsOf(input);
  const weight = readMass(input, "weight_kg", "weight_lb", units, true, "weight");
  const reps = Number(input.reps);
  if (!Number.isFinite(reps) || reps < 1) throw new Error("reps must be a whole number >= 1");
  const formulaRaw = String(input.formula ?? "");
  const formula =
    formulaRaw === "brzycki" || formulaRaw === "average" || formulaRaw === "epley"
      ? formulaRaw
      : undefined;
  const result = computeOneRepMax({ weight_kg: weight.kg!, reps, formula });
  const conversions: Record<string, string> = {};
  if (weight.converted_from_lb != null) {
    conversions.weight = `${weight.converted_from_lb} lb → ${weight.kg!.toFixed(2)} kg`;
  }
  return { ...result, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
}

export async function doAssessStrengthLevel(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") throw new Error("sex must be 'male' or 'female'");
  const units = unitsOf(input);
  const bw = readMass(input, "bodyweight_kg", "bodyweight_lb", units, true, "bodyweight");
  const orm = readSignedMass(input, "one_rep_max_kg", "one_rep_max_lb");
  const setW = readMass(input, "weight_kg", "weight_lb", units, false, "weight");
  const reps = input.reps != null ? Number(input.reps) : undefined;
  const age = input.age != null ? Number(input.age) : undefined;

  const result = computeStrengthStandards({
    exercise: String(input.exercise ?? ""),
    sex,
    bodyweight_kg: bw.kg!,
    one_rep_max_kg: orm.kg ?? undefined,
    weight_kg: setW.kg ?? undefined,
    reps: reps != null && Number.isFinite(reps) ? reps : undefined,
    age: age != null && Number.isFinite(age) ? age : undefined,
  });

  const conversions: Record<string, string> = {};
  if (bw.converted_from_lb != null) {
    conversions.bodyweight = `${bw.converted_from_lb} lb → ${bw.kg!.toFixed(2)} kg`;
  }
  if (orm.converted_from_lb != null) {
    conversions.one_rep_max = `${orm.converted_from_lb} lb → ${orm.kg!.toFixed(2)} kg`;
  }
  if (setW.converted_from_lb != null) {
    conversions.weight = `${setW.converted_from_lb} lb → ${setW.kg!.toFixed(2)} kg`;
  }
  return { ...result, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
}

export async function doComputePowerliftingScore(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") throw new Error("sex must be 'male' or 'female'");
  const units = unitsOf(input);
  const bw = readMass(input, "bodyweight_kg", "bodyweight_lb", units, true, "bodyweight");
  const squat = readMass(input, "squat_kg", "squat_lb", units, false, "squat");
  const bench = readMass(input, "bench_kg", "bench_lb", units, false, "bench");
  const deadlift = readMass(input, "deadlift_kg", "deadlift_lb", units, false, "deadlift");
  const total = readMass(input, "total_kg", "total_lb", units, false, "total");
  const equipment = input.equipment === "equipped" ? "equipped" : "raw";

  const result = computePowerliftingScore({
    sex,
    bodyweight_kg: bw.kg!,
    squat_kg: squat.kg ?? undefined,
    bench_kg: bench.kg ?? undefined,
    deadlift_kg: deadlift.kg ?? undefined,
    total_kg: total.kg ?? undefined,
    equipment,
  });
  const conversions: Record<string, string> = {};
  if (bw.converted_from_lb != null) {
    conversions.bodyweight = `${bw.converted_from_lb} lb → ${bw.kg!.toFixed(2)} kg`;
  }
  return { ...result, units, ...(Object.keys(conversions).length ? { conversions } : {}) };
}

export async function doStrengthSymmetry(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") throw new Error("sex must be 'male' or 'female'");
  const units = unitsOf(input);
  const bw = readMass(input, "bodyweight_kg", "bodyweight_lb", units, true, "bodyweight");
  const age = input.age != null ? Number(input.age) : undefined;
  const toKg = (v: unknown) => (units === "imperial" ? Number(v) / LB_PER_KG : Number(v));
  const rawLifts = Array.isArray(input.lifts) ? input.lifts : [];
  const lifts = rawLifts.map((l) => {
    const o = l as Record<string, unknown>;
    return {
      exercise: String(o.exercise ?? ""),
      one_rep_max_kg: o.one_rep_max != null ? toKg(o.one_rep_max) : undefined,
      weight_kg: o.weight != null ? toKg(o.weight) : undefined,
      reps: o.reps != null ? Number(o.reps) : undefined,
    };
  });
  const result = computeStrengthSymmetry({
    sex,
    bodyweight_kg: bw.kg!,
    age: age != null && Number.isFinite(age) ? age : undefined,
    lifts,
  });
  return { ...result, units };
}

export async function doPlateBarbellRacking(input: Record<string, unknown>) {
  const units = unitsOf(input);
  const isImp = units === "imperial";
  const targetRaw = isImp
    ? (input.target_lb ?? input.target_kg)
    : (input.target_kg ?? input.target_lb);
  if (targetRaw == null || !Number.isFinite(Number(targetRaw))) {
    throw new Error(`target required — pass target_${isImp ? "lb" : "kg"}`);
  }
  const target = Number(targetRaw);
  const barRaw = isImp ? input.bar_lb : input.bar_kg;
  const bar = barRaw != null && Number.isFinite(Number(barRaw)) ? Number(barRaw) : isImp ? 45 : 20;
  const platesRaw = Array.isArray(input.available_plates)
    ? input.available_plates.map(Number)
    : null;
  const plates = platesRaw && platesRaw.length ? platesRaw : isImp ? DEFAULT_PLATES_LB : undefined;

  const unit = isImp ? "lb" : "kg";
  const r = computePlateRacking(
    { target_kg: target, bar_kg: bar, available_plates_kg: plates },
    unit,
  );
  return {
    unit,
    target: r.target_kg,
    bar: r.bar_kg,
    per_side: r.per_side.map((p) => ({ plate: p.plate_kg, count: p.count })),
    loaded: r.loaded_kg,
    exact: r.exact,
    leftover: r.leftover_kg,
    notes: r.notes,
  };
}

export async function doEstimateVo2Max(input: Record<string, unknown>) {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  const age = Number(input.age);
  if (!Number.isFinite(age)) {
    throw new Error("age is required (years)");
  }
  const restingHr = Number(input.resting_heart_rate);
  if (!Number.isFinite(restingHr)) {
    throw new Error("resting_heart_rate is required (bpm)");
  }
  return computeVo2Max({
    sex,
    age,
    resting_heart_rate: restingHr,
    max_heart_rate: input.max_heart_rate != null ? Number(input.max_heart_rate) : null,
  });
}

export async function doLogCardio(storage: UserStorage, input: Record<string, unknown>) {
  const profile = await storage.loadProfile();
  if (!profile) {
    throw new Error(
      "no profile yet — call update_profile first (need sex + birth_year to derive VO₂max from the heart rate)",
    );
  }
  const restingHr = Number(input.resting_heart_rate);
  if (!Number.isFinite(restingHr) || restingHr <= 0) {
    throw new Error("resting_heart_rate required and must be > 0");
  }
  const maxHr = input.max_heart_rate != null ? Number(input.max_heart_rate) : null;
  const age = ageFromBirthYear(profile.birth_year);

  // computeVo2Max validates ranges (resting 30-120, maxHR > resting) and throws
  // a user-fixable message — let it bubble up as the tool error.
  const result = computeVo2Max({
    sex: profile.sex,
    age,
    resting_heart_rate: restingHr,
    max_heart_rate: maxHr,
  });

  const entry: CardioEntry = {
    date: String(input.date ?? todayIso()),
    resting_heart_rate: restingHr,
    max_heart_rate: result.max_heart_rate,
    vo2_max: result.vo2_max,
    vo2_max_category: result.category,
    max_heart_rate_estimated: result.max_heart_rate_estimated,
    notes: input.notes ? String(input.notes) : "",
  };
  await storage.appendCardio(entry);
  const total = await storage.countCardio();
  return {
    logged: entry,
    vo2_max: result.vo2_max,
    category: result.category,
    max_heart_rate: result.max_heart_rate,
    max_heart_rate_estimated: result.max_heart_rate_estimated,
    total_entries: total,
    notes: result.notes,
  };
}

export async function doDeleteCardioEntry(storage: UserStorage, input: Record<string, unknown>) {
  const id = Number(input.id);
  if (!Number.isInteger(id)) {
    throw new Error("id required (the cardio entry's row id)");
  }
  const deleted = await storage.deleteCardioEntry(id);
  if (!deleted) {
    return { error: "no cardio entry with that id" };
  }
  return { deleted: true, id };
}

// Edit a saved cardio reading in place. Resolves the entry by id, merges the
// provided fields over its existing values, recomputes VO₂max against the
// profile (same path as doLogCardio), and writes it back — preserving the row
// id + created_at. `date` (when given) moves the entry to a new day.
export async function doUpdateCardioEntry(storage: UserStorage, input: Record<string, unknown>) {
  const id = Number(input.id);
  if (!Number.isInteger(id)) {
    throw new Error("id required (the cardio entry's row id)");
  }
  const profile = await storage.loadProfile();
  if (!profile) {
    throw new Error(
      "no profile yet — call update_profile first (need sex + birth_year to derive VO₂max from the heart rate)",
    );
  }
  const existing = await storage.getCardioEntry(id);
  if (!existing) {
    return { error: "no cardio entry with that id" };
  }

  const restingHr =
    input.resting_heart_rate != null
      ? Number(input.resting_heart_rate)
      : existing.resting_heart_rate;
  if (restingHr == null || !Number.isFinite(restingHr) || restingHr <= 0) {
    throw new Error("resting_heart_rate must be > 0");
  }

  // max HR: explicit input wins; empty/0 clears back to the age estimate;
  // otherwise reuse the existing MEASURED value only (a previously-estimated
  // max is left null so it re-estimates from the current age).
  const hasMaxHr = Object.prototype.hasOwnProperty.call(input, "max_heart_rate");
  let maxHr: number | null;
  if (hasMaxHr) {
    const v = Number(input.max_heart_rate);
    maxHr = input.max_heart_rate == null || !Number.isFinite(v) || v <= 0 ? null : v;
  } else {
    maxHr = existing.max_heart_rate_estimated ? null : (existing.max_heart_rate ?? null);
  }

  const age = ageFromBirthYear(profile.birth_year);

  // computeVo2Max validates ranges (resting 30-120, maxHR > resting) and throws
  // a user-fixable message — let it bubble up as the tool error.
  const result = computeVo2Max({
    sex: profile.sex,
    age,
    resting_heart_rate: restingHr,
    max_heart_rate: maxHr,
  });

  const newDate =
    input.date != null && String(input.date).trim() ? String(input.date).trim() : existing.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    throw new Error(`date must be YYYY-MM-DD (got: ${JSON.stringify(newDate)})`);
  }

  const hasNotes = Object.prototype.hasOwnProperty.call(input, "notes");
  const notes = hasNotes ? String(input.notes ?? "").trim() || null : (existing.notes ?? null);

  const updated = await storage.updateCardioEntry(id, {
    date: newDate,
    resting_heart_rate: restingHr,
    max_heart_rate: result.max_heart_rate,
    vo2_max: result.vo2_max,
    vo2_max_category: result.category,
    max_heart_rate_estimated: result.max_heart_rate_estimated,
    notes,
  });
  if (!updated) {
    return { error: "no cardio entry with that id" };
  }
  return {
    updated,
    moved: newDate !== existing.date ? { from: existing.date, to: newDate } : null,
    vo2_max: result.vo2_max,
    category: result.category,
    max_heart_rate: result.max_heart_rate,
    max_heart_rate_estimated: result.max_heart_rate_estimated,
    notes: result.notes,
  };
}

export async function doComputeMaxPotential(storage: UserStorage, input: Record<string, unknown>) {
  // Fall back to the stored profile for any frame measurement the agent didn't
  // pass. sex / height / wrist / ankle are all stable identity/frame values that
  // live on the profile, so a user who measured them once never has to repeat
  // them — the agent can call this tool with no args and we backfill from disk.
  // Anything the agent DID pass wins (lets it run hypotheticals). Stored values
  // are always metric, so we only inject the *_cm fields; an explicit
  // units=imperial input still converts the agent-supplied *_in values.
  const profile = await storage.loadProfile();
  if (profile) {
    if (input.sex === undefined && profile.sex) input.sex = profile.sex;
    if (
      input.height_cm === undefined &&
      input.height_in === undefined &&
      profile.height_cm != null
    ) {
      input.height_cm = profile.height_cm;
    }
    if (input.wrist_cm === undefined && input.wrist_in === undefined && profile.wrist_cm != null) {
      input.wrist_cm = profile.wrist_cm;
    }
    if (input.ankle_cm === undefined && input.ankle_in === undefined && profile.ankle_cm != null) {
      input.ankle_cm = profile.ankle_cm;
    }
  }

  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female'");
  }
  const units = (input.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";
  const height = readLength(input, "height_cm", "height_in", units, true, "height");
  const wrist = readLength(input, "wrist_cm", "wrist_in", units, true, "wrist");
  const ankle = readLength(input, "ankle_cm", "ankle_in", units, true, "ankle");
  const targetBf =
    input.target_body_fat_pct != null ? Number(input.target_body_fat_pct) : undefined;
  if (targetBf !== undefined && !Number.isFinite(targetBf)) {
    throw new Error("target_body_fat_pct must be a number");
  }
  const result = computeMaxPotential({
    sex,
    height_cm: height.cm!,
    wrist_cm: wrist.cm!,
    ankle_cm: ankle.cm!,
    target_body_fat_pct: targetBf,
  });
  const conversions: Record<string, string> = {};
  if (height.converted_from_in != null) {
    conversions.height = `${height.converted_from_in} in → ${height.cm!.toFixed(2)} cm`;
  }
  if (wrist.converted_from_in != null) {
    conversions.wrist = `${wrist.converted_from_in} in → ${wrist.cm!.toFixed(2)} cm`;
  }
  if (ankle.converted_from_in != null) {
    conversions.ankle = `${ankle.converted_from_in} in → ${ankle.cm!.toFixed(2)} cm`;
  }
  // Drop the multi-body-fat reference_band before returning to the model. It
  // carries max weight/LBM at several BF levels (stage/lean/athletic/maintainable)
  // in one result — which let the model answer a follow-up like "at 15% fat?"
  // from this single call's prose instead of re-calling the tool, so no fresh
  // card rendered (the card only shows the one evaluated BF). Stripping it forces
  // a re-call with target_body_fat_pct for any other level → a card every time.
  // The card never used reference_band, and nothing outside the agent consumes
  // it. The band's notes line is dropped with it to avoid a dangling reference.
  const { reference_band: _refBand, notes: rawNotes, ...rest } = result;
  const notes = (rawNotes ?? []).filter((n) => !n.includes("reference_band"));
  // Enrich with the gap to potential so the card (and the model) can say "how
  // much muscle is left to build" — not just the ceiling. Current LBM comes from
  // the latest weigh-in; body fat falls back to the Navy estimate so a user who
  // never entered a measured BF% still gets a gap. Remaining is clamped at 0 (an
  // already-at-ceiling user shouldn't see a negative).
  const latest = await storage.latestBodyComp();
  const currentBf = latest?.body_fat_pct ?? latest?.body_fat_pct_navy ?? null;
  const gap =
    latest?.weight_kg != null && currentBf != null
      ? computePotentialProgress(result.max_lean_body_mass_kg, latest.weight_kg, currentBf)
      : null;
  return {
    ...rest,
    ...(gap ?? {}),
    notes,
    units,
    ...(Object.keys(conversions).length ? { conversions } : {}),
  };
}

// Backfill what the agent didn't pass: sex / height / wrist from the profile,
// tape girths from the most recent logged value of each (log_measurements +
// weigh-ins). Anything the agent DID pass (in either unit) wins, so
// hypotheticals still work.
// Returns the day the girths describe: today when the user supplied any tape
// value themselves (they just measured), else the latest day any auto-filled
// value was logged on (null when nothing was filled).
async function backfillGirths(
  storage: UserStorage,
  input: Record<string, unknown>,
  fromProfile: Array<"height" | "wrist">,
  fromTape: ProportionPart[],
): Promise<string | null> {
  const missing = (k: string) => input[`${k}_cm`] === undefined && input[`${k}_in`] === undefined;
  const profile = await storage.loadProfile();
  if (profile) {
    if (input.sex === undefined && profile.sex) input.sex = profile.sex;
    if (fromProfile.includes("height") && missing("height") && profile.height_cm != null) {
      input.height_cm = profile.height_cm;
    }
    if (fromProfile.includes("wrist") && missing("wrist") && profile.wrist_cm != null) {
      input.wrist_cm = profile.wrist_cm;
    }
  }
  const { values: latest, dates } = await storage.latestGirthsDated(todayIso());
  const supplied = fromTape.some((k) => !missing(k));
  let filledOn: string | null = null;
  for (const k of fromTape) {
    if (missing(k) && latest[k] != null) {
      input[`${k}_cm`] = latest[k];
      const d = dates[k];
      if (d && (!filledOn || d > filledOn)) filledOn = d;
    }
  }
  // Women's body shape reads the bust, which is what the chest girth holds.
  if (input.sex === "female" && fromTape.includes("chest") && missing("bust")) {
    if (latest.chest != null) input.bust_cm = latest.chest;
  }
  return supplied ? todayIso() : filledOn;
}

function readSex(input: Record<string, unknown>): "male" | "female" {
  const sex = String(input.sex ?? "");
  if (sex !== "male" && sex !== "female") {
    throw new Error("sex must be 'male' or 'female' (not on the profile — ask the user)");
  }
  return sex;
}

const PROPORTION_INPUTS = [
  "shoulders",
  "chest",
  "waist",
  "hips",
  "arm",
  "forearm",
  "neck",
  "thigh",
  "calf",
] as const;

export async function doComputeIdealProportions(
  storage: UserStorage,
  input: Record<string, unknown>,
) {
  const date = await backfillGirths(storage, input, ["height", "wrist"], [...PROPORTION_INPUTS]);
  const sex = readSex(input);
  const units = (input.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";
  const wrist = readLength(input, "wrist_cm", "wrist_in", units, true, "wrist");
  const height = readLength(input, "height_cm", "height_in", units, false, "height");
  const measurements: Partial<Record<(typeof PROPORTION_INPUTS)[number], number>> = {};
  for (const p of PROPORTION_INPUTS) {
    const v = readLength(input, `${p}_cm`, `${p}_in`, units, false, p);
    if (v.cm != null) measurements[p] = v.cm;
  }
  return {
    ...computeIdealProportions({ sex, wrist_cm: wrist.cm!, height_cm: height.cm, measurements }),
    units,
    // The day these girths describe — the card's date tag opens it on
    // Body → Measurements.
    date: date ?? todayIso(),
  };
}

export async function doReviewTrainingPlan(storage: UserStorage, input: Record<string, unknown>) {
  let planId: number | null = null;
  if (input.plan_id != null && input.plan_id !== "") {
    planId = Number(input.plan_id);
    if (!Number.isFinite(planId) || planId <= 0) {
      throw new Error("plan_id must be a positive integer");
    }
  } else {
    planId = (await storage.loadProfile())?.active_workout_plan_id ?? null;
  }
  const plan = planId != null ? await storage.loadWorkoutPlan(planId) : null;
  if (!plan) {
    return {
      error: "no_plan",
      message:
        planId != null
          ? `workout plan ${planId} not found`
          : "the user has no active workout plan — offer to build one or activate one",
    };
  }
  let proportions;
  try {
    // Same auto-fill as the standalone tool: profile wrist/height/sex plus the
    // latest weigh-in and measuring session.
    proportions = await doComputeIdealProportions(storage, {});
  } catch (e) {
    return {
      error: "proportions_unavailable",
      message: `${e instanceof Error ? e.message : String(e)} — ask for the missing measurements (wrist plus a few tape girths), save them with log_measurements, then review again`,
    };
  }
  return { ...reviewTrainingPlan(plan, proportions), proportions_date: proportions.date };
}

export async function doClassifyBodyShape(storage: UserStorage, input: Record<string, unknown>) {
  await backfillGirths(storage, input, [], ["waist", "hips", "chest", "shoulders"]);
  const sex = readSex(input);
  const units = (input.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";
  const len = (k: string, required = false) =>
    readLength(input, `${k}_cm`, `${k}_in`, units, required, k.replace("_", " ")).cm;
  return {
    ...classifyBodyShape({
      sex,
      waist_cm: len("waist", true)!,
      hips_cm: len("hips", true)!,
      bust_cm: len("bust"),
      chest_cm: len("chest"),
      high_hip_cm: len("high_hip"),
      shoulders_cm: len("shoulders"),
    }),
    units,
  };
}

// Girths that live on the weigh-in rather than the measuring session.
const WEIGH_IN_GIRTHS = ["waist", "neck", "hip"] as const;

// undefined = not passed (keep), null = clear, number = set.
function readGirthCm(input: Record<string, unknown>, part: string): number | null | undefined {
  const v = input[`${part}_cm`];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 5 || n > 300) {
    throw new Error(`${part}_cm must be a circumference in cm (5-300)`);
  }
  return n;
}

export async function doLogMeasurements(storage: UserStorage, input: Record<string, unknown>) {
  const date =
    input.date != null && String(input.date).trim() ? String(input.date).trim() : todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  const time = readTime(input.time);

  const muscle = Object.fromEntries(MUSCLE_GIRTHS.map((p) => [p, readGirthCm(input, p)]));
  const shared = Object.fromEntries(WEIGH_IN_GIRTHS.map((p) => [p, readGirthCm(input, p)]));
  const touchesSession =
    Object.values(muscle).some((v) => v !== undefined) || input.notes !== undefined;
  const sharedPatch: Record<string, number | null> = {};
  for (const p of WEIGH_IN_GIRTHS) if (shared[p] !== undefined) sharedPatch[`${p}_cm`] = shared[p];
  if (!touchesSession && Object.keys(sharedPatch).length === 0) {
    throw new Error("pass at least one measurement");
  }
  const weight = input.weight_kg != null && input.weight_kg !== "" ? Number(input.weight_kg) : null;

  // Resolve the weigh-in up front: edit the day's newest one, or create one
  // only when there's something to store AND a weight to anchor it.
  const weighInToday = Object.keys(sharedPatch).length
    ? ((await storage.readBodyCompRange(date, date)).at(-1) ?? null)
    : null;
  const createWeighIn = !weighInToday && Object.values(sharedPatch).some((v) => v != null);
  if (createWeighIn && weight == null) {
    throw new Error(
      `no weigh-in on ${date} — waist / neck / hip are stored on the day's weigh-in (they feed the Navy body-fat estimate). Pass weight_kg to log one with them.`,
    );
  }

  let session: BodyMeasurementEntry | null = await storage.getMeasurement(date);
  if (touchesSession) {
    const merged: BodyMeasurementEntry = {
      date,
      shoulders_cm:
        muscle.shoulders === undefined ? (session?.shoulders_cm ?? null) : muscle.shoulders,
      chest_cm: muscle.chest === undefined ? (session?.chest_cm ?? null) : muscle.chest,
      arm_cm: muscle.arm === undefined ? (session?.arm_cm ?? null) : muscle.arm,
      forearm_cm: muscle.forearm === undefined ? (session?.forearm_cm ?? null) : muscle.forearm,
      thigh_cm: muscle.thigh === undefined ? (session?.thigh_cm ?? null) : muscle.thigh,
      calf_cm: muscle.calf === undefined ? (session?.calf_cm ?? null) : muscle.calf,
      notes: input.notes !== undefined ? String(input.notes ?? "") : (session?.notes ?? ""),
      time: time !== undefined ? time : (session?.time ?? null),
    };
    const empty = MUSCLE_GIRTHS.every((p) => merged[`${p}_cm`] == null) && !merged.notes;
    if (empty) {
      if (session) await storage.deleteMeasurement(date);
      session = null;
    } else {
      session = await storage.upsertMeasurement(merged);
    }
  }

  let weighIn: { action: "updated" | "created"; entry: BodyCompEntry } | null = null;
  if (weighInToday) {
    const res = await doUpdateBodyCompEntry(storage, {
      ...sharedPatch,
      ...(weight != null ? { weight_kg: weight } : {}),
      entry_id: weighInToday.id,
    });
    weighIn = { action: "updated", entry: res.updated };
  } else if (createWeighIn) {
    const res = await doLogBodyComp(storage, {
      date,
      weight_kg: weight,
      ...sharedPatch,
      ...(time !== undefined ? { time } : {}),
    });
    weighIn = { action: "created", entry: res.logged };
  }

  return { date, measurements: session, weigh_in: weighIn };
}

export async function doComputeTargets(storage: UserStorage, input: Record<string, unknown>) {
  const profile = await storage.loadProfile();
  if (!profile) {
    return {
      error:
        "no profile yet — call update_profile first (gather sex, age, height_cm, activity_level, goal from the user)",
    };
  }
  const latest = await storage.latestBodyComp();
  if (!latest || latest.weight_kg == null) {
    return {
      error:
        "no body composition entry yet — call log_body_comp first (need current weight_kg; body_fat_pct optional but improves accuracy)",
    };
  }
  // body_fat_pct flows in as user-entered ?? Navy estimate so cuts/recomps get
  // Katch-McArdle when *any* BF% is available, entered or computed.
  const effectiveBf = latest.body_fat_pct ?? latest.body_fat_pct_navy ?? null;
  const result = computeTargets(profile, {
    weight_kg: latest.weight_kg,
    body_fat_pct: effectiveBf,
  });
  let saved_to_plan: number | null = null;
  if (input.save_as_default) {
    const planId = input.plan_id != null ? Number(input.plan_id) : undefined;
    const ok = await storage.setDietDefaultTarget(result.daily_target, planId);
    if (!ok) {
      return {
        ...result,
        body_comp_source: { date: latest.date, weight_kg: latest.weight_kg },
        save_warning:
          "couldn't save as default — no active diet plan (create one with save_diet_plan, or pass plan_id)",
      };
    }
    saved_to_plan = planId ?? profile.active_diet_plan_id ?? null;
  }
  return {
    ...result,
    body_comp_source: { date: latest.date, weight_kg: latest.weight_kg },
    ...(saved_to_plan != null ? { saved_to_plan } : {}),
  };
}
