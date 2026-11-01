/**
 * Muscle-group taxonomy. Stable IDs (snake_case) for muscles and groups so
 * exercise rows and progress queries never key on display strings.
 *
 * Source: anatomical convention; mirrors the shape of /muscle_groups.json
 * that bootstrapped this feature.
 */
import type { Muscle, MuscleGroup, MuscleGroupId, MuscleId } from "../workout-types.ts";

type MuscleSeed = { id: MuscleId; label: string };
type GroupSeed = { id: MuscleGroupId; label: string; muscles: MuscleSeed[] };

const SEED: GroupSeed[] = [
  {
    id: "shoulders",
    label: "Shoulders",
    muscles: [
      { id: "anterior_deltoid", label: "Anterior Deltoid" },
      { id: "lateral_deltoid", label: "Lateral Deltoid" },
      { id: "posterior_deltoid", label: "Posterior Deltoid" },
    ],
  },
  {
    id: "chest",
    label: "Chest",
    muscles: [
      { id: "pectoralis_major_clavicular", label: "Pectoralis Major (Clavicular Head)" },
      { id: "pectoralis_major_sternal", label: "Pectoralis Major (Sternal Head)" },
    ],
  },
  {
    id: "arms_and_forearms",
    label: "Arms & Forearms",
    muscles: [
      { id: "biceps_brachii", label: "Biceps Brachii" },
      { id: "brachialis", label: "Brachialis" },
      { id: "brachioradialis", label: "Brachioradialis" },
      { id: "forearm_flexors", label: "Forearm Flexors" },
      { id: "forearm_extensors", label: "Forearm Extensors" },
      { id: "triceps_brachii", label: "Triceps Brachii" },
    ],
  },
  {
    id: "core",
    label: "Core",
    muscles: [
      { id: "rectus_abdominis", label: "Rectus Abdominis" },
      { id: "external_obliques", label: "External Obliques" },
      { id: "internal_obliques", label: "Internal Obliques" },
    ],
  },
  {
    id: "back",
    label: "Back",
    muscles: [
      { id: "trapezius", label: "Trapezius" },
      { id: "latissimus_dorsi", label: "Latissimus Dorsi" },
      { id: "infraspinatus", label: "Infraspinatus" },
      { id: "teres_major", label: "Teres Major" },
      { id: "rhomboids", label: "Rhomboids" },
      { id: "erector_spinae", label: "Erector Spinae" },
    ],
  },
  {
    id: "hips_and_glutes",
    label: "Hips & Glutes",
    muscles: [
      { id: "gluteus_medius", label: "Gluteus Medius" },
      { id: "gluteus_maximus", label: "Gluteus Maximus" },
    ],
  },
  {
    id: "legs_anterior",
    label: "Legs (Anterior)",
    muscles: [
      { id: "rectus_femoris", label: "Rectus Femoris (Quadriceps)" },
      { id: "vastus_lateralis", label: "Vastus Lateralis (Quadriceps)" },
      { id: "vastus_medialis", label: "Vastus Medialis (Quadriceps)" },
      { id: "sartorius", label: "Sartorius" },
      { id: "gracilis", label: "Gracilis" },
      { id: "tensor_fasciae_latae", label: "Tensor Fasciae Latae" },
      { id: "tibialis_anterior", label: "Tibialis Anterior" },
    ],
  },
  {
    id: "legs_posterior",
    label: "Legs (Posterior)",
    muscles: [
      { id: "biceps_femoris", label: "Biceps Femoris (Hamstrings)" },
      { id: "semitendinosus", label: "Semitendinosus (Hamstrings)" },
      { id: "semimembranosus", label: "Semimembranosus (Hamstrings)" },
      { id: "gastrocnemius", label: "Gastrocnemius (Calves)" },
      { id: "soleus", label: "Soleus" },
    ],
  },
];

export const MUSCLE_GROUPS: MuscleGroup[] = SEED.map((g) => ({
  id: g.id,
  label: g.label,
  muscles: g.muscles.map((m) => m.id),
}));

export const MUSCLES: Muscle[] = SEED.flatMap((g) =>
  g.muscles.map((m) => ({ id: m.id, label: m.label, group: g.id })),
);

// Quick-lookup map. Used by progress derivations to roll specific-muscle
// exercise mappings up to muscle-group volume.
export const MUSCLE_TO_GROUP: Record<MuscleId, MuscleGroupId> = Object.fromEntries(
  MUSCLES.map((m) => [m.id, m.group]),
);

export const MUSCLE_LABEL: Record<MuscleId, string> = Object.fromEntries(
  MUSCLES.map((m) => [m.id, m.label]),
);

export const MUSCLE_GROUP_LABEL: Record<MuscleGroupId, string> = Object.fromEntries(
  MUSCLE_GROUPS.map((g) => [g.id, g.label]),
);

// Finer "what does it train" buckets for browsing exercises — the groups above
// lump biceps/triceps/forearms and hamstrings/calves together. Display and
// filtering only: stored data and volume roll-ups stay on the groups. Every
// muscle sits in exactly one target.
export type MuscleTarget = { id: string; label: string; muscles: MuscleId[] };

export const MUSCLE_TARGETS: MuscleTarget[] = [
  {
    id: "shoulders",
    label: "Shoulders",
    muscles: ["anterior_deltoid", "lateral_deltoid", "posterior_deltoid"],
  },
  {
    id: "chest",
    label: "Chest",
    muscles: ["pectoralis_major_clavicular", "pectoralis_major_sternal"],
  },
  { id: "biceps", label: "Biceps", muscles: ["biceps_brachii", "brachialis"] },
  { id: "triceps", label: "Triceps", muscles: ["triceps_brachii"] },
  {
    id: "forearms",
    label: "Forearms",
    muscles: ["brachioradialis", "forearm_flexors", "forearm_extensors"],
  },
  {
    id: "abs",
    label: "Abs & Obliques",
    muscles: ["rectus_abdominis", "external_obliques", "internal_obliques"],
  },
  { id: "traps", label: "Traps", muscles: ["trapezius"] },
  {
    id: "upper_back",
    label: "Lats & Upper Back",
    muscles: ["latissimus_dorsi", "teres_major", "rhomboids", "infraspinatus"],
  },
  { id: "lower_back", label: "Lower Back", muscles: ["erector_spinae"] },
  { id: "glutes", label: "Glutes", muscles: ["gluteus_maximus", "gluteus_medius"] },
  {
    id: "quads",
    label: "Quads",
    muscles: ["rectus_femoris", "vastus_lateralis", "vastus_medialis"],
  },
  {
    id: "hip_adductors",
    label: "Adductors & Hip Flexors",
    muscles: ["gracilis", "sartorius", "tensor_fasciae_latae"],
  },
  {
    id: "hamstrings",
    label: "Hamstrings",
    muscles: ["biceps_femoris", "semitendinosus", "semimembranosus"],
  },
  {
    id: "calves",
    label: "Calves & Shins",
    muscles: ["gastrocnemius", "soleus", "tibialis_anterior"],
  },
];

export const MUSCLE_TO_TARGET: Record<MuscleId, string> = Object.fromEntries(
  MUSCLE_TARGETS.flatMap((t) => t.muscles.map((m) => [m, t.id])),
);

export const MUSCLE_TARGET_LABEL: Record<string, string> = Object.fromEntries(
  MUSCLE_TARGETS.map((t) => [t.id, t.label]),
);
