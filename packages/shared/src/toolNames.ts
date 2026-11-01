/**
 * Canonical, cross-package tool-name registries.
 *
 * These two lists are consumed by BOTH sides of the app:
 *   - @fa/agent (server): builds its runtime Sets from them and re-checks every
 *     entry against the `ToolName` union derived from TOOL_DEFS, so a name that
 *     isn't a real tool is a compile error there.
 *   - @fa/web (client): can't import @fa/agent (it pulls in server-only deps),
 *     so before this module the frontend kept hand-copied string sets that
 *     silently drifted (e.g. `update_cardio_entry`, `log_water`, `log_steps`
 *     were missing). Importing the same arrays here makes any future drift a
 *     compile error instead of a dropped form card on history reload.
 *
 * Keep this module dependency-free so it stays importable from both a browser
 * bundle and the server with no transitive pull-ins.
 */

// Tools that mutate user data and therefore open a pre-execution confirmation
// gate. `ask_user` / `ask_user_multi` also pass through the agent gate (for
// their option-picker UI) but write nothing, so each consumer adds them
// separately rather than listing them here.
export const MUTATING_TOOL_NAMES = [
  "update_profile",
  // Filing a feature request writes a row for the team, so it goes through the
  // same pre-execution Accept/Decline gate as every other write — the form card
  // IS the confirmation (no chat re-ask). No update_* counterpart, so its card
  // goes read-only after save, like log_body_comp.
  "submit_feature_request",
  "add_food",
  "update_food",
  "log_meal",
  "update_meal",
  "log_water",
  "log_body_comp",
  "save_diet_plan",
  "delete_diet_plan",
  "update_diet_day",
  "add_diet_meal",
  "update_diet_meal",
  "remove_diet_meal",
  "add_diet_portion",
  "update_diet_portion",
  "remove_diet_portion",
  "log_planned_meal",
  "save_recipe",
  "delete_recipe",
  "update_recipe_portion",
  "set_recipe_favorite",
  "log_recipe",
  "update_pantry",
  "import_pantry",
  "delete_meal",
  "delete_body_comp_entry",
  "update_body_comp_entry",
  "save_workout_plan",
  "delete_workout_plan",
  "update_workout_plan_day",
  "add_exercise_to_plan_day",
  "remove_exercise_from_plan_day",
  "update_plan_exercise",
  "replace_plan_exercise",
  "log_workout_session",
  "delete_workout_session",
  "log_steps",
  "delete_steps",
  "log_cardio",
  "delete_cardio_entry",
  "update_cardio_entry",
  "log_measurements",
] as const;
export type MutatingToolName = (typeof MUTATING_TOOL_NAMES)[number];

// Read/compute tools whose structured result renders as a rich "result card"
// (calorie ring, macro bars, metric gauges) instead of model prose. The web
// app's card registry is typed `Record<ResultCardToolName, …>`, so every name
// here MUST have a card component and vice versa.
export const RESULT_CARD_TOOL_NAMES = [
  "get_todays_macros",
  "get_water_status",
  "compute_targets",
  "compute_bmr",
  "compute_macro_split",
  "compute_protein_target",
  "compute_calorie_deficit",
  "preview_meal",
  "compute_bmi",
  "compute_ideal_weight",
  "compute_ffmi",
  "estimate_body_fat",
  "compute_lean_body_mass",
  "compute_water_intake",
  "get_body_composition",
  "estimate_vo2_max",
  "compute_heart_rate_zones",
  "compute_step_calories",
  "compute_max_potential",
  "compute_ideal_proportions",
  "classify_body_shape",
  "compute_one_rep_max",
  "convert_rpe",
  "plan_warmup_sets",
  "compute_training_volume",
  "assess_strength_level",
  "compute_powerlifting_score",
  "strength_symmetry",
  "plate_barbell_racking",
  "lookup_food",
  "lookup_product",
  "substitute_food",
  "estimate_training_kcal",
  "last_sets_for_exercise",
  "progress_report",
  "shopping_list",
  // Sources card for evidence-based answers — the model calls `cite` with the
  // studies behind its reply and the card renders them as rows.
  "cite",
] as const;
export type ResultCardToolName = (typeof RESULT_CARD_TOOL_NAMES)[number];
