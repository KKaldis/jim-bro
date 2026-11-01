/**
 * Drizzle schema. Two layers:
 *   1. Better Auth tables (user / session / account / verification).
 *      Names + columns must match Better Auth's expectations.
 *   2. App tables (profile, plans, logs, pantry, conversation, usage).
 *      All app tables FK to user.id with ON DELETE CASCADE so DELETE /me
 *      tears everything down in one statement.
 *
 * Nested-but-bounded structures (rotation, weekly_split, meal items, etc.)
 * are stored as JSONB rather than normalized — they're per-user blobs that
 * we read whole, never query into.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// =====================================================================
// Better Auth tables
// =====================================================================

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  // No `image` column: email+password only, no avatars. Better Auth still
  // sends `image` on signup/updateUser — packages/auth strips it in a
  // databaseHook, since the Drizzle adapter rejects fields not in the schema.
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// =====================================================================
// App tables
// =====================================================================

// Profile holds stable identity + targets only. Weight / body-fat / circumference
// readings live in body_comp_entry — that table is the single source of truth
// for "current weight" everywhere downstream (BMR, dashboards, agent tools).
// Anything that needs today's body state reads the latest entry and merges it
// with the profile's height/sex/birth_year/activity/goal at compute time.
export const profile = pgTable(
  "profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    sex: varchar("sex", { length: 16 }).notNull(),
    birthYear: integer("birth_year").notNull(), // e.g. 1990
    heightCm: doublePrecision("height_cm").notNull(),
    activityLevel: varchar("activity_level", { length: 32 }).notNull(),
    goal: varchar("goal", { length: 32 }).notNull(),
    targetWeightKg: doublePrecision("target_weight_kg"),
    restrictions: jsonb("restrictions"), // string[]
    notes: text("notes"),
    // Skeletal-frame proxies for the Casey-Butt muscular-potential estimate.
    // Stable (don't change with training); optional. Stored metric (cm).
    wristCm: doublePrecision("wrist_cm"),
    ankleCm: doublePrecision("ankle_cm"),
    // Preferred unit system for the measurement UI (display-only; storage is
    // always metric). NULL = treated as 'metric'.
    units: varchar("units", { length: 16 }),
    // Preferred product language (BCP-47 base subtag: 'en' | 'el' | 'ar' | 'sq' | 'fa' | 'ur' | 'nl' | 'it'). Single
    // source of truth for the UI language AND the language the agent authors
    // stored content in (recipe/meal names, notes, descriptions). NULL = 'en'.
    language: varchar("language", { length: 8 }).default("en"),
    // The user's everyday hydration target in ml. Single source of truth for
    // the daily water goal — applies to every day. NULL = use the app default
    // (DEFAULT_WATER_GOAL_ML).
    waterGoalMl: integer("water_goal_ml"),
    // Catalog machine ids (snake_case) the user's gym has, e.g.
    // ["lat_pulldown_machine", "leg_press_machine"]. Optional equipment
    // filter the agent prefers when building plans. NULL / empty = no
    // constraint (plan with all machines). Plain string[]; no FK to the
    // static catalog, mirroring exercise_id / machine_id elsewhere.
    gymMachineIds: jsonb("gym_machine_ids"), // string[]

    // The user's currently-active diet plan (exactly one). NULL = no active plan.
    // ON DELETE SET NULL so deleting the active plan just clears the pointer.
    activeDietPlanId: bigint("active_diet_plan_id", { mode: "number" }).references(
      () => dietPlan.id,
      { onDelete: "set null" },
    ),
    // The user's currently-active workout plan (exactly one). Mirrors
    // activeDietPlanId — NULL = none active, ON DELETE SET NULL clears it.
    activeWorkoutPlanId: bigint("active_workout_plan_id", {
      mode: "number",
    }).references(() => workoutPlan.id, { onDelete: "set null" }),
    // Cached "recommended" daily target (#1): derived from this profile + the
    // latest body_comp_entry via computeTargets(). OUTPUT-ONLY — recomputed on
    // every profile / body-comp write, never read back as an input. Distinct from
    // the diet plan's prescribed target (default_target_* on diet_plan).
    targetKcal: doublePrecision("target_kcal"),
    targetProteinG: doublePrecision("target_protein_g"),
    targetFatG: doublePrecision("target_fat_g"),
    targetCarbsG: doublePrecision("target_carbs_g"),
    targetFiberG: doublePrecision("target_fiber_g"),
    targetsComputedAt: timestamp("targets_computed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // DB-level mirror of the Sex / ActivityLevel / Goal unions in
    // packages/shared/src/types.ts. See drizzle/0015_value_check_constraints.sql.
    sexCheck: check("profile_sex_check", sql`${t.sex} IN ('male', 'female')`),
    activityLevelCheck: check(
      "profile_activity_level_check",
      sql`${t.activityLevel} IN ('sedentary', 'light', 'moderate', 'very', 'extreme')`,
    ),
    goalCheck: check(
      "profile_goal_check",
      sql`${t.goal} IN ('cut', 'maintain', 'recomp', 'lean_bulk')`,
    ),
  }),
);

// =====================================================================
// Diets (normalized template: plan → day → meal → portion)
// =====================================================================
//
// Mirrors the workout-table pattern (workout_plan → day → exercise). A user
// can have many plans; exactly one is "active" (profile.active_diet_plan_id).
// Per-macro COLUMNS, never a JSONB macro blob inside a normalized row;
// fiber stays nullable (NULL = unknown, 0 = known zero).

export const dietPlan = pgTable(
  "diet_plan",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("My diet plan"),
    // Anchors index-based rotation (vs weekday-based). YYYY-MM-DD.
    startDate: varchar("start_date", { length: 10 }),
    // Default day target (fallback when the day carries none).
    defaultTargetKcal: doublePrecision("default_target_kcal"),
    defaultTargetP: doublePrecision("default_target_p"),
    defaultTargetF: doublePrecision("default_target_f"),
    defaultTargetC: doublePrecision("default_target_c"),
    defaultTargetFiber: doublePrecision("default_target_fiber"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("diet_plan_user_idx").on(t.userId),
  }),
);

// One row per rotation day. `position` orders the rotation (index mode);
// `weekdays` pins the day to weekdays (one day can run Mon AND Thu).
export const dietPlanDay = pgTable(
  "diet_plan_day",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    planId: bigint("plan_id", { mode: "number" })
      .notNull()
      .references(() => dietPlan.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    weekdays: text("weekdays")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    name: text("name").notNull(),
    // Per-day target override (nullable — fall back to the plan default).
    targetKcal: doublePrecision("target_kcal"),
    targetP: doublePrecision("target_p"),
    targetF: doublePrecision("target_f"),
    targetC: doublePrecision("target_c"),
    targetFiber: doublePrecision("target_fiber"),
  },
  (t) => ({
    byPlan: index("diet_plan_day_plan_idx").on(t.planId),
  }),
);

export const dietPlanMeal = pgTable(
  "diet_plan_meal",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dayId: bigint("day_id", { mode: "number" })
      .notNull()
      .references(() => dietPlanDay.id, { onDelete: "cascade" }),
    slot: varchar("slot", { length: 32 }).notNull(), // breakfast | lunch | ... | free text
    time: varchar("time", { length: 5 }), // HH:MM
    position: integer("position").notNull().default(0),
  },
  (t) => ({
    byDay: index("diet_plan_meal_day_idx").on(t.dayId, t.position),
  }),
);

// One planned portion. `food` is a soft ref to pantry_item.name (no FK —
// renames/deletes must not orphan the plan). Macro columns are OVERRIDE
// values, absolute for this portion: NULL = resolve live from the pantry.
export const dietPlanPortion = pgTable(
  "diet_plan_portion",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    mealId: bigint("meal_id", { mode: "number" })
      .notNull()
      .references(() => dietPlanMeal.id, { onDelete: "cascade" }),
    food: text("food").notNull(),
    grams: doublePrecision("grams").notNull(),
    position: integer("position").notNull().default(0),
    kcal: doublePrecision("kcal"),
    proteinG: doublePrecision("protein_g"),
    fatG: doublePrecision("fat_g"),
    carbsG: doublePrecision("carbs_g"),
    fiberG: doublePrecision("fiber_g"),
    source: varchar("source", { length: 16 }), // db | estimated | manual
  },
  (t) => ({
    byMeal: index("diet_plan_portion_meal_idx").on(t.mealId, t.position),
  }),
);

// A recipe is a named, reusable bundle of ingredient portions — conceptually a
// `diet_plan_meal` extracted to stand alone (no plan/day/meal ancestry). The
// user builds it once ("chicken rice bowl") and logs the whole thing as one
// collapsed meal-log entry instead of re-entering each food. `slug` is the
// canonical snake_case key (unique per user), kept in a SEPARATE namespace from
// pantry_item.name so a recipe can't shadow a food in lookup_food. `servings`
// lets a batch-cooked recipe divide into per-serving portions.
export const recipe = pgTable(
  "recipe",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // display name: "Chicken Rice Bowl"
    slug: text("slug").notNull(), // canonical snake_case key
    servings: doublePrecision("servings").notNull().default(1),
    favorite: boolean("favorite").notNull().default(false), // user-starred for quick access
    notes: text("notes"),
    instructions: text("instructions"), // the method / steps to make it
    sourceUrl: text("source_url"), // origin when imported from a recipe page
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byUserSlug: uniqueIndex("recipe_user_slug_idx").on(t.userId, t.slug),
  }),
);

// One recipe ingredient. Mirrors diet_plan_portion exactly (minus the plan
// ancestry): `food` is a soft ref to pantry_item.name (no FK — a recipe
// survives a pantry rename/delete), grams is always grams (pcs items convert
// via grams_per_serving at expand time), and the macro columns are an absolute
// OVERRIDE for this portion — NULL = resolve live from the pantry at read time.
export const recipePortion = pgTable(
  "recipe_portion",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recipeId: bigint("recipe_id", { mode: "number" })
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    food: text("food").notNull(),
    grams: doublePrecision("grams").notNull(),
    position: integer("position").notNull().default(0),
    kcal: doublePrecision("kcal"),
    proteinG: doublePrecision("protein_g"),
    fatG: doublePrecision("fat_g"),
    carbsG: doublePrecision("carbs_g"),
    fiberG: doublePrecision("fiber_g"),
    source: varchar("source", { length: 16 }), // db | estimated | manual
  },
  (t) => ({
    byRecipe: index("recipe_portion_recipe_idx").on(t.recipeId, t.position),
  }),
);

// Pantry rows: composite PK (user_id, name). This is the user's single food +
// supplement catalog — quantities AND the nutritional facts that used to live
// in the global food_db. There is no shared food database anymore: a food
// "exists" for a user iff it's a pantry row.
//
//   - `quantity`+`unit` amount on hand, expressed in `unit` (g | ml | pcs).
//   - `gramsPerServing` grams in one `pcs` serving — lets count-based items
//                        resolve to macros (1 egg = 60g → macros for 60g).
//   - macros            per-100 g/ml. Nullable: a freshly-scanned receipt item
//                        may carry just a name + quantity until enriched.
//   - `toBuy`           restock flag — surfaces on the shopping list.
//   - `barcode`         optional UPC/EAN/GTIN, digits-only; resolves a scanned
//                        label against the user's own pantry first.
export const pantryItem = pgTable(
  "pantry_item",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    quantity: doublePrecision("quantity").notNull().default(0),
    unit: varchar("unit", { length: 16 }).notNull().default("g"),
    gramsPerServing: doublePrecision("grams_per_serving"),
    // per-100 g/ml macros (nullable until known)
    kcal: doublePrecision("kcal"),
    proteinG: doublePrecision("protein_g"),
    fatG: doublePrecision("fat_g"),
    carbsG: doublePrecision("carbs_g"),
    fiberG: doublePrecision("fiber_g"),
    category: text("category"),
    barcode: text("barcode"),
    toBuy: boolean("to_buy").notNull().default(false),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.name] }),
    // Resolve a scanned barcode against this user's pantry.
    byBarcode: index("pantry_item_barcode_idx").on(t.userId, t.barcode),
    // See drizzle/0015_value_check_constraints.sql.
    unitCheck: check("pantry_item_unit_check", sql`${t.unit} IN ('g', 'ml', 'pcs')`),
  }),
);

// Per-day meal log: PK (user_id, date), meals as JSONB (Meal[]).
export const mealLog = pgTable(
  "meal_log",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(),
    meals: jsonb("meals").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.date] }),
  }),
);

// One aggregate step count per user per day. Steps are inherently a daily
// total (a pedometer integrates over the whole day), so — unlike workout sets
// — they live as a single upserted row keyed by (user, date) rather than as
// per-event rows. The PWA's accelerometer step-detector flushes the running
// total here; the Dashboard tile and the Workout "Walking" card both read it.
// `goal` is the user's daily target (nullable → use the app default).
export const dailySteps = pgTable(
  "daily_steps",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
    steps: integer("steps").notNull().default(0),
    goal: integer("goal"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.date] }),
  }),
);

// One aggregate water-intake total per user per day. Like daily_steps, intake
// is a running daily total (the user logs glasses/bottles over the day), so it
// lives as a single upserted row keyed by (user, date) rather than per-sip
// rows. `ml` is the absolute total for the day. The daily goal is NOT per-day:
// it lives on profile.water_goal_ml. Read by the HydrationCard and
// loggable/editable by the chat agent (log_water tool).
export const waterLog = pgTable(
  "water_log",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
    ml: integer("ml").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.date] }),
  }),
);

// Time-series source of truth for body state. Each row stores both the raw
// measurements the user entered (or a sensor read) and the values derived from
// them at write time:
//   raw:      weight_kg, body_fat_pct, waist_cm, neck_cm, hip_cm, body_fat_method
//   computed: body_fat_pct_navy (Navy circumference estimate),
//             bmi, ffmi, ffmi_normalized, fat_free_mass_kg, fat_mass_kg
//
// Computed values are snapshotted with the profile's height/sex at the moment
// of write — if the user later corrects their height/sex on the profile, prior
// rows keep their original computed values. That's the deliberate trade-off
// for cheap time-series queries; a future "recompute" pass can refresh them.
export const bodyCompEntry = pgTable(
  "body_comp_entry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(),
    // --- raw inputs ---
    weightKg: doublePrecision("weight_kg"),
    bodyFatPct: doublePrecision("body_fat_pct"),
    bodyFatMethod: varchar("body_fat_method", { length: 32 }),
    waistCm: doublePrecision("waist_cm"),
    neckCm: doublePrecision("neck_cm"),
    hipCm: doublePrecision("hip_cm"),
    notes: text("notes"),
    time: varchar("time", { length: 5 }), // HH:MM local, user-picked; null = unset
    // --- computed (write-time snapshot) ---
    bodyFatPctNavy: doublePrecision("body_fat_pct_navy"),
    bmi: doublePrecision("bmi"),
    ffmi: doublePrecision("ffmi"),
    ffmiNormalized: doublePrecision("ffmi_normalized"),
    fatFreeMassKg: doublePrecision("fat_free_mass_kg"),
    fatMassKg: doublePrecision("fat_mass_kg"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byUserDate: index("body_comp_user_date_idx").on(t.userId, t.date),
    // Mirrors the BodyFatMethod union; NULL allowed (a CHECK passes on NULL).
    // See drizzle/0015_value_check_constraints.sql.
    bodyFatMethodCheck: check(
      "body_comp_entry_body_fat_method_check",
      sql`${t.bodyFatMethod} IN ('dexa', 'bia_scale', 'caliper', 'visual_estimate', 'navy', 'other')`,
    ),
  }),
);

// Tape-measure girths for tracking muscle proportions (Body → Measurements).
// One row per user per day — a measuring session — so a re-measure the same
// day overwrites rather than stacks. Arm is measured flexed.
//
// Waist / neck / hip deliberately do NOT live here: they feed the Navy BF%
// estimate, so they stay on body_comp_entry (the day's weigh-in) and the
// Measurements view reads/writes them there. One source of truth per girth.
export const bodyMeasurement = pgTable(
  "body_measurement",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(),
    shouldersCm: doublePrecision("shoulders_cm"),
    chestCm: doublePrecision("chest_cm"),
    armCm: doublePrecision("arm_cm"),
    forearmCm: doublePrecision("forearm_cm"),
    thighCm: doublePrecision("thigh_cm"),
    calfCm: doublePrecision("calf_cm"),
    notes: text("notes"),
    time: varchar("time", { length: 5 }), // HH:MM local, user-picked; null = unset
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byUserDate: uniqueIndex("body_measurement_user_date_idx").on(t.userId, t.date),
  }),
);

// Time-series source of truth for cardio fitness. Each row stores the raw
// heart-rate readings the user entered and the VO₂max derived from them at
// write time (Uth formula), snapshotted with the profile's age + sex at the
// moment of write — same write-time-snapshot contract as body_comp_entry, so a
// later profile edit doesn't silently rewrite history.
//   raw:      resting_heart_rate, max_heart_rate
//   computed: vo2_max, vo2_max_category, max_heart_rate_estimated
export const cardioEntry = pgTable(
  "cardio_entry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(),
    // --- raw inputs ---
    restingHeartRate: doublePrecision("resting_heart_rate"),
    maxHeartRate: doublePrecision("max_heart_rate"),
    notes: text("notes"),
    // --- computed (write-time snapshot) ---
    vo2Max: doublePrecision("vo2_max"),
    vo2MaxCategory: varchar("vo2_max_category", { length: 16 }),
    maxHeartRateEstimated: boolean("max_heart_rate_estimated"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byUserDate: index("cardio_entry_user_date_idx").on(t.userId, t.date),
    // Mirrors the Vo2MaxCategory union in packages/shared/src/cardio.ts.
    vo2MaxCategoryCheck: check(
      "cardio_entry_vo2_max_category_check",
      sql`${t.vo2MaxCategory} IN ('poor', 'fair', 'good', 'excellent', 'superior')`,
    ),
  }),
);

// One row per Anthropic message. content is the full content-block array
// (text + thinking + tool_use + tool_result), with image data stripped on
// save (replaced by a text placeholder) to keep rows small.
//
// provider/model attribute each row to the LLM that was active when the row
// was written — so a conversation that spans a model switch can be audited
// per-message. Nullable for pre-feature rows.
export const conversationMessage = pgTable(
  "conversation_message",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(), // user | assistant
    content: jsonb("content").notNull(),
    provider: varchar("provider", { length: 32 }),
    model: varchar("model", { length: 128 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("conversation_user_id_idx").on(t.userId, t.id),
  }),
);

// Append-only ledger of API usage. One row per provider API call (one agent
// loop iteration). `chat_id` groups iterations of a single /chat call;
// `iteration_index` orders them. `message_id` links to the assistant message
// produced (nullable, ON DELETE SET NULL — preserves cost rows when a user
// erases their chat history). `provider` + `model` attribute the call so
// multi-provider deployments can report per-provider spend.
//
// Pre-feature rows have chat_id / iteration_index / message_id NULL and
// represent the old per-chat aggregate format.
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id"),
    iterationIndex: integer("iteration_index"),
    messageId: bigint("message_id", { mode: "number" }).references(() => conversationMessage.id, {
      onDelete: "set null",
    }),
    provider: varchar("provider", { length: 32 }).notNull().default("anthropic"),
    model: varchar("model", { length: 128 }).notNull().default(""),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    stopReason: varchar("stop_reason", { length: 64 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("usage_ledger_user_idx").on(t.userId, t.createdAt),
    byProviderModel: index("usage_ledger_provider_model_idx").on(t.provider, t.model, t.createdAt),
    byChat: index("usage_ledger_chat_idx").on(t.chatId),
  }),
);

// =====================================================================
// AI usage
// =====================================================================
//
// One row per AI operation the user triggered — a chat turn (all its agent-loop
// iterations) or an image recognition — for the usage page (GET /me/usage).
// Distinct grain from usage_ledger: that table is per-provider-call telemetry
// for chat only (pruned after a year). `kind` is llm | image_recognition,
// `source` the product surface (chat, food_scan, …) — see USAGE_KINDS /
// USAGE_SOURCES in @fa/shared/usage. Server extensions get each row through
// onUsage() in @fa/agent and can keep their own ledgers keyed on `id`.
export const aiUsageEvent = pgTable(
  "ai_usage_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    // Provider-run web searches in this event (priced per search).
    webSearches: integer("web_searches").notNull().default(0),
    // Estimated provider cost at list price, in micro-USD (1e-6 $). NULL when
    // the model has no MODEL_PRICES row.
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" }),
    chatId: uuid("chat_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("ai_usage_event_user_idx").on(t.userId, t.createdAt),
  }),
);

// =====================================================================
// Workout tables
// =====================================================================
//
// Normalized split: plan → day → exercise (prescription), and session → set
// (the actual lifts performed). exercise_id / machine_id are plain text
// references to the static catalog in @fa/shared/data (no FK — catalog IDs
// can be renamed/removed without orphaning history, and user-custom exercises
// land in a future user_exercise table without changing this shape).

export const workoutPlan = pgTable(
  "workout_plan",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("workout_plan_user_idx").on(t.userId),
  }),
);

// One row per plan day. `weekdays` is the set of weekdays this day is
// scheduled to (empty = unscheduled template day). Stored as a Postgres
// text[] so "Chest Day 1 runs Mon + Thu" is one row, not two.
export const workoutPlanDay = pgTable(
  "workout_plan_day",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    planId: bigint("plan_id", { mode: "number" })
      .notNull()
      .references(() => workoutPlan.id, { onDelete: "cascade" }),
    weekdays: text("weekdays")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    name: text("name").notNull(),
    focus: text("focus"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byPlan: index("workout_plan_day_plan_idx").on(t.planId),
  }),
);

// Prescription: which exercise + how many sets/reps + a target weight hint.
export const workoutPlanExercise = pgTable(
  "workout_plan_exercise",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    planDayId: bigint("plan_day_id", { mode: "number" })
      .notNull()
      .references(() => workoutPlanDay.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id").notNull(), // catalog id
    machineId: text("machine_id"), // catalog id, optional
    order: integer("order").notNull().default(0),
    targetSets: integer("target_sets").notNull().default(3),
    // Which targets apply depends on the exercise (see exerciseFields): reps
    // for lifts, duration for timed holds and cardio — the other stays null.
    targetReps: integer("target_reps").default(8),
    targetWeightKg: doublePrecision("target_weight_kg"),
    targetDurationSec: integer("target_duration_sec"), // seconds
    notes: text("notes"),
  },
  (t) => ({
    byDay: index("workout_plan_exercise_day_idx").on(t.planDayId, t.order),
  }),
);

// One row per session. plan_day_id is nullable so users can do ad-hoc
// (unplanned) sessions. Multiple sessions per date are allowed.
export const workoutSession = pgTable(
  "workout_session",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
    planDayId: bigint("plan_day_id", { mode: "number" }).references(() => workoutPlanDay.id, {
      onDelete: "set null",
    }),
    name: text("name"),
    durationMin: doublePrecision("duration_min"),
    kcalBurned: doublePrecision("kcal_burned"),
    notes: text("notes"),
    startedAt: timestamp("started_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    byUserDate: index("workout_session_user_date_idx").on(t.userId, t.date),
  }),
);

// One row per set. exercise_id matches WorkoutPlanExercise.exercise_id by
// convention but isn't FK'd — it points at the static catalog (or a future
// user_exercise table). Index by (user via session, exercise_id, completed_at)
// powers the per-exercise progress query.
export const workoutSessionSet = pgTable(
  "workout_session_set",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: bigint("session_id", { mode: "number" })
      .notNull()
      .references(() => workoutSession.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id").notNull(),
    machineId: text("machine_id"),
    setIndex: integer("set_index").notNull(), // 1-based within the exercise
    reps: integer("reps").notNull(),
    weightKg: doublePrecision("weight_kg").notNull().default(0),
    rpe: doublePrecision("rpe"),
    // Cardio work (running/cycling/rowing…) and timed holds (plank): elapsed
    // seconds (+ optional metres for cardio). Null on lifted sets. Drives
    // MET-based calorie estimation.
    durationSec: integer("duration_sec"),
    distanceM: doublePrecision("distance_m"),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    bySession: index("workout_set_session_idx").on(t.sessionId),
    byExercise: index("workout_set_exercise_idx").on(t.exerciseId, t.completedAt),
  }),
);

// =====================================================================
// Feature requests
// =====================================================================
//
// Append-only inbox of feature requests the chat agent files on the user's
// behalf (submit_feature_request tool) when they ask for a capability the app
// doesn't have yet. One row per request; `status` lets a maintainer triage
// (open → planned/declined/shipped) without a schema change. FK to user with
// ON DELETE CASCADE so DELETE /me clears them with everything else.
export const toolFeatureRequest = pgTable(
  "tool_feature_request",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    details: text("details"),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("tool_feature_request_user_idx").on(t.userId, t.createdAt),
    statusCheck: check(
      "tool_feature_request_status_check",
      sql`${t.status} IN ('open', 'planned', 'declined', 'shipped')`,
    ),
  }),
);
