import { describe, expect, test } from "bun:test";
import { computeStepCalories, computeWaterIntake } from "./lifestyle.ts";

describe("computeWaterIntake", () => {
  test("35 ml/kg + 600 ml per exercise hour + 500 ml when hot", () => {
    const r = computeWaterIntake({ weight_kg: 80, exercise_min: 60, climate: "hot", sex: "male" });
    expect(r.base_ml).toBe(2800);
    expect(r.exercise_ml).toBe(600);
    expect(r.climate_ml).toBe(500);
    expect(r.total_ml).toBe(3900);
    expect(r.glasses).toBe(16);
    expect(r.efsa_total_ml).toBe(2500);
  });
});

describe("computeStepCalories", () => {
  test("10k brisk steps for an 80 kg, 180 cm man", () => {
    const r = computeStepCalories({ steps: 10000, weight_kg: 80, height_cm: 180, sex: "male" });
    expect(r.stride_cm).toBe(75);
    expect(r.distance_km).toBeCloseTo(7.47, 2);
    expect(r.minutes).toBe(80);
    expect(r.kcal).toBe(426);
    expect(r.net_kcal).toBe(314);
    expect(r.step_goal).toEqual({ low: 8000, high: 10000 });
  });

  test("over-60s get the lower goal band", () => {
    const r = computeStepCalories({
      steps: 3000,
      weight_kg: 70,
      height_cm: 165,
      sex: "female",
      age: 65,
    });
    expect(r.step_goal).toEqual({ low: 6000, high: 8000 });
    expect(r.pct_of_goal).toBe(50);
  });
});
