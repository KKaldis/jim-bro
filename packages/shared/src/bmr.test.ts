import { describe, expect, test } from "bun:test";
import {
  computeBmrFromInputs,
  computeCalorieDeficit,
  computeIdealWeight,
  computeProteinTarget,
  computeLeanBodyMass,
  estimateBodyFatArmy,
  MIN_INTAKE_KCAL,
} from "./bmr.ts";

describe("computeProteinTarget", () => {
  test("matches the TDEE macro split's protein for the same inputs", () => {
    const tdee = computeBmrFromInputs({
      sex: "male",
      weight_kg: 82,
      height_cm: 180,
      age: 32,
      body_fat_pct: 15,
      activity_level: "moderate",
      goal: "cut",
    });
    const p = computeProteinTarget({ weight_kg: 82, body_fat_pct: 15, goal: "cut" });
    expect(p.protein_g).toBe(tdee.daily_target!.p);
    expect(p.basis).toBe("lean_mass");
  });

  test("falls back to bodyweight without body fat", () => {
    const p = computeProteinTarget({ weight_kg: 80, goal: "maintain" });
    expect(p.protein_g).toBe(176);
    expect(p.basis).toBe("bodyweight");
    expect(p.per_meal_g).toBe(44);
    expect(p.rda_g).toBe(64);
  });
});

describe("computeIdealWeight", () => {
  test("Devine at 6 ft is 77.6 kg for a man", () => {
    const r = computeIdealWeight({ sex: "male", height_cm: 72 * 2.54 });
    expect(r.devine_kg).toBeCloseTo(77.6, 1);
    expect(r.robinson_kg).toBeCloseTo(74.8, 1);
    expect(r.hamwi_kg).toBeCloseTo(80.4, 1);
  });

  test("every formula returns its base weight at exactly 5 ft", () => {
    const r = computeIdealWeight({ sex: "female", height_cm: 60 * 2.54 });
    expect(r.devine_kg).toBe(45.5);
    expect(r.robinson_kg).toBe(49);
    expect(r.miller_kg).toBe(53.1);
    expect(r.notes).toHaveLength(1);
  });
});

describe("computeCalorieDeficit", () => {
  const base = {
    sex: "male" as const,
    age: 32,
    weight_kg: 90,
    height_cm: 180,
    activity_level: "moderate" as const,
    goal_weight_kg: 80,
  };

  test("0.5%/week from 90 kg is a ~495 kcal deficit", () => {
    const r = computeCalorieDeficit({ ...base, weekly_loss_pct: 0.5 });
    expect(r.daily_deficit).toBeCloseTo(495, -1);
    expect(r.weekly_loss_kg).toBeCloseTo(0.45, 2);
    expect(r.weeks).toBe(23);
    expect(r.capped).toBe(false);
  });

  test("caps at the minimum intake and stretches the timeline", () => {
    const r = computeCalorieDeficit({
      ...base,
      sex: "female",
      weight_kg: 60,
      height_cm: 160,
      goal_weight_kg: 55,
      activity_level: "sedentary",
      weekly_loss_pct: 1.5,
    });
    expect(r.capped).toBe(true);
    expect(r.daily_kcal).toBe(MIN_INTAKE_KCAL.female);
  });

  test("rejects a goal above current weight", () => {
    expect(() =>
      computeCalorieDeficit({ ...base, goal_weight_kg: 95, weekly_loss_pct: 0.5 }),
    ).toThrow();
  });
});

describe("estimateBodyFatArmy", () => {
  test("180 lb man with a 36 in waist", () => {
    const r = estimateBodyFatArmy({
      sex: "male",
      weight_kg: 180 / 2.2046226218,
      waist_cm: 36 * 2.54,
    });
    expect(r.body_fat_pct).toBe(23.1);
  });
});

describe("computeLeanBodyMass", () => {
  test("Boer without body fat, body fat when given", () => {
    const a = computeLeanBodyMass({ sex: "male", weight_kg: 80, height_cm: 180 });
    expect(a.basis).toBe("boer");
    expect(a.lean_mass_kg).toBe(61.4);
    const b = computeLeanBodyMass({ sex: "male", weight_kg: 80, height_cm: 180, body_fat_pct: 15 });
    expect(b.lean_mass_kg).toBe(68);
    expect(b.fat_mass_kg).toBe(12);
  });
});
