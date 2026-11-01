// Tool presentation categories for chat — icon + badge color per tool call.
//
// The agent stamps a `category` on every tool_started / tool_proposed /
// tool_finished stream event (packages/agent/src/tools/registry.ts → getToolCategory),
// so live tool calls carry it over the wire. Restored history has no events,
// so `categoryOf(name)` mirrors the server map to derive the category from the
// tool name alone. Keep TOOL_CATEGORIES in sync with the server's map.
import {
  Compass,
  Dumbbell,
  Info,
  PieChart,
  Scale,
  ShoppingBasket,
  TrendingUp,
  Utensils,
  type LucideIcon,
} from "lucide-react";

import i18n from "../i18n";
import type { StreamEvent } from "../api/model";

// Sourced from the generated OpenAPI types so it can't drift from the wire
// contract (apps/server/src/schemas.ts → ToolCategory).
export type ToolCategory = StreamEvent extends infer U
  ? U extends { category: infer C }
    ? C
    : never
  : never;

// name → category, mirroring TOOL_META in packages/agent/src/tools/registry.ts.
// Used only for history rehydration; live calls use the wire `category`.
const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  show_screen: "navigation",
  log_body_comp: "body-comp",
  delete_body_comp_entry: "body-comp",
  compute_bmi: "body-comp",
  compute_ffmi: "body-comp",
  compute_bmr: "body-comp",
  compute_macro_split: "body-comp",
  compute_protein_target: "body-comp",
  compute_calorie_deficit: "body-comp",
  compute_ideal_weight: "body-comp",
  estimate_body_fat: "body-comp",
  compute_lean_body_mass: "body-comp",
  compute_water_intake: "nutrition",
  get_body_composition: "body-comp",
  estimate_vo2_max: "training",
  compute_heart_rate_zones: "training",
  compute_step_calories: "training",
  log_cardio: "training",
  delete_cardio_entry: "training",
  log_measurements: "body-comp",
  update_body_comp_entry: "body-comp",
  compute_max_potential: "body-comp",
  compute_ideal_proportions: "body-comp",
  classify_body_shape: "body-comp",
  compute_one_rep_max: "training",
  assess_strength_level: "training",
  compute_powerlifting_score: "training",
  strength_symmetry: "training",
  plate_barbell_racking: "training",
  convert_rpe: "training",
  plan_warmup_sets: "training",
  compute_training_volume: "training",
  lookup_food: "nutrition",
  lookup_product: "nutrition",
  log_meal: "nutrition",
  update_meal: "nutrition",
  delete_meal: "nutrition",
  preview_meal: "nutrition",
  substitute_food: "nutrition",
  compute_targets: "nutrition",
  get_diet_plan: "nutrition",
  list_diet_plans: "nutrition",
  activate_diet_plan: "nutrition",
  save_diet_plan: "nutrition",
  delete_diet_plan: "nutrition",
  update_diet_day: "nutrition",
  add_diet_meal: "nutrition",
  update_diet_meal: "nutrition",
  remove_diet_meal: "nutrition",
  add_diet_portion: "nutrition",
  update_diet_portion: "nutrition",
  remove_diet_portion: "nutrition",
  log_planned_meal: "nutrition",
  add_food: "pantry",
  update_food: "pantry",
  update_pantry: "pantry",
  import_pantry: "pantry",
  shopping_list: "pantry",
  estimate_training_kcal: "training",
  search_exercises: "training",
  get_workout_plans: "training",
  review_training_plan: "training",
  activate_workout_plan: "training",
  save_workout_plan: "training",
  delete_workout_plan: "training",
  update_workout_plan_day: "training",
  add_exercise_to_plan_day: "training",
  remove_exercise_from_plan_day: "training",
  update_plan_exercise: "training",
  replace_plan_exercise: "training",
  log_workout_session: "training",
  list_workout_sessions: "training",
  delete_workout_session: "training",
  last_sets_for_exercise: "training",
  progress_report: "progress",
  ask_user: "info",
  update_profile: "info",
  get_todays_macros: "macros",
  request_tools: "info",
  web_search: "info",
  $web_search: "info",
  web_fetch: "info",
  cite: "info",
};

export function categoryOf(name: string): ToolCategory {
  return TOOL_CATEGORIES[name] ?? "info";
}

type CategoryMeta = {
  // Localized, resolved live via a getter so it tracks the active language
  // (CATEGORY_META is built once at import, before the language settles).
  readonly label: string;
  Icon: LucideIcon;
  // Icon tint used inside the neutral status pill.
  iconClass: string;
  // Tinted badge chrome (bg + text + border) for the category-colored chip.
  badgeClass: string;
};

// Build a CategoryMeta whose `label` resolves through i18n on every read, so
// consumers reading `categoryMeta(c).label` always get the current language.
function meta(
  category: ToolCategory,
  Icon: LucideIcon,
  iconClass: string,
  badgeClass: string,
): CategoryMeta {
  return {
    get label() {
      return i18n.t(`lib.category.${category}`);
    },
    Icon,
    iconClass,
    badgeClass,
  };
}

// Per-category icon + color. Colors are light/dark-mode aware Tailwind tokens.
export const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
  "body-comp": meta(
    "body-comp",
    Scale,
    "text-violet-600 dark:text-violet-400",
    "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
  ),
  nutrition: meta(
    "nutrition",
    Utensils,
    "text-emerald-600 dark:text-emerald-400",
    "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  ),
  pantry: meta(
    "pantry",
    ShoppingBasket,
    "text-amber-600 dark:text-amber-400",
    "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  ),
  training: meta(
    "training",
    Dumbbell,
    "text-sky-600 dark:text-sky-400",
    "border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  ),
  progress: meta(
    "progress",
    TrendingUp,
    "text-rose-600 dark:text-rose-400",
    "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  ),
  navigation: meta(
    "navigation",
    Compass,
    "text-indigo-600 dark:text-indigo-400",
    "border-indigo-300 bg-indigo-100 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  ),
  macros: meta(
    "macros",
    PieChart,
    "text-teal-600 dark:text-teal-400",
    "border-teal-300 bg-teal-100 text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300",
  ),
  info: meta(
    "info",
    Info,
    "text-slate-500 dark:text-slate-400",
    "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
  ),
};

export function categoryMeta(category: ToolCategory): CategoryMeta {
  return CATEGORY_META[category];
}
