// Single source of truth for mapping a StrengthLevel slug/name to our
// workout-catalog ExerciseId. Imported by BOTH generators so they can never
// drift out of sync:
//   - scripts/strength-standards/generate.mjs sets catalog_id on each standards row
//   - scripts/exercise-catalog/generate.mjs decides which lifts still need a
//     catalog entry (any id not already hand-curated goes into exercises-extra.ts)
// If these two disagreed, a lift's standards catalog_id would point at a catalog
// entry that doesn't exist — which is exactly what centralizing this prevents.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The hand-curated catalog names/ids the standards generator matches against. */
export const CATALOG_JSON = path.resolve(__dirname, "../strength-standards/catalog.json");

// StrengthLevel slug -> our workout-catalog ExerciseId. Only confident matches;
// everything else falls back to a normalized-name match, then snake(slug).
export const CATALOG_OVERRIDES = {
  "bench-press": "barbell_bench_press",
  squat: "back_squat",
  deadlift: "deadlift",
  "shoulder-press": "overhead_press_barbell",
  "military-press": "overhead_press_barbell",
  "bent-over-row": "barbell_row",
  "incline-bench-press": "incline_barbell_bench_press",
  "front-squat": "front_squat",
  "romanian-deadlift": "romanian_deadlift",
  "close-grip-bench-press": "close_grip_bench_press",
  "dumbbell-bench-press": "dumbbell_bench_press",
  "incline-dumbbell-bench-press": "incline_dumbbell_press",
  "dumbbell-shoulder-press": "overhead_press_dumbbell",
  "machine-shoulder-press": "shoulder_press_machine_ex",
  "chest-press": "machine_chest_press",
  "lying-tricep-extension": "skullcrusher",
  "dumbbell-curl": "dumbbell_curl",
  "barbell-curl": "barbell_curl",
  "hammer-curl": "hammer_curl",
  "preacher-curl": "preacher_curl",
  "dumbbell-row": "dumbbell_row",
  "t-bar-row": "tbar_row",
  "seated-cable-row": "seated_cable_row",
  "lat-pulldown": "lat_pulldown",
  "tricep-pushdown": "tricep_pushdown",
  "barbell-shrug": "shrug_barbell",
  "dumbbell-shrug": "shrug_dumbbell",
  "hip-thrust": "hip_thrust",
  "glute-bridge": "glute_bridge",
  "hack-squat": "hack_squat",
  "leg-extension": "leg_extension",
  "seated-leg-curl": "leg_curl_seated",
  "lying-leg-curl": "leg_curl_lying",
  "dumbbell-bulgarian-split-squat": "bulgarian_split_squat",
  "wrist-curl": "wrist_curl",
  "back-extension": "hyperextension",
  "good-morning": "good_morning",
  "upright-row": "upright_row",
  "arnold-press": "arnold_press",
  "dumbbell-lateral-raise": "lateral_raise_dumbbell",
  "dumbbell-front-raise": "front_raise_dumbbell",
  "dumbbell-fly": "dumbbell_fly",
  "glute-kickback": "glute_kickback",
  crunches: "crunch",
  "russian-twist": "russian_twist",
  "hanging-leg-raise": "hanging_leg_raise",
  "push-ups": "pushup",
  "pull-ups": "pullup",
  "chin-ups": "chinup",
  dips: "dip_triceps",
  "stiff-leg-deadlift": "stiff_leg_deadlift",
  plank: "plank",
};

// Crawled (exercises-extra.ts) catalog id -> the gym machine it's performed
// on, so they show up in the machine filter. StrengthLevel has no machine
// data; hand-curated entries set machine_id directly in exercises.ts.
export const CATALOG_MACHINES = {
  machine_lateral_raise: "lateral_raise_machine",
  hip_abduction: "hip_abductor_machine",
  hip_adduction: "hip_adductor_machine",
  cable_woodchopper: "cable_crossover",
  cable_bicep_curl: "cable_crossover",
  cable_fly: "cable_crossover",
  machine_reverse_fly: "rear_delt_fly_machine",
  machine_seated_crunch: "ab_crunch_machine",
  machine_chest_fly: "pec_deck_machine",
  sled_leg_press: "leg_press_machine",
  machine_calf_raise: "calf_raise_machine",
};

/** Normalize a display name for fuzzy matching (case/punctuation-insensitive). */
export const normName = (s) =>
  s
    .toLowerCase()
    .replace(/&lt;/g, "<")
    .replace(/[^a-z0-9]+/g, "");

/** Fallback id when a slug has no override / name match: snake_case the slug. */
export const slugToId = (slug) => slug.replace(/-/g, "_");

/** The hand-curated catalog as [{ id, name }]. */
export function readCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_JSON, "utf8"));
}

/** Map of normalized catalog name -> catalog id, for name matching. */
export function buildCatalogByNorm(catalog = readCatalog()) {
  return new Map(catalog.map((c) => [normName(c.name), c.id]));
}

/**
 * Resolve a StrengthLevel slug + display name to a workout-catalog ExerciseId:
 * explicit override > normalized-name match > snake(slug). Never returns null —
 * every lift gets a catalog id (an existing hand-curated one, or one added to
 * exercises-extra.ts by scripts/exercise-catalog/generate.mjs).
 */
export function resolveCatalogId(slug, name, byNorm) {
  return CATALOG_OVERRIDES[slug] ?? byNorm.get(normName(name)) ?? slugToId(slug);
}
