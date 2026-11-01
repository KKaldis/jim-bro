/**
 * Static catalog of common strength + cardio exercises.
 *
 * Each exercise links to specific muscles (primary + secondary). The muscle
 * group is derived via MUSCLE_TO_GROUP — never duplicated here. When the
 * exercise is performed on a specific machine, machine_id is set so the UI
 * can filter "what can I do on the leg press?".
 */
import type { Exercise } from "../workout-types.ts";
import { EXTRA_EXERCISES } from "./exercises-extra.ts";

// Hand-curated exercises with precise muscle-head mappings. The broader set of
// StrengthLevel lifts (bodypart-level muscles) is spread in from EXTRA_EXERCISES
// below so the catalog covers every lift that has strength standards.
const BASE_EXERCISES: Exercise[] = [
  // -------------------- CHEST --------------------
  {
    id: "barbell_bench_press",
    name: "Barbell Bench Press",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["pectoralis_major_sternal"],
    secondary_muscles: ["pectoralis_major_clavicular", "triceps_brachii", "anterior_deltoid"],
    // Example metadata (the only populated entries for now — see ExerciseMetadata).
    metadata: {
      image_urls: [
        "https://placehold.co/480x270?text=Bench+Press+%E2%80%94+setup",
        "https://placehold.co/480x270?text=Bench+Press+%E2%80%94+bottom",
      ],
      video_url: "https://www.youtube.com/watch?v=rT7DgCr-3pg",
      description:
        "Lie flat, plant your feet, and pinch your shoulder blades together. Grip just outside shoulder width, lower the bar to mid-chest with elbows ~45°, then press back up to lockout without flaring or bouncing.",
    },
  },
  {
    id: "incline_barbell_bench_press",
    name: "Incline Barbell Bench Press",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["pectoralis_major_clavicular"],
    secondary_muscles: ["anterior_deltoid", "triceps_brachii"],
  },
  {
    id: "dumbbell_bench_press",
    name: "Dumbbell Bench Press",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["pectoralis_major_sternal"],
    secondary_muscles: ["pectoralis_major_clavicular", "triceps_brachii", "anterior_deltoid"],
  },
  {
    id: "incline_dumbbell_press",
    name: "Incline Dumbbell Press",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["pectoralis_major_clavicular"],
    secondary_muscles: ["anterior_deltoid", "triceps_brachii"],
  },
  {
    id: "dumbbell_fly",
    name: "Dumbbell Fly",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["pectoralis_major_sternal"],
    secondary_muscles: ["anterior_deltoid"],
  },
  {
    id: "machine_chest_press",
    name: "Chest Press (Machine)",
    type: "compound",
    equipment: "machine",
    machine_id: "chest_press_machine",
    primary_muscles: ["pectoralis_major_sternal"],
    secondary_muscles: ["triceps_brachii", "anterior_deltoid"],
  },
  {
    id: "pushup",
    name: "Push-up",
    type: "compound",
    equipment: "bodyweight",
    primary_muscles: ["pectoralis_major_sternal"],
    secondary_muscles: ["triceps_brachii", "anterior_deltoid", "rectus_abdominis"],
  },
  {
    id: "dip_chest",
    name: "Chest Dip",
    type: "compound",
    equipment: "bodyweight",
    primary_muscles: ["pectoralis_major_sternal"],
    secondary_muscles: ["triceps_brachii", "anterior_deltoid"],
  },

  // -------------------- BACK --------------------
  {
    id: "deadlift",
    name: "Deadlift",
    type: "compound",
    equipment: "barbell",
    primary_muscles: [
      "gluteus_maximus",
      "biceps_femoris",
      "semitendinosus",
      "semimembranosus",
      "erector_spinae",
    ],
    secondary_muscles: [
      "latissimus_dorsi",
      "trapezius",
      "rhomboids",
      "vastus_lateralis",
      "forearm_flexors",
    ],
  },
  {
    id: "barbell_row",
    name: "Barbell Row",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["latissimus_dorsi", "rhomboids"],
    secondary_muscles: ["trapezius", "posterior_deltoid", "biceps_brachii"],
  },
  {
    id: "dumbbell_row",
    name: "One-Arm Dumbbell Row",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["latissimus_dorsi", "rhomboids"],
    secondary_muscles: ["trapezius", "biceps_brachii", "posterior_deltoid"],
  },
  {
    id: "pullup",
    name: "Pull-up",
    type: "compound",
    equipment: "bodyweight",
    primary_muscles: ["latissimus_dorsi"],
    secondary_muscles: ["biceps_brachii", "rhomboids", "trapezius", "teres_major"],
  },
  {
    id: "chinup",
    name: "Chin-up",
    type: "compound",
    equipment: "bodyweight",
    primary_muscles: ["latissimus_dorsi", "biceps_brachii"],
    secondary_muscles: ["rhomboids", "trapezius", "teres_major"],
  },
  {
    id: "lat_pulldown",
    name: "Lat Pulldown",
    type: "compound",
    equipment: "machine",
    machine_id: "lat_pulldown_machine",
    primary_muscles: ["latissimus_dorsi"],
    secondary_muscles: ["biceps_brachii", "rhomboids", "teres_major"],
    // Example metadata (the only populated entries for now — see ExerciseMetadata).
    metadata: {
      image_urls: ["https://placehold.co/480x270?text=Lat+Pulldown"],
      video_url: "https://www.youtube.com/watch?v=CAwf7n6Luuc",
      description:
        "Set the thigh pad snug, grip the bar wider than shoulders. Drive your elbows down and back to pull the bar to your upper chest, squeezing the lats; control it back up to a full stretch without leaning back excessively.",
    },
  },
  {
    id: "seated_cable_row",
    name: "Seated Cable Row",
    type: "compound",
    equipment: "cable",
    machine_id: "seated_row_machine",
    primary_muscles: ["latissimus_dorsi", "rhomboids"],
    secondary_muscles: ["trapezius", "biceps_brachii", "posterior_deltoid"],
  },
  {
    id: "tbar_row",
    name: "T-Bar Row",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["latissimus_dorsi", "rhomboids", "trapezius"],
    secondary_muscles: ["biceps_brachii", "posterior_deltoid"],
  },
  {
    id: "face_pull",
    name: "Face Pull",
    type: "isolation",
    equipment: "cable",
    machine_id: "cable_crossover",
    primary_muscles: ["posterior_deltoid", "rhomboids"],
    secondary_muscles: ["trapezius", "infraspinatus"],
  },
  {
    id: "shrug_barbell",
    name: "Barbell Shrug",
    type: "isolation",
    equipment: "barbell",
    primary_muscles: ["trapezius"],
    secondary_muscles: ["forearm_flexors"],
  },
  {
    id: "shrug_dumbbell",
    name: "Dumbbell Shrug",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["trapezius"],
    secondary_muscles: ["forearm_flexors"],
  },
  {
    id: "hyperextension",
    name: "Back Extension (Hyperextension)",
    type: "isolation",
    equipment: "bodyweight",
    machine_id: "back_extension_bench",
    primary_muscles: ["erector_spinae"],
    secondary_muscles: ["gluteus_maximus", "biceps_femoris"],
  },

  // -------------------- SHOULDERS --------------------
  {
    id: "overhead_press_barbell",
    name: "Overhead Press (Barbell)",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["anterior_deltoid"],
    secondary_muscles: ["lateral_deltoid", "triceps_brachii", "trapezius"],
  },
  {
    id: "overhead_press_dumbbell",
    name: "Overhead Press (Dumbbell)",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["anterior_deltoid"],
    secondary_muscles: ["lateral_deltoid", "triceps_brachii", "trapezius"],
  },
  {
    id: "shoulder_press_machine_ex",
    name: "Shoulder Press (Machine)",
    type: "compound",
    equipment: "machine",
    machine_id: "shoulder_press_machine",
    primary_muscles: ["anterior_deltoid"],
    secondary_muscles: ["lateral_deltoid", "triceps_brachii"],
  },
  {
    id: "lateral_raise_dumbbell",
    name: "Dumbbell Lateral Raise",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["lateral_deltoid"],
    secondary_muscles: ["anterior_deltoid"],
  },
  {
    id: "lateral_raise_cable",
    name: "Cable Lateral Raise",
    type: "isolation",
    equipment: "cable",
    machine_id: "cable_crossover",
    primary_muscles: ["lateral_deltoid"],
    secondary_muscles: ["anterior_deltoid"],
  },
  {
    id: "front_raise_dumbbell",
    name: "Dumbbell Front Raise",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["anterior_deltoid"],
    secondary_muscles: [],
  },
  {
    id: "arnold_press",
    name: "Arnold Press",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["anterior_deltoid", "lateral_deltoid"],
    secondary_muscles: ["triceps_brachii"],
  },
  {
    id: "upright_row",
    name: "Upright Row",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["lateral_deltoid", "trapezius"],
    secondary_muscles: ["biceps_brachii", "anterior_deltoid"],
  },

  // -------------------- ARMS --------------------
  {
    id: "barbell_curl",
    name: "Barbell Curl",
    type: "isolation",
    equipment: "barbell",
    primary_muscles: ["biceps_brachii"],
    secondary_muscles: ["brachialis", "brachioradialis"],
  },
  {
    id: "dumbbell_curl",
    name: "Dumbbell Curl",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["biceps_brachii"],
    secondary_muscles: ["brachialis", "brachioradialis"],
  },
  {
    id: "hammer_curl",
    name: "Hammer Curl",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["brachialis", "brachioradialis"],
    secondary_muscles: ["biceps_brachii"],
  },
  {
    id: "preacher_curl",
    name: "Preacher Curl",
    type: "isolation",
    equipment: "machine",
    machine_id: "preacher_curl_machine",
    primary_muscles: ["biceps_brachii"],
    secondary_muscles: ["brachialis"],
  },
  {
    id: "tricep_pushdown",
    name: "Triceps Pushdown",
    type: "isolation",
    equipment: "cable",
    machine_id: "cable_crossover",
    primary_muscles: ["triceps_brachii"],
    secondary_muscles: [],
  },
  {
    id: "skullcrusher",
    name: "Skullcrusher (Lying Tricep Extension)",
    type: "isolation",
    equipment: "barbell",
    primary_muscles: ["triceps_brachii"],
    secondary_muscles: [],
  },
  {
    id: "dip_triceps",
    name: "Tricep Dip",
    type: "compound",
    equipment: "bodyweight",
    primary_muscles: ["triceps_brachii"],
    secondary_muscles: ["pectoralis_major_sternal", "anterior_deltoid"],
  },
  {
    id: "close_grip_bench_press",
    name: "Close-Grip Bench Press",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["triceps_brachii"],
    secondary_muscles: ["pectoralis_major_sternal", "anterior_deltoid"],
  },
  {
    id: "wrist_curl",
    name: "Wrist Curl",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["forearm_flexors"],
    secondary_muscles: [],
  },
  {
    id: "reverse_wrist_curl",
    name: "Reverse Wrist Curl",
    type: "isolation",
    equipment: "dumbbell",
    primary_muscles: ["forearm_extensors"],
    secondary_muscles: [],
  },

  // -------------------- LEGS (anterior — quads) --------------------
  {
    id: "back_squat",
    name: "Back Squat",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "vastus_medialis"],
    secondary_muscles: ["gluteus_maximus", "biceps_femoris", "erector_spinae"],
  },
  {
    id: "front_squat",
    name: "Front Squat",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "vastus_medialis"],
    secondary_muscles: ["gluteus_maximus", "erector_spinae", "rectus_abdominis"],
  },
  {
    id: "hack_squat",
    name: "Hack Squat",
    type: "compound",
    equipment: "machine",
    machine_id: "hack_squat_machine",
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "vastus_medialis"],
    secondary_muscles: ["gluteus_maximus"],
  },
  {
    id: "leg_extension",
    name: "Leg Extension",
    type: "isolation",
    equipment: "machine",
    machine_id: "leg_extension_machine",
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "vastus_medialis"],
    secondary_muscles: [],
  },
  {
    id: "bulgarian_split_squat",
    name: "Bulgarian Split Squat",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "vastus_medialis", "gluteus_maximus"],
    secondary_muscles: ["biceps_femoris", "gluteus_medius"],
  },
  {
    id: "walking_lunge",
    name: "Walking Lunge",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "gluteus_maximus"],
    secondary_muscles: ["biceps_femoris", "vastus_medialis"],
  },

  // -------------------- LEGS (posterior — hamstrings + calves) --------------------
  {
    id: "romanian_deadlift",
    name: "Romanian Deadlift",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["biceps_femoris", "semitendinosus", "semimembranosus", "gluteus_maximus"],
    secondary_muscles: ["erector_spinae", "forearm_flexors"],
  },
  {
    id: "stiff_leg_deadlift",
    name: "Stiff-Leg Deadlift",
    type: "compound",
    equipment: "dumbbell",
    primary_muscles: ["biceps_femoris", "semitendinosus", "semimembranosus"],
    secondary_muscles: ["gluteus_maximus", "erector_spinae"],
  },
  {
    id: "leg_curl_lying",
    name: "Lying Leg Curl",
    type: "isolation",
    equipment: "machine",
    machine_id: "leg_curl_machine",
    primary_muscles: ["biceps_femoris", "semitendinosus", "semimembranosus"],
    secondary_muscles: [],
  },
  {
    id: "leg_curl_seated",
    name: "Seated Leg Curl",
    type: "isolation",
    equipment: "machine",
    machine_id: "leg_curl_machine",
    primary_muscles: ["biceps_femoris", "semitendinosus", "semimembranosus"],
    secondary_muscles: [],
  },
  {
    id: "calf_raise_seated",
    name: "Seated Calf Raise",
    type: "isolation",
    equipment: "machine",
    machine_id: "calf_raise_machine",
    primary_muscles: ["soleus"],
    secondary_muscles: ["gastrocnemius"],
  },
  {
    id: "good_morning",
    name: "Good Morning",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["biceps_femoris", "semitendinosus", "erector_spinae"],
    secondary_muscles: ["gluteus_maximus"],
  },

  // -------------------- HIPS / GLUTES --------------------
  {
    id: "hip_thrust",
    name: "Hip Thrust",
    type: "compound",
    equipment: "barbell",
    primary_muscles: ["gluteus_maximus"],
    secondary_muscles: ["biceps_femoris", "vastus_lateralis"],
  },
  {
    id: "glute_bridge",
    name: "Glute Bridge",
    type: "compound",
    equipment: "bodyweight",
    primary_muscles: ["gluteus_maximus"],
    secondary_muscles: ["biceps_femoris", "rectus_abdominis"],
  },
  {
    id: "glute_kickback",
    name: "Glute Kickback",
    type: "isolation",
    equipment: "cable",
    machine_id: "glute_kickback_machine",
    primary_muscles: ["gluteus_maximus"],
    secondary_muscles: ["biceps_femoris"],
  },

  // -------------------- CORE --------------------
  {
    id: "plank",
    name: "Plank",
    type: "isolation",
    equipment: "bodyweight",
    tracks: ["duration_weight"],
    primary_muscles: ["rectus_abdominis"],
    secondary_muscles: ["external_obliques", "internal_obliques", "erector_spinae"],
  },
  {
    id: "side_plank",
    name: "Side Plank",
    type: "isolation",
    equipment: "bodyweight",
    tracks: ["duration_weight"],
    primary_muscles: ["external_obliques", "internal_obliques"],
    secondary_muscles: ["rectus_abdominis", "gluteus_medius"],
  },
  {
    id: "crunch",
    name: "Crunch",
    type: "isolation",
    equipment: "bodyweight",
    primary_muscles: ["rectus_abdominis"],
    secondary_muscles: [],
  },
  {
    id: "russian_twist",
    name: "Russian Twist",
    type: "isolation",
    equipment: "bodyweight",
    primary_muscles: ["external_obliques", "internal_obliques"],
    secondary_muscles: ["rectus_abdominis"],
  },
  {
    id: "hanging_leg_raise",
    name: "Hanging Leg Raise",
    type: "isolation",
    equipment: "bodyweight",
    primary_muscles: ["rectus_abdominis"],
    secondary_muscles: ["external_obliques", "internal_obliques"],
  },

  // -------------------- CARDIO --------------------
  {
    id: "treadmill_run",
    name: "Treadmill Run",
    type: "cardio",
    equipment: "cardio",
    machine_id: "treadmill",
    primary_muscles: ["rectus_femoris", "biceps_femoris", "gastrocnemius"],
    secondary_muscles: ["soleus", "gluteus_maximus"],
  },
  {
    id: "stationary_bike_ride",
    name: "Stationary Bike",
    type: "cardio",
    equipment: "cardio",
    machine_id: "stationary_bike",
    primary_muscles: ["rectus_femoris", "vastus_lateralis"],
    secondary_muscles: ["biceps_femoris", "gluteus_maximus"],
  },
  {
    id: "elliptical_session",
    name: "Elliptical",
    type: "cardio",
    equipment: "cardio",
    machine_id: "elliptical",
    primary_muscles: ["rectus_femoris", "biceps_femoris"],
    secondary_muscles: ["gluteus_maximus", "latissimus_dorsi"],
  },
  {
    id: "rowing_machine",
    name: "Rowing Machine",
    type: "cardio",
    equipment: "cardio",
    machine_id: "rowing_erg",
    primary_muscles: ["latissimus_dorsi", "biceps_femoris"],
    secondary_muscles: ["rhomboids", "trapezius", "rectus_femoris", "biceps_brachii"],
  },
  {
    id: "stair_climber_session",
    name: "Stair Climber",
    type: "cardio",
    equipment: "cardio",
    machine_id: "stair_climber",
    primary_muscles: ["rectus_femoris", "gluteus_maximus"],
    secondary_muscles: ["gastrocnemius", "biceps_femoris"],
  },
  {
    id: "walking",
    name: "Walking",
    type: "cardio",
    equipment: "bodyweight",
    primary_muscles: ["gastrocnemius", "biceps_femoris"],
    secondary_muscles: ["soleus", "gluteus_maximus", "rectus_femoris"],
    notes:
      "Outdoor or treadmill walking. The app's step counter tracks today's " +
      "steps automatically while it's open on your phone.",
  },
];

// Hand-refined muscles for generated lifts whose bodypart-level mapping skews
// the plan totals (primary muscles only count there). Kept here, not in the
// generated file, so a re-run of the generator doesn't drop them. Each mirrors
// its hand-curated sibling (walking_lunge, barbell_bench_press, ...).
const EXTRA_MUSCLE_FIXES: Record<
  string,
  Pick<Exercise, "primary_muscles" | "secondary_muscles">
> = {
  sled_leg_press: {
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "vastus_medialis"],
    secondary_muscles: ["gluteus_maximus", "biceps_femoris"],
  },
  dumbbell_lunge: {
    primary_muscles: ["rectus_femoris", "vastus_lateralis", "gluteus_maximus"],
    secondary_muscles: ["biceps_femoris", "vastus_medialis"],
  },
  smith_machine_bench_press: {
    primary_muscles: ["pectoralis_major_sternal"],
    secondary_muscles: ["pectoralis_major_clavicular", "triceps_brachii", "anterior_deltoid"],
  },
  seated_dumbbell_shoulder_press: {
    primary_muscles: ["anterior_deltoid"],
    secondary_muscles: ["lateral_deltoid", "triceps_brachii"],
  },
};

export const EXERCISES: Exercise[] = [
  ...BASE_EXERCISES,
  ...EXTRA_EXERCISES.map((e) => ({ ...e, ...EXTRA_MUSCLE_FIXES[e.id] })),
];

export const EXERCISE_BY_ID: Record<string, Exercise> = Object.fromEntries(
  EXERCISES.map((e) => [e.id, e]),
);
