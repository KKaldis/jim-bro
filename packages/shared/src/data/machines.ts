/**
 * Static catalog of common gym machines. A machine targets one or more
 * muscle groups; the set of exercises performable *on* a machine is derived
 * from exercises.ts (exercises[].machine_id), not stored here.
 */
import type { Machine } from "../workout-types.ts";

export const MACHINES: Machine[] = [
  { id: "lat_pulldown_machine", name: "Lat Pulldown", muscle_groups: ["back"] },
  { id: "seated_row_machine", name: "Seated Row Machine", muscle_groups: ["back"] },
  { id: "chest_press_machine", name: "Chest Press Machine", muscle_groups: ["chest"] },
  { id: "pec_deck_machine", name: "Pec Deck (Chest Fly)", muscle_groups: ["chest"] },
  { id: "shoulder_press_machine", name: "Shoulder Press Machine", muscle_groups: ["shoulders"] },
  { id: "lateral_raise_machine", name: "Lateral Raise Machine", muscle_groups: ["shoulders"] },
  {
    id: "rear_delt_fly_machine",
    name: "Rear Delt Fly Machine",
    muscle_groups: ["shoulders", "back"],
  },
  {
    id: "leg_press_machine",
    name: "Leg Press",
    muscle_groups: ["legs_anterior", "hips_and_glutes"],
  },
  {
    id: "hack_squat_machine",
    name: "Hack Squat Machine",
    muscle_groups: ["legs_anterior", "hips_and_glutes"],
  },
  { id: "leg_extension_machine", name: "Leg Extension Machine", muscle_groups: ["legs_anterior"] },
  { id: "leg_curl_machine", name: "Leg Curl Machine", muscle_groups: ["legs_posterior"] },
  { id: "calf_raise_machine", name: "Calf Raise Machine", muscle_groups: ["legs_posterior"] },
  { id: "hip_abductor_machine", name: "Hip Abductor Machine", muscle_groups: ["hips_and_glutes"] },
  {
    id: "hip_adductor_machine",
    name: "Hip Adductor Machine",
    muscle_groups: ["legs_anterior", "hips_and_glutes"],
  },
  {
    id: "glute_kickback_machine",
    name: "Glute Kickback Machine",
    muscle_groups: ["hips_and_glutes"],
  },
  {
    id: "preacher_curl_machine",
    name: "Preacher Curl Machine",
    muscle_groups: ["arms_and_forearms"],
  },
  {
    id: "triceps_extension_machine",
    name: "Triceps Extension Machine",
    muscle_groups: ["arms_and_forearms"],
  },
  {
    id: "cable_crossover",
    name: "Cable Crossover",
    muscle_groups: ["chest", "shoulders", "back", "arms_and_forearms"],
  },
  {
    id: "assisted_pullup_machine",
    name: "Assisted Pull-up / Dip Machine",
    muscle_groups: ["back", "arms_and_forearms", "chest"],
  },
  {
    id: "smith_machine",
    name: "Smith Machine",
    muscle_groups: ["chest", "back", "shoulders", "legs_anterior", "hips_and_glutes"],
  },
  { id: "ab_crunch_machine", name: "Ab Crunch Machine", muscle_groups: ["core"] },
  {
    id: "back_extension_bench",
    name: "Back Extension Bench",
    muscle_groups: ["back", "hips_and_glutes"],
  },
  { id: "treadmill", name: "Treadmill", muscle_groups: ["legs_anterior", "legs_posterior"] },
  {
    id: "stationary_bike",
    name: "Stationary Bike",
    muscle_groups: ["legs_anterior", "legs_posterior"],
  },
  { id: "elliptical", name: "Elliptical", muscle_groups: ["legs_anterior", "legs_posterior"] },
  {
    id: "rowing_erg",
    name: "Rowing Ergometer",
    muscle_groups: ["back", "legs_posterior", "arms_and_forearms"],
  },
  {
    id: "stair_climber",
    name: "Stair Climber",
    muscle_groups: ["legs_anterior", "hips_and_glutes"],
  },
];

export const MACHINE_BY_ID: Record<string, Machine> = Object.fromEntries(
  MACHINES.map((m) => [m.id, m]),
);

// Machine id -> silhouette slug under /exercise-icons (reuses the exercise
// icon set: each machine borrows the icon of its signature movement). Cardio
// machines have no icon yet.
export const MACHINE_ICONS: Record<string, string> = {
  lat_pulldown_machine: "lat-pulldown",
  seated_row_machine: "seated-cable-row",
  chest_press_machine: "chest-press",
  pec_deck_machine: "machine-chest-fly",
  shoulder_press_machine: "machine-shoulder-press",
  lateral_raise_machine: "machine-lateral-raise",
  rear_delt_fly_machine: "machine-reverse-fly",
  leg_press_machine: "sled-leg-press",
  hack_squat_machine: "hack-squat",
  leg_extension_machine: "leg-extension",
  leg_curl_machine: "lying-leg-curl",
  calf_raise_machine: "machine-calf-raise",
  hip_abductor_machine: "hip-abduction",
  hip_adductor_machine: "hip-adduction",
  glute_kickback_machine: "glute-kickback",
  preacher_curl_machine: "machine-bicep-curl",
  triceps_extension_machine: "machine-tricep-extension",
  cable_crossover: "cable-fly",
  assisted_pullup_machine: "pull-ups",
  smith_machine: "smith-machine-squat",
  ab_crunch_machine: "machine-seated-crunch",
  back_extension_bench: "back-extension",
};

export function machineIconUrl(machineId: string): string | null {
  const slug = MACHINE_ICONS[machineId];
  return slug ? `/exercise-icons/${slug}.png` : null;
}
