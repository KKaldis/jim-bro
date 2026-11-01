import { describe, expect, test } from "bun:test";
import { computeHeartRateZones, computeVo2Max } from "./cardio.ts";

describe("computeHeartRateZones", () => {
  test("percent of max, Tanaka estimate at 40", () => {
    const r = computeHeartRateZones({ age: 40 });
    expect(r.max_heart_rate).toBe(180);
    expect(r.method).toBe("percent_max");
    expect(r.zones[1]).toMatchObject({ low_bpm: 108, high_bpm: 126 });
    expect(r.zones[4].high_bpm).toBe(180);
  });

  test("Karvonen with a resting heart rate", () => {
    const r = computeHeartRateZones({ age: 40, resting_heart_rate: 60, max_heart_rate: 190 });
    expect(r.method).toBe("karvonen");
    // 60 + 0.6 × 130 = 138, 60 + 0.7 × 130 = 151
    expect(r.zones[1]).toMatchObject({ low_bpm: 138, high_bpm: 151 });
  });

  test("agrees with the VO2max estimate on max heart rate", () => {
    const z = computeHeartRateZones({ age: 33 });
    const v = computeVo2Max({ age: 33, sex: "male", resting_heart_rate: 60 });
    expect(z.max_heart_rate).toBe(v.max_heart_rate);
  });
});
