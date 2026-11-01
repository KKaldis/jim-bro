// Silhouette measurement: widths of the body at anatomical levels (front
// view), ported from the original Python prototype.
//
// Pose landmarks are only ANCHORS for where to scan; the widths themselves
// come from the silhouette. "left"/"right" are the SUBJECT's sides (MediaPipe
// convention), so on a front-facing camera image the subject's left is on the
// image right.

import {
  largestComponent,
  runContaining,
  runsInRow,
  verticalExtent,
  type Mask,
  type Point,
} from "./mask.ts";

/** One measured level, kept for the overlay. */
export type Scan = { name: string; widthPx: number; p0: Point; p1: Point };

export type FrontMeasurements = {
  /** "cm" when the whole body is in frame and the height is known, else "px". */
  units: "cm" | "px";
  cmPerPx: number;
  heightPx: number;
  widths: Record<string, number>;
  scans: Scan[];
  warnings: string[];
  /** Torso-relative positions (0 = shoulder line, 1 = hip line) of the levels found. */
  levels: Record<string, number>;
};

export type Landmarks = Record<string, Point>;

// One-sided walk this many times longer than the other = the limb is touching
// another body part (arm against torso).
const MERGE_RATIO = 1.8;
// The heel / toe landmarks sit a little above the sole's outline.
const SOLE_TOLERANCE = 0.015;

const round1 = (n: number) => Math.round(n * 10) / 10;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mid = (p: Point, q: Point): Point => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];

/** `from`, `from + step`, … while < `to` (integer-stepped, no float drift). */
function arange(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const v = from + i * step;
    if (v >= to - 1e-9) return out;
    out.push(v);
  }
}

function linspace(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (n === 1 ? a : a + ((b - a) * i) / (n - 1)));
}

type Clamp = [number | null, number | null];

/**
 * Width of the limb perpendicular to segment a→b at fraction t: walk outward
 * both ways until leaving the mask (or hitting maxHalfPx / a clamp column).
 * `merged` = one side walked much further than the other; with
 * `mirrorMerged` the width is then twice the short side (the segment runs
 * along the bone, roughly the limb's centre line).
 */
export function widthAcrossSegment(
  m: Mask,
  a: Point,
  b: Point,
  t: number,
  maxHalfPx: number,
  clamp: Clamp = [null, null],
  mirrorMerged = false,
): { width: number; p0: Point; p1: Point; merged: boolean } {
  const px = a[0] + t * (b[0] - a[0]);
  const py = a[1] + t * (b[1] - a[1]);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const norm = Math.hypot(dx, dy) || 1;
  const nx = -dy / norm;
  const ny = dx / norm;
  const [loX, hiX] = clamp;

  const walk = (sign: number) => {
    let step = 0;
    while (step < maxHalfPx) {
      const nxt = step + 1;
      const x = px + sign * nx * nxt;
      const y = py + sign * ny * nxt;
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || xi >= m.width || yi < 0 || yi >= m.height || !m.data[yi * m.width + xi]) break;
      if ((loX != null && x < loX) || (hiX != null && x > hiX)) break;
      step = nxt;
    }
    return step;
  };

  let dPos = walk(1);
  let dNeg = walk(-1);
  const short = Math.min(dPos, dNeg);
  const merged = short > 0 && Math.max(dPos, dNeg) > MERGE_RATIO * short;
  if (merged && mirrorMerged) dPos = dNeg = short;
  return {
    width: dPos + dNeg,
    p0: [px - nx * dNeg, py - ny * dNeg],
    p1: [px + nx * dPos, py + ny * dPos],
    merged,
  };
}

/**
 * Max (girth-like) or min (joint-like) perpendicular width over a t-range.
 * For "max", samples where the limb touches the torso would read huge, so
 * they're skipped; only if every sample is merged do we fall back to the
 * mirrored half-width.
 */
function extremeAlongSegment(
  m: Mask,
  a: Point,
  b: Point,
  tRange: [number, number],
  mode: "max" | "min",
  maxHalfPx: number,
  clamp: Clamp = [null, null],
  samples = 24,
): { width: number; p0: Point; p1: Point } {
  const clean: { width: number; p0: Point; p1: Point }[] = [];
  const mirrored: typeof clean = [];
  for (const t of linspace(tRange[0], tRange[1], samples)) {
    const r = widthAcrossSegment(m, a, b, t, maxHalfPx, clamp, mode === "max");
    if (r.width <= 0) continue;
    (r.merged && mode === "max" ? mirrored : clean).push(r);
  }
  let best: (typeof clean)[number] | null = null;
  for (const r of clean.length ? clean : mirrored) {
    if (!best || (mode === "max" ? r.width > best.width : r.width < best.width)) best = r;
  }
  return best ?? { width: 0, p0: a, p1: a };
}

const runWidth = (r: [number, number]) => r[1] - r[0];

/**
 * Widths at shoulders/chest/waist/hips/neck plus per-side limb widths, from a
 * front-facing photo (upright, arms ~20° out, feet hip-width). Scale comes
 * from silhouette height (crown to heel) = the user's real height.
 *
 * Torso mode (`heightCm` null, `lowerBody` false): for photos cropped at the
 * head or legs. Widths stay in pixels and legs are skipped; the shape ratios
 * still hold because they're scale-free.
 */
export function measureFront(
  rawMask: Mask,
  lm: Landmarks,
  heightCm: number | null,
  lowerBody = true,
  /**
   * Sole level from the foot landmarks. The silhouette's bottom is clamped to
   * it, so a rug or shadow merged with the feet can't stretch the height —
   * and with it, shrink every centimetre.
   */
  soleY: number | null = null,
): FrontMeasurements {
  const mask = largestComponent(rawMask);
  const [top, maskBottom] = verticalExtent(mask);
  const bottom =
    soleY != null ? Math.min(maskBottom, soleY + SOLE_TOLERANCE * (soleY - top)) : maskBottom;
  const heightPx = bottom - top;
  const cmpp = heightCm ? heightCm / heightPx : 1;
  const out: FrontMeasurements = {
    units: heightCm ? "cm" : "px",
    cmPerPx: cmpp,
    heightPx,
    widths: {},
    scans: [],
    warnings: [],
    levels: {},
  };

  const need = (k: string) => {
    const p = lm[k];
    if (!p) throw new Error(`missing landmark ${k}`);
    return p;
  };
  const shL = need("left_shoulder");
  const shR = need("right_shoulder");
  const hpL = need("left_hip");
  const hpR = need("right_hip");
  const shMid = mid(shL, shR);
  const hpMid = mid(hpL, hpR);
  const torsoPx = hpMid[1] - shMid[1];
  if (torsoPx <= 0) throw new Error("hips above shoulders — is the photo upside down?");

  // Body midline interpolated between shoulder-mid and hip-mid (and a little
  // beyond), robust to a slight lean.
  const centerX = (y: number) => lerp(shMid[0], hpMid[0], (y - shMid[1]) / torsoPx);
  const levelY = (frac: number) => Math.round(shMid[1] + frac * torsoPx);
  const centerRun = (y: number) => runContaining(mask, y, centerX(y));
  const add = (name: string, wpx: number, p0: Point, p1: Point) => {
    out.widths[name] = round1(wpx * cmpp);
    out.scans.push({ name, widthPx: wpx, p0, p1 });
  };

  // --- Armpit: first row below the shoulders where the arm separates from
  // the torso (a gap on both sides of the centre run).
  let armpitFrac: number | null = null;
  for (const frac of arange(0.05, 0.6, 0.005)) {
    const y = levelY(frac);
    const run = centerRun(y);
    if (!run) continue;
    const runs = runsInRow(mask, y);
    if (runs.some(([, x1]) => x1 < run[0]) && runs.some(([x0]) => x0 > run[1])) {
      armpitFrac = frac;
      break;
    }
  }
  if (armpitFrac == null) {
    out.warnings.push(
      "Arms never separate from the torso — hold them ~20° out from the body. Shoulder, chest and waist widths include the arms and are unreliable.",
    );
    armpitFrac = 0.25;
  } else if (armpitFrac > 0.3) {
    out.warnings.push(
      "Arms hang against the torso, so the armpit gap only opens low — the chest is measured below the pecs. Hold the arms ~20° out for a true chest width.",
    );
  }
  out.levels.armpit = armpitFrac;

  // --- Shoulders (bideltoid): widest centre-run row in a narrow band around
  // the shoulder landmarks. Not down to the armpit: with the arms angled out,
  // rows just above it include the upper arm and read far too wide.
  {
    let best: { y: number; run: [number, number] } | null = null;
    for (const frac of arange(-0.08, Math.min(armpitFrac, 0.1), 0.005)) {
      const y = levelY(frac);
      const run = centerRun(y);
      if (run && (!best || runWidth(run) > runWidth(best.run))) best = { y, run };
    }
    if (best) {
      add("shoulders", runWidth(best.run) + 1, [best.run[0], best.y], [best.run[1], best.y]);
      out.levels.shoulders = (best.y - shMid[1]) / torsoPx;
    }
  }

  // --- Chest: just under the armpit, torso only.
  {
    const frac = armpitFrac + 0.04;
    const y = levelY(frac);
    const run = centerRun(y);
    if (run) {
      add("chest", runWidth(run) + 1, [run[0], y], [run[1], y]);
      out.levels.chest = frac;
    }
  }

  // --- Waist: narrowest torso row between mid-torso and the hip line.
  {
    let best: { y: number; run: [number, number]; frac: number } | null = null;
    for (const frac of arange(0.45, 0.95, 0.005)) {
      const y = levelY(frac);
      const run = centerRun(y);
      if (run && (!best || runWidth(run) < runWidth(best.run))) best = { y, run, frac };
    }
    if (best) {
      add("waist", runWidth(best.run) + 1, [best.run[0], best.y], [best.run[1], best.y]);
      out.levels.waist = best.frac;
    }
  }

  // --- Hips: widest row from the hip line down to the crotch (where the
  // midline leaves the body).
  {
    let best: { y: number; run: [number, number]; frac: number } | null = null;
    const hipsInFrame = levelY(1.15) < mask.height;
    for (const frac of hipsInFrame ? arange(0.85, 1.6, 0.005) : []) {
      const y = levelY(frac);
      const run = centerRun(y);
      if (!run) break; // crotch reached
      // Hands beside the hips merge into the run when the arms aren't out —
      // ignore rows far wider than the hip-landmark spread.
      if (runWidth(run) > 2.2 * Math.abs(hpL[0] - hpR[0])) continue;
      if (!best || runWidth(run) > runWidth(best.run)) best = { y, run, frac };
    }
    if (best) {
      add("hips", runWidth(best.run) + 1, [best.run[0], best.y], [best.run[1], best.y]);
      out.levels.hips = best.frac;
    }
  }

  // --- Neck: narrowest row between the mouth and the shoulder line.
  if (lm.mouth_left && lm.mouth_right) {
    const mouthY = mid(lm.mouth_left, lm.mouth_right)[1];
    let best: { y: number; run: [number, number] } | null = null;
    const y0 = Math.trunc(mouthY + 0.25 * (shMid[1] - mouthY));
    for (let y = y0; y < Math.trunc(shMid[1]); y++) {
      const run = runContaining(mask, y, centerX(y));
      if (run && (!best || runWidth(run) < runWidth(best.run))) best = { y, run };
    }
    if (best) add("neck", runWidth(best.run) + 1, [best.run[0], best.y], [best.run[1], best.y]);
  }

  // --- Limbs, per side, perpendicular to the bone segment.
  const limbCap = 0.5 * torsoPx; // never walk further than half a torso
  for (const side of ["left", "right"] as const) {
    const s = lm[`${side}_shoulder`];
    const e = lm[`${side}_elbow`];
    const w = lm[`${side}_wrist`];
    const h = lm[`${side}_hip`];
    const k = lm[`${side}_knee`];
    const a = lm[`${side}_ankle`];
    if (!s || !e || !w || !h) continue;
    const midX = centerX(h[1]);
    // Stop the inner-thigh walk at the midline so touching thighs don't get
    // measured as one.
    const clamp: Clamp = h[0] > midX ? [midX, null] : [null, midX];
    const none: Clamp = [null, null];
    const specs: [string, Point, Point, [number, number], "max" | "min", Clamp][] = [
      ["upper_arm", s, e, [0.35, 0.75], "max", none],
      ["elbow", s, e, [0.9, 1.0], "min", none],
      ["forearm", e, w, [0.1, 0.45], "max", none],
      ["wrist", e, w, [0.8, 0.97], "min", none],
    ];
    if (lowerBody && k && a) {
      specs.push(
        ["thigh", h, k, [0.15, 0.4], "max", clamp],
        ["knee", h, k, [0.9, 1.0], "min", clamp],
        ["calf", k, a, [0.15, 0.45], "max", clamp],
        ["ankle", k, a, [0.8, 0.95], "min", clamp],
      );
    }
    for (const [name, p, q, tr, mode, cl] of specs) {
      const r = extremeAlongSegment(mask, p, q, tr, mode, limbCap, cl);
      if (r.width > 0) add(`${name}_${side}`, r.width, r.p0, r.p1);
    }
  }

  return out;
}
