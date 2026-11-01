import { describe, expect, test } from "bun:test";
import { classifyBodyShape, computeIdealProportions, idealGirths } from "./proportions.ts";

const IN = 2.54;

describe("idealGirths", () => {
  test("men match the GainFrame table for a 7in wrist", () => {
    const g = idealGirths("male", 7 * IN);
    expect(g.chest / IN).toBeCloseTo(45.5, 1);
    expect(g.arm / IN).toBeCloseTo(17.5, 1);
    expect(g.neck / IN).toBeCloseTo(17.5, 1);
    expect(g.calf / IN).toBeCloseTo(17.5, 1);
    // 70% of chest — the bottom of the article's 32–34in band.
    expect(g.waist / IN).toBeCloseTo(31.85, 1);
    expect(g.shoulders / g.waist).toBeCloseTo(1.618, 3);
  });

  test("women: a 6in wrist gives the classic ~36-25-36 hourglass", () => {
    const g = idealGirths("female", 6 * IN);
    expect(g.chest / IN).toBeCloseTo(36, 1);
    expect(g.hips / IN).toBeCloseTo(36, 1);
    expect(g.waist / g.hips).toBeCloseTo(0.7, 3);
  });
});

describe("computeIdealProportions", () => {
  test("scores parts, inverts the waist, and ranks the lagging muscle first", () => {
    const r = computeIdealProportions({
      sex: "male",
      wrist_cm: 17.8,
      height_cm: 180,
      measurements: { chest: 104, waist: 90, arm: 38, calf: 40, shoulders: 120 },
    });
    const by = Object.fromEntries(r.rows.map((x) => [x.part, x]));
    expect(by.arm.pct_of_ideal).toBe(Math.round((38 / (17.8 * 2.5)) * 100)); // 85
    expect(by.arm.status).toBe("lagging");
    // Waist bigger than ideal → ideal/actual, below 95 → above_ideal.
    expect(by.waist.pct_of_ideal).toBe(Math.round(((17.8 * 6.5 * 0.7) / 90) * 100));
    expect(by.waist.status).toBe("above_ideal");
    expect(by.thigh.actual_cm).toBeNull();
    expect(r.priorities[0].action).toBe("reduce_waist");
    expect(r.priorities[1].part).toBe("arm");
    expect(r.priorities[1].muscles).toContain("biceps_brachii");
    expect(r.ratios.shoulder_to_waist).toBeCloseTo(1.333, 3);
    expect(r.ratios.waist_to_height).toBeCloseTo(0.5, 3);
    expect(r.proportion_score).not.toBeNull();
  });

  test("a girth past the ideal is above_ideal and costs score like one under it", () => {
    const ideal = idealGirths("male", 17);
    const r = computeIdealProportions({
      sex: "male",
      wrist_cm: 17,
      measurements: { hips: ideal.hips * 1.25, arm: ideal.arm * 0.8 },
    });
    const by = Object.fromEntries(r.rows.map((x) => [x.part, x]));
    expect(by.hips.pct_of_ideal).toBe(125);
    expect(by.hips.status).toBe("above_ideal");
    expect(by.arm.status).toBe("lagging");
    // hips 100/125 = 80, arm 80 → 80, not the 90 a capped surplus would give.
    expect(r.proportion_score).toBe(80);
  });

  test("a waist under the ideal caps at 100, not a bonus", () => {
    const r = computeIdealProportions({ sex: "male", wrist_cm: 17, measurements: { waist: 60 } });
    expect(r.rows.find((x) => x.part === "waist")!.pct_of_ideal).toBe(100);
  });

  test("rejects an implausible wrist", () => {
    expect(() =>
      computeIdealProportions({ sex: "male", wrist_cm: 45, measurements: {} }),
    ).toThrow();
  });
});

describe("classifyBodyShape — women (FFIT / calculator.net)", () => {
  const f = (bust: number, waist: number, hips: number, high_hip?: number) =>
    classifyBodyShape({
      sex: "female",
      bust_cm: bust * IN,
      waist_cm: waist * IN,
      hips_cm: hips * IN,
      high_hip_cm: high_hip != null ? high_hip * IN : null,
    });

  test.each([
    [36, 25, 36, undefined, "hourglass"],
    [34, 26, 39, 30, "bottom_hourglass"],
    [38, 28, 36, undefined, "top_hourglass"],
    [33, 26, 37, 33, "spoon"],
    [34, 31, 39, undefined, "triangle"],
    [40, 34, 35, undefined, "inverted_triangle"],
    [34, 29, 35, undefined, "rectangle"],
  ])("%p-%p-%p (high hip %p) → %p", (b, w, h, hh, shape) => {
    expect(f(b, w, h, hh).shape).toBe(shape as never);
  });

  test("WHR risk bands", () => {
    expect(f(36, 25, 36).whr_risk).toBe("low");
    expect(f(36, 30, 36).whr_risk).toBe("moderate"); // 0.83
    expect(f(36, 31, 36).whr_risk).toBe("high"); // 0.86
  });
});

describe("classifyBodyShape — men (Alfrik + taper fallback)", () => {
  const m = (chest: number, waist: number, hips: number, shoulders?: number) =>
    classifyBodyShape({
      sex: "male",
      chest_cm: chest * IN,
      waist_cm: waist * IN,
      hips_cm: hips * IN,
      shoulders_cm: shoulders != null ? shoulders * IN : null,
    });

  test.each([
    [40, 33, 39, "trapezoid"],
    [38, 36, 41, "triangle"],
    [38, 34, 38, "rectangle"],
    [46, 32, 38, "v_taper"],
    [40, 44, 41, "oval"],
  ])("%p/%p/%p → %p", (c, w, h, shape) => {
    expect(m(c, w, h).shape).toBe(shape as never);
  });

  test("falls back to the taper when no rule matches", () => {
    // chest 3in over hips, small taper: none of the Alfrik rules fire.
    const r = m(40, 36, 37);
    expect(r.shape).toBe("rectangle");
    expect(r.notes.join(" ")).toContain("between the standard");
  });

  test("shoulders drive the taper ratio when given", () => {
    const r = m(40, 33, 39, 52);
    expect(r.taper_basis).toBe("shoulders");
    expect(r.taper_ratio).toBeCloseTo(1.58, 2);
  });
});
