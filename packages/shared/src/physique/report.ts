// Widths → girths, ratios, body shape, somatotype and training priorities,
// ported from the original Python prototype.
//
// Every threshold is a first guess (ANSUR II means + physique-coaching
// convention), NOT calibrated against real users yet. Muscle ids match
// packages/shared/src/data/muscle-groups.ts.

import { estimateBodyFatNavy } from "../bmr.ts";
import { largestComponent, verticalExtent, type Mask, type Point } from "./mask.ts";
import { measureFront, type FrontMeasurements, type Landmarks } from "./measure.ts";

type Sex = "male" | "female";
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/* ------------------------------------------------------------- girths -- */

// Cross-sections are modelled as ellipses: front width × depth. With no side
// photo the depth comes from rough ANSUR II depth/width means — fine for
// tracking change, not for absolute numbers.
const DEPTH_RATIO: Record<string, number> = {
  neck: 0.95,
  chest: 0.76,
  waist: 0.78,
  hips: 0.72,
  upper_arm: 0.95,
  forearm: 0.8,
  wrist: 0.7,
  thigh: 0.95,
  calf: 0.9,
  ankle: 0.85,
};
// Torso sections are rounded rectangles; an ellipse under-reads them.
const SHAPE_CORRECTION: Record<string, number> = { chest: 1.04, waist: 1.02, hips: 1.04 };

/** Ramanujan's approximation, full axes width × depth. */
export function ellipsePerimeter(width: number, depth: number): number {
  const a = width / 2;
  const b = depth / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Width of a part: the torso key itself, else the mean of its left/right. */
function widthOf(widths: Record<string, number>, part: string): number | null {
  if (widths[part]) return widths[part];
  const sides = [widths[`${part}_left`], widths[`${part}_right`]].filter((x): x is number => !!x);
  return sides.length ? sides.reduce((s, x) => s + x, 0) / sides.length : null;
}

export function girthsFromWidths(widths: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [part, ratio] of Object.entries(DEPTH_RATIO)) {
    const w = widthOf(widths, part);
    if (!w) continue;
    out[part] = round1(ellipsePerimeter(w, w * ratio) * (SHAPE_CORRECTION[part] ?? 1));
  }
  return out;
}

/** Left vs right width difference, % of the larger side (+ = left bigger). */
export function asymmetry(widths: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of ["upper_arm", "forearm", "thigh", "calf"]) {
    const l = widths[`${part}_left`];
    const r = widths[`${part}_right`];
    if (l && r) out[part] = round1((100 * (l - r)) / Math.max(l, r));
  }
  return out;
}

/* -------------------------------------------------------------- shape -- */

export type PhysiqueShape =
  | "v_taper"
  | "square"
  | "diamond"
  | "triangle"
  | "hourglass"
  | "pear"
  | "apple"
  | "inverted_triangle"
  | "rectangle"
  | "unknown";
export type GoalShape = "v_taper" | "square" | "hourglass";

export type Ratios = Partial<
  Record<"shoulders/waist" | "chest/waist" | "shoulders/hips" | "waist/hips", number>
>;

export function frontRatios(w: Record<string, number>): Ratios {
  const r: Ratios = {};
  const { shoulders: s, chest: c, waist: wa, hips: h } = w;
  if (s && wa) r["shoulders/waist"] = round3(s / wa);
  if (c && wa) r["chest/waist"] = round3(c / wa);
  if (s && h) r["shoulders/hips"] = round3(s / h);
  if (wa && h) r["waist/hips"] = round3(wa / h);
  return r;
}

export function classifyShape(r: Ratios, sex: Sex): PhysiqueShape {
  const sw = r["shoulders/waist"];
  const sh = r["shoulders/hips"];
  const wh = r["waist/hips"];
  if (sex === "male" && sw != null && (sh == null || wh == null)) {
    // Hips out of frame: shoulders:waist is still the V-taper signal, but
    // triangle can't be told from square.
    if (sw >= 1.75) return "v_taper";
    return sw < 1.35 ? "diamond" : "square";
  }
  if (sw == null || sh == null || wh == null) return "unknown";
  if (sex === "female") {
    if (wh >= 0.85) return "apple";
    if (wh <= 0.75 && sh >= 1.05 && sh <= 1.25) return "hourglass";
    if (sh < 1.05) return "pear";
    if (sh > 1.25) return "inverted_triangle";
    return "rectangle";
  }
  if (wh >= 0.95 && sw < 1.45) return "diamond"; // waist is (one of) the widest points
  if (sh < 1.15) return "triangle";
  if (sw >= 1.75 && sh >= 1.35) return "v_taper";
  return "square";
}

// Casey Butt (2008) max-girth ratios — same constants as bmr.ts.
const CB_RATIOS: Record<string, ["wrist" | "ankle", number]> = {
  chest: ["wrist", 6.5],
  upper_arm: ["wrist", 1.96], // flexed; we compare relaxed + bump
  forearm: ["wrist", 1.16],
  neck: ["wrist", 2.5],
  thigh: ["ankle", 4.65],
  calf: ["ankle", 1.92],
};
const FEMALE_CB_SCALAR = 0.85;
const FLEX_BUMP_CM = 2;

const PART_MUSCLES: Record<string, string[]> = {
  chest: ["pectoralis_major_sternal", "pectoralis_major_clavicular"],
  upper_arm: ["triceps_brachii", "biceps_brachii", "brachialis"],
  forearm: ["brachioradialis", "forearm_flexors", "forearm_extensors"],
  neck: ["trapezius"],
  thigh: ["vastus_lateralis", "vastus_medialis", "rectus_femoris", "biceps_femoris"],
  calf: ["gastrocnemius", "soleus"],
};

// Lean enough that a wide waist is structure/obliques rather than fat.
const LEAN_BF: Record<Sex, number> = { male: 15, female: 25 };

const SHAPE_TARGETS: Record<GoalShape, Partial<Record<keyof Ratios, number>>> = {
  v_taper: { "shoulders/waist": 1.75, "shoulders/hips": 1.4 },
  square: { "shoulders/waist": 1.55, "shoulders/hips": 1.3 },
  hourglass: { "waist/hips": 0.7, "shoulders/hips": 1.15 },
};
const DEFAULT_GOAL: Record<Sex, GoalShape> = { male: "v_taper", female: "hourglass" };

export type PhysiquePriority = {
  /** Muscle id, a "<part>_<side>" balance target, or "reduce_waist_fat". */
  target: string;
  kind: "muscle" | "nutrition" | "balance";
  /** Higher = more urgent. */
  score: number;
  reason: string;
};

function priorities(
  sex: Sex,
  r: Ratios,
  goal: GoalShape,
  girths: Record<string, number>,
  asym: Record<string, number>,
  bfPct: number | null,
  wristCm: number | null,
  ankleCm: number | null,
): { priorities: PhysiquePriority[]; development: Record<string, number>; notes: string[] } {
  const out: PhysiquePriority[] = [];
  const notes: string[] = [];
  const lean = bfPct != null && bfPct <= LEAN_BF[sex];
  const target = SHAPE_TARGETS[goal];

  // 1. Shape gap.
  const swTarget = target["shoulders/waist"];
  const sw = r["shoulders/waist"];
  if (swTarget != null && sw != null && swTarget - sw > 0) {
    const gap = swTarget - sw;
    if (bfPct != null && !lean) {
      out.push({
        target: "reduce_waist_fat",
        kind: "nutrition",
        score: 3 + gap * 10,
        reason: `Shoulder:waist is ${sw.toFixed(2)} vs ${swTarget.toFixed(2)} for a ${goal.replace("_", " ")}. At ${Math.round(bfPct)}% body fat the waist is the faster lever — a cut narrows the waist more than training widens the shoulders.`,
      });
    }
    out.push({
      target: "lateral_deltoid",
      kind: "muscle",
      score: 2 + gap * 10,
      reason: "Side delts add the most width per cm of muscle — the main V-taper driver.",
    });
    out.push({
      target: "latissimus_dorsi",
      kind: "muscle",
      score: 1.5 + gap * 8,
      reason: "Lat width widens the upper torso and visually narrows the waist.",
    });
    if (lean)
      notes.push("Waist is already lean, so avoid heavy weighted oblique work that thickens it.");
  }

  const whTarget = target["waist/hips"];
  const wh = r["waist/hips"];
  if (whTarget != null && wh != null && wh > whTarget) {
    const gap = wh - whTarget;
    if (bfPct != null && !lean) {
      out.push({
        target: "reduce_waist_fat",
        kind: "nutrition",
        score: 3 + gap * 10,
        reason: `Waist:hips is ${wh.toFixed(2)} vs ${whTarget.toFixed(2)} for an ${goal}.`,
      });
    }
    out.push({
      target: "gluteus_medius",
      kind: "muscle",
      score: 2 + gap * 10,
      reason: "Glute medius adds upper-hip width, which sharpens the waist-to-hip curve.",
    });
    out.push({
      target: "gluteus_maximus",
      kind: "muscle",
      score: 1.5 + gap * 8,
      reason: "Glute max adds hip volume (mostly seen in profile).",
    });
  }

  const shTarget = target["shoulders/hips"];
  const sh = r["shoulders/hips"];
  if (shTarget != null && sh != null && sh < shTarget - 0.08) {
    out.push({
      target: "lateral_deltoid",
      kind: "muscle",
      score: 1.5 + (shTarget - sh) * 8,
      reason: "Shoulders are narrow relative to the hips for this goal shape.",
    });
  }

  // 2. Girth development vs frame-predicted potential.
  const frame = { wrist: wristCm, ankle: ankleCm };
  const scalar = sex === "female" ? FEMALE_CB_SCALAR : 1;
  const development: Record<string, number> = {};
  for (const [part, [base, k]] of Object.entries(CB_RATIOS)) {
    const g = girths[part];
    const f = frame[base];
    if (!g || !f) continue;
    const actual = g + (part === "upper_arm" ? FLEX_BUMP_CM : 0);
    development[part] = round3(actual / (f * k * scalar));
  }
  if (!wristCm || !ankleCm) {
    notes.push(
      "Add your wrist and ankle girth to your profile to rank muscles by how far each is from its frame-predicted potential.",
    );
  }
  const dev = Object.entries(development);
  if (dev.length >= 3) {
    const mean = dev.reduce((s, [, v]) => s + v, 0) / dev.length;
    for (const [part, idx] of dev) {
      const lag = mean - idx;
      if (lag > 0.04 && part !== "neck") {
        const muscles = PART_MUSCLES[part];
        out.push({
          target: muscles[0],
          kind: "muscle",
          score: 1 + lag * 20,
          reason: `${part.replace("_", " ")} is at ${Math.round(idx * 100)}% of frame potential vs ${Math.round(mean * 100)}% average — lagging the rest of the body. Also hits: ${muscles.slice(1).join(", ")}.`,
        });
      }
    }
  }

  // 3. Left/right balance.
  for (const [part, pct] of Object.entries(asym)) {
    if (Math.abs(pct) >= 6) {
      const weaker = pct > 0 ? "right" : "left";
      out.push({
        target: `${part}_${weaker}`,
        kind: "balance",
        score: 0.5 + Math.abs(pct) / 10,
        reason: `${part.replace("_", " ")} is ${Math.round(Math.abs(pct))}% narrower on the ${weaker} side (could also be pose or camera angle — confirm with a tape). Add unilateral work.`,
      });
    }
  }

  // Dedupe by target, keeping the highest score.
  const best = new Map<string, PhysiquePriority>();
  for (const p of out) {
    const prev = best.get(p.target);
    if (!prev || p.score > prev.score) best.set(p.target, p);
  }
  const sorted = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ ...p, score: Math.round(p.score * 100) / 100 }));
  return { priorities: sorted, development, notes };
}

/* --------------------------------------------------------- somatotype -- */

// Heath-Carter anthropometric somatotype (Carter 2002). The formulas are
// exact; without calipers the inputs are estimated and listed in assumptions.
const ELBOW_TO_HUMERUS = 0.8;
const KNEE_TO_FEMUR = 0.88;

type Skinfolds = { triceps: number; subscapular: number; supraspinale: number; calf: number };

export function skinfoldsFromBf(bfPct: number, sex: Sex): Skinfolds {
  const [bf, k] = sex === "female" ? [Math.max(bfPct - 8, 3), 1.35] : [bfPct, 1];
  return {
    triceps: Math.max(3, 0.62 * bf * k),
    subscapular: Math.max(4, 0.8 * bf),
    supraspinale: Math.max(3, 0.7 * bf),
    calf: Math.max(3, 0.55 * bf * k),
  };
}

export function endomorphy(sf: Skinfolds, heightCm: number): number {
  const x = (sf.triceps + sf.subscapular + sf.supraspinale) * (170.18 / heightCm);
  return -0.7182 + 0.1451 * x - 0.00068 * x ** 2 + 0.0000014 * x ** 3;
}

export function ectomorphy(heightCm: number, weightKg: number): number {
  const hwr = heightCm / Math.cbrt(weightKg);
  if (hwr >= 40.75) return 0.732 * hwr - 28.58;
  if (hwr > 38.25) return 0.463 * hwr - 17.63;
  return 0.1;
}

function mesomorphy(
  humerus: number,
  femur: number,
  flexedArm: number,
  calf: number,
  sf: Skinfolds,
  heightCm: number,
): number {
  return (
    0.858 * humerus +
    0.601 * femur +
    0.188 * (flexedArm - sf.triceps / 10) +
    0.161 * (calf - sf.calf / 10) -
    0.131 * heightCm +
    4.5
  );
}

const NOUN = { endo: "endomorph", meso: "mesomorph", ecto: "ectomorph" } as const;
const ADJ = { endo: "endomorphic", meso: "mesomorphic", ecto: "ectomorphic" } as const;
type Comp = keyof typeof NOUN;
const ORDER: Comp[] = ["endo", "meso", "ecto"];

/** Carter's 13 categories, collapsed to their naming rules (0.5 tolerance). */
export function somatotypeCategory(endo: number, meso: number, ecto: number): string {
  const v: Record<Comp, number> = { endo, meso, ecto };
  const [a, b, c] = [...ORDER].sort((x, y) => v[y] - v[x]);
  if (v[a] - v[c] <= 1) return "central";
  if (v[a] - v[b] <= 0.5) {
    const [first, second] = [a, b].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
    return `${NOUN[first]}-${NOUN[second]}`;
  }
  if (v[b] - v[c] <= 0.5) return `balanced ${NOUN[a]}`;
  return `${ADJ[b]} ${NOUN[a]}`;
}

export type Somatotype = {
  endomorphy: number;
  mesomorphy: number | null;
  ectomorphy: number;
  category: string | null;
  assumptions: string[];
};

/* ------------------------------------------------------------- report -- */

const UPPER = [
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_hip",
  "right_hip",
];
const LOWER = ["left_knee", "right_knee", "left_ankle", "right_ankle"];

/** One analysed camera frame: mask + landmarks in that frame's pixels. */
export type PhysiqueFrame = {
  mask: Mask;
  landmarks: Landmarks;
  visibility: Record<string, number>;
  /** Share of the silhouette the segmenter labelled as clothing. */
  clothesFraction: number;
};

export type PhysiqueMode = "full" | "torso";
/** Why a capture fell back to ratios only. */
export type TorsoReason = "no_height" | "head_cut" | "feet_cut" | "legs_hidden";

const FEET = ["left_heel", "right_heel", "left_foot_index", "right_foot_index"];
const EDGE_PX = 3;

export type FrameCheck = {
  mode: PhysiqueMode;
  reason: TorsoReason | null;
  /** Sole level (lowest visible foot landmark), when the feet are seen. */
  soleY: number | null;
};

/** Thrown for an outline that is only a fragment of the body. */
export class BrokenOutlineError extends Error {
  constructor() {
    super("the body outline is broken up — it doesn't span the body the landmarks see");
  }
}

/**
 * The measured blob must actually be the body: reach the shoulders and hips,
 * and (when they're seen) the head and the feet. A segmentation that fell
 * apart against a busy background leaves fragments — measuring the biggest
 * one would turn a 30 px blob near the feet into "your height".
 */
function assertSpansBody(f: PhysiqueFrame, top: number, bottom: number) {
  const y = (n: string) => ((f.visibility[n] ?? 0) >= 0.5 ? f.landmarks[n]?.[1] : undefined);
  const ys = (names: string[]) => names.map(y).filter((v): v is number => v != null);
  const shoulders = ys(["left_shoulder", "right_shoulder"]);
  const hips = ys(["left_hip", "right_hip"]);
  const nose = y("nose");
  const feet = ys(FEET);
  const span = (feet.length ? Math.max(...feet) : bottom) - (nose ?? top);
  const slack = 0.08 * Math.max(span, 1);
  const bad =
    (shoulders.length && top > Math.min(...shoulders)) ||
    (hips.length && bottom < Math.max(...hips)) ||
    (nose != null && top > nose) ||
    (feet.length && bottom < Math.max(...feet) - slack);
  if (bad) throw new BrokenOutlineError();
}

/**
 * "full" when crown to heel is in frame (real-world scale), else "torso".
 *
 * Judged on the body blob and the foot landmarks, not on "any mask pixel at
 * the edge": on a phone the feet often stand near the bottom of the frame
 * with a rug or shadow merged into them, which touches the edge without the
 * body being cut off.
 */
export function frameCheck(f: PhysiqueFrame): FrameCheck {
  const torso = (reason: TorsoReason): FrameCheck => ({ mode: "torso", reason, soleY: null });
  const body = largestComponent(f.mask);
  const [top, bottom] = verticalExtent(body);
  assertSpansBody(f, top, bottom);
  if (top < EDGE_PX) return torso("head_cut");
  if (LOWER.some((n) => (f.visibility[n] ?? 0) < 0.5)) return torso("legs_hidden");
  const feet = FEET.filter((n) => (f.visibility[n] ?? 0) >= 0.5 && f.landmarks[n]).map(
    (n) => f.landmarks[n][1],
  );
  if (!feet.length) {
    // No foot landmarks: fall back to the silhouette itself.
    return bottom > f.mask.height - 1 - EDGE_PX
      ? torso("feet_cut")
      : { mode: "full", reason: null, soleY: null };
  }
  const sole = Math.max(...feet);
  if (sole > f.mask.height - 1 - EDGE_PX) return torso("feet_cut");
  return { mode: "full", reason: null, soleY: sole };
}

function qualityWarnings(f: PhysiqueFrame): string[] {
  const w: string[] = [];
  const low = UPPER.filter((n) => (f.visibility[n] ?? 0) < 0.5);
  if (low.length)
    w.push(`Low-confidence landmarks: ${low.join(", ")} — partly hidden or out of frame.`);
  if (f.clothesFraction > 0.45) {
    w.push(
      `${Math.round(f.clothesFraction * 100)}% of the silhouette is clothing — widths will read high. Fitted shorts and top (or swimwear) give real numbers.`,
    );
  }
  const hipY = f.landmarks.left_hip?.[1];
  for (const side of ["left", "right"] as const) {
    const wr = f.landmarks[`${side}_wrist`];
    const sh = f.landmarks[`${side}_shoulder`];
    if (wr && sh && hipY != null && wr[1] < sh[1] + 0.5 * Math.abs(hipY - sh[1])) {
      w.push(
        `${side} hand is raised (holding the phone?) — that side's torso edge may be hidden, so shoulder/chest widths and the ${side} arm are unreliable.`,
      );
    }
  }
  return w;
}

export type FrameMeasurement = {
  mode: PhysiqueMode;
  /** Set when mode is "torso". */
  reason: TorsoReason | null;
  front: FrontMeasurements;
  warnings: string[];
};

/** Measure one frame. Throws when the frame has no usable person. */
export function measureFrame(f: PhysiqueFrame, heightCm: number | null): FrameMeasurement {
  const check = frameCheck(f);
  const full = check.mode === "full" && !!heightCm;
  const reason = full ? null : (check.reason ?? "no_height");
  const front = measureFront(f.mask, f.landmarks, full ? heightCm : null, full, check.soleY);
  return {
    mode: full ? "full" : "torso",
    reason,
    front,
    warnings: [...qualityWarnings(f), ...front.warnings],
  };
}

/**
 * Per-key median over a burst of frames — one frame's segmentation wobble
 * or a blink of motion shouldn't decide a measurement. A key counts only if
 * at least half of the frames produced it.
 */
export function medianWidths(list: Record<string, number>[]): Record<string, number> {
  const keys = new Set(list.flatMap((w) => Object.keys(w)));
  const out: Record<string, number> = {};
  for (const k of keys) {
    const vals = list
      .map((w) => w[k])
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    if (vals.length * 2 < list.length) continue;
    const m = vals.length >> 1;
    out[k] = round1(vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2);
  }
  return out;
}

export type PhysiqueReportInput = {
  sex: Sex;
  heightCm: number | null;
  weightKg: number | null;
  bfPct: number | null;
  wristCm: number | null;
  ankleCm: number | null;
  goalShape?: GoalShape;
  mode: PhysiqueMode;
  units: "cm" | "px";
  widths: Record<string, number>;
  warnings: string[];
  /** The pixel scale the widths were converted with (full mode). */
  scale?: { cmPerPx: number; heightPx: number } | null;
  /** Why the capture is torso-only, when it is. */
  torsoReason?: TorsoReason | null;
};

export type PhysiqueReport = {
  mode: PhysiqueMode;
  units: "cm" | "px";
  /**
   * How pixels became centimetres: the silhouette (crown to heel) is
   * `heightPx` tall and the user is `heightCm`, so 1 px = `cmPerPx` cm.
   * null in torso mode, where there is no real-world scale.
   */
  scale: { cmPerPx: number; heightPx: number; heightCm: number } | null;
  /** Why there are no centimetres (null in full mode). */
  torsoReason: TorsoReason | null;
  widths: Record<string, number>;
  /** Estimated circumferences (cm), full mode only. */
  girths: Record<string, number>;
  asymmetryPct: Record<string, number>;
  bodyFat: { pct: number; source: "user" | "navy_from_photo" } | null;
  ratios: Ratios;
  shape: PhysiqueShape;
  goalShape: GoalShape;
  somatotype: Somatotype | null;
  /** Girth ÷ frame-predicted max girth, per part. */
  development: Record<string, number>;
  priorities: PhysiquePriority[];
  notes: string[];
  warnings: string[];
};

export function physiqueReport(i: PhysiqueReportInput): PhysiqueReport {
  const full = i.mode === "full" && i.units === "cm";
  const warnings = [...i.warnings];
  const notes: string[] = [];
  const torsoReason: TorsoReason | null = full
    ? null
    : (i.torsoReason ?? (i.heightCm ? null : "no_height"));
  if (!full) {
    notes.push(
      "Torso-only capture — no real-world scale, so results are ratios only: no centimetres, girths or Navy body fat.",
    );
  }
  const girths = full ? girthsFromWidths(i.widths) : {};
  const asym = asymmetry(i.widths);

  let bodyFat: PhysiqueReport["bodyFat"] =
    i.bfPct != null ? { pct: i.bfPct, source: "user" } : null;
  if (!bodyFat && full && i.heightCm && girths.neck && girths.waist) {
    try {
      const navy = estimateBodyFatNavy({
        sex: i.sex,
        height_cm: i.heightCm,
        neck_cm: girths.neck,
        waist_cm: girths.waist,
        hip_cm: girths.hips ?? null,
      });
      bodyFat = { pct: round1(navy.body_fat_pct), source: "navy_from_photo" };
      warnings.push(
        "Body fat is a Navy-formula estimate from photo-derived girths (narrowest waist, not navel) — treat it as ±5%. A real reading on your last weigh-in replaces it.",
      );
    } catch {
      // Implausible girths (neck ≥ waist): leave body fat unknown.
    }
  }
  const bf = bodyFat?.pct ?? null;

  let somatotype: Somatotype | null = null;
  if (i.heightCm && i.weightKg) {
    const ecto = round1(Math.max(0.1, ectomorphy(i.heightCm, i.weightKg)));
    const sf = bf != null ? skinfoldsFromBf(bf, i.sex) : null;
    const endo = sf ? round1(Math.max(0.1, endomorphy(sf, i.heightCm))) : null;
    const elbow = widthOf(i.widths, "elbow");
    const knee = widthOf(i.widths, "knee");
    if (full && sf && endo != null && elbow && knee && girths.upper_arm && girths.calf) {
      const meso = round1(
        Math.max(
          0.1,
          mesomorphy(
            elbow * ELBOW_TO_HUMERUS,
            knee * KNEE_TO_FEMUR,
            girths.upper_arm + FLEX_BUMP_CM,
            girths.calf,
            sf,
            i.heightCm,
          ),
        ),
      );
      somatotype = {
        endomorphy: endo,
        mesomorphy: meso,
        ectomorphy: ecto,
        category: somatotypeCategory(endo, meso, ecto),
        assumptions: [
          `Skinfolds estimated from ${bf}% body fat (no caliper data).`,
          "Bone breadths estimated from the elbow and knee silhouette widths.",
          "Flexed arm girth estimated as relaxed girth + 2 cm.",
        ],
      };
    } else if (endo != null) {
      somatotype = {
        endomorphy: endo,
        mesomorphy: null,
        ectomorphy: ecto,
        category: null,
        assumptions: [],
      };
    }
  }

  const ratios = frontRatios(i.widths);
  const goal = i.goalShape ?? DEFAULT_GOAL[i.sex];
  const p = priorities(i.sex, ratios, goal, girths, asym, bf, i.wristCm, i.ankleCm);

  return {
    mode: full ? "full" : "torso",
    units: full ? "cm" : "px",
    torsoReason,
    scale:
      full && i.scale && i.heightCm
        ? {
            cmPerPx: Math.round(i.scale.cmPerPx * 10000) / 10000,
            heightPx: Math.round(i.scale.heightPx),
            heightCm: i.heightCm,
          }
        : null,
    widths: i.widths,
    girths,
    asymmetryPct: asym,
    bodyFat,
    ratios,
    shape: classifyShape(ratios, i.sex),
    goalShape: goal,
    somatotype,
    development: p.development,
    priorities: p.priorities,
    notes: [...notes, ...p.notes],
    warnings: [...new Set(warnings)],
  };
}

export type { Point };
