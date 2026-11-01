// Ported from the original Python prototype's measurement and analysis tests,
// so the TypeScript measurement matches the results it was validated against.
import { describe, expect, test } from "bun:test";
import {
  asymmetry,
  classifyShape,
  dilate,
  ectomorphy,
  ellipsePerimeter,
  endomorphy,
  erode,
  girthsFromWidths,
  BrokenOutlineError,
  frameCheck,
  largestComponent,
  measureFrame,
  measureFront,
  medianWidths,
  physiqueReport,
  runsInRow,
  somatotypeCategory,
  widthAcrossSegment,
  type Mask,
  type PhysiqueFrame,
  type PhysiqueReportInput,
  type Point,
} from "./index.ts";

/* ---------------------------------------------- tiny rasteriser (cv2) -- */

const H = 240;
const W = 200;
const CX = 100;

function blank(w = W, h = H): Mask {
  return { width: w, height: h, data: new Uint8Array(w * h) };
}
function set(m: Mask, x: number, y: number) {
  if (x >= 0 && x < m.width && y >= 0 && y < m.height) m.data[y * m.width + x] = 1;
}
function circle(m: Mask, cx: number, cy: number, r: number) {
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(m, x, y);
}
function rect(m: Mask, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(m, x, y);
}
/** Even-odd scanline fill, edges inclusive (close enough to cv2.fillPoly). */
function poly(m: Mask, pts: Point[]) {
  for (let y = 0; y < m.height; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if (y0 === y1) continue;
      if (y >= Math.min(y0, y1) && y < Math.max(y0, y1))
        xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) set(m, x, y);
  }
  // Horizontal edges themselves.
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    if (y0 === y1) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) set(m, x, y0);
  }
}
/** Thick line: every pixel within thickness/2 of the segment. */
function line(m: Mask, a: Point, b: Point, thickness: number) {
  const r = thickness / 2;
  const [ax, ay] = a;
  const [bx, by] = b;
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  for (let y = Math.floor(Math.min(ay, by) - r); y <= Math.ceil(Math.max(ay, by) + r); y++)
    for (let x = Math.floor(Math.min(ax, bx) - r); x <= Math.ceil(Math.max(ax, bx) + r); x++) {
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
      if ((x - (ax + t * (bx - ax))) ** 2 + (y - (ay + t * (by - ay))) ** 2 <= r * r) set(m, x, y);
    }
}

/** Synthetic A-pose figure, 180 px tall: 1 px == 1 cm with heightCm 179. */
function figure(): Mask {
  const m = blank();
  circle(m, CX, 41, 11); // head, top at y=30
  rect(m, CX - 6, 50, CX + 6, 62); // neck: 13 wide
  poly(m, [
    [CX - 22, 62],
    [CX + 22, 62],
    [CX + 22, 72],
    [CX + 18, 82],
    [CX + 14, 100],
    [CX + 18, 118],
    [CX + 18, 128],
    [CX - 18, 128],
    [CX - 18, 118],
    [CX - 14, 100],
    [CX - 18, 82],
    [CX - 22, 72],
  ]);
  for (const s of [-1, 1]) {
    line(m, [CX + s * 17, 68], [CX + s * 40, 110], 10);
    line(m, [CX + s * 40, 110], [CX + s * 55, 145], 8);
  }
  for (const s of [-1, 1]) {
    line(m, [CX + s * 10, 128], [CX + s * 12, 168], 14);
    line(m, [CX + s * 12, 168], [CX + s * 12, 202], 10);
  }
  rect(m, CX - 18, 202, CX + 18, 209); // feet
  return m;
}

function landmarks(): Record<string, Point> {
  const lm: Record<string, Point> = {};
  // Subject's left is image right.
  for (const [side, s] of [
    ["left", 1],
    ["right", -1],
  ] as const) {
    lm[`${side}_shoulder`] = [CX + s * 17, 66];
    lm[`${side}_elbow`] = [CX + s * 40, 110];
    lm[`${side}_wrist`] = [CX + s * 55, 145];
    lm[`${side}_hip`] = [CX + s * 10, 122];
    lm[`${side}_knee`] = [CX + s * 12, 168];
    lm[`${side}_ankle`] = [CX + s * 12, 202];
  }
  lm.mouth_left = [CX + 3, 46];
  lm.mouth_right = [CX - 3, 46];
  return lm;
}

/* ------------------------------------------------------------ measure -- */

describe("mask primitives", () => {
  test("runsInRow", () => {
    const m = blank(10, 1);
    m.data.set([0, 0, 1, 1, 0, 0, 1, 1, 1, 0]);
    expect(runsInRow(m, 0)).toEqual([
      [2, 3],
      [6, 8],
    ]);
  });

  test("largestComponent drops islands", () => {
    const m = blank(20, 20);
    rect(m, 2, 2, 10, 10);
    rect(m, 15, 15, 16, 16);
    const out = largestComponent(m);
    expect(out.data[15 * 20 + 15]).toBe(0);
    expect(out.data[5 * 20 + 5]).toBe(1);
  });

  test("dilate then erode restores a box", () => {
    const m = blank(30, 30);
    rect(m, 10, 10, 19, 19);
    const back = erode(dilate(m, 5), 5);
    expect(Array.from(back.data)).toEqual(Array.from(m.data));
  });
});

describe("measureFront", () => {
  test("width across a vertical bar", () => {
    const m = blank(50, 50);
    rect(m, 20, 0, 30, 49); // 11 px wide
    const r = widthAcrossSegment(m, [25, 0], [25, 49], 0.5, 40);
    expect(Math.abs(r.width - 10)).toBeLessThanOrEqual(1);
  });

  test("front widths on the synthetic figure", () => {
    const fm = measureFront(figure(), landmarks(), 179);
    const w = fm.widths;
    expect(fm.cmPerPx).toBeCloseTo(1, 5);
    expect(fm.warnings).toEqual([]);
    // The arm stroke caps the torso corners like a deltoid → ~48, not 44.
    expect(Math.abs(w.shoulders - 48)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.waist - 29)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.hips - 37)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.neck - 13)).toBeLessThanOrEqual(1);
    expect(w.shoulders).toBeGreaterThan(w.chest);
    expect(w.chest).toBeGreaterThan(w.waist);
    expect(Math.abs(w.upper_arm_left - 10)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.upper_arm_left - w.upper_arm_right)).toBeLessThanOrEqual(1);
    expect(Math.abs(w.thigh_left - 14)).toBeLessThanOrEqual(2);
    expect(Math.abs(w.calf_left - 10)).toBeLessThanOrEqual(2);
  });

  test("arms glued to the torso warn", () => {
    const m = figure();
    rect(m, CX - 45, 60, CX + 45, 129);
    const fm = measureFront(m, landmarks(), 179);
    expect(fm.warnings.some((x) => x.includes("Arms never separate"))).toBe(true);
  });

  test("torso mode keeps the ratios", () => {
    const full = measureFront(figure(), landmarks(), 179).widths;
    const src = figure();
    const crop = blank(W, 105);
    crop.data.set(src.data.subarray(45 * W, 150 * W));
    const lm = Object.fromEntries(
      Object.entries(landmarks()).map(([k, [x, y]]) => [k, [x, y - 45] as Point]),
    );
    const fm = measureFront(crop, lm, null, false);
    expect(fm.units).toBe("px");
    expect(fm.widths.thigh_left).toBeUndefined();
    const ratio = fm.widths.shoulders / fm.widths.waist;
    const want = full.shoulders / full.waist;
    expect(Math.abs(ratio - want) / want).toBeLessThan(0.03);
  });
});

/* ------------------------------------------------------------ framing -- */

describe("frameCheck", () => {
  // The figure's feet end at y=209 of a 240 px frame; heels/toes visible.
  const frame = (mask: Mask, extra: Record<string, Point> = {}): PhysiqueFrame => {
    const landmarks = { ...landmarks_(), ...extra };
    return {
      mask,
      landmarks,
      visibility: Object.fromEntries(Object.keys(landmarks).map((k) => [k, 1])),
      clothesFraction: 0,
    };
  };
  const landmarks_ = () => ({
    ...landmarks(),
    nose: [CX, 40] as Point,
    left_heel: [CX + 12, 207] as Point,
    right_heel: [CX - 12, 207] as Point,
    left_foot_index: [CX + 14, 209] as Point,
    right_foot_index: [CX - 14, 209] as Point,
  });

  test("a clean full-body frame is full", () => {
    expect(frameCheck(frame(figure())).mode).toBe("full");
  });

  test("a rug merged with the feet doesn't make it torso, or stretch the scale", () => {
    const clean = measureFrame(frame(figure()), 179);
    const m = figure();
    rect(m, CX - 60, 206, CX + 60, H - 1); // rug from the feet to the bottom edge
    const f = frame(m);
    expect(frameCheck(f)).toMatchObject({ mode: "full", reason: null });
    const rug = measureFrame(f, 179);
    expect(rug.mode).toBe("full");
    // Without the sole clamp the rug would add ~30 px (≈17%) of "height".
    expect(Math.abs(rug.front.heightPx - clean.front.heightPx) / clean.front.heightPx).toBeLessThan(
      0.03,
    );
    expect(Math.abs(rug.front.widths.waist - clean.front.widths.waist)).toBeLessThanOrEqual(1);
  });

  test("feet at the very bottom edge are cut off", () => {
    const m = figure();
    rect(m, CX - 18, 202, CX + 18, H - 1); // feet run off the bottom edge
    const f = frame(m, { left_foot_index: [CX + 14, H - 1], right_foot_index: [CX - 14, H - 1] });
    expect(frameCheck(f)).toMatchObject({ mode: "torso", reason: "feet_cut" });
  });

  test("head at the top edge is cut off", () => {
    const m = figure();
    rect(m, CX - 3, 0, CX + 3, 30); // hair to the top edge
    expect(frameCheck(frame(m)).reason).toBe("head_cut");
  });

  test("a fragment of the body is rejected, not measured", () => {
    // Only the feet survived segmentation (busy background).
    const m = blank();
    rect(m, CX - 18, 195, CX + 18, 209);
    expect(() => frameCheck(frame(m))).toThrow(BrokenOutlineError);
  });

  test("no height → torso with reason no_height", () => {
    expect(measureFrame(frame(figure()), null)).toMatchObject({
      mode: "torso",
      reason: "no_height",
    });
  });
});

/* ----------------------------------------------------------- analysis -- */

const base: PhysiqueReportInput = {
  sex: "male",
  heightCm: 180,
  weightKg: 80,
  bfPct: null,
  wristCm: null,
  ankleCm: null,
  mode: "full",
  units: "cm",
  widths: {},
  warnings: [],
};

describe("girths and shape", () => {
  test("ellipse perimeter of a circle", () => {
    expect(ellipsePerimeter(10, 10)).toBeCloseTo(31.416, 2);
  });

  test("limb girth averages the sides", () => {
    const g = girthsFromWidths({ waist: 30, upper_arm_left: 10, upper_arm_right: 12 });
    expect(g.upper_arm).toBeCloseTo(ellipsePerimeter(11, 11 * 0.95), 1);
  });

  test("asymmetry sign", () => {
    expect(asymmetry({ thigh_left: 20, thigh_right: 18 }).thigh).toBeCloseTo(10, 5);
  });

  test("ectomorphy branches", () => {
    expect(ectomorphy(180, 80)).toBeCloseTo(1.999, 2);
    expect(ectomorphy(170, 100)).toBe(0.1);
  });

  test("endomorphy reference", () => {
    expect(
      endomorphy({ triceps: 10, subscapular: 10, supraspinale: 10, calf: 8 }, 170.18),
    ).toBeCloseTo(3.06, 2);
  });

  test.each([
    [[3.0, 3.2, 3.1], "central"],
    [[2.0, 5.0, 2.2], "balanced mesomorph"],
    [[3.5, 5.0, 1.5], "endomorphic mesomorph"],
    [[4.8, 5.0, 1.0], "endomorph-mesomorph"],
    [[1.0, 2.5, 4.5], "mesomorphic ectomorph"],
    [[1.5, 2.0, 4.5], "balanced ectomorph"],
  ] as const)("somatotype category %p → %s", ([en, me, ec], want) => {
    expect(somatotypeCategory(en, me, ec)).toBe(want);
  });

  test("male shape classes", () => {
    expect(
      classifyShape(
        { "shoulders/waist": 1.85, "shoulders/hips": 1.45, "waist/hips": 0.78 },
        "male",
      ),
    ).toBe("v_taper");
    expect(
      classifyShape({ "shoulders/waist": 1.35, "shoulders/hips": 1.3, "waist/hips": 0.97 }, "male"),
    ).toBe("diamond");
    expect(
      classifyShape({ "shoulders/waist": 1.55, "shoulders/hips": 1.3, "waist/hips": 0.84 }, "male"),
    ).toBe("square");
  });

  test("a fat waist puts the cut first", () => {
    const r = physiqueReport({
      ...base,
      bfPct: 26,
      widths: { shoulders: 46, waist: 36, hips: 37 },
    });
    expect(r.priorities[0].target).toBe("reduce_waist_fat");
    expect(r.priorities.map((p) => p.target)).toContain("lateral_deltoid");
  });

  test("lean + narrow shoulders → delts and lats", () => {
    const r = physiqueReport({
      ...base,
      bfPct: 11,
      widths: { shoulders: 46, waist: 29, hips: 34 },
    });
    const targets = r.priorities.map((p) => p.target);
    expect(targets.slice(0, 2)).toEqual(["lateral_deltoid", "latissimus_dorsi"]);
    expect(targets).not.toContain("reduce_waist_fat");
  });

  test("Navy body fat from photo girths when none is known", () => {
    const r = physiqueReport({
      ...base,
      widths: { neck: 12.4, waist: 30, hips: 34, shoulders: 46 },
    });
    expect(r.bodyFat?.source).toBe("navy_from_photo");
    expect(r.bodyFat!.pct).toBeGreaterThan(5);
    expect(r.bodyFat!.pct).toBeLessThan(40);
  });

  test("full mode reports the scale it used", () => {
    const r = physiqueReport({
      ...base,
      widths: { shoulders: 46 },
      scale: { cmPerPx: 0.18, heightPx: 1000 },
    });
    expect(r.scale).toEqual({ cmPerPx: 0.18, heightPx: 1000, heightCm: 180 });
  });

  test("torso mode reports ratios only", () => {
    const r = physiqueReport({
      ...base,
      mode: "torso",
      units: "px",
      widths: { shoulders: 460, waist: 290 },
    });
    expect(r.girths).toEqual({});
    expect(r.bodyFat).toBeNull();
    expect(r.scale).toBeNull();
    expect(r.ratios["shoulders/waist"]).toBeCloseTo(460 / 290, 3);
  });
});

describe("medianWidths", () => {
  test("per-key median, keys need half the frames", () => {
    const m = medianWidths([{ waist: 30, neck: 12 }, { waist: 34 }, { waist: 31 }, { waist: 50 }]);
    expect(m.waist).toBeCloseTo(32.5, 5);
    expect(m.neck).toBeUndefined();
  });
});
