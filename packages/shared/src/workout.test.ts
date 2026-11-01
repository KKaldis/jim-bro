import { describe, expect, test } from "bun:test";
import {
  EXERCISES,
  getExercise,
  MUSCLES,
  MUSCLE_TARGETS,
  MUSCLE_TO_TARGET,
  resolveExerciseRef,
  searchExercises,
  targetsForExercise,
} from "./workout.ts";
import { exerciseFields, isTimedExercise } from "./workout-types.ts";

describe("muscle targets", () => {
  test("every muscle sits in exactly one target", () => {
    for (const m of MUSCLES) {
      const owners = MUSCLE_TARGETS.filter((t) => t.muscles.includes(m.id));
      expect(owners.map((t) => t.id)).toHaveLength(1);
    }
    // No target names a muscle the taxonomy doesn't have.
    const known = new Set(MUSCLES.map((m) => m.id));
    for (const t of MUSCLE_TARGETS) for (const m of t.muscles) expect(known.has(m)).toBe(true);
  });

  test("every exercise lands in at least one target", () => {
    const orphans = EXERCISES.filter((e) => targetsForExercise(e).length === 0).map((e) => e.id);
    expect(orphans).toEqual([]);
  });

  test("calves and forearms are searchable on their own", () => {
    const calves = searchExercises({ target: "calves" });
    expect(calves.length).toBeGreaterThan(0);
    expect(
      calves.every((e) => e.primary_muscles.some((m) => MUSCLE_TO_TARGET[m] === "calves")),
    ).toBe(true);
    expect(searchExercises({ target: "forearms" }).length).toBeGreaterThan(0);
  });
});

describe("exerciseFields", () => {
  const fieldsOf = (id: string) => exerciseFields(getExercise(id));

  test("lifts use reps + weight", () => {
    expect(fieldsOf("barbell_bench_press")).toEqual({
      reps: true,
      weight: true,
      duration: false,
      distance: false,
    });
  });

  test("timed holds use duration + weight, no reps", () => {
    expect(fieldsOf("plank")).toEqual({
      reps: false,
      weight: true,
      duration: true,
      distance: false,
    });
    expect(isTimedExercise(getExercise("side_plank"))).toBe(true);
  });

  test("cardio uses duration + distance", () => {
    expect(fieldsOf("treadmill_run")).toEqual({
      reps: false,
      weight: false,
      duration: true,
      distance: true,
    });
  });

  test("an unknown id falls back to reps + weight", () => {
    expect(exerciseFields(null)).toEqual({
      reps: true,
      weight: true,
      duration: false,
      distance: false,
    });
  });
});

describe("resolveExerciseRef", () => {
  test.each([
    ["barbell_bench_press", "barbell_bench_press"],
    ["Barbell Bench Press", "barbell_bench_press"],
    ["lat pulldown", "lat_pulldown"],
    ["romanian deadlift", "romanian_deadlift"],
    ["pull up", "pullup"],
    ["skull crusher", "skullcrusher"],
    ["triceps pushdown", "tricep_pushdown"],
  ])("%s resolves to %s", (ref, id) => {
    const r = resolveExerciseRef(ref);
    expect(r.ok && r.exercise.id).toBe(id);
  });

  test.each([
    // plurals and spelling
    ["pull-ups", "pullup"],
    ["face pulls", "face_pull"],
    ["cable flyes", "cable_fly"],
    // equipment named in the query but not in the catalog name
    ["barbell back squat", "back_squat"],
    // an equipment-only tie goes to the conventional default
    ["bench press", "barbell_bench_press"],
    ["overhead press", "overhead_press_barbell"],
    ["lateral raise", "lateral_raise_dumbbell"],
    // ...unless the query says which
    ["dumbbell bench press", "dumbbell_bench_press"],
    ["cable lateral raise", "lateral_raise_cable"],
  ])("%s resolves to %s", (ref, id) => {
    const r = resolveExerciseRef(ref);
    expect(r.ok && r.exercise.id).toBe(id);
  });

  test("a tie between real variants is ambiguous and returns them", () => {
    const r = resolveExerciseRef("leg curl");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates.map((e) => e.id)).toContain("leg_curl_seated");
  });

  test("an alias the gym can't do falls through to normal matching", () => {
    const noSled = (e: { id: string }) => e.id !== "sled_leg_press";
    expect(resolveExerciseRef("leg press").ok).toBe(true);
    const r = resolveExerciseRef("leg press", { available: noSled });
    expect(r.ok ? r.exercise.id : r.candidates.map((e) => e.id)).not.toContain("sled_leg_press");
  });

  test.each([
    // qualifiers the catalog leaves implicit
    ["barbell bent over row", "barbell_row"],
    ["conventional deadlift", "deadlift"],
    ["standing barbell overhead press", "overhead_press_barbell"],
    // ...but a catalog name that contains one still matches exactly
    ["standing leg curl", "standing_leg_curl"],
    // shorthand for the default variant (never the Smith machine one)
    ["barbell squat", "back_squat"],
    ["RDL", "romanian_deadlift"],
    ["ohp", "overhead_press_barbell"],
  ])("%s resolves to %s", (ref, id) => {
    const r = resolveExerciseRef(ref);
    expect(r.ok && r.exercise.id).toBe(id);
  });

  test("the availability filter narrows names but never an explicit id", () => {
    const noMachines = (e: { machine_id?: string }) => !e.machine_id;
    const byName = resolveExerciseRef("lat pulldown", { available: noMachines });
    expect(byName.ok && byName.exercise.id).not.toBe("lat_pulldown");
    const byId = resolveExerciseRef("lat_pulldown", { available: noMachines });
    expect(byId.ok && byId.exercise.id).toBe("lat_pulldown");
  });

  test("nonsense resolves to nothing", () => {
    const r = resolveExerciseRef("zzzz qqqq");
    expect(r.ok).toBe(false);
  });
});
