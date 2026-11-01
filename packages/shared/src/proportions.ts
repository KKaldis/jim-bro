// Physique proportions: "ideal" girths from skeletal frame + body-shape
// classification from tape measurements. Pure functions shared by the agent
// tools (compute_ideal_proportions, classify_body_shape), the web calculators
// and their result cards.
//
// All inputs/outputs are centimetres. Any "ideal" here is a classical
// aesthetic convention, not a health or performance target — the notes the
// functions return say so, and the agent is told to pass them on.

import type { MuscleId } from "./workout-types.ts";
import { round1 } from "./food.ts";

const CM_PER_IN = 2.54;

// ============================================================================
// Ideal proportions
// ============================================================================

export type ProportionPart =
  "shoulders" | "chest" | "waist" | "hips" | "arm" | "forearm" | "neck" | "thigh" | "calf";

// Display/radar order: upper body clockwise from the top, then the legs.
export const PROPORTION_PARTS: readonly ProportionPart[] = [
  "shoulders",
  "chest",
  "arm",
  "forearm",
  "neck",
  "waist",
  "hips",
  "thigh",
  "calf",
];

export type IdealProportionsInput = {
  sex: "male" | "female";
  // Narrowest point of the wrist, just below the hand — the skeletal-frame
  // anchor every ideal is scaled from (it barely changes with training/fat).
  wrist_cm: number;
  height_cm?: number | null;
  // Whatever the user has measured; every part is optional. Arm = flexed.
  measurements: Partial<Record<ProportionPart, number | null>>;
};

// "ahead" is no longer produced (past the ideal is above_ideal for every part)
// but stays in the type for results already saved in chat history.
export type ProportionStatus = "lagging" | "close" | "on_target" | "ahead" | "above_ideal";

export type ProportionRow = {
  part: ProportionPart;
  ideal_cm: number;
  actual_cm: number | null;
  // actual / ideal × 100 — except the waist, where SMALLER is better, so it's
  // ideal / actual × 100, capped at 100 (a waist under the ideal is not a
  // surplus to celebrate). null when the part wasn't measured.
  pct_of_ideal: number | null;
  status: ProportionStatus | null;
  // Where this part's ideal comes from (shown as a footnote on the card).
  source: string;
  // The app's muscle ids that grow this girth — what to prioritise if lagging.
  muscles: MuscleId[];
};

export type ProportionPriority = {
  part: ProportionPart;
  pct_of_ideal: number;
  // "train" = build the muscles listed; "reduce_waist" = a nutrition lever.
  action: "train" | "reduce_waist";
  muscles: MuscleId[];
};

export type IdealProportionsResult = {
  sex: "male" | "female";
  method: "grecian_ideal" | "hourglass_frame";
  wrist_cm: number;
  rows: ProportionRow[];
  // Mean of the measured parts' pct_of_ideal, each capped at 100 — so an
  // overdeveloped part can't hide a lagging one. null with < 2 parts measured.
  proportion_score: number | null;
  priorities: ProportionPriority[];
  ratios: {
    shoulder_to_waist: number | null; // "Adonis index" — golden ratio ≈ 1.618
    chest_to_waist: number | null;
    waist_to_hip: number | null;
    waist_to_height: number | null; // < 0.5 is the common health guideline
  };
  notes: string[];
};

type PartRule = { ratio: number; base: "wrist" | "chest" | "waist" | "hips"; source: string };

// Men — classic "Grecian ideal" as summarised by GainFrame (chest 6.5× wrist,
// waist 70% of chest, arm/neck/calf 2.5× wrist), with John McCallum's chest
// percentages for the parts that summary leaves out (forearm 29%, thigh 53%,
// hips 85% of chest) and the golden ratio for shoulders (1.618× waist).
const MALE_RULES: Record<ProportionPart, PartRule> = {
  chest: { ratio: 6.5, base: "wrist", source: "6.5 × wrist (Grecian ideal)" },
  waist: { ratio: 0.7, base: "chest", source: "70% of ideal chest (Grecian ideal)" },
  arm: { ratio: 2.5, base: "wrist", source: "2.5 × wrist, flexed (Grecian ideal)" },
  neck: { ratio: 2.5, base: "wrist", source: "2.5 × wrist (Grecian ideal)" },
  calf: { ratio: 2.5, base: "wrist", source: "2.5 × wrist (Grecian ideal)" },
  forearm: { ratio: 0.29, base: "chest", source: "29% of ideal chest (McCallum)" },
  thigh: { ratio: 0.53, base: "chest", source: "53% of ideal chest (McCallum)" },
  hips: { ratio: 0.85, base: "chest", source: "85% of ideal chest (McCallum)" },
  shoulders: { ratio: 1.618, base: "waist", source: "1.618 × ideal waist (golden ratio)" },
};

// Women — there is no published wrist-based standard. This is the app's
// convention: the classic hourglass (bust = hips, waist 70% of hips — Singh's
// 0.70 waist-to-hip ratio) scaled to the wrist so a 15.2 cm (6") wrist gives
// ~36-25-36", golden-ratio shoulders, and limb targets set from typical lean,
// trained women at that frame.
const FEMALE_RULES: Record<ProportionPart, PartRule> = {
  chest: { ratio: 6.0, base: "wrist", source: "bust = hips (hourglass), 6.0 × wrist" },
  hips: { ratio: 6.0, base: "wrist", source: "6.0 × wrist (hourglass convention)" },
  waist: { ratio: 0.7, base: "hips", source: "70% of ideal hips (WHR 0.70, Singh)" },
  shoulders: { ratio: 1.618, base: "waist", source: "1.618 × ideal waist (golden ratio)" },
  arm: { ratio: 2.0, base: "wrist", source: "2.0 × wrist, flexed (app convention)" },
  forearm: { ratio: 1.6, base: "wrist", source: "1.6 × wrist (app convention)" },
  neck: { ratio: 2.1, base: "wrist", source: "2.1 × wrist (app convention)" },
  thigh: { ratio: 3.65, base: "wrist", source: "3.65 × wrist (app convention)" },
  calf: { ratio: 2.35, base: "wrist", source: "2.35 × wrist (app convention)" },
};

const PART_MUSCLES: Record<ProportionPart, MuscleId[]> = {
  shoulders: ["lateral_deltoid", "posterior_deltoid", "latissimus_dorsi"],
  chest: ["pectoralis_major_sternal", "pectoralis_major_clavicular"],
  arm: ["biceps_brachii", "triceps_brachii", "brachialis"],
  forearm: ["brachioradialis", "forearm_flexors", "forearm_extensors"],
  neck: ["trapezius"],
  waist: [],
  hips: ["gluteus_maximus", "gluteus_medius"],
  thigh: ["vastus_lateralis", "vastus_medialis", "rectus_femoris", "biceps_femoris"],
  calf: ["gastrocnemius", "soleus"],
};

function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  return a != null && b != null && a > 0 && b > 0 ? Math.round((a / b) * 1000) / 1000 : null;
}

export function idealGirths(
  sex: "male" | "female",
  wrist_cm: number,
): Record<ProportionPart, number> {
  const rules = sex === "female" ? FEMALE_RULES : MALE_RULES;
  const out = {} as Record<ProportionPart, number>;
  // Resolve in dependency order: wrist-based parts, then chest/hips-based,
  // then waist-based (shoulders).
  const resolve = (part: ProportionPart): number => {
    if (out[part] != null) return out[part];
    const r = rules[part];
    const base = r.base === "wrist" ? wrist_cm : resolve(r.base === "chest" ? "chest" : r.base);
    out[part] = base * r.ratio;
    return out[part];
  };
  for (const p of PROPORTION_PARTS) resolve(p);
  return out;
}

function statusOf(part: ProportionPart, pct: number): ProportionStatus {
  if (part === "waist") return pct < 95 ? "above_ideal" : "on_target";
  if (pct < 90) return "lagging";
  if (pct < 97) return "close";
  if (pct <= 105) return "on_target";
  // The ideal is a target, not a floor: past it the proportions are off the
  // other way (and for hips it's mostly fat).
  return "above_ideal";
}

// A part's contribution to the proportion score, out of 100. Missing the
// ideal costs the same either way: over it scores ideal / actual. The waist's
// pct is already ideal / actual capped at 100.
function scoreOf(r: ProportionRow): number {
  const pct = r.pct_of_ideal!;
  return pct > 100 ? 10_000 / pct : pct;
}

export function computeIdealProportions(i: IdealProportionsInput): IdealProportionsResult {
  if (!(i.wrist_cm > 0)) throw new Error("wrist_cm must be > 0");
  if (i.wrist_cm < 11 || i.wrist_cm > 25) {
    throw new Error(
      `wrist_cm ${i.wrist_cm} is outside the plausible 11–25 cm range — measure at the narrowest point just below the hand`,
    );
  }
  const rules = i.sex === "female" ? FEMALE_RULES : MALE_RULES;
  const ideals = idealGirths(i.sex, i.wrist_cm);
  const m = i.measurements;

  const rows: ProportionRow[] = PROPORTION_PARTS.map((part) => {
    const ideal = ideals[part];
    const raw = m[part];
    const actual = raw != null && raw > 0 ? raw : null;
    let pct: number | null = null;
    if (actual != null) {
      pct = part === "waist" ? Math.min(100, (ideal / actual) * 100) : (actual / ideal) * 100;
      pct = Math.round(pct);
    }
    return {
      part,
      ideal_cm: round1(ideal),
      actual_cm: actual != null ? round1(actual) : null,
      pct_of_ideal: pct,
      status: pct != null ? statusOf(part, pct) : null,
      source: rules[part].source,
      muscles: PART_MUSCLES[part],
    };
  });

  const measured = rows.filter((r) => r.pct_of_ideal != null);
  const proportion_score =
    measured.length >= 2
      ? Math.round(measured.reduce((s, r) => s + scoreOf(r), 0) / measured.length)
      : null;

  // Priorities: the waist first when it's well over the ideal (fat loss moves
  // every ratio at once), then the most-lagging muscle girths.
  const priorities: ProportionPriority[] = [];
  const waist = rows.find((r) => r.part === "waist");
  if (waist?.status === "above_ideal") {
    priorities.push({
      part: "waist",
      pct_of_ideal: waist.pct_of_ideal!,
      action: "reduce_waist",
      muscles: [],
    });
  }
  measured
    .filter((r) => r.part !== "waist" && r.pct_of_ideal! < 97)
    .sort((a, b) => a.pct_of_ideal! - b.pct_of_ideal!)
    .slice(0, 3)
    .forEach((r) =>
      priorities.push({
        part: r.part,
        pct_of_ideal: r.pct_of_ideal!,
        action: "train",
        muscles: r.muscles,
      }),
    );

  const notes: string[] = [
    i.sex === "female"
      ? "There is no published wrist-based ideal for women: this uses the classic hourglass (bust = hips, waist-to-hip 0.70) scaled to the wrist, with limb targets set from typical lean, trained women. It is an aesthetic convention, not a health target."
      : "Classic 'Grecian ideal' proportions (chest 6.5× wrist, waist 70% of chest, arm/neck/calf 2.5× wrist), plus McCallum's ratios for forearm/thigh/hips and the golden ratio for shoulders. An aesthetic reference that suits a lean, trained physique, not a health target.",
    "Measure the arm flexed at the peak, the waist at its narrowest point, hips and thighs at the widest, neck below the Adam's apple. Use the same tape and time of day each time, and remeasure every 8–12 weeks.",
  ];
  if (measured.length < 3) {
    notes.push("Add more measurements to see your proportion profile — at least 3 parts.");
  }
  if (waist?.status === "above_ideal") {
    notes.push(
      "The waist is the biggest lever: losing fat narrows it and lifts the shoulder-to-waist and chest-to-waist ratios at the same time.",
    );
  }

  return {
    sex: i.sex,
    method: i.sex === "female" ? "hourglass_frame" : "grecian_ideal",
    wrist_cm: round1(i.wrist_cm),
    rows,
    proportion_score,
    priorities,
    ratios: {
      shoulder_to_waist: ratio(m.shoulders, m.waist),
      chest_to_waist: ratio(m.chest, m.waist),
      waist_to_hip: ratio(m.waist, m.hips),
      waist_to_height: ratio(m.waist, i.height_cm),
    },
    notes,
  };
}

// ============================================================================
// Body shape
// ============================================================================

export type FemaleBodyShape =
  | "hourglass"
  | "bottom_hourglass"
  | "top_hourglass"
  | "spoon"
  | "triangle"
  | "inverted_triangle"
  | "rectangle";
export type MaleBodyShape = "v_taper" | "trapezoid" | "rectangle" | "triangle" | "oval";
export type BodyShape = FemaleBodyShape | MaleBodyShape | "unclassified";

export type BodyShapeInput = {
  sex: "male" | "female";
  waist_cm: number;
  hips_cm: number;
  // Women: bust over the fullest part. Men: chest at nipple level.
  bust_cm?: number | null;
  chest_cm?: number | null;
  // Women only: ~18 cm (7") below the natural waist. Separates spoon from
  // bottom hourglass; optional.
  high_hip_cm?: number | null;
  // Men only, optional: shoulder circumference around the deltoids. When
  // given it drives the taper (the classic Adonis index) instead of the chest.
  shoulders_cm?: number | null;
};

export type BodyShapeResult = {
  sex: "male" | "female";
  shape: BodyShape;
  // The other shapes whose rule also matched (rule order decides `shape`).
  also_matches: BodyShape[];
  waist_to_hip: number;
  // WHO: ≥ 0.85 (women) / ≥ 0.90 (men) = substantially increased risk.
  whr_risk: "low" | "moderate" | "high";
  taper_ratio: number | null; // men: shoulders (or chest) ÷ waist
  taper_basis: "shoulders" | "chest" | null;
  inputs: BodyShapeInput;
  notes: string[];
};

// FFIT for Apparel rules (Simmons, Istook & Devarajan 2004), as published by
// calculator.net's body-type calculator. Thresholds are in INCHES and the
// order matters — the first rule that matches wins.
function femaleShapes(
  bust: number,
  waist: number,
  hips: number,
  highHip: number | null,
): FemaleBodyShape[] {
  const b = bust / CM_PER_IN;
  const w = waist / CM_PER_IN;
  const h = hips / CM_PER_IN;
  const hh = highHip != null ? highHip / CM_PER_IN : null;
  const hhw = hh != null ? hh / w : null;
  const out: FemaleBodyShape[] = [];
  if (b - h <= 1 && h - b < 3.6 && (b - w >= 9 || h - w >= 10)) out.push("hourglass");
  if (h - b >= 3.6 && h - b < 10 && h - w >= 9 && (hhw == null || hhw < 1.193)) {
    out.push("bottom_hourglass");
  }
  if (b - h > 1 && b - h < 10 && b - w >= 9) out.push("top_hourglass");
  if (hhw != null && h - b > 2 && h - w >= 7 && hhw >= 1.193) out.push("spoon");
  if (h - b >= 3.6 && h - w < 9) out.push("triangle");
  if (b - h >= 3.6 && b - w < 9) out.push("inverted_triangle");
  if (h - b < 3.6 && b - h < 3.6 && b - w < 9 && h - w < 10) out.push("rectangle");
  return out;
}

// Men, primary: Alfrik's male body-shape calculator rules (chest / waist /
// hips, thresholds in INCHES, first match wins). "Inverted triangle" is our
// v_taper. One deliberate deviation: Alfrik checks oval LAST, so a waist
// bigger than both chest and hips still reads "rectangle" (its rectangle rule
// only bounds chest−waist from above). We check oval first.
function alfrikMaleShapes(chest: number, waist: number, hips: number): MaleBodyShape[] {
  const c = chest / CM_PER_IN;
  const w = waist / CM_PER_IN;
  const h = hips / CM_PER_IN;
  const out: MaleBodyShape[] = [];
  if (w > c && w > h) out.push("oval");
  if (Math.abs(c - h) <= 2 && c - w >= 5 && h - w >= 5) out.push("trapezoid");
  if (h - c >= 2 && w - c < 7) out.push("triangle");
  if (Math.abs(c - h) < 2 && c - w < 7 && h - w < 5) out.push("rectangle");
  if (c - h >= 4 && c - w >= 5) out.push("v_taper");
  return out;
}

// Men, fallback: those rules leave gaps (e.g. chest 2–4" over the hips with a
// modest taper — a common build), so when none match we fall back to the
// app's taper bands. Average adult men sit around chest/waist ≈ 1.13 and
// shoulders/waist ≈ 1.28 (ANSUR II) → "rectangle".
const MALE_TAPER = {
  shoulders: { v: 1.55, trapezoid: 1.4 },
  chest: { v: 1.3, trapezoid: 1.15 },
};

function taperShape(basis: "shoulders" | "chest", taper: number, waist: number, hips: number) {
  if (waist >= hips && taper < MALE_TAPER[basis].trapezoid) return "oval" as const;
  const t = MALE_TAPER[basis];
  return taper >= t.v
    ? ("v_taper" as const)
    : taper >= t.trapezoid
      ? ("trapezoid" as const)
      : ("rectangle" as const);
}

export function classifyBodyShape(i: BodyShapeInput): BodyShapeResult {
  const pos = (v: number | null | undefined) => (v != null && v > 0 ? v : null);
  const waist = pos(i.waist_cm);
  const hips = pos(i.hips_cm);
  if (waist == null || hips == null) throw new Error("waist_cm and hips_cm must be > 0");
  const whr = Math.round((waist / hips) * 100) / 100;
  const [modCut, highCut] = i.sex === "female" ? [0.8, 0.85] : [0.95, 0.9];
  // WHO's single cut-off is "high"; the band just below it is "moderate"
  // (NIDDK flags women from 0.80; men get a 0.05 band for symmetry).
  const whr_risk =
    whr >= highCut ? "high" : whr >= Math.min(modCut, highCut - 0.05) ? "moderate" : "low";
  const notes: string[] = [];

  let shapes: BodyShape[];
  let taper: number | null = null;
  let basis: "shoulders" | "chest" | null = null;
  if (i.sex === "female") {
    const bust = pos(i.bust_cm);
    if (bust == null) throw new Error("bust_cm is required for women");
    const highHip = pos(i.high_hip_cm);
    shapes = femaleShapes(bust, waist, hips, highHip);
    if (highHip == null) {
      notes.push(
        "Without a high-hip measurement (~18 cm below the waist) spoon can't be told apart from bottom hourglass.",
      );
    }
    notes.push(
      "Shape rules from the FFIT apparel-fit system (as used by calculator.net's body-type calculator). A clothing-fit category, not a health measure.",
    );
  } else {
    const chest = pos(i.chest_cm);
    const shoulders = pos(i.shoulders_cm);
    if (chest == null && shoulders == null) {
      throw new Error("chest_cm or shoulders_cm is required for men");
    }
    basis = shoulders != null ? "shoulders" : "chest";
    taper = Math.round(((shoulders ?? chest!) / waist) * 100) / 100;
    shapes = chest != null ? alfrikMaleShapes(chest, waist, hips) : [];
    if (shapes.length === 0) {
      shapes = [taperShape(basis, taper, waist, hips)];
      notes.push(
        chest == null
          ? "Shape from the shoulder-to-waist taper (add a chest measurement for the standard chest/waist/hips rules)."
          : "Your measurements fall between the standard chest/waist/hips rules, so the shape comes from the taper ratio instead.",
      );
    } else {
      notes.push("Shape rules from Alfrik's male body-shape calculator (chest, waist, hips).");
    }
    notes.push(
      basis === "shoulders"
        ? "Taper = shoulders ÷ waist (Adonis index; the golden-ratio ideal is 1.618)."
        : "Taper = chest ÷ waist. Add a shoulder measurement for the classic Adonis index.",
    );
  }
  if (whr_risk !== "low") {
    notes.push(
      `Waist-to-hip ${whr} is ${whr_risk === "high" ? "at or above" : "near"} the WHO risk cut-off (${highCut} for ${i.sex === "female" ? "women" : "men"}) — fat around the midsection matters for health regardless of shape.`,
    );
  }

  return {
    sex: i.sex,
    shape: shapes[0] ?? "unclassified",
    also_matches: shapes.slice(1),
    waist_to_hip: whr,
    whr_risk,
    taper_ratio: taper,
    taper_basis: basis,
    inputs: i,
    notes,
  };
}
