// Runtime smoke test of the agent tool path for the strength calculators.
import { executeTool } from "../../packages/agent/src/tools.ts";

const storage = {} as never; // strength calculators don't touch storage

async function call(name: string, input: Record<string, unknown>) {
  const out = await executeTool(name, input, storage);
  const parsed = JSON.parse(out);
  const err = parsed.error ? ` ERROR=${parsed.error}` : "";
  console.log(`\n# ${name}(${JSON.stringify(input)})${err}`);
  return parsed;
}

const r1 = await call("compute_one_rep_max", { weight_kg: 100, reps: 5 });
console.log("  1RM:", r1.one_rep_max_kg, "rep_table[4]:", r1.rep_table?.[4]);

const r2 = await call("assess_strength_level", {
  exercise: "bench-press",
  sex: "male",
  bodyweight_kg: 90,
  one_rep_max_kg: 141,
});
console.log("  level:", r2.level, "pct:", r2.percentile, "next:", JSON.stringify(r2.next_level));

const r2b = await call("assess_strength_level", {
  exercise: "push-ups",
  sex: "male",
  bodyweight_kg: 80,
  reps: 40,
});
console.log("  push-ups level:", r2b.level, "metric:", r2b.metric, "unit:", r2b.performance_unit);

const r2c = await call("assess_strength_level", {
  exercise: "squat",
  sex: "male",
  units: "imperial",
  bodyweight_lb: 200,
  weight_lb: 315,
  reps: 3,
});
console.log(
  "  squat(imperial) level:",
  r2c.level,
  "perf(kg):",
  r2c.performance,
  "conv:",
  JSON.stringify(r2c.conversions),
);

const r3 = await call("compute_powerlifting_score", {
  sex: "male",
  bodyweight_kg: 100,
  squat_kg: 220,
  bench_kg: 160,
  deadlift_kg: 250,
});
console.log("  wilks:", r3.wilks, "dots:", r3.dots, "ipf_gl:", r3.ipf_gl, "total:", r3.total_kg);

const r4 = await call("strength_symmetry", {
  sex: "male",
  bodyweight_kg: 90,
  lifts: [
    { exercise: "bench-press", one_rep_max: 141 },
    { exercise: "squat", one_rep_max: 120 },
    { exercise: "deadlift", one_rep_max: 140 },
  ],
});
console.log(
  "  symmetry:",
  r4.symmetry_pct,
  "weakest:",
  r4.weakest?.exercise,
  "spread:",
  r4.spread_percentile,
);

const r5 = await call("plate_barbell_racking", { target_kg: 142.5 });
console.log(
  "  per_side:",
  JSON.stringify(r5.per_side),
  "loaded:",
  r5.loaded,
  "exact:",
  r5.exact,
  "unit:",
  r5.unit,
);

const r5b = await call("plate_barbell_racking", { units: "imperial", target_lb: 225 });
console.log("  imperial per_side:", JSON.stringify(r5b.per_side), "loaded:", r5b.loaded, r5b.unit);

// error path
const err = await call("assess_strength_level", {
  exercise: "not-a-real-lift",
  sex: "male",
  bodyweight_kg: 80,
  one_rep_max_kg: 100,
});
console.log("  bad-exercise handled:", !!err.error);

console.log("\nsmoke test done");
