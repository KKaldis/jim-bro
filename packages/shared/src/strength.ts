// Strength calculators — reverse-engineered from strengthlevel.com.
//
// Everything here is a PURE function over inline inputs so the same math backs
// both the agent tools (packages/agent) and the frontend live previews
// (apps/web), exactly like computeBmi / computeVo2Max. Nothing here touches
// storage or the network.
//
// Four families:
//   1. One-rep max        — estimate 1RM from a submaximal set (+ rep→%1RM table)
//   2. Strength standards — rank a lift Beginner→Elite for sex/bodyweight/age,
//                           against StrengthLevel's population data (287 lifts)
//   3. Powerlifting score — Wilks (2020), DOTS, IPF GoodLift from a S/B/D total
//   4. Utilities          — strength symmetry (lift balance) + plate racking
import type { Sex } from "./types.ts";
import {
  FEMALE_BODYWEIGHTS_KG,
  MALE_BODYWEIGHTS_KG,
  STRENGTH_AGE_MULTIPLIERS,
  STRENGTH_STANDARDS,
  type StrengthLevelRow,
  type StrengthMetric,
  type StrengthStandardEntry,
} from "./data/strength-standards.ts";

export { STRENGTH_STANDARDS, MALE_BODYWEIGHTS_KG, FEMALE_BODYWEIGHTS_KG, STRENGTH_AGE_MULTIPLIERS };
export type { StrengthStandardEntry, StrengthMetric, StrengthLevelRow };

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// =====================================================================
// 1. One-rep max
// =====================================================================

// Two workhorse estimators. Epley is the app's existing default (see
// workout.ts epley1RM) and what StrengthLevel uses; Brzycki tracks it closely
// and reads exactly 100% at 1 rep, which makes for a cleaner percentage chart.
//   Epley:   1RM = w × (1 + reps/30)
//   Brzycki: 1RM = w × 36 / (37 − reps)
export type OneRepMaxFormula = "epley" | "brzycki" | "average";

export type RepPercentRow = {
  reps: number;
  percent_of_1rm: number; // e.g. 100, 97, 94 …
  weight_kg: number; // predicted rep-max load at this rep count
};

export type OneRepMaxInput = {
  weight_kg: number;
  reps: number;
  formula?: OneRepMaxFormula;
};

export type OneRepMaxResult = {
  one_rep_max_kg: number;
  formula: OneRepMaxFormula;
  epley_kg: number;
  brzycki_kg: number;
  inputs: { weight_kg: number; reps: number };
  // Load you'd expect to hit for 1–12 reps, as a % of the estimated 1RM.
  rep_table: RepPercentRow[];
  notes: string[];
};

function epley(weight: number, reps: number): number {
  return reps <= 1 ? weight : weight * (1 + reps / 30);
}
function brzycki(weight: number, reps: number): number {
  // 37 − reps hits 0 at 37 reps; guard the divergence.
  if (reps <= 1) return weight;
  if (reps >= 37) return weight * 36;
  return (weight * 36) / (37 - reps);
}

// Classic Brzycki percentage chart: pct(r) = (37 − r) / 36. Reads 100% at 1 rep.
function brzyckiPercent(reps: number): number {
  return reps >= 37 ? 0 : ((37 - reps) / 36) * 100;
}

export function computeOneRepMax(i: OneRepMaxInput): OneRepMaxResult {
  if (i.weight_kg <= 0) throw new Error("weight_kg must be > 0");
  if (!Number.isFinite(i.reps) || i.reps < 1) throw new Error("reps must be >= 1");
  if (i.reps > 20) {
    // Not an error — just unreliable. The note carries the caveat.
  }
  const formula = i.formula ?? "epley";
  const epleyKg = round1(epley(i.weight_kg, i.reps));
  const brzyckiKg = round1(brzycki(i.weight_kg, i.reps));
  const oneRm =
    formula === "epley"
      ? epleyKg
      : formula === "brzycki"
        ? brzyckiKg
        : round1((epleyKg + brzyckiKg) / 2);

  const rep_table: RepPercentRow[] = [];
  for (let r = 1; r <= 12; r++) {
    const pct = brzyckiPercent(r);
    rep_table.push({
      reps: r,
      percent_of_1rm: Math.round(pct),
      weight_kg: round1((oneRm * pct) / 100),
    });
  }

  const notes: string[] = [
    "Estimated 1RM — an extrapolation from a submaximal set, not a tested max. Most accurate at 1–5 reps; it drifts high past ~10 reps and past ~12 it's a rough guide only.",
    `Epley (${epleyKg} kg) and Brzycki (${brzyckiKg} kg) are shown side by side; they agree closely at low reps and diverge as reps climb.`,
    "The rep table uses the standard Brzycki %-of-1RM chart — treat the loads as starting points and adjust to how the bar actually moves.",
  ];
  if (i.reps > 12) {
    notes.push(
      `${i.reps} reps is a high-rep set — the 1RM estimate carries real uncertainty here; retest with a heavier set of 3–5 for a tighter number.`,
    );
  }
  return {
    one_rep_max_kg: oneRm,
    formula,
    epley_kg: epleyKg,
    brzycki_kg: brzyckiKg,
    inputs: { weight_kg: i.weight_kg, reps: i.reps },
    rep_table,
    notes,
  };
}

// =====================================================================
// 2. Strength standards (Beginner → Elite)
// =====================================================================

export type StrengthLevelName = "beginner" | "novice" | "intermediate" | "advanced" | "elite";

export const STRENGTH_LEVELS: StrengthLevelName[] = [
  "beginner",
  "novice",
  "intermediate",
  "advanced",
  "elite",
];

// StrengthLevel's definition: each level is the point you're "stronger than N%
// of lifters". These are the percentile anchors for the five level thresholds.
export const STRENGTH_LEVEL_PERCENTILE: Record<StrengthLevelName, number> = {
  beginner: 5,
  novice: 20,
  intermediate: 50,
  advanced: 80,
  elite: 95,
};

// ---- exercise lookup ----

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const BY_SLUG = new Map(STRENGTH_STANDARDS.map((e) => [e.slug, e]));
const BY_CATALOG = new Map<string, StrengthStandardEntry>();
const BY_NORMNAME = new Map<string, StrengthStandardEntry>();
for (const e of STRENGTH_STANDARDS) {
  if (e.catalog_id && !BY_CATALOG.has(e.catalog_id)) BY_CATALOG.set(e.catalog_id, e);
  const nk = normKey(e.name);
  if (!BY_NORMNAME.has(nk)) BY_NORMNAME.set(nk, e);
}

// Resolve a slug / catalog ExerciseId / display name to a standards entry.
export function findStrengthStandard(query: string): StrengthStandardEntry | null {
  if (!query) return null;
  const q = query.trim();
  return (
    BY_SLUG.get(q) ??
    BY_CATALOG.get(q) ??
    BY_SLUG.get(q.toLowerCase().replace(/[\s_]+/g, "-")) ??
    BY_NORMNAME.get(normKey(q)) ??
    null
  );
}

export type StrengthExerciseSummary = {
  slug: string;
  name: string;
  category: StrengthStandardEntry["category"];
  bodypart: string;
  metric: StrengthMetric;
  catalog_id: string | null;
};

// Light list for pickers / tool enums — no bulky standards rows.
export function listStrengthExercises(): StrengthExerciseSummary[] {
  return STRENGTH_STANDARDS.map(({ slug, name, category, bodypart, metric, catalog_id }) => ({
    slug,
    name,
    category,
    bodypart,
    metric,
    catalog_id,
  }));
}

// ---- interpolation helpers ----

// Piecewise-linear through (xs[i], ys[i]); linearly extrapolates past the ends
// using the nearest segment's slope. Guards zero-width segments.
function piecewise(x: number, xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 1) return ys[0];
  if (x <= xs[0]) {
    const dx = xs[1] - xs[0];
    return dx === 0 ? ys[0] : ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / dx;
  }
  for (let i = 0; i < n - 1; i++) {
    if (x <= xs[i + 1]) {
      const dx = xs[i + 1] - xs[i];
      return dx === 0 ? ys[i + 1] : ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / dx;
    }
  }
  const dx = xs[n - 1] - xs[n - 2];
  return dx === 0 ? ys[n - 1] : ys[n - 1] + ((ys[n - 1] - ys[n - 2]) * (x - xs[n - 1])) / dx;
}

// Age multiplier vs the 25–40 peak, interpolated from the StrengthLevel curve.
export function strengthAgeMultiplier(sex: Sex, age: number): number {
  const xs = STRENGTH_AGE_MULTIPLIERS.map((r) => r.age);
  const ys = STRENGTH_AGE_MULTIPLIERS.map((r) => (sex === "male" ? r.male : r.female));
  const a = clamp(age, xs[0], xs[xs.length - 1]);
  return piecewise(a, xs, ys);
}

// The five level thresholds for a lift at a given bodyweight (+ optional age),
// interpolated between the tabulated brackets.
function thresholdsAt(
  entry: StrengthStandardEntry,
  sex: Sex,
  bodyweightKg: number,
  age: number | null,
): [number, number, number, number, number] {
  const axis = sex === "male" ? MALE_BODYWEIGHTS_KG : FEMALE_BODYWEIGHTS_KG;
  const rows: StrengthLevelRow[] = sex === "male" ? entry.male : entry.female;
  const bw = clamp(bodyweightKg, axis[0], axis[axis.length - 1]);
  const ageMult = age != null ? strengthAgeMultiplier(sex, age) : 1;
  const out = [0, 0, 0, 0, 0] as [number, number, number, number, number];
  for (let lvl = 0; lvl < 5; lvl++) {
    const col = rows.map((r) => r[lvl]);
    out[lvl] = piecewise(bw, axis, col) * ageMult;
  }
  return out;
}

function levelFor(perf: number, thr: number[]): StrengthLevelName {
  if (perf >= thr[4]) return "elite";
  if (perf >= thr[3]) return "advanced";
  if (perf >= thr[2]) return "intermediate";
  if (perf >= thr[1]) return "novice";
  return "beginner";
}

// Percentile of a performance against the five thresholds, using the level
// anchors (5/20/50/80/95) with linear interp + gentle extrapolation on the tails.
function percentileFor(perf: number, thr: number[]): number {
  const anchors = [5, 20, 50, 80, 95];
  return clamp(Math.round(piecewise(perf, thr, anchors)), 1, 99);
}

export type StrengthLevelBand = {
  level: StrengthLevelName;
  percentile: number; // lower edge, i.e. "stronger than N%"
  min: number; // performance at the band's lower edge (kg or reps)
  max: number | null; // upper edge (= next band's min); null for elite
};

export type StrengthStandardsInput = {
  // slug ("bench-press"), catalog ExerciseId ("barbell_bench_press"), or name.
  exercise: string;
  sex: Sex;
  bodyweight_kg: number;
  // Provide the performance one of these ways:
  one_rep_max_kg?: number; // weight / bodyweight_load metrics (added kg, may be < 0)
  weight_kg?: number; // with `reps` → 1RM derived via Epley (weight metric)
  reps?: number; // reps metric → the rep count itself; else pairs with weight_kg
  age?: number; // optional age adjustment
};

export type StrengthStandardsResult = {
  exercise: {
    slug: string;
    name: string;
    category: StrengthStandardEntry["category"];
    bodypart: string;
    metric: StrengthMetric;
    catalog_id: string | null;
  };
  sex: Sex;
  bodyweight_kg: number;
  age: number | null;
  age_multiplier: number;
  metric: StrengthMetric;
  performance: number; // the assessed value (1RM kg, added kg, or reps)
  performance_unit: "kg" | "reps";
  bodyweight_ratio: number | null; // 1RM / bodyweight (weight metric only)
  level: StrengthLevelName;
  percentile: number; // 1–99
  thresholds: Record<StrengthLevelName, number>; // at this bodyweight + age
  reference_bands: StrengthLevelBand[];
  next_level: { level: StrengthLevelName; remaining: number } | null;
  notes: string[];
};

export function computeStrengthStandards(i: StrengthStandardsInput): StrengthStandardsResult {
  const entry = findStrengthStandard(i.exercise);
  if (!entry) {
    throw new Error(
      `no strength standards for "${i.exercise}". Pass a StrengthLevel slug (e.g. "bench-press"), a catalog exercise id, or the exact exercise name.`,
    );
  }
  if (i.bodyweight_kg <= 0) throw new Error("bodyweight_kg must be > 0");
  const age = i.age != null && Number.isFinite(i.age) ? i.age : null;
  if (age != null && (age < 10 || age > 100)) {
    throw new Error("age must be between 10 and 100");
  }

  // Resolve the performance value for the exercise's metric.
  const metric = entry.metric;
  let performance: number;
  let performance_unit: "kg" | "reps";
  if (metric === "reps") {
    performance_unit = "reps";
    if (i.reps == null || !Number.isFinite(i.reps)) {
      throw new Error(
        `${entry.name} is a reps-based exercise — pass reps (your best set), not weight.`,
      );
    }
    performance = i.reps;
  } else {
    performance_unit = "kg";
    if (i.one_rep_max_kg != null && Number.isFinite(i.one_rep_max_kg)) {
      performance = i.one_rep_max_kg;
    } else if (i.weight_kg != null && i.reps != null) {
      performance = round1(epley(i.weight_kg, i.reps));
    } else {
      throw new Error(
        metric === "bodyweight_load"
          ? `${entry.name} is scored by ADDED weight — pass one_rep_max_kg as the added kg (negative if assisted), or weight_kg + reps.`
          : `pass one_rep_max_kg, or weight_kg + reps to estimate it.`,
      );
    }
  }

  const thr = thresholdsAt(entry, i.sex, i.bodyweight_kg, age);
  const ageMult = age != null ? round1000(strengthAgeMultiplier(i.sex, age)) : 1;
  const level = levelFor(performance, thr);
  const percentile = percentileFor(performance, thr);

  const thresholds: Record<StrengthLevelName, number> = {
    beginner: round1(thr[0]),
    novice: round1(thr[1]),
    intermediate: round1(thr[2]),
    advanced: round1(thr[3]),
    elite: round1(thr[4]),
  };
  const reference_bands: StrengthLevelBand[] = STRENGTH_LEVELS.map((lvl, idx) => ({
    level: lvl,
    percentile: STRENGTH_LEVEL_PERCENTILE[lvl],
    min: round1(thr[idx]),
    max: idx < 4 ? round1(thr[idx + 1]) : null,
  }));

  // How much more to reach the next level up.
  let next_level: { level: StrengthLevelName; remaining: number } | null = null;
  const li = STRENGTH_LEVELS.indexOf(level);
  if (li < 4) {
    next_level = { level: STRENGTH_LEVELS[li + 1], remaining: round1(thr[li + 1] - performance) };
  }

  const notes: string[] = [
    `Levels are StrengthLevel population standards: Beginner = stronger than 5% of lifters, Novice 20%, Intermediate 50%, Advanced 80%, Elite 95%.`,
  ];
  if (metric === "weight") {
    notes.push(
      "Standards are compared against your one-rep max — a heavier set was converted to an estimated 1RM where needed.",
    );
  } else if (metric === "bodyweight_load") {
    notes.push(
      "This is a bodyweight movement: the standard is the ADDED weight on top of your bodyweight (negative means band/machine assistance).",
    );
  } else {
    notes.push("This is a bodyweight movement scored by max reps in a single set, not by load.");
  }
  if (age != null) {
    notes.push(
      ageMult >= 1
        ? "Ages 25–40 are the peak reference band — no age adjustment applied."
        : `Age adjustment applied (×${ageMult}): standards ease off after 40, matching StrengthLevel's age tables.`,
    );
  } else {
    notes.push(
      "No age given — standards use the 25–40 peak band. Pass age to adjust for masters lifters.",
    );
  }
  notes.push(
    "Population reference ranges, not a verdict — bodyweight, limb lengths and training age all move the number. Track the trend, not the single label.",
  );

  return {
    exercise: {
      slug: entry.slug,
      name: entry.name,
      category: entry.category,
      bodypart: entry.bodypart,
      metric,
      catalog_id: entry.catalog_id,
    },
    sex: i.sex,
    bodyweight_kg: i.bodyweight_kg,
    age,
    age_multiplier: ageMult,
    metric,
    performance: round1(performance),
    performance_unit,
    bodyweight_ratio: metric === "weight" ? round1000(performance / i.bodyweight_kg) : null,
    level,
    percentile,
    thresholds,
    reference_bands,
    next_level,
    notes,
  };
}

function round1000(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// =====================================================================
// 3. Powerlifting scores — Wilks (2020), DOTS, IPF GoodLift
// =====================================================================

// Each formula normalizes a total (or single lift) by bodyweight so lifters of
// different sizes can be compared. Coefficients are the published official sets.
type Poly = { A: number; B: number; C: number; D: number; E: number; F?: number };

// Classic Wilks (Robert Wilks, 2004) — the canonical "Wilks score". Coefficient
// ≈ 0.61 at 100 kg male (the universally-quoted value), which sits alongside
// DOTS rather than the rescaled 2020 "Wilks2" variant.
//   Wilks = 500 / (A + B·x + C·x² + D·x³ + E·x⁴ + F·x⁵) × total,  x = bodyweight
const WILKS: Record<Sex, Poly> = {
  male: {
    A: -216.0475144,
    B: 16.2606339,
    C: -0.002388645,
    D: -0.00113732,
    E: 7.01863e-6,
    F: -1.291e-8,
  },
  female: {
    A: 594.31747775582,
    B: -27.23842536447,
    C: 0.82112226871,
    D: -0.00930733913,
    E: 4.731582e-5,
    F: -9.054e-8,
  },
};

const DOTS: Record<Sex, Poly> = {
  male: { A: -307.75076, B: 24.0900756, C: -0.1918759221, D: 0.0007391293, E: -0.000001093 },
  female: { A: -57.96288, B: 13.6175032, C: -0.1126655495, D: 0.0005158568, E: -0.0000010706 },
};

// IPF GoodLift: 100 / (A − B·e^(−C·bw)) × total. Raw ("classic") vs equipped.
const IPF_GL: Record<"raw" | "equipped", Record<Sex, { A: number; B: number; C: number }>> = {
  raw: {
    male: { A: 1199.72839, B: 1025.18162, C: 0.00921 },
    female: { A: 610.32796, B: 1045.59282, C: 0.03048 },
  },
  equipped: {
    male: { A: 1236.25115, B: 1449.21864, C: 0.01644 },
    female: { A: 758.63878, B: 949.31382, C: 0.02435 },
  },
};

export function wilksScore(sex: Sex, bodyweightKg: number, totalKg: number): number {
  const c = WILKS[sex];
  const x = bodyweightKg;
  const denom = c.A + c.B * x + c.C * x ** 2 + c.D * x ** 3 + c.E * x ** 4 + (c.F ?? 0) * x ** 5;
  return round1((500 / denom) * totalKg);
}

export function dotsScore(sex: Sex, bodyweightKg: number, totalKg: number): number {
  const c = DOTS[sex];
  const x = bodyweightKg;
  const denom = c.A + c.B * x + c.C * x ** 2 + c.D * x ** 3 + c.E * x ** 4;
  return round1((500 / denom) * totalKg);
}

export function ipfGlScore(
  sex: Sex,
  bodyweightKg: number,
  totalKg: number,
  equipment: "raw" | "equipped" = "raw",
): number {
  const c = IPF_GL[equipment][sex];
  const denom = c.A - c.B * Math.exp(-c.C * bodyweightKg);
  return round1((100 / denom) * totalKg);
}

export type PowerliftingInput = {
  sex: Sex;
  bodyweight_kg: number;
  // Provide the three lifts (they're summed) OR a total directly.
  squat_kg?: number;
  bench_kg?: number;
  deadlift_kg?: number;
  total_kg?: number;
  equipment?: "raw" | "equipped";
};

export type PowerliftingResult = {
  sex: Sex;
  bodyweight_kg: number;
  total_kg: number;
  lifts: { squat_kg: number | null; bench_kg: number | null; deadlift_kg: number | null };
  equipment: "raw" | "equipped";
  wilks: number;
  dots: number;
  ipf_gl: number;
  notes: string[];
};

export function computePowerliftingScore(i: PowerliftingInput): PowerliftingResult {
  if (i.bodyweight_kg <= 0) throw new Error("bodyweight_kg must be > 0");
  const squat = i.squat_kg ?? null;
  const bench = i.bench_kg ?? null;
  const deadlift = i.deadlift_kg ?? null;
  const summed = (squat ?? 0) + (bench ?? 0) + (deadlift ?? 0);
  const total = i.total_kg != null ? i.total_kg : summed;
  if (!(total > 0)) {
    throw new Error("provide total_kg, or at least one of squat_kg / bench_kg / deadlift_kg.");
  }
  const equipment = i.equipment ?? "raw";
  const notes = [
    "Wilks (classic), DOTS and IPF GoodLift each normalize your total by bodyweight so lifters of different sizes compare fairly — they weight the bodyweight classes slightly differently, so the three scores won't match.",
    "IPF GoodLift is the current IPF standard; DOTS is popular in tested federations; Wilks is the long-standing classic (Wilks & DOTS sit on a similar scale). Higher is better; ~400+ Wilks/DOTS (men) is elite-adjacent.",
  ];
  if (i.total_kg != null && summed > 0 && Math.abs(summed - i.total_kg) > 0.5) {
    notes.push(
      `Using the total_kg you gave (${i.total_kg}); the three lifts summed to ${round1(summed)}.`,
    );
  }
  if (equipment === "equipped") {
    notes.push(
      "Using equipped IPF GL coefficients (supportive suit/shirt). Wilks & DOTS have no raw/equipped split.",
    );
  }
  return {
    sex: i.sex,
    bodyweight_kg: i.bodyweight_kg,
    total_kg: round1(total),
    lifts: { squat_kg: squat, bench_kg: bench, deadlift_kg: deadlift },
    equipment,
    wilks: wilksScore(i.sex, i.bodyweight_kg, total),
    dots: dotsScore(i.sex, i.bodyweight_kg, total),
    ipf_gl: ipfGlScore(i.sex, i.bodyweight_kg, total, equipment),
    notes,
  };
}

// =====================================================================
// 4a. Strength symmetry — how balanced a set of lifts is
// =====================================================================

export type SymmetryLiftInput = {
  exercise: string; // slug / catalog id / name
  one_rep_max_kg?: number;
  weight_kg?: number;
  reps?: number;
};

export type SymmetryLiftResult = {
  exercise: string;
  name: string;
  level: StrengthLevelName;
  percentile: number;
  performance: number;
  performance_unit: "kg" | "reps";
};

export type StrengthSymmetryInput = {
  sex: Sex;
  bodyweight_kg: number;
  age?: number;
  lifts: SymmetryLiftInput[];
};

export type StrengthSymmetryResult = {
  sex: Sex;
  bodyweight_kg: number;
  lifts: SymmetryLiftResult[];
  symmetry_pct: number; // 100 = perfectly balanced across lifts
  strongest: SymmetryLiftResult | null;
  weakest: SymmetryLiftResult | null;
  spread_percentile: number; // max − min percentile
  notes: string[];
};

// Rank each lift on its own standard, then measure how tightly the percentiles
// cluster. A big gap = a lagging lift. Symmetry% = 100 − percentile spread.
export function computeStrengthSymmetry(i: StrengthSymmetryInput): StrengthSymmetryResult {
  if (!i.lifts || i.lifts.length < 2) {
    throw new Error("strength symmetry needs at least two lifts to compare.");
  }
  const results: SymmetryLiftResult[] = i.lifts.map((l) => {
    const r = computeStrengthStandards({
      exercise: l.exercise,
      sex: i.sex,
      bodyweight_kg: i.bodyweight_kg,
      age: i.age,
      one_rep_max_kg: l.one_rep_max_kg,
      weight_kg: l.weight_kg,
      reps: l.reps,
    });
    return {
      exercise: r.exercise.slug,
      name: r.exercise.name,
      level: r.level,
      percentile: r.percentile,
      performance: r.performance,
      performance_unit: r.performance_unit,
    };
  });
  const byPct = [...results].sort((a, b) => a.percentile - b.percentile);
  const weakest = byPct[0];
  const strongest = byPct[byPct.length - 1];
  const spread = strongest.percentile - weakest.percentile;
  const symmetry_pct = clamp(Math.round(100 - spread), 0, 100);

  const notes: string[] = [
    "Each lift is ranked on its own StrengthLevel standard, then compared by percentile — so a strong bench and a lagging squat show up as an imbalance even though the kg differ.",
  ];
  if (spread <= 10) {
    notes.push("Your lifts are well balanced — no single movement is dragging.");
  } else {
    notes.push(
      `Your ${weakest.name} (${weakest.level}, ${weakest.percentile}th pct) lags your ${strongest.name} (${strongest.level}, ${strongest.percentile}th pct) by ${spread} percentile points — prioritize the lagging lift to even things out.`,
    );
  }
  return {
    sex: i.sex,
    bodyweight_kg: i.bodyweight_kg,
    lifts: results,
    symmetry_pct,
    strongest,
    weakest,
    spread_percentile: spread,
    notes,
  };
}

// =====================================================================
// 4b. Plate barbell racking — what to load per side
// =====================================================================

// Standard kg competition plates, heaviest first.
export const DEFAULT_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];
export const DEFAULT_PLATES_LB = [45, 35, 25, 10, 5, 2.5];

export type PlateRackingInput = {
  target_kg: number;
  bar_kg?: number; // default 20 (Olympic bar)
  available_plates_kg?: number[]; // denominations you have; each usable in pairs
};

export type PlateRackingResult = {
  target_kg: number;
  bar_kg: number;
  per_side: { plate_kg: number; count: number }[];
  loaded_kg: number; // bar + plates actually loaded
  exact: boolean;
  leftover_kg: number; // target − loaded (≥ 0)
  notes: string[];
};

// Greedy load per side. Plates come in pairs, so we solve for one side against
// half the (target − bar) load and mirror it. `unit` only labels the notes —
// the arithmetic is unit-agnostic, so a caller working in lb passes lb numbers.
export function computePlateRacking(
  i: PlateRackingInput,
  unit: "kg" | "lb" = "kg",
): PlateRackingResult {
  const bar = i.bar_kg ?? 20;
  if (i.target_kg <= 0) throw new Error("target_kg must be > 0");
  const plates = [...(i.available_plates_kg ?? DEFAULT_PLATES_KG)]
    .filter((p) => p > 0)
    .sort((a, b) => b - a);
  const notes: string[] = [];
  if (i.target_kg < bar) {
    return {
      target_kg: i.target_kg,
      bar_kg: bar,
      per_side: [],
      loaded_kg: bar,
      exact: i.target_kg === bar,
      leftover_kg: round1(i.target_kg - bar),
      notes: [
        `Target ${i.target_kg} ${unit} is at or below the empty bar (${bar} ${unit}) — nothing to load.`,
      ],
    };
  }
  let perSideRemaining = (i.target_kg - bar) / 2;
  const per_side: { plate_kg: number; count: number }[] = [];
  for (const p of plates) {
    if (perSideRemaining < p - 1e-9) continue;
    const count = Math.floor((perSideRemaining + 1e-9) / p);
    if (count > 0) {
      per_side.push({ plate_kg: p, count });
      perSideRemaining = round1000(perSideRemaining - count * p);
    }
  }
  const loaded = round1(bar + 2 * per_side.reduce((s, x) => s + x.plate_kg * x.count, 0));
  const leftover = round1(i.target_kg - loaded);
  const exact = Math.abs(leftover) < 1e-6;
  notes.push(
    exact
      ? `Load these plates on EACH side of the ${bar} ${unit} bar to hit ${i.target_kg} ${unit}.`
      : `Closest with the given plates is ${loaded} ${unit} (${leftover > 0 ? `${leftover} ${unit} short` : `${-leftover} ${unit} over`}). Add smaller plates/collars for an exact match.`,
  );
  return {
    target_kg: i.target_kg,
    bar_kg: bar,
    per_side,
    loaded_kg: loaded,
    exact,
    leftover_kg: leftover,
    notes,
  };
}
