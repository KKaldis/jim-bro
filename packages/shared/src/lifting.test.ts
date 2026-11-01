import { describe, expect, test } from "bun:test";
import { computeRpe, computeTrainingVolume, computeWarmupSets, rpePercent } from "./lifting.ts";

describe("rpePercent", () => {
  test("matches the RTS chart", () => {
    expect(rpePercent(1, 10)).toBe(100);
    expect(rpePercent(1, 9)).toBe(95.5);
    expect(rpePercent(5, 8)).toBe(81.1);
    expect(rpePercent(10, 10)).toBe(73.9);
    expect(rpePercent(12, 6)).toBe(57.4);
  });

  test("rejects off-chart input", () => {
    expect(() => rpePercent(13, 8)).toThrow();
    expect(() => rpePercent(5, 8.25)).toThrow();
  });
});

describe("computeRpe", () => {
  test("100 kg × 5 @ 8 → e1RM and a single @ 8", () => {
    const r = computeRpe({ weight_kg: 100, reps: 5, rpe: 8 });
    expect(r.e1rm_kg).toBeCloseTo(123.3, 1);
    expect(r.rir).toBe(2);
    expect(r.target_kg).toBe(113.5);
    expect(r.rep_loads).toHaveLength(10);
  });
});

describe("computeWarmupSets", () => {
  test("ramps to a 140 kg top set in 2.5 kg steps", () => {
    const r = computeWarmupSets({ top_kg: 140 });
    expect(r.sets.map((s) => s.load)).toEqual([20, 55, 82.5, 105, 117.5]);
    expect(r.top.per_side).toEqual([
      { plate_kg: 25, count: 2 },
      { plate_kg: 10, count: 1 },
    ]);
  });

  test("adds a heavy single before a triple", () => {
    const r = computeWarmupSets({ top_kg: 140, top_reps: 3 });
    expect(r.sets.at(-1)!.load).toBe(127.5);
  });

  test("pounds use 5 lb steps on a 45 lb bar", () => {
    const r = computeWarmupSets({ top_kg: 315, unit: "lb" });
    expect(r.sets.map((s) => s.load)).toEqual([45, 125, 185, 235, 265]);
  });
});

describe("computeTrainingVolume", () => {
  test("tonnage and weekly sets per primary group", () => {
    const r = computeTrainingVolume({
      entries: [
        { exercise_id: "barbell_bench_press", sets: 4, reps: 8, weight_kg: 80 },
        { exercise_id: "back_squat", sets: 3, reps: 5, weight_kg: 120 },
      ],
      sessions_per_week: 2,
    });
    expect(r.session_tonnage_kg).toBe(4 * 8 * 80 + 3 * 5 * 120);
    expect(r.weekly_tonnage_kg).toBe(2 * (4 * 8 * 80 + 3 * 5 * 120));
    const chest = r.muscles.find((m) => m.group === "chest")!;
    expect(chest.weekly_sets).toBe(8);
    expect(chest.verdict).toBe("under");
  });
});
