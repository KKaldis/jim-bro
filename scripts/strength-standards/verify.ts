import {
  computeOneRepMax,
  computeStrengthStandards,
  computePowerliftingScore,
  computeStrengthSymmetry,
  computePlateRacking,
  wilksScore,
} from "../../packages/shared/src/strength.ts";

let pass = 0,
  fail = 0;
function check(label: string, got: unknown, want: unknown, tol = 0) {
  const ok =
    typeof got === "number" && typeof want === "number"
      ? Math.abs(got - want) <= tol
      : JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "✓" : "✗"} ${label}: got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`,
  );
  if (ok) pass++;
  else fail++;
}

// ---- 1RM ----
check("1RM epley 100x5", computeOneRepMax({ weight_kg: 100, reps: 5 }).one_rep_max_kg, 116.7, 0.1);
check("1RM brzycki 100x5", computeOneRepMax({ weight_kg: 100, reps: 5 }).brzycki_kg, 112.5, 0.1);
check(
  "1RM rep table 1rep=100%",
  computeOneRepMax({ weight_kg: 100, reps: 1 }).rep_table[0].percent_of_1rm,
  100,
);

// ---- Strength standards vs StrengthLevel bench male tables ----
// male BW90 row = [62,84,111,141,172]
const b90 = computeStrengthStandards({
  exercise: "bench-press",
  sex: "male",
  bodyweight_kg: 90,
  one_rep_max_kg: 111,
});
check(
  "bench male bw90 thresholds",
  [
    b90.thresholds.beginner,
    b90.thresholds.novice,
    b90.thresholds.intermediate,
    b90.thresholds.advanced,
    b90.thresholds.elite,
  ],
  [62, 84, 111, 141, 172],
);
check("bench male bw90 @111 = intermediate", b90.level, "intermediate");
check("bench male bw90 @111 percentile≈50", b90.percentile, 50, 1);
const b90adv = computeStrengthStandards({
  exercise: "barbell_bench_press",
  sex: "male",
  bodyweight_kg: 90,
  one_rep_max_kg: 141,
});
check("bench via catalog_id @141 = advanced", b90adv.level, "advanced");
check("bench @141 percentile≈80", b90adv.percentile, 80, 1);
// interpolation: bw 92.5 between 90[62..] and 95[67,89,116,147,180]
const b925 = computeStrengthStandards({
  exercise: "bench-press",
  sex: "male",
  bodyweight_kg: 92.5,
  one_rep_max_kg: 100,
});
check(
  "bench bw92.5 intermediate interp (111+116)/2=113.5",
  b925.thresholds.intermediate,
  113.5,
  0.01,
);
// age: male 60yo multiplier 0.7469
const bAge = computeStrengthStandards({
  exercise: "bench-press",
  sex: "male",
  bodyweight_kg: 90,
  one_rep_max_kg: 100,
  age: 60,
});
check("bench age60 int = 111*0.7469≈82.9", bAge.thresholds.intermediate, 82.9, 0.2);
// derive 1RM from weight+reps
const bReps = computeStrengthStandards({
  exercise: "bench-press",
  sex: "male",
  bodyweight_kg: 90,
  weight_kg: 100,
  reps: 5,
});
check("bench weight+reps -> perf 116.7", bReps.performance, 116.7, 0.1);
// reps-based exercise (push-ups)
const pu = computeStrengthStandards({
  exercise: "push-ups",
  sex: "male",
  bodyweight_kg: 80,
  reps: 40,
});
check("push-ups metric=reps", pu.metric, "reps");
check("push-ups perf unit reps", pu.performance_unit, "reps");
// bodyweight_load (pull-ups added kg)
const pull = computeStrengthStandards({
  exercise: "pull-ups",
  sex: "male",
  bodyweight_kg: 80,
  one_rep_max_kg: 30,
});
check("pull-ups metric=bodyweight_load", pull.metric, "bodyweight_load");

// ---- Powerlifting ----
const pl = computePowerliftingScore({
  sex: "male",
  bodyweight_kg: 100,
  squat_kg: 220,
  bench_kg: 160,
  deadlift_kg: 250,
});
check("PL total 630", pl.total_kg, 630);
console.log(`   wilks=${pl.wilks} dots=${pl.dots} ipf_gl=${pl.ipf_gl}`);
// Wilks sanity: 90kg male 500kg total ~ known ≈ 328-333
console.log("   wilks 90kg/500 =", wilksScore("male", 90, 500));

// ---- symmetry ----
const sym = computeStrengthSymmetry({
  sex: "male",
  bodyweight_kg: 90,
  lifts: [
    { exercise: "bench-press", one_rep_max_kg: 141 }, // advanced
    { exercise: "squat", one_rep_max_kg: 100 }, // low
  ],
});
check("symmetry weakest = squat", sym.weakest?.exercise, "squat");
console.log(`   symmetry_pct=${sym.symmetry_pct} spread=${sym.spread_percentile}`);

// ---- plate racking ----
const pr = computePlateRacking({ target_kg: 100, bar_kg: 20 });
check("plates 100kg exact", pr.exact, true);
check("plates 100kg per side", pr.per_side, [
  { plate_kg: 25, count: 1 },
  { plate_kg: 15, count: 1 },
]);
const pr2 = computePlateRacking({ target_kg: 142.5, bar_kg: 20 });
check("plates 142.5 exact", pr2.exact, true);
console.log("   142.5 per side:", JSON.stringify(pr2.per_side));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
