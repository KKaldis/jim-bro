// Shared types across the Jim-Bro lib + storage + tools.

import type { Weekday } from "./workout-types.ts";

// Macros are the unit of nutritional accounting throughout the system.
// `fiber` is optional because legacy food rows / diet plans created before
// fiber tracking landed don't carry it; treat `undefined` as 0 when summing
// and "unknown" when displaying. Carbs (`c`) is total carbs including fiber.
export type Macros = {
  kcal: number;
  p: number;
  f: number;
  c: number;
  fiber?: number;
};

export type Sex = "male" | "female";

export type ActivityLevel = "sedentary" | "light" | "moderate" | "very" | "extreme";

export type Goal = "cut" | "maintain" | "recomp" | "lean_bulk";

// Preferred unit system for entering/displaying measurements. Storage is
// always metric; this only governs the input boundary in the UI.
export type UnitSystem = "metric" | "imperial";

// Product language (BCP-47 base subtag). Drives the UI language and the
// language the agent authors stored content in. Extend as locales are added.
export type Language = "en" | "el" | "ar" | "sq" | "fa" | "ur" | "nl" | "it";

export type BodyFatMethod =
  | "dexa"
  | "bia_scale"
  | "caliper"
  | "visual_estimate"
  // "navy" means the BF% was derived from circumferences (waist/neck[/hip]),
  // not entered directly — body_fat_pct stays null and body_fat_pct_navy holds
  // the estimate. Kept as a method so the entry records how BF% was obtained.
  | "navy"
  | "other";

// Profile holds stable identity + targets only. weight / body_fat / circumference
// readings live on BodyCompEntry — read the latest entry to get "current" values.
export type Profile = {
  sex: Sex;
  birth_year: number; // e.g. 1990
  height_cm: number;
  activity_level: ActivityLevel;
  goal: Goal;
  restrictions?: string[];
  target_weight_kg?: number | null;
  notes?: string;
  // Stable skeletal-frame proxies (don't change with training) used to derive
  // the drug-free muscular potential (Casey Butt). Optional — many users never
  // measure them. Stored metric; the UI converts at the boundary per `units`.
  wrist_cm?: number | null;
  ankle_cm?: number | null;
  // The user's preferred unit system for entering/reading measurements.
  // Display-only: storage is always metric. Defaults to "metric" when unset.
  units?: UnitSystem;
  // Preferred product language. Single source of truth for the UI language and
  // the language the agent authors stored content in. Defaults to "en" unset.
  language?: Language;
  // The user's everyday hydration target in ml — a persistent daily water goal
  // that applies to every day. NULL/absent = use the app default. Single source
  // of truth for the goal.
  water_goal_ml?: number | null;
  // Catalog machine ids (snake_case) the user's gym actually has. Optional
  // equipment-availability filter for workout planning: when set, the agent
  // should PREFER exercises performable on these machines; an empty/absent
  // list means "no constraint — any machine in the catalog is fair game".
  // Free-weight / bodyweight exercises are never gated by this. Validated
  // loosely (unknown ids are tolerated, not rejected) so a catalog rename
  // can't brick a saved profile.
  gym_machine_ids?: string[] | null;
  // The user's currently-active diet plan (read-only here; set via the
  // activate flow, never written through saveProfile). NULL = none active.
  active_diet_plan_id?: number | null;
  // The user's currently-active workout plan (read-only here; set via the
  // activate flow, never written through saveProfile). NULL = none active.
  active_workout_plan_id?: number | null;
  // Cached "recommended" daily target (#1), derived from this profile + the
  // latest body-comp entry. OUTPUT-ONLY: populated by loadProfile, recomputed
  // on every profile / body-comp write, and IGNORED by saveProfile input.
  target_kcal?: number | null;
  target_protein_g?: number | null;
  target_fat_g?: number | null;
  target_carbs_g?: number | null;
  target_fiber_g?: number | null;
  targets_computed_at?: string | null; // ISO timestamp
};

export type MealItem = Macros & {
  food: string;
  grams: number;
  source?: "db" | "estimated" | "manual";
  // Presentation-only grouping tag: set when this item came from expanding a
  // recipe into the log (log_recipe). Items sharing one recipe tag render as a
  // single collapsible card. Anything that ignores it sees a normal MealItem.
  recipe?: { slug: string; name: string; servings: number };
};

export type Meal = {
  slot: "breakfast" | "lunch" | "dinner" | "snack" | string;
  time?: string;
  items: MealItem[];
};

export type MealLog = {
  date: string;
  meals: Meal[];
};

// One line of food, anywhere a human eats/plans it.
//   meal_log:  macros always present (frozen at log time — see MealItem)
//   diet_plan: macros absent → resolve live from pantry;
//              present → explicit override / non-pantry food
// Never store per-100 macros in a Portion (those live on PantryItem).
export type Portion = {
  food: string; // canonical pantry name (soft ref — survives pantry deletes)
  grams: number; // always grams; pcs items convert via grams_per_serving
  macros?: Macros; // ABSOLUTE for this portion (override), not per-100
  source?: "db" | "estimated" | "manual";
};

// ---- diet plan (normalized template: plan → day → meal → portion) ----
//
// The hydrated tree mirrors the legacy JSONB shape ({ start_date?,
// default_target?, rotation }) so dayTargetFromPlan / buildShoppingList kept
// their call shape — but every node now carries its row id (granular edits)
// and plan items are resolvable Portions instead of frozen MealItems.

export type DietPlanPortion = Portion & { id: number };

export type DietPlanMeal = {
  id: number;
  slot: "breakfast" | "lunch" | "dinner" | "snack" | string;
  time?: string; // HH:MM
  items: DietPlanPortion[];
};

export type DietPlanDay = {
  id: number;
  name: string;
  // Weekdays this day runs on (weekday mode); empty = index-rotation only.
  weekdays: Weekday[];
  target?: Macros;
  meals: DietPlanMeal[];
};

export type DietPlan = {
  id: number;
  name: string;
  start_date?: string; // anchors index-based rotation
  default_target?: Macros;
  rotation: DietPlanDay[];
};

// Shape written by save_diet_plan / PUT /diet/plan — server assigns ids.
export type DietPlanWriteInput = {
  name?: string | null;
  start_date?: string | null;
  default_target?: Macros | null;
  days: Array<{
    name: string;
    weekdays?: Weekday[];
    target?: Macros | null;
    meals: Array<{
      slot: string;
      time?: string | null;
      items: Portion[];
    }>;
  }>;
};

// ---- recipe (a named, reusable bundle of ingredient Portions) ----
//
// A recipe is conceptually a diet-plan meal extracted to stand alone: a named,
// ordered list of live-resolving Portions. Reuses the Portion model exactly —
// macros absent → resolve live from the pantry; present → explicit override.
// Each portion carries its row id so the granular update_recipe_portion tool
// mirrors update_diet_portion.

export type RecipePortion = Portion & { id: number };

export type Recipe = {
  id: number;
  name: string; // display name: "Chicken Rice Bowl"
  slug: string; // canonical snake_case key (unique per user)
  servings: number; // batch yield — divides totals into per-serving macros
  favorite: boolean; // user-starred for quick access
  notes?: string;
  instructions?: string; // the method / steps to make it
  source_url?: string; // origin when imported from a recipe page
  ingredients: RecipePortion[];
};

// Shape written by save_recipe / update_recipe — server assigns ids + slug.
export type RecipeWriteInput = {
  name: string;
  servings?: number | null;
  favorite?: boolean | null;
  notes?: string | null;
  instructions?: string | null;
  source_url?: string | null;
  ingredients: Portion[];
};

// One weigh-in. Raw fields are what the user entered (or a sensor read);
// computed fields are derived at write time using the profile's height + sex.
// `body_fat_pct` is the user-entered reading (DEXA / scale / caliper).
// `body_fat_pct_navy` is the Navy-method estimate from circumferences — kept
// separate so we never overwrite a real measurement with an estimate.
// The effective body-fat % for downstream math is `body_fat_pct ?? body_fat_pct_navy`.
export type BodyCompEntry = {
  // Database row id. Present on entries read back from storage; absent on
  // entries freshly constructed in-memory (e.g. log_body_comp before write).
  // Lets callers target one specific weigh-in when several share a date.
  id?: number;
  date: string; // YYYY-MM-DD
  // raw inputs
  weight_kg: number | null;
  body_fat_pct: number | null;
  body_fat_method?: BodyFatMethod | null;
  waist_cm: number | null;
  neck_cm?: number | null;
  hip_cm?: number | null;
  notes?: string;
  time?: string | null; // HH:MM local, when it was measured; null = not given
  // computed
  body_fat_pct_navy?: number | null;
  bmi?: number | null;
  ffmi?: number | null;
  ffmi_normalized?: number | null;
  fat_free_mass_kg?: number | null;
  fat_mass_kg?: number | null;
  // When the entry was logged (ISO timestamp). Read-only; set by storage.
  logged_at?: string;
};

// A cardio-fitness reading: heart rates the user entered plus the VO₂max
// derived from them at write time (see computeVo2Max in cardio.ts). Like
// BodyCompEntry this is the time-series source of truth — read the latest row
// for "current" cardio fitness.
export type CardioEntry = {
  // Database row id. Present on entries read back from storage; absent on
  // entries freshly constructed in-memory (e.g. log_cardio before write).
  id?: number;
  date: string; // YYYY-MM-DD
  // raw inputs
  resting_heart_rate: number | null;
  max_heart_rate?: number | null;
  notes?: string;
  // computed (write-time snapshot from the profile's age + sex)
  vo2_max?: number | null;
  vo2_max_category?: import("./cardio.ts").Vo2MaxCategory | null;
  max_heart_rate_estimated?: boolean | null;
};

// Tape-measure girths that only matter for proportions (one measuring session
// per day). Waist / neck / hip are NOT here — they live on BodyCompEntry,
// where they also feed the Navy BF% estimate. Arm is flexed.
export const MUSCLE_GIRTHS = ["shoulders", "chest", "arm", "forearm", "thigh", "calf"] as const;
export type MuscleGirth = (typeof MUSCLE_GIRTHS)[number];

export type BodyMeasurementEntry = {
  id?: number;
  date: string; // YYYY-MM-DD
  shoulders_cm: number | null;
  chest_cm: number | null;
  arm_cm: number | null;
  forearm_cm: number | null;
  thigh_cm: number | null;
  calf_cm: number | null;
  notes?: string;
  time?: string | null; // HH:MM local, when it was measured; null = not given
  // When the session was last measured (ISO timestamp). Read-only; set by
  // storage — a re-measure the same day overwrites the row, so it's updated_at.
  logged_at?: string;
};

// Serving / amount unit for a pantry item. "g"/"ml" are base units (macros
// are stored per-100 of them); "pcs" is a count, converted to base grams via
// `grams_per_serving`.
export type ServingUnit = "g" | "ml" | "pcs";

// A pantry item is the unified food/supplement record (supplements are just
// category "supplement"): quantity on hand PLUS
// the nutritional facts (per-100 g/ml macros) that used to live in the global
// food_db. `macros` is optional because a freshly-scanned receipt line may
// carry only a name + quantity until it's enriched.
export type PantryItem = {
  name: string; // canonical snake_case key (unique per user)
  quantity: number; // amount on hand, in `unit`
  unit: ServingUnit;
  grams_per_serving?: number; // grams in one piece (for unit="pcs")
  to_buy: boolean; // restock flag — surfaces on the shopping list
  category?: string;
  // Optional UPC/EAN/GTIN, digits-only. Resolves a scanned label against the
  // user's own pantry before falling back to OpenFoodFacts.
  barcode?: string;
  // per-100 g/ml macros (absent until known)
  macros?: Macros;
};

export type Pantry = {
  items: Record<string, PantryItem>;
};
