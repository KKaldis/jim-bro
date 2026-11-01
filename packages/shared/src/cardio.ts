import type { Sex } from "./types.ts";

// VO₂max — the volume of oxygen (ml) the body can use per kg of bodyweight per
// minute at maximal effort. It's the single best lab measure of aerobic
// (cardio) fitness. A treadmill/bike test is the gold standard, but a good
// no-effort estimate comes from the resting/max heart-rate ratio:
//
//   Uth–Sørensen–Overgaard–Pedersen (2004):
//     VO₂max ≈ 15.3 × (HRmax / HRrest)        [ml·kg⁻¹·min⁻¹]
//
// HRmax, if not measured, is estimated with Tanaka (2001), which tracks the
// general population better than the old "220 − age":
//
//     HRmax ≈ 208 − 0.7 × age
//
// The estimate is only as good as a true RESTING heart rate (measured seated /
// lying after a few minutes of quiet) and is least accurate at the extremes —
// it's a tracking number, not a diagnosis.

export type Vo2MaxCategory = "poor" | "fair" | "good" | "excellent" | "superior";

export type Vo2MaxInput = {
  age: number;
  sex: Sex;
  resting_heart_rate: number;
  // Optional measured/known max HR (bpm). Omitted → Tanaka estimate from age.
  max_heart_rate?: number | null;
};

export type Vo2MaxResult = {
  vo2_max: number; // ml·kg⁻¹·min⁻¹, rounded to 0.1
  max_heart_rate: number; // the HRmax actually used (bpm)
  max_heart_rate_estimated: boolean; // true when derived from age (Tanaka)
  resting_heart_rate: number;
  category: Vo2MaxCategory;
  inputs: Vo2MaxInput;
  notes: string[];
};

// Lower-bound VO₂max thresholds (ml·kg⁻¹·min⁻¹) for fair / good / excellent /
// superior, by sex and age bracket. Below the "fair" bound is "poor". Values
// follow commonly published Cooper Institute / ACSM-style population norms —
// reference ranges, not clinical cutoffs.
type Bands = { fair: number; good: number; excellent: number; superior: number };

const MALE_BANDS: Array<{ maxAge: number; bands: Bands }> = [
  { maxAge: 29, bands: { fair: 42, good: 46, excellent: 51, superior: 56 } },
  { maxAge: 39, bands: { fair: 41, good: 44, excellent: 49, superior: 53 } },
  { maxAge: 49, bands: { fair: 38, good: 42, excellent: 45, superior: 49 } },
  { maxAge: 59, bands: { fair: 35, good: 38, excellent: 42, superior: 45 } },
  { maxAge: 200, bands: { fair: 31, good: 35, excellent: 38, superior: 42 } },
];

const FEMALE_BANDS: Array<{ maxAge: number; bands: Bands }> = [
  { maxAge: 29, bands: { fair: 36, good: 39, excellent: 44, superior: 49 } },
  { maxAge: 39, bands: { fair: 34, good: 37, excellent: 41, superior: 45 } },
  { maxAge: 49, bands: { fair: 32, good: 35, excellent: 38, superior: 42 } },
  { maxAge: 59, bands: { fair: 29, good: 32, excellent: 36, superior: 40 } },
  { maxAge: 200, bands: { fair: 27, good: 30, excellent: 33, superior: 37 } },
];

function bandsFor(sex: Sex, age: number): Bands {
  const table = sex === "male" ? MALE_BANDS : FEMALE_BANDS;
  return (table.find((row) => age <= row.maxAge) ?? table[table.length - 1]).bands;
}

export const VO2_MAX_CATEGORIES: Vo2MaxCategory[] = [
  "poor",
  "fair",
  "good",
  "excellent",
  "superior",
];

export type Vo2MaxReferenceBand = {
  category: Vo2MaxCategory;
  min: number; // inclusive lower bound (ml·kg⁻¹·min⁻¹)
  max: number | null; // exclusive upper bound; null = open-ended (superior)
};

// The five VO₂max category bands for a given sex + age, low→high. Lets the UI
// draw a reference scale and place the user's estimate on it.
export function vo2MaxReference(sex: Sex, age: number): Vo2MaxReferenceBand[] {
  const b = bandsFor(sex, age);
  return [
    { category: "poor", min: 0, max: b.fair },
    { category: "fair", min: b.fair, max: b.good },
    { category: "good", min: b.good, max: b.excellent },
    { category: "excellent", min: b.excellent, max: b.superior },
    { category: "superior", min: b.superior, max: null },
  ];
}

function vo2Category(vo2: number, bands: Bands): Vo2MaxCategory {
  if (vo2 >= bands.superior) return "superior";
  if (vo2 >= bands.excellent) return "excellent";
  if (vo2 >= bands.good) return "good";
  if (vo2 >= bands.fair) return "fair";
  return "poor";
}

// Tanaka (2001) age-predicted max heart rate, bpm.
export function tanakaMaxHr(age: number): number {
  return Math.round(208 - 0.7 * age);
}

export function computeVo2Max(i: Vo2MaxInput): Vo2MaxResult {
  if (i.age <= 0 || i.age > 120) {
    throw new Error("age must be between 1 and 120");
  }
  if (i.resting_heart_rate <= 0) {
    throw new Error("resting_heart_rate must be > 0");
  }
  if (i.resting_heart_rate < 30 || i.resting_heart_rate > 120) {
    throw new Error(
      `resting_heart_rate ${i.resting_heart_rate} bpm is outside the plausible 30-120 range — re-check the reading (measure seated/lying after a few minutes of rest)`,
    );
  }

  const estimated = i.max_heart_rate == null;
  const hrMax = estimated ? tanakaMaxHr(i.age) : (i.max_heart_rate as number);
  if (hrMax <= i.resting_heart_rate) {
    throw new Error(
      `max_heart_rate (${hrMax}) must exceed resting_heart_rate (${i.resting_heart_rate})`,
    );
  }

  const vo2 = 15.3 * (hrMax / i.resting_heart_rate);
  const bands = bandsFor(i.sex, i.age);

  const notes: string[] = [
    "Estimated from the resting/max heart-rate ratio (Uth 2004) — a no-effort proxy. A graded treadmill or bike test measures VO₂max directly and more accurately.",
    "Accuracy hinges on a true resting heart rate: measure it seated or lying down after a few minutes of quiet, ideally first thing in the morning.",
  ];
  if (estimated) {
    notes.push(
      `Max heart rate estimated as ${hrMax} bpm (Tanaka: 208 − 0.7 × age). Provide a measured HRmax for a tighter estimate.`,
    );
  }
  notes.push(
    "Category boundaries are population reference ranges by age and sex (Cooper/ACSM-style), not clinical cutoffs — use the trend over time more than the single label.",
  );

  return {
    vo2_max: Math.round(vo2 * 10) / 10,
    max_heart_rate: hrMax,
    max_heart_rate_estimated: estimated,
    resting_heart_rate: i.resting_heart_rate,
    category: vo2Category(vo2, bands),
    inputs: i,
    notes,
  };
}

// Five training zones as percentages of max heart rate, the scheme most
// watches use. With a resting heart rate they switch to Karvonen, which takes
// the percentages of heart-rate reserve (max − resting) and adds resting back,
// so a fit person with a low resting rate gets zones that sit where they feel.
export const HR_ZONES = [
  { zone: 1, name: "Recovery", low: 0.5, high: 0.6 },
  { zone: 2, name: "Aerobic base", low: 0.6, high: 0.7 },
  { zone: 3, name: "Tempo", low: 0.7, high: 0.8 },
  { zone: 4, name: "Threshold", low: 0.8, high: 0.9 },
  { zone: 5, name: "VO₂max", low: 0.9, high: 1.0 },
] as const;

export type HeartRateZonesInput = {
  age: number;
  resting_heart_rate?: number | null;
  max_heart_rate?: number | null;
};

export type HeartRateZone = {
  zone: number;
  name: string;
  low_pct: number;
  high_pct: number;
  low_bpm: number;
  high_bpm: number;
};

export type HeartRateZonesResult = {
  max_heart_rate: number;
  max_heart_rate_estimated: boolean;
  resting_heart_rate: number | null;
  method: "percent_max" | "karvonen";
  zones: HeartRateZone[];
  inputs: HeartRateZonesInput;
  notes: string[];
};

export function computeHeartRateZones(i: HeartRateZonesInput): HeartRateZonesResult {
  if (i.age <= 0 || i.age > 120) throw new Error("age must be between 1 and 120");
  const estimated = i.max_heart_rate == null;
  const hrMax = estimated ? tanakaMaxHr(i.age) : (i.max_heart_rate as number);
  const rest = i.resting_heart_rate ?? null;
  if (rest != null && (rest < 30 || rest > 120)) {
    throw new Error(`resting_heart_rate ${rest} bpm is outside the plausible 30-120 range`);
  }
  if (rest != null && hrMax <= rest) {
    throw new Error(`max_heart_rate (${hrMax}) must exceed resting_heart_rate (${rest})`);
  }

  const at = (pct: number) => Math.round(rest != null ? rest + pct * (hrMax - rest) : pct * hrMax);
  const zones = HR_ZONES.map((z) => ({
    zone: z.zone,
    name: z.name,
    low_pct: Math.round(z.low * 100),
    high_pct: Math.round(z.high * 100),
    low_bpm: at(z.low),
    high_bpm: at(z.high),
  }));

  const notes: string[] = [
    rest != null
      ? "Karvonen method: each zone is a percentage of heart-rate reserve (max − resting), plus resting."
      : "Percentages of max heart rate. Add a resting heart rate to switch to Karvonen, which fits fitter people better.",
  ];
  if (estimated) {
    notes.push(
      `Max heart rate estimated as ${hrMax} bpm (Tanaka: 208 − 0.7 × age). Individual max varies by ±10 bpm, so a measured max shifts every zone.`,
    );
  }

  return {
    max_heart_rate: hrMax,
    max_heart_rate_estimated: estimated,
    resting_heart_rate: rest,
    method: rest != null ? "karvonen" : "percent_max",
    zones,
    inputs: i,
    notes,
  };
}
