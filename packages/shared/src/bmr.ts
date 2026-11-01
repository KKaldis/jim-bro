import type { ActivityLevel, Goal, Macros, Profile, Sex } from "./types.ts";
import { round1 } from "./food.ts";

export const ACTIVITY: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very: 1.725,
  extreme: 1.9,
};

export const GOAL_KCAL_DELTA: Record<Goal, number> = {
  cut: -0.2,
  maintain: 0.0,
  recomp: -0.05,
  lean_bulk: 0.1,
};

export function ageFromDob(dob: string): number {
  const [y, m, d] = dob.split("-").map(Number);
  const today = new Date();
  let age = today.getFullYear() - y;
  const month = today.getMonth() + 1;
  if (month < m || (month === m && today.getDate() < d)) age--;
  return age;
}

// Profiles store only the birth year (exact birthday isn't needed for BMR/TDEE,
// where a ±1yr drift is negligible). Age is the year count since birth.
export function ageFromBirthYear(birthYear: number): number {
  return new Date().getFullYear() - birthYear;
}

export function mifflinStJeor(sex: "male" | "female", kg: number, cm: number, age: number): number {
  const base = 10 * kg + 6.25 * cm - 5 * age;
  return base + (sex === "male" ? 5 : -161);
}

export function katchMcArdle(lbmKg: number): number {
  return 370 + 21.6 * lbmKg;
}

// Protein per kg of lean mass (bodyweight when lean mass is unknown). Higher on
// a cut, where the deficit raises the protein needed to hold on to muscle.
export const PROTEIN_G_PER_KG: Record<Goal, number> = {
  cut: 2.4,
  maintain: 2.2,
  recomp: 2.2,
  lean_bulk: 1.8,
};

export function macroSplit(kcal: number, kg: number, lbmKg: number | null, goal: Goal): Macros {
  const ref = lbmKg ?? kg;
  const proteinG = Math.round(PROTEIN_G_PER_KG[goal] * ref);
  const fatG = Math.round(0.9 * kg);
  const carbsKcal = Math.max(0, kcal - proteinG * 4 - fatG * 9);
  const carbsG = Math.round(carbsKcal / 4);
  // IOM Adequate Intake: 14g fiber per 1000 kcal. Bounded to a sensible
  // floor so a deep cut at 1200 kcal still recommends ~17g rather than
  // dropping to zero.
  const fiberG = Math.max(14, Math.round((14 * kcal) / 1000));
  return {
    kcal: Math.round(kcal),
    p: proteinG,
    f: fatG,
    c: carbsG,
    fiber: fiberG,
  };
}

export type TargetsResult = {
  inputs: {
    sex: "male" | "female";
    weight_kg: number;
    height_cm: number;
    age: number;
    activity_level: ActivityLevel;
    goal: Goal;
    body_fat_pct: number | null;
    lean_mass_kg: number | null;
  };
  bmr_mifflin_st_jeor: number;
  bmr_katch_mcardle: number | null;
  bmr_used: number;
  tdee: number;
  daily_target: Macros;
  notes: string[];
};

// US Navy circumference method (Hodgdon-Beckett body density + Siri).
// Inputs in cm.
//   D_men   = 1.0324  − 0.19077 × log10(waist − neck)        + 0.15456 × log10(height)
//   D_women = 1.29579 − 0.35004 × log10(waist + hip − neck)  + 0.22100 × log10(height)
//   BF%     = 495 / D − 450        (Siri equation)
export type NavyBodyFatInput = {
  sex: "male" | "female";
  height_cm: number;
  neck_cm: number;
  waist_cm: number;
  hip_cm?: number | null;
};

export function estimateBodyFatNavy(i: NavyBodyFatInput): {
  body_fat_pct: number;
  body_density: number;
  method: "navy";
  inputs: NavyBodyFatInput;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (i.sex === "female" && (i.hip_cm == null || i.hip_cm <= 0)) {
    throw new Error("navy method for women requires hip_cm");
  }
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  if (i.neck_cm <= 0 || i.waist_cm <= 0) {
    throw new Error("neck_cm and waist_cm must be > 0");
  }
  const inner =
    i.sex === "male" ? i.waist_cm - i.neck_cm : i.waist_cm + (i.hip_cm ?? 0) - i.neck_cm;
  if (inner <= 0) {
    throw new Error(
      `navy formula needs waist${i.sex === "female" ? "+hip" : ""} > neck (got inner=${inner})`,
    );
  }
  const density =
    i.sex === "male"
      ? 1.0324 - 0.19077 * Math.log10(inner) + 0.15456 * Math.log10(i.height_cm)
      : 1.29579 - 0.35004 * Math.log10(inner) + 0.221 * Math.log10(i.height_cm);
  if (density <= 0) {
    throw new Error(`body density came out non-positive (${density}) — check inputs`);
  }
  const bf = 495 / density - 450;
  if (bf < 3 || bf > 60) {
    warnings.push(
      `result ${bf.toFixed(1)}% is outside the typical 3-60% range — double-check measurements (waist at navel for men / narrowest for women; neck below larynx; hip at widest)`,
    );
  }
  return {
    body_fat_pct: Math.round(bf * 10) / 10,
    body_density: Math.round(density * 10000) / 10000,
    method: "navy",
    inputs: i,
    warnings,
  };
}

// BMI = kg / m². Pure anthropometric ratio — separate from BMR/TDEE math.
// WHO categories (adults, non-pregnant): the boundaries below are the
// standard cutoffs used in clinical and population health work.
export type BmiCategory =
  | "underweight_severe" // <16
  | "underweight_moderate" // 16-16.9
  | "underweight_mild" // 17-18.4
  | "normal" // 18.5-24.9
  | "overweight" // 25-29.9
  | "obese_class_1" // 30-34.9
  | "obese_class_2" // 35-39.9
  | "obese_class_3"; // >=40

function bmiCategory(bmi: number): BmiCategory {
  if (bmi < 16) return "underweight_severe";
  if (bmi < 17) return "underweight_moderate";
  if (bmi < 18.5) return "underweight_mild";
  if (bmi < 25) return "normal";
  if (bmi < 30) return "overweight";
  if (bmi < 35) return "obese_class_1";
  if (bmi < 40) return "obese_class_2";
  return "obese_class_3";
}

export type BmiInput = { weight_kg: number; height_cm: number };

export type BmiResult = {
  bmi: number;
  category: BmiCategory;
  inputs: BmiInput;
  // Healthy weight band for this height (BMI 18.5-24.9), kg, rounded to 0.1.
  healthy_weight_range_kg: { low: number; high: number };
  notes: string[];
};

export function computeBmi(i: BmiInput): BmiResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  const heightM = i.height_cm / 100;
  const bmi = i.weight_kg / (heightM * heightM);
  const low = 18.5 * heightM * heightM;
  const high = 24.9 * heightM * heightM;
  const notes: string[] = [
    "BMI doesn't distinguish fat from lean mass — high-muscle individuals can read overweight without excess fat. Pair with body_fat_pct (estimate_body_fat) for a fuller picture.",
  ];
  return {
    bmi: Math.round(bmi * 10) / 10,
    category: bmiCategory(bmi),
    inputs: i,
    healthy_weight_range_kg: {
      low: Math.round(low * 10) / 10,
      high: Math.round(high * 10) / 10,
    },
    notes,
  };
}

// Fat-Free Mass Index — a body-composition analog of BMI that scales lean
// mass (rather than total mass) to height². Tracks muscularity directly:
// two people with the same BMI but different body-fat % can have very
// different FFMIs.
//
//   FFM_kg          = weight_kg × (1 − body_fat_pct / 100)
//   FFMI            = FFM_kg / height_m²
//   normalized_FFMI = FFMI + 6.1 × (1.8 − height_m)
//
// The normalization adjusts to a 1.8m reference so people of different
// heights can be compared on the same scale. Category boundaries below
// come from Kouri et al. 1995 (a population-level natural-vs-steroid
// study) and are usually applied to the normalized value.
export type FfmiCategory =
  | "below_average"
  | "average"
  | "above_average"
  | "very_above_average"
  | "outstanding"
  | "extremely_high"
  | "outside_natural_range";

function ffmiCategory(normFfmi: number, sex: "male" | "female"): FfmiCategory {
  if (sex === "male") {
    if (normFfmi < 17) return "below_average";
    if (normFfmi < 18) return "average";
    if (normFfmi < 20) return "above_average";
    if (normFfmi < 21) return "very_above_average";
    if (normFfmi < 22.5) return "outstanding";
    if (normFfmi < 25) return "extremely_high";
    return "outside_natural_range";
  }
  if (normFfmi < 13) return "below_average";
  if (normFfmi < 14) return "average";
  if (normFfmi < 15) return "above_average";
  if (normFfmi < 17) return "very_above_average";
  if (normFfmi < 19) return "outstanding";
  if (normFfmi < 21.5) return "extremely_high";
  return "outside_natural_range";
}

export type FfmiInput = {
  sex: "male" | "female";
  weight_kg: number;
  height_cm: number;
  body_fat_pct: number;
};

export type FfmiResult = {
  ffmi: number;
  normalized_ffmi: number;
  fat_free_mass_kg: number;
  fat_mass_kg: number;
  category: FfmiCategory;
  inputs: FfmiInput;
  notes: string[];
};

export function computeFfmi(i: FfmiInput): FfmiResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  if (i.body_fat_pct < 2 || i.body_fat_pct > 60) {
    throw new Error(
      `body_fat_pct ${i.body_fat_pct} out of plausible range (2-60). Re-check the value; FFMI needs accurate BF%.`,
    );
  }
  const heightM = i.height_cm / 100;
  const ffmKg = i.weight_kg * (1 - i.body_fat_pct / 100);
  const fatKg = i.weight_kg - ffmKg;
  const ffmi = ffmKg / (heightM * heightM);
  const normFfmi = ffmi + 6.1 * (1.8 - heightM);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    ffmi: round1(ffmi),
    normalized_ffmi: round1(normFfmi),
    fat_free_mass_kg: round1(ffmKg),
    fat_mass_kg: round1(fatKg),
    category: ffmiCategory(normFfmi, i.sex),
    inputs: i,
    notes: [
      "FFMI is only as good as the body-fat % input — DEXA/BIA are more reliable than visual estimates. Consider running estimate_body_fat (navy method) if you only have circumferences.",
      "Categories use the normalized FFMI (height-adjusted to 1.8m). Boundaries are from Kouri et al. 1995 — population-level reference points; individual variation is large.",
      "The frequently-quoted ~25 'natural ceiling' for men is the normalized FFMI value, not the raw one.",
    ],
  };
}

// Casey Butt (2008) — predict maximum drug-free muscular potential from
// wrist + ankle circumferences (proxies for skeletal frame size) + height.
// Empirical fit over a population of natural-champion bodybuilders.
//
//   LBM_lbs = H_in^1.5
//           × ( sqrt(W_in)/22.6670 + sqrt(A_in)/17.0104 )
//           × ( BF_pct/224 + 0.984 )
//
// The BF_pct term captures that peak LBM is reached at "off-season" levels
// (LBM falls slightly when cut to stage condition). The formula was fit on
// men; for women we apply a 0.85 scalar (commonly cited in natural-BB
// literature — women's max LBM trends ~15% lower at equivalent frame).
//
// Companion predictions for max cold/lean muscle girths use the
// Park/Casey-Butt rule-of-thumb ratios (cm = ratio × wrist_cm or
// ratio × ankle_cm). These are rougher than the LBM formula — surface
// them as "approx" so the user doesn't take them as precise targets.
export type MaxPotentialInput = {
  sex: "male" | "female";
  height_cm: number;
  // Narrowest point of the dominant wrist, distal to the styloid process.
  wrist_cm: number;
  // Narrowest point above the lateral malleolus.
  ankle_cm: number;
  // Body-fat % at which to evaluate the LBM ceiling (LBM is slightly higher
  // off-season than at stage). Defaults: 8 (male), 18 (female).
  target_body_fat_pct?: number;
};

export type MaxPotentialBand = {
  label: string;
  body_fat_pct: number;
  max_lean_body_mass_kg: number;
  max_weight_kg: number;
};

export type MaxPotentialResult = {
  max_lean_body_mass_kg: number;
  max_weight_kg: number;
  evaluated_at_body_fat_pct: number;
  reference_band: MaxPotentialBand[];
  predicted_max_circumferences_cm: {
    chest: number;
    neck: number;
    bicep_flexed: number;
    forearm: number;
    thigh: number;
    calf: number;
  };
  inputs: MaxPotentialInput;
  notes: string[];
};

const LB_PER_KG = 2.2046226218;
const CM_PER_IN = 2.54;

// Cold, lean rule-of-thumb max girths (Park / Casey Butt natural-BB lore).
// All multipliers act on wrist or ankle circumference in the SAME unit.
const RATIOS = {
  chest_per_wrist: 6.5,
  neck_per_wrist: 2.5,
  bicep_per_wrist: 1.96,
  forearm_per_wrist: 1.16,
  thigh_per_ankle: 4.65,
  calf_per_ankle: 1.92,
};

function caseyButtLbmLbs(
  height_in: number,
  wrist_in: number,
  ankle_in: number,
  body_fat_pct: number,
): number {
  return (
    Math.pow(height_in, 1.5) *
    (Math.sqrt(wrist_in) / 22.667 + Math.sqrt(ankle_in) / 17.0104) *
    (body_fat_pct / 224 + 0.984)
  );
}

export function computeMaxPotential(i: MaxPotentialInput): MaxPotentialResult {
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  if (i.wrist_cm <= 0) throw new Error("wrist_cm must be > 0");
  if (i.ankle_cm <= 0) throw new Error("ankle_cm must be > 0");

  const sexScalar = i.sex === "male" ? 1 : 0.85;
  const height_in = i.height_cm / CM_PER_IN;
  const wrist_in = i.wrist_cm / CM_PER_IN;
  const ankle_in = i.ankle_cm / CM_PER_IN;

  const evalBf = i.target_body_fat_pct ?? (i.sex === "male" ? 8 : 18);
  if (evalBf < 2 || evalBf > 40) {
    throw new Error(`target_body_fat_pct ${evalBf} out of plausible range (2-40)`);
  }

  const lbmLbs = caseyButtLbmLbs(height_in, wrist_in, ankle_in, evalBf) * sexScalar;
  const lbmKg = lbmLbs / LB_PER_KG;
  const totalKg = lbmKg / (1 - evalBf / 100);

  const buildBand = (label: string, bf: number): MaxPotentialBand => {
    const lbm = (caseyButtLbmLbs(height_in, wrist_in, ankle_in, bf) * sexScalar) / LB_PER_KG;
    return {
      label,
      body_fat_pct: bf,
      max_lean_body_mass_kg: round1(lbm),
      max_weight_kg: round1(lbm / (1 - bf / 100)),
    };
  };
  const reference_band: MaxPotentialBand[] =
    i.sex === "male"
      ? [
          buildBand("stage_condition", 5),
          buildBand("very_lean", 8),
          buildBand("athletic", 12),
          buildBand("maintainable", 15),
        ]
      : [
          buildBand("stage_condition", 12),
          buildBand("very_lean", 15),
          buildBand("athletic", 20),
          buildBand("maintainable", 24),
        ];

  const predicted_max_circumferences_cm = {
    chest: round1(i.wrist_cm * RATIOS.chest_per_wrist),
    neck: round1(i.wrist_cm * RATIOS.neck_per_wrist),
    bicep_flexed: round1(i.wrist_cm * RATIOS.bicep_per_wrist),
    forearm: round1(i.wrist_cm * RATIOS.forearm_per_wrist),
    thigh: round1(i.ankle_cm * RATIOS.thigh_per_ankle),
    calf: round1(i.ankle_cm * RATIOS.calf_per_ankle),
  };

  const notes: string[] = [
    "Casey Butt 2008 formula — fit on natural-champion bodybuilders. Predicts the upper bound of drug-free lean mass; most lifters land below it.",
    "Wrist + ankle are stable bone-frame proxies that don't change with training; the result is a lifetime ceiling, not a near-term target.",
    "Body-fat term: LBM falls slightly at stage-lean BF% vs off-season. The reference_band shows max weight at typical conditions.",
  ];
  if (i.sex === "female") {
    notes.push(
      "Female estimate applies a 0.85 scalar to the male-derived formula (natural-BB literature heuristic). Population data on women is thinner — treat as a rough ceiling.",
    );
  }
  notes.push(
    "Predicted_max_circumferences_cm use Park/Casey-Butt rule-of-thumb ratios (forearm 1.16×wrist, bicep 1.96×wrist, neck 2.5×wrist, chest 6.5×wrist, calf 1.92×ankle, thigh 4.65×ankle). Rougher than the LBM number — flag as approximate.",
    "Measurement matters: wrist at the narrowest point distal to the styloid; ankle at the narrowest point above the lateral malleolus. A 0.5 cm tape error shifts the result a couple of kg.",
  );

  return {
    max_lean_body_mass_kg: round1(lbmKg),
    max_weight_kg: round1(totalKg),
    evaluated_at_body_fat_pct: evalBf,
    reference_band,
    predicted_max_circumferences_cm,
    inputs: i,
    notes,
  };
}

export type PotentialProgress = {
  current_lean_body_mass_kg: number;
  current_weight_kg: number;
  current_body_fat_pct: number;
  remaining_lean_mass_gain_kg: number;
  // Current lean mass as % of the max-potential lean mass — the "how close am
  // I" number the gauge plots. Can exceed 100 (formula error, or enhanced).
  pct_of_potential: number;
};

// How far along the user is toward their max lean mass. Shared by the agent
// tool (from the latest weigh-in) and the calculator (from its inputs) so the
// card shows the same number either way. Remaining is clamped at 0 — an
// at-ceiling user shouldn't see a negative gain.
export function computePotentialProgress(
  max_lean_body_mass_kg: number,
  weight_kg: number,
  body_fat_pct: number,
): PotentialProgress | null {
  if (
    !(weight_kg > 0) ||
    !(body_fat_pct >= 0 && body_fat_pct < 100) ||
    !(max_lean_body_mass_kg > 0)
  ) {
    return null;
  }
  const lbm = weight_kg * (1 - body_fat_pct / 100);
  return {
    current_lean_body_mass_kg: Math.round(lbm * 10) / 10,
    current_weight_kg: weight_kg,
    current_body_fat_pct: Math.round(body_fat_pct * 10) / 10,
    remaining_lean_mass_gain_kg: Math.round(Math.max(0, max_lean_body_mass_kg - lbm) * 10) / 10,
    pct_of_potential: Math.round((lbm / max_lean_body_mass_kg) * 100),
  };
}

// Natural muscular ceiling, expressed as how much more fat-free (muscle) mass
// a lifter could add before crossing the FFMI "outside natural range" boundary
// — normalized FFMI 25 for men, 21.5 for women (Kouri et al. 1995, the same
// cutoffs ffmiCategory() uses). Unlike computeMaxPotential (Casey Butt), this
// needs no wrist/ankle frame measurements: it works straight off the current
// fat-free mass + height already on a body-comp entry, so it can render on the
// dashboard profile card.
//
//   ceiling_raw_FFMI = ceiling_norm − 6.1 × (1.8 − height_m)   (undo normalize)
//   max_FFM_kg       = ceiling_raw_FFMI × height_m²
//   potential_gain   = max(0, max_FFM_kg − current_FFM_kg)
export const NATURAL_FFMI_CEILING: Record<Sex, number> = {
  male: 25,
  female: 21.5,
};

export type FfmiPotentialInput = {
  sex: Sex;
  height_cm: number;
  fat_free_mass_kg: number;
};

export type FfmiPotentialResult = {
  ceiling_normalized_ffmi: number;
  max_fat_free_mass_kg: number;
  // Additional lean mass before the natural ceiling; clamped at 0 for lifters
  // already at or beyond it.
  potential_gain_kg: number;
};

export function computeFfmiPotential(i: FfmiPotentialInput): FfmiPotentialResult {
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  if (i.fat_free_mass_kg <= 0) throw new Error("fat_free_mass_kg must be > 0");
  const heightM = i.height_cm / 100;
  const ceilingNorm = NATURAL_FFMI_CEILING[i.sex];
  const ceilingRaw = ceilingNorm - 6.1 * (1.8 - heightM);
  const maxFfm = ceilingRaw * heightM * heightM;
  return {
    ceiling_normalized_ffmi: ceilingNorm,
    max_fat_free_mass_kg: round1(maxFfm),
    potential_gain_kg: round1(Math.max(0, maxFfm - i.fat_free_mass_kg)),
  };
}

// Deurenberg formula (1991): BF% = 1.20×BMI + 0.23×age − 10.8×sex − 5.4
// where sex = 1 for male, 0 for female. Less accurate than DEXA but
// useful when only height/weight/age/sex are known.
export type DeurenbergBodyFatInput = {
  sex: "male" | "female";
  weight_kg: number;
  height_cm: number;
  age: number;
};

export function estimateBodyFatDeurenberg(i: DeurenbergBodyFatInput): {
  body_fat_pct: number;
  method: "deurenberg";
  bmi: number;
  inputs: DeurenbergBodyFatInput;
  warnings: string[];
} {
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  const heightM = i.height_cm / 100;
  const bmi = i.weight_kg / (heightM * heightM);
  const bf = 1.2 * bmi + 0.23 * i.age - 10.8 * (i.sex === "male" ? 1 : 0) - 5.4;
  const warnings: string[] = [
    "Deurenberg is a population-level estimate; ±4-5% typical error vs DEXA",
  ];
  if (bmi < 18 || bmi > 35) {
    warnings.push(
      `BMI ${bmi.toFixed(1)} is outside Deurenberg's validated range (18-35) — treat result as rough`,
    );
  }
  return {
    body_fat_pct: Math.round(bf * 10) / 10,
    method: "deurenberg",
    bmi: Math.round(bmi * 10) / 10,
    inputs: i,
    warnings,
  };
}

// Ad-hoc BMR / TDEE / macro math from inline inputs — does NOT require a
// saved profile. activity_level and goal are optional: if missing, TDEE and
// daily_target are omitted.
export type BmrInput = {
  sex: "male" | "female";
  weight_kg: number;
  height_cm: number;
  age: number;
  body_fat_pct?: number | null;
  activity_level?: ActivityLevel;
  goal?: Goal;
};

export type BmrResult = {
  inputs: BmrInput & { lean_mass_kg: number | null };
  bmr_mifflin_st_jeor: number;
  bmr_katch_mcardle: number | null;
  bmr_used: number;
  tdee: number | null;
  daily_target: Macros | null;
  notes: string[];
};

export function computeBmrFromInputs(i: BmrInput): BmrResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  if (i.age <= 0 || i.age > 120) throw new Error("age must be between 1 and 120");
  const bmrMsj = Math.round(mifflinStJeor(i.sex, i.weight_kg, i.height_cm, i.age));
  const bf = i.body_fat_pct ?? null;
  const lbmKg = bf != null ? Math.round(i.weight_kg * (1 - bf / 100) * 10) / 10 : null;
  const bmrKm = lbmKg != null ? Math.round(katchMcArdle(lbmKg)) : null;
  const bmrUsed = bmrKm ?? bmrMsj;

  const notes: string[] = [];
  notes.push(
    bmrKm != null
      ? `Using Katch-McArdle (lean mass ${lbmKg} kg) — preferred when body fat is known`
      : "Using Mifflin-St Jeor — Katch-McArdle would need body_fat_pct",
  );

  let tdee: number | null = null;
  let dailyTarget: Macros | null = null;
  if (i.activity_level) {
    const mult = ACTIVITY[i.activity_level];
    tdee = Math.round(bmrUsed * mult);
    notes.push(`Activity multiplier ${mult} (${i.activity_level})`);
    if (i.goal) {
      const delta = GOAL_KCAL_DELTA[i.goal];
      const kcal = Math.round(tdee * (1 + delta));
      dailyTarget = macroSplit(kcal, i.weight_kg, lbmKg, i.goal);
      const goalPct = Math.round(delta * 100);
      notes.push(`Goal delta ${goalPct >= 0 ? "+" : ""}${goalPct}% from TDEE`);
    }
  }

  return {
    inputs: { ...i, lean_mass_kg: lbmKg },
    bmr_mifflin_st_jeor: bmrMsj,
    bmr_katch_mcardle: bmrKm,
    bmr_used: bmrUsed,
    tdee,
    daily_target: dailyTarget,
    notes,
  };
}

// Latest body state, sourced from the most-recent body_comp_entry. Caller is
// responsible for picking the right row (typically `latestBodyMetrics()` from
// storage). Effective body_fat_pct = user-entered ?? Navy estimate.
export type LatestBodyMetrics = {
  weight_kg: number;
  body_fat_pct?: number | null;
};

// How far back a weight-only weigh-in reaches for a body-fat reading. Body fat
// moves slowly while weight moves daily, so a recent reading is carried forward
// rather than dropping to the BF-free BMR (which makes the calorie target jump
// on weight-only days). Beyond this window it's too stale to trust.
export const BF_CARRY_FORWARD_DAYS = 45;

type BodyMetricsRow = {
  date: string;
  weight_kg?: number | null;
  body_fat_pct?: number | null;
  body_fat_pct_navy?: number | null;
};

// The inputs computeTargets wants, from a date-ascending list of body entries:
// the newest weight, with that entry's body fat (entered reading beats the Navy
// estimate) or else the newest reading within BF_CARRY_FORWARD_DAYS before it.
// Same rule the server applies when it caches the profile's targets, so every
// surface lands on the same numbers. Null when no entry has a weight.
export function latestBodyMetrics(
  entries: readonly BodyMetricsRow[],
): (LatestBodyMetrics & { date: string }) | null {
  let li = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].weight_kg != null) {
      li = i;
      break;
    }
  }
  if (li < 0) return null;
  const latest = entries[li];
  const cutoff = new Date(`${latest.date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - BF_CARRY_FORWARD_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  let bf: number | null = null;
  for (let i = li; i >= 0 && entries[i].date >= cutoffIso; i--) {
    bf = entries[i].body_fat_pct ?? entries[i].body_fat_pct_navy ?? null;
    if (bf != null) break;
  }
  return { date: latest.date, weight_kg: latest.weight_kg as number, body_fat_pct: bf };
}

export function computeTargets(profile: Profile, latest: LatestBodyMetrics): TargetsResult {
  const age = ageFromBirthYear(profile.birth_year);
  const bf = latest.body_fat_pct ?? null;
  const weightKg = latest.weight_kg;
  const bmrMsj = Math.round(mifflinStJeor(profile.sex, weightKg, profile.height_cm, age));
  const lbmKg = bf != null ? Math.round(weightKg * (1 - bf / 100) * 10) / 10 : null;
  const bmrKm = lbmKg != null ? Math.round(katchMcArdle(lbmKg)) : null;
  const bmrUsed = bmrKm ?? bmrMsj;
  const activityMult = ACTIVITY[profile.activity_level];
  const tdee = Math.round(bmrUsed * activityMult);
  const goalDelta = GOAL_KCAL_DELTA[profile.goal];
  const targetKcal = Math.round(tdee * (1 + goalDelta));
  const macros = macroSplit(targetKcal, weightKg, lbmKg, profile.goal);
  const goalPct = Math.round(goalDelta * 100);
  return {
    inputs: {
      sex: profile.sex,
      weight_kg: weightKg,
      height_cm: profile.height_cm,
      age,
      activity_level: profile.activity_level,
      goal: profile.goal,
      body_fat_pct: bf,
      lean_mass_kg: lbmKg,
    },
    bmr_mifflin_st_jeor: bmrMsj,
    bmr_katch_mcardle: bmrKm,
    bmr_used: bmrUsed,
    tdee,
    daily_target: macros,
    notes: [
      `Activity multiplier ${activityMult} (${profile.activity_level})`,
      `Goal delta ${goalPct >= 0 ? "+" : ""}${goalPct}% from TDEE`,
    ],
  };
}

// Derive every computed field on a body-comp entry from its raw inputs +
// the profile's height/sex. Used at write time by the agent's log_body_comp
// tool (and the new POST /body endpoint) so the database always stores both
// what the user entered AND what we derived from it.
//
// Returns ONLY the computed fields — the caller pairs them with the raw
// inputs to assemble the full row. Anything that can't be computed (missing
// height, out-of-range body fat) stays null rather than throwing — partial
// data is the common case and the dashboard renders "—" for null fields.
export type ComputedBodyMetrics = {
  body_fat_pct_navy: number | null;
  bmi: number | null;
  ffmi: number | null;
  ffmi_normalized: number | null;
  fat_free_mass_kg: number | null;
  fat_mass_kg: number | null;
  // The effective body-fat % we used downstream (entered wins over Navy).
  effective_body_fat_pct: number | null;
};

export type ComputeBodyMetricsInput = {
  // Profile context
  sex: Sex;
  height_cm: number;
  // Raw measurements
  weight_kg: number | null;
  body_fat_pct: number | null;
  waist_cm: number | null;
  neck_cm: number | null;
  hip_cm: number | null;
};

// Compute Navy body-fat % without throwing. Returns null when the required
// circumferences are missing or the formula is ill-defined for the inputs
// (e.g. neck >= waist, or a result outside the plausible 2-60% range).
function navyBfNoThrow(
  sex: Sex,
  height_cm: number,
  waist_cm: number | null,
  neck_cm: number | null,
  hip_cm: number | null,
): number | null {
  if (!waist_cm || !neck_cm || !height_cm) return null;
  if (sex === "female" && !hip_cm) return null;
  const inner = sex === "male" ? waist_cm - neck_cm : waist_cm + (hip_cm ?? 0) - neck_cm;
  if (inner <= 0) return null;
  const density =
    sex === "male"
      ? 1.0324 - 0.19077 * Math.log10(inner) + 0.15456 * Math.log10(height_cm)
      : 1.29579 - 0.35004 * Math.log10(inner) + 0.221 * Math.log10(height_cm);
  if (density <= 0) return null;
  const bf = 495 / density - 450;
  if (!Number.isFinite(bf) || bf < 2 || bf > 60) return null;
  return round1(bf);
}

export function computeBodyMetrics(i: ComputeBodyMetricsInput): ComputedBodyMetrics {
  const heightM = i.height_cm > 0 ? i.height_cm / 100 : null;
  const denom = heightM != null ? heightM * heightM : null;

  const bmi =
    denom != null && i.weight_kg != null && i.weight_kg > 0 ? round1(i.weight_kg / denom) : null;

  const bfNavy = navyBfNoThrow(i.sex, i.height_cm, i.waist_cm, i.neck_cm, i.hip_cm);

  // User-entered BF% beats the estimate — never overwrite a real reading.
  const effectiveBf =
    i.body_fat_pct != null && i.body_fat_pct >= 2 && i.body_fat_pct <= 60 ? i.body_fat_pct : bfNavy;

  let fat_free_mass_kg: number | null = null;
  let fat_mass_kg: number | null = null;
  let ffmi: number | null = null;
  let ffmi_normalized: number | null = null;

  if (i.weight_kg != null && i.weight_kg > 0 && effectiveBf != null) {
    const ffm = i.weight_kg * (1 - effectiveBf / 100);
    fat_free_mass_kg = round1(ffm);
    fat_mass_kg = round1(i.weight_kg - ffm);
    if (denom != null && heightM != null) {
      const raw = ffm / denom;
      ffmi = round1(raw);
      ffmi_normalized = round1(raw + 6.1 * (1.8 - heightM));
    }
  }

  return {
    body_fat_pct_navy: bfNavy,
    bmi,
    ffmi,
    ffmi_normalized,
    fat_free_mass_kg,
    fat_mass_kg,
    effective_body_fat_pct: effectiveBf,
  };
}

// Daily protein target on its own — the same per-kg rule macroSplit uses, so
// the protein and TDEE calculators never disagree. Lean mass is the reference
// when body fat is known; otherwise bodyweight, which reads slightly high.
export type ProteinInput = {
  weight_kg: number;
  body_fat_pct?: number | null;
  goal: Goal;
  meals?: number;
};

export type ProteinResult = {
  protein_g: number;
  g_per_kg_reference: number;
  g_per_kg_bodyweight: number;
  basis: "lean_mass" | "bodyweight";
  lean_mass_kg: number | null;
  meals: number;
  per_meal_g: number;
  // The RDA (0.8 g/kg bodyweight) — the floor for sedentary adults, not a target.
  rda_g: number;
  inputs: ProteinInput;
  notes: string[];
};

export function computeProteinTarget(i: ProteinInput): ProteinResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  const bf = i.body_fat_pct ?? null;
  const lbm = bf != null ? round1(i.weight_kg * (1 - bf / 100)) : null;
  const perKg = PROTEIN_G_PER_KG[i.goal];
  const protein = Math.round(perKg * (lbm ?? i.weight_kg));
  const meals = Math.max(1, Math.round(i.meals ?? 4));
  const notes: string[] = [
    lbm != null
      ? `Set at ${perKg} g per kg of lean mass (${lbm} kg).`
      : `Set at ${perKg} g per kg of bodyweight — add a body-fat % to base it on lean mass, which reads lower.`,
    "Spreading it over 3-5 meals of roughly 0.4 g/kg each supports muscle protein synthesis better than one or two large servings.",
  ];
  return {
    protein_g: protein,
    g_per_kg_reference: perKg,
    g_per_kg_bodyweight: Math.round((protein / i.weight_kg) * 100) / 100,
    basis: lbm != null ? "lean_mass" : "bodyweight",
    lean_mass_kg: lbm,
    meals,
    per_meal_g: Math.round(protein / meals),
    rda_g: Math.round(0.8 * i.weight_kg),
    inputs: i,
    notes,
  };
}

// Ideal body weight from height alone. All four are linear in inches over five
// feet, from clinical dosing work rather than body-composition research, so
// they disagree by several kilos and ignore muscle entirely. Below 5 ft the
// lines are extrapolated.
//   Devine (1974)   M 50.0 + 2.3/in   F 45.5 + 2.3/in
//   Robinson (1983) M 52.0 + 1.9/in   F 49.0 + 1.7/in
//   Miller (1983)   M 56.2 + 1.41/in  F 53.1 + 1.36/in
//   Hamwi (1964)    M 48.0 + 2.7/in   F 45.5 + 2.2/in
const IBW_FORMULAS: Record<
  "devine" | "robinson" | "miller" | "hamwi",
  Record<Sex, [base: number, perInch: number]>
> = {
  devine: { male: [50, 2.3], female: [45.5, 2.3] },
  robinson: { male: [52, 1.9], female: [49, 1.7] },
  miller: { male: [56.2, 1.41], female: [53.1, 1.36] },
  hamwi: { male: [48, 2.7], female: [45.5, 2.2] },
};

export type IdealWeightInput = { sex: Sex; height_cm: number };

export type IdealWeightResult = {
  devine_kg: number;
  robinson_kg: number;
  miller_kg: number;
  hamwi_kg: number;
  average_kg: number;
  // BMI 18.5-24.9 at this height — the same band computeBmi reports.
  healthy_bmi_range_kg: { low: number; high: number };
  inputs: IdealWeightInput;
  notes: string[];
};

export function computeIdealWeight(i: IdealWeightInput): IdealWeightResult {
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  const inchesOver5ft = i.height_cm / 2.54 - 60;
  const calc = (k: keyof typeof IBW_FORMULAS) => {
    const [base, perInch] = IBW_FORMULAS[k][i.sex];
    return base + perInch * inchesOver5ft;
  };
  const devine = calc("devine");
  const robinson = calc("robinson");
  const miller = calc("miller");
  const hamwi = calc("hamwi");
  const m2 = (i.height_cm / 100) ** 2;
  const notes: string[] = [
    "These formulas come from drug-dosing research and know nothing about muscle — a trained lifter will sit well above them at low body fat.",
  ];
  if (inchesOver5ft < 0) {
    notes.push(
      "Below 5 ft the formulas are extrapolated past the heights they were built on; lean on the BMI range instead.",
    );
  }
  return {
    devine_kg: round1(devine),
    robinson_kg: round1(robinson),
    miller_kg: round1(miller),
    hamwi_kg: round1(hamwi),
    average_kg: round1((devine + robinson + miller + hamwi) / 4),
    healthy_bmi_range_kg: { low: round1(18.5 * m2), high: round1(24.9 * m2) },
    inputs: i,
    notes,
  };
}

// Energy content of a kilo of body-mass loss, the usual planning figure. Real
// loss is not pure fat, so it is a rate for planning, not a prediction.
export const KCAL_PER_KG_BODY_MASS = 7700;

// Below these, intake is hard to make nutritionally complete without
// supervision, so a planned deficit is capped here rather than going lower.
export const MIN_INTAKE_KCAL: Record<Sex, number> = { male: 1500, female: 1200 };

export type CalorieDeficitInput = Omit<BmrInput, "goal" | "activity_level"> & {
  activity_level: ActivityLevel;
  goal_weight_kg: number;
  // Planned loss per week as a percentage of current bodyweight (0.25-1.5).
  weekly_loss_pct: number;
};

export type CalorieDeficitResult = {
  tdee: number;
  daily_kcal: number;
  daily_deficit: number;
  weekly_loss_kg: number;
  weeks: number;
  to_lose_kg: number;
  // True when the requested rate would have gone below MIN_INTAKE_KCAL.
  capped: boolean;
  goal_bmi: number;
  macros: Macros;
  inputs: CalorieDeficitInput;
  notes: string[];
};

export function computeCalorieDeficit(i: CalorieDeficitInput): CalorieDeficitResult {
  if (i.goal_weight_kg <= 0) throw new Error("goal_weight_kg must be > 0");
  if (i.goal_weight_kg >= i.weight_kg) {
    throw new Error(
      "goal weight must be below current weight — for gaining, use a lean-bulk TDEE target",
    );
  }
  if (i.weekly_loss_pct <= 0 || i.weekly_loss_pct > 1.5) {
    throw new Error("weekly_loss_pct must be between 0 and 1.5");
  }
  const base = computeBmrFromInputs({ ...i, goal: undefined });
  const tdee = base.tdee as number;
  const floor = MIN_INTAKE_KCAL[i.sex];

  const wanted = Math.round(
    tdee - (i.weight_kg * (i.weekly_loss_pct / 100) * KCAL_PER_KG_BODY_MASS) / 7,
  );
  const capped = wanted < floor;
  const daily = capped ? floor : wanted;
  const deficit = tdee - daily;
  if (deficit <= 0) {
    throw new Error(
      `maintenance (${tdee} kcal) is already at the ${floor} kcal minimum — add activity rather than cutting intake`,
    );
  }

  const weekly = (deficit * 7) / KCAL_PER_KG_BODY_MASS;
  const toLose = i.weight_kg - i.goal_weight_kg;
  const goalBmi = i.goal_weight_kg / (i.height_cm / 100) ** 2;

  const notes: string[] = [...base.notes];
  if (capped) {
    notes.push(
      `The requested rate would put intake at ${wanted} kcal; capped at the ${floor} kcal minimum, which slows the timeline.`,
    );
  }
  if (i.weekly_loss_pct > 1) {
    notes.push(
      "Losing more than 1% of bodyweight a week makes it much harder to keep muscle. Keep protein high and keep lifting.",
    );
  }
  if (goalBmi < 18.5) {
    notes.push(
      `The goal weight is a BMI of ${round1(goalBmi)}, below the 18.5 healthy floor for your height.`,
    );
  }
  notes.push(
    "Maintenance falls as you lose weight, so recalculate every 4-5 kg or the deficit quietly shrinks.",
  );

  return {
    tdee,
    daily_kcal: daily,
    daily_deficit: deficit,
    weekly_loss_kg: Math.round(weekly * 100) / 100,
    weeks: Math.ceil(toLose / weekly),
    to_lose_kg: round1(toLose),
    capped,
    goal_bmi: round1(goalBmi),
    macros: macroSplit(daily, i.weight_kg, base.inputs.lean_mass_kg, "cut"),
    inputs: i,
    notes,
  };
}

// A calorie target split into grams, for when the calories are already known —
// macroSplit plus the shares and lean mass the result cards show.
export type MacroSplitInput = {
  kcal: number;
  weight_kg: number;
  body_fat_pct?: number | null;
  goal: Goal;
};

export type MacroSplitResult = {
  macros: Macros;
  // Percent of calories from each macro, rounded.
  pct: { p: number; c: number; f: number };
  lean_mass_kg: number | null;
  // True when protein + fat alone use up the calories, leaving carbs at zero.
  carbs_floored: boolean;
  inputs: MacroSplitInput;
  notes: string[];
};

export function computeMacroSplit(i: MacroSplitInput): MacroSplitResult {
  if (i.kcal <= 0) throw new Error("kcal must be > 0");
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  const bf = i.body_fat_pct ?? null;
  const lbm = bf != null ? round1(i.weight_kg * (1 - bf / 100)) : null;
  const m = macroSplit(i.kcal, i.weight_kg, lbm, i.goal);
  const share = (k: number) => Math.round((k / i.kcal) * 100);
  const fixed = m.p * 4 + m.f * 9;
  const notes: string[] = [
    `Protein ${PROTEIN_G_PER_KG[i.goal]} g/kg of ${lbm != null ? `lean mass (${lbm} kg)` : "bodyweight"}, fat 0.9 g/kg of bodyweight, carbohydrate fills the remaining calories.`,
  ];
  if (fixed > i.kcal) {
    notes.push(
      `Protein and fat alone need ${fixed} kcal, more than the ${Math.round(i.kcal)} kcal target, so carbs are at zero — the target is too low for this bodyweight.`,
    );
  }
  return {
    macros: m,
    pct: { p: share(m.p * 4), c: share(m.c * 4), f: share(m.f * 9) },
    lean_mass_kg: lbm,
    carbs_floored: fixed > i.kcal,
    inputs: i,
    notes,
  };
}

// US Army one-site tape method (AR 600-9, 2023): a single abdominal girth at
// the navel plus bodyweight, in inches and pounds.
//   men   BF% = −26.97 − 0.12  × lb + 1.99 × abdomen_in
//   women BF% = −9.15  − 0.015 × lb + 1.27 × abdomen_in
export type ArmyBodyFatInput = { sex: Sex; weight_kg: number; waist_cm: number };

export function estimateBodyFatArmy(i: ArmyBodyFatInput): {
  body_fat_pct: number;
  method: "army";
  inputs: ArmyBodyFatInput;
  warnings: string[];
} {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  if (i.waist_cm <= 0) throw new Error("waist_cm must be > 0");
  const lb = i.weight_kg * 2.2046226218;
  const inches = i.waist_cm / 2.54;
  const bf =
    i.sex === "male" ? -26.97 - 0.12 * lb + 1.99 * inches : -9.15 - 0.015 * lb + 1.27 * inches;
  const warnings: string[] = [];
  if (bf < 3 || bf > 60) {
    warnings.push(
      `result ${bf.toFixed(1)}% is outside the typical 3-60% range — re-check the waist (at the navel, relaxed, after breathing out)`,
    );
  }
  return { body_fat_pct: round1(bf), method: "army", inputs: i, warnings };
}

// Lean body mass. With a body-fat % it is simply weight × (1 − BF); without
// one, three height-and-weight regressions estimate it (all kg, cm):
//   Boer (1984)  M 0.407W + 0.267H − 19.2         F 0.252W + 0.473H − 48.3
//   James (1976) M 1.1W − 128(W/H)²               F 1.07W − 148(W/H)²
//   Hume (1966)  M 0.32810W + 0.33929H − 29.5336  F 0.29569W + 0.41813H − 43.2933
export type LeanBodyMassInput = {
  sex: Sex;
  weight_kg: number;
  height_cm: number;
  body_fat_pct?: number | null;
};

export type LeanBodyMassResult = {
  // The figure to use: from body fat when given, else Boer.
  lean_mass_kg: number;
  fat_mass_kg: number;
  lean_pct: number;
  basis: "body_fat" | "boer";
  from_body_fat_kg: number | null;
  boer_kg: number;
  james_kg: number;
  hume_kg: number;
  inputs: LeanBodyMassInput;
  notes: string[];
};

export function computeLeanBodyMass(i: LeanBodyMassInput): LeanBodyMassResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  if (i.height_cm <= 0) throw new Error("height_cm must be > 0");
  const w = i.weight_kg;
  const h = i.height_cm;
  const m = i.sex === "male";
  const boer = m ? 0.407 * w + 0.267 * h - 19.2 : 0.252 * w + 0.473 * h - 48.3;
  const james = m ? 1.1 * w - 128 * (w / h) ** 2 : 1.07 * w - 148 * (w / h) ** 2;
  const hume = m ? 0.3281 * w + 0.33929 * h - 29.5336 : 0.29569 * w + 0.41813 * h - 43.2933;
  const bf = i.body_fat_pct ?? null;
  const fromBf = bf != null ? w * (1 - bf / 100) : null;
  const lean = fromBf ?? boer;
  const notes: string[] = [
    fromBf != null
      ? "Lean mass from your body-fat %: weight × (1 − body fat). Only as accurate as the body-fat figure."
      : "Estimated with the Boer formula from height and weight. Add a body-fat % for a figure based on your actual composition.",
    "The formulas assume average muscularity, so they under-read people who lift and over-read people with very little muscle. James also breaks down at high BMI.",
  ];
  return {
    lean_mass_kg: round1(lean),
    fat_mass_kg: round1(w - lean),
    lean_pct: round1((lean / w) * 100),
    basis: fromBf != null ? "body_fat" : "boer",
    from_body_fat_kg: fromBf != null ? round1(fromBf) : null,
    boer_kg: round1(boer),
    james_kg: round1(james),
    hume_kg: round1(hume),
    inputs: i,
    notes,
  };
}
