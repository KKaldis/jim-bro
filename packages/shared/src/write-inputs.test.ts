import { describe, expect, test } from "bun:test";

import {
  normalizeDietPlanWrite,
  normalizePortion,
  normalizeWeekdays,
  normalizeWorkoutPlanWrite,
  normalizeWorkoutSet,
  WriteInputError,
} from "./write-inputs.ts";

describe("normalizeWeekdays", () => {
  test("accepts an array, a legacy single string, or nothing", () => {
    expect(normalizeWeekdays(["Monday", " friday ", "monday"])).toEqual(["monday", "friday"]);
    expect(normalizeWeekdays("Tuesday")).toEqual(["tuesday"]);
    expect(normalizeWeekdays(undefined)).toEqual([]);
  });

  test("rejects unknown names instead of dropping them", () => {
    expect(() => normalizeWeekdays(["mon"])).toThrow(WriteInputError);
  });
});

describe("normalizeWorkoutPlanWrite", () => {
  const plan = (exercise: Record<string, unknown>) => ({
    name: " Push ",
    days: [{ weekdays: ["monday"], exercises: [exercise] }],
  });

  test("keeps cardio / timed-hold durations (and nulls their reps)", () => {
    const run = normalizeWorkoutPlanWrite(
      plan({ exercise_id: "treadmill_run", target_sets: 1, target_duration_sec: 1800 }),
    );
    expect(run.days[0].exercises[0]).toMatchObject({
      target_duration_sec: 1800,
      target_reps: null,
    });
    const hold = normalizeWorkoutPlanWrite(
      plan({ exercise_id: "plank", target_sets: 3, target_duration_sec: 60 }),
    );
    expect(hold.days[0].exercises[0].target_duration_sec).toBe(60);
  });

  test("defaults sets, names the day, trims the plan name", () => {
    const out = normalizeWorkoutPlanWrite(plan({ exercise_id: "barbell_bench_press" }));
    expect(out.name).toBe("Push");
    expect(out.days[0].name).toBe("Day 1");
    expect(out.days[0].exercises[0]).toMatchObject({ target_sets: 3, target_reps: null });
  });

  test("rejects unknown catalog ids and non-positive targets", () => {
    expect(() => normalizeWorkoutPlanWrite(plan({ exercise_id: "not_a_thing" }))).toThrow(
      /unknown exercise_id/,
    );
    expect(() =>
      normalizeWorkoutPlanWrite(plan({ exercise_id: "barbell_bench_press", target_sets: 0 })),
    ).toThrow(/target_sets must be > 0/);
  });
});

describe("normalizeWorkoutSet", () => {
  test("cardio sets default reps/weight to 0", () => {
    expect(
      normalizeWorkoutSet({ exercise_id: "treadmill_run", duration_sec: 600.4 }),
    ).toMatchObject({ reps: 0, weight_kg: 0, duration_sec: 600 });
  });

  test("strength sets need reps > 0 and floor them", () => {
    expect(() => normalizeWorkoutSet({ exercise_id: "barbell_bench_press", reps: 0 })).toThrow(
      /reps must be > 0/,
    );
    expect(normalizeWorkoutSet({ exercise_id: "barbell_bench_press", reps: 5.7 }).reps).toBe(5);
  });
});

describe("diet plan", () => {
  test("portions need a food and grams > 0", () => {
    expect(normalizePortion({ food: " oats ", grams: 80 })).toEqual({ food: "oats", grams: 80 });
    expect(() => normalizePortion({ food: "oats", grams: 0 })).toThrow(/grams > 0/);
  });

  test("plan write normalizes days, meals and weekdays", () => {
    const out = normalizeDietPlanWrite({
      start_date: "2026-01-05",
      days: [{ weekdays: "Monday", meals: [{ slot: " breakfast ", time: "", items: [] }] }],
    });
    expect(out.days[0]).toMatchObject({
      name: "Day 1",
      weekdays: ["monday"],
      meals: [{ slot: "breakfast", time: null, items: [] }],
    });
    expect(() => normalizeDietPlanWrite({ start_date: "jan 5", days: [] })).toThrow(/start_date/);
  });
});
