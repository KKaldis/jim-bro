// Helpers shared by the Workout screen's tabs.
import type { ExerciseId, MachineId, Weekday } from "@fa/shared";

// Local working copy of a plan day. ids are optional because new days/exercises
// don't have one until the server assigns one on save.
type EditDay = {
  id?: number;
  weekdays: Weekday[];
  name: string;
  focus: string;
  exercises: EditExercise[];
};

type EditExercise = {
  id?: number;
  exercise_id: ExerciseId;
  machine_id: MachineId | null;
  order: number;
  target_sets: number;
  target_reps: number | null;
  target_weight_kg: number | null;
  target_duration_sec: number | null;
  notes: string;
};

export type EditPlan = {
  id?: number;
  name: string;
  notes: string;
  days: EditDay[];
};
