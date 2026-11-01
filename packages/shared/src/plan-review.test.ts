import { describe, expect, test } from "bun:test";
import { reviewTrainingPlan } from "./plan-review.ts";
import { computeIdealProportions } from "./proportions.ts";
import type { WorkoutPlan } from "./workout-types.ts";

const ex = (id: number, exercise_id: string, target_sets: number) => ({
  id,
  exercise_id,
  order: id,
  target_sets,
});

const PLAN: WorkoutPlan = {
  id: 9,
  name: "Upper / Lower",
  days: [
    {
      id: 1,
      weekdays: ["monday", "thursday"],
      name: "Upper",
      exercises: [ex(1, "barbell_bench_press", 4), ex(2, "lateral_raise_dumbbell", 3)],
    },
    {
      id: 2,
      weekdays: ["tuesday"],
      name: "Lower",
      exercises: [ex(3, "back_squat", 4), ex(4, "treadmill_run", 1), ex(5, "not_a_real_lift", 3)],
    },
    { id: 3, weekdays: [], name: "Arms (optional)", exercises: [ex(6, "barbell_curl", 3)] },
  ],
};

// A frame where the arm lags most, then chest and calf.
const PROPORTIONS = computeIdealProportions({
  sex: "male",
  wrist_cm: 17.8,
  measurements: { chest: 104, arm: 36, calf: 36, shoulders: 120, waist: 82, thigh: 60 },
});

describe("reviewTrainingPlan", () => {
  const r = reviewTrainingPlan(PLAN, PROPORTIONS);
  const part = (p: string) => r.parts.find((x) => x.part === p)!;

  test("counts weekly sets per scheduled weekday, unscheduled days once", () => {
    // Upper ×2 (4+3 sets), Lower ×1 (4 sets; cardio + unknown skipped), Arms ×1 (3).
    expect(r.sessions_per_week).toBe(4);
    expect(r.total_weekly_sets).toBe(2 * 7 + 4 + 3);
    expect(r.unscheduled_days).toBe(1);
    expect(r.unknown_exercise_ids).toEqual(["not_a_real_lift"]);
  });

  test("primary sets count 1, secondary 0.5", () => {
    // Bench is primary chest (8/wk); lateral raises don't touch chest.
    expect(part("chest").weekly_sets).toBe(8);
    // Curls primary (3) + bench's secondary triceps (8 × 0.5).
    expect(part("arm").weekly_sets).toBe(3 + 4);
    // Treadmill is cardio, so calves get nothing.
    expect(part("calf").weekly_sets).toBe(0);
  });

  test("lagging parts are held to the priority floor and surface as gaps", () => {
    expect(part("arm").priority_rank).not.toBeNull();
    expect(part("arm").target_min).toBe(12);
    expect(part("arm").verdict).toBe("under");
    expect(r.gaps).toContain("arm");
    expect(r.gaps).toContain("calf");
    // Gaps come out in priority order.
    const ranks = r.gaps.map((g) => part(g).priority_rank!);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  test("reports structural issues alongside volume", () => {
    expect(r.days.map((d) => d.name)).toEqual(["Upper", "Lower", "Arms (optional)"]);
    expect(r.issues).toContainEqual({ kind: "unscheduled_days", days: ["Arms (optional)"] });
    // bench, lateral raise, squat, curl — none has a target weight (cardio and
    // the unknown id don't count).
    expect(r.issues).toContainEqual({ kind: "missing_target_weights", exercises: 4 });
    expect(r.issues.some((i) => i.kind === "long_sessions")).toBe(false);
  });

  test("screen_totals match the app's Muscle totals: primary only, full credit", () => {
    const chest = r.screen_totals.groups.find((g) => g.label === "Chest");
    // Bench 4 sets × 2 days; its secondary triceps don't count here.
    expect(chest?.sets).toBe(8);
    expect(r.screen_totals.groups.find((g) => g.label === "Triceps")).toBeUndefined();
    // ...while `parts` credits the triceps half a set each (arm = curls 3 + 4).
    expect(part("arm").weekly_sets).toBe(7);
    expect(r.screen_totals.targets.length).toBeGreaterThan(0);
  });

  test("cardio never counts as muscle sets on the screen totals", () => {
    // The Lower day's treadmill run is the plan's only calf "work".
    expect(r.screen_totals.targets.find((t) => t.label === "Calves & Shins")).toBeUndefined();
  });

  test("the waist never gets a volume row", () => {
    expect(r.parts.some((p) => p.part === "waist")).toBe(false);
  });
});
