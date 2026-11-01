/**
 * Per-user storage backed by Postgres (Drizzle).
 *
 * Public surface kept stable from the prior YAML-backed version, except all
 * read/write methods are now async.
 *
 * Conversation persistence: rows in conversation_message (one per message).
 * Image blocks in user-role messages are stripped on save and replaced with
 * a small text placeholder, so per-row JSONB stays bounded and we don't
 * re-send (and re-pay for) image tokens on every subsequent turn.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, sql } from "drizzle-orm";

import { db, schema } from "@fa/db_postgres";
import { logger } from "@fa/logger";
import {
  BF_CARRY_FORWARD_DAYS as SHARED_BF_CARRY_FORWARD_DAYS,
  computeTargets,
  exerciseFields,
  getExercise,
  MUSCLE_GIRTHS,
  toPantryKey,
  type ProportionPart,
  WEEKDAYS,
} from "@fa/shared";
import type { FaMessage, FaTextBlock } from "./schema/index.ts";
import type {
  BodyCompEntry,
  BodyMeasurementEntry,
  CardioEntry,
  DietPlan,
  DietPlanDay,
  DietPlanMeal,
  DietPlanPortion,
  DietPlanWriteInput,
  Portion,
  ExerciseId,
  MachineId,
  Macros,
  MealLog,
  Pantry,
  PantryItem,
  Profile,
  Recipe,
  RecipePortion,
  RecipeWriteInput,
  ServingUnit,
  Weekday,
  WorkoutPlan,
  WorkoutPlanDay,
  WorkoutPlanExercise,
  WorkoutPlanWriteInput,
  WorkoutSession,
  WorkoutSessionPatchInput,
  WorkoutSessionStartInput,
  WorkoutSet,
  WorkoutSetInput,
  LastExerciseSet,
} from "@fa/shared";

const log = logger.child({ pkg: "agent", mod: "storage" });

const VALID_WEEKDAYS: ReadonlySet<string> = new Set(WEEKDAYS);

// Coerce a Postgres text[] column (or any unknown shape) into a deduped
// list of valid Weekday values. Anything else is dropped — old single-string
// values that lingered through the migration become a one-element array,
// nulls become an empty array. (Lenient on purpose: this reads stored rows.
// Writes are validated strictly by @fa/shared normalizeWeekdays upstream.)
function coerceWeekdays(value: unknown): Weekday[] {
  const arr = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  const seen = new Set<Weekday>();
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const w = v.trim().toLowerCase();
    if (VALID_WEEKDAYS.has(w)) seen.add(w as Weekday);
  }
  return Array.from(seen);
}

// Executor handle for queries — either the pool-backed `db()` or a transaction
// `tx`. Threading `tx` into hydration reads is essential when a row was just
// inserted in the same transaction: a fresh `db()` query uses a different
// pooled connection and won't see the uncommitted insert.
type DbExecutor =
  ReturnType<typeof db> | Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

// The target columns a plan exercise uses (see exerciseFields): reps for lifts,
// seconds for timed holds and cardio — the unused one is stored null. A lift
// without target_reps falls back to 8, the column default.
function planTargetColumns(e: {
  exercise_id: string;
  target_reps?: number | null;
  target_duration_sec?: number | null;
}): { targetReps: number | null; targetDurationSec: number | null } {
  const fields = exerciseFields(getExercise(e.exercise_id));
  return {
    targetReps: fields.reps ? (e.target_reps ?? 8) : null,
    targetDurationSec: fields.duration ? (e.target_duration_sec ?? null) : null,
  };
}

// User ids come from Better Auth (CUID/UUID). Keep a permissive validator for
// dev / programmatic callers — auth-derived ids always pass.
const USERID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function validateUserId(id: string): void {
  if (!USERID_RE.test(id)) {
    throw new Error(`invalid userId: must match ${USERID_RE} (got: ${JSON.stringify(id)})`);
  }
}

// --- pantry helpers (row <-> domain) ---

// Partial update for a single pantry item. Fields left `undefined` are not
// touched on update; on insert they fall back to column defaults. Pass
// `macros: null` to clear macros, `barcode: null` to clear a barcode, etc.
export type PantryItemPatch = {
  quantity?: number;
  unit?: ServingUnit;
  grams_per_serving?: number | null;
  to_buy?: boolean;
  category?: string | null;
  barcode?: string | null;
  macros?: Macros | null;
};

// How far back recomputeTargets reaches for a body-fat reading when the latest
// weigh-in is weight-only — shared with the client's latestBodyMetrics so the
// cached target and the on-screen one agree.
const BF_CARRY_FORWARD_DAYS = SHARED_BF_CARRY_FORWARD_DAYS;

// Shift a YYYY-MM-DD date string back by `days`, returning YYYY-MM-DD. Anchored
// at UTC midnight so DST/offset never nudges the result across a day boundary.
function isoDateMinusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Sort keys for queryPantry. "quantity" plus the four macro columns sort with
// NULLs last; "name" is the default.
export type PantrySort = "name" | "quantity" | "kcal" | "protein" | "carbs" | "fat";

export type PantryQueryOpts = {
  q?: string;
  category?: string;
  sort?: PantrySort;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type PantryQueryResult = {
  items: PantryItem[];
  total: number;
  categories: string[];
};

function rowToPantryItem(r: typeof schema.pantryItem.$inferSelect): PantryItem {
  const hasMacros = r.kcal != null;
  const item: PantryItem = {
    name: r.name,
    quantity: r.quantity,
    unit: (r.unit as ServingUnit) ?? "g",
    to_buy: r.toBuy,
  };
  if (r.gramsPerServing != null) item.grams_per_serving = r.gramsPerServing;
  if (r.category) item.category = r.category;
  if (r.barcode) item.barcode = r.barcode;
  if (hasMacros) {
    const macros: Macros = {
      kcal: r.kcal ?? 0,
      p: r.proteinG ?? 0,
      f: r.fatG ?? 0,
      c: r.carbsG ?? 0,
    };
    if (r.fiberG != null) macros.fiber = r.fiberG;
    item.macros = macros;
  }
  return item;
}

// --- diet-plan helpers (row <-> domain) ---

// Per-macro columns → Macros value-object. All-null columns mean "no target
// / no override" → undefined. fiber stays absent when NULL (unknown).
function macrosFromColumns(
  kcal: number | null,
  p: number | null,
  f: number | null,
  c: number | null,
  fiber: number | null,
): Macros | undefined {
  if (kcal == null && p == null && f == null && c == null && fiber == null) {
    return undefined;
  }
  const m: Macros = { kcal: kcal ?? 0, p: p ?? 0, f: f ?? 0, c: c ?? 0 };
  if (fiber != null) m.fiber = fiber;
  return m;
}

function rowToDietPortion(r: typeof schema.dietPlanPortion.$inferSelect): DietPlanPortion {
  const macros = macrosFromColumns(r.kcal, r.proteinG, r.fatG, r.carbsG, r.fiberG);
  return {
    id: r.id,
    food: r.food,
    grams: r.grams,
    ...(macros ? { macros } : {}),
    ...(r.source ? { source: r.source as Portion["source"] } : {}),
  };
}

function dietPortionInsertValues(
  mealId: number,
  p: Portion,
  position: number,
): typeof schema.dietPlanPortion.$inferInsert {
  return {
    mealId,
    food: p.food,
    grams: p.grams,
    position,
    kcal: p.macros?.kcal ?? null,
    proteinG: p.macros?.p ?? null,
    fatG: p.macros?.f ?? null,
    carbsG: p.macros?.c ?? null,
    fiberG: p.macros?.fiber ?? null,
    source: p.source ?? null,
  };
}

// Recipe portions mirror diet-plan portions exactly (food + grams + optional
// absolute macro override; NULL macros → resolve live from the pantry).
function rowToRecipePortion(r: typeof schema.recipePortion.$inferSelect): RecipePortion {
  const macros = macrosFromColumns(r.kcal, r.proteinG, r.fatG, r.carbsG, r.fiberG);
  return {
    id: r.id,
    food: r.food,
    grams: r.grams,
    ...(macros ? { macros } : {}),
    ...(r.source ? { source: r.source as Portion["source"] } : {}),
  };
}

function recipePortionInsertValues(
  recipeId: number,
  p: Portion,
  position: number,
): typeof schema.recipePortion.$inferInsert {
  return {
    recipeId,
    food: p.food,
    grams: p.grams,
    position,
    kcal: p.macros?.kcal ?? null,
    proteinG: p.macros?.p ?? null,
    fatG: p.macros?.f ?? null,
    carbsG: p.macros?.c ?? null,
    fiberG: p.macros?.fiber ?? null,
    source: p.source ?? null,
  };
}

// --- per-user storage ---

export class UserStorage {
  constructor(public readonly userId: string) {
    validateUserId(userId);
  }

  // ---- profile ----
  async loadProfile(): Promise<Profile | null> {
    const [row] = await db()
      .select()
      .from(schema.profile)
      .where(eq(schema.profile.userId, this.userId))
      .limit(1);
    if (!row) return null;
    return {
      sex: row.sex as Profile["sex"],
      birth_year: row.birthYear,
      height_cm: row.heightCm,
      activity_level: row.activityLevel as Profile["activity_level"],
      goal: row.goal as Profile["goal"],
      ...(row.targetWeightKg != null ? { target_weight_kg: row.targetWeightKg } : {}),
      ...(row.restrictions ? { restrictions: row.restrictions as string[] } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.wristCm != null ? { wrist_cm: row.wristCm } : {}),
      ...(row.ankleCm != null ? { ankle_cm: row.ankleCm } : {}),
      ...(row.units ? { units: row.units as Profile["units"] } : {}),
      ...(row.language ? { language: row.language as Profile["language"] } : {}),
      ...(row.waterGoalMl != null ? { water_goal_ml: row.waterGoalMl } : {}),
      ...(row.gymMachineIds ? { gym_machine_ids: row.gymMachineIds as string[] } : {}),
      ...(row.activeDietPlanId != null ? { active_diet_plan_id: row.activeDietPlanId } : {}),
      ...(row.activeWorkoutPlanId != null
        ? { active_workout_plan_id: row.activeWorkoutPlanId }
        : {}),
      // Cached recommended target (output-only).
      ...(row.targetKcal != null ? { target_kcal: row.targetKcal } : {}),
      ...(row.targetProteinG != null ? { target_protein_g: row.targetProteinG } : {}),
      ...(row.targetFatG != null ? { target_fat_g: row.targetFatG } : {}),
      ...(row.targetCarbsG != null ? { target_carbs_g: row.targetCarbsG } : {}),
      ...(row.targetFiberG != null ? { target_fiber_g: row.targetFiberG } : {}),
      ...(row.targetsComputedAt
        ? { targets_computed_at: row.targetsComputedAt.toISOString() }
        : {}),
    };
  }

  // Persist the stable profile fields, then recompute the cached recommended
  // target from the saved profile + the latest body-comp entry. The target_*
  // columns are OUTPUT-ONLY: any target_* / active_diet_plan_id on the input is
  // ignored here (active is owned by setActiveDietPlan; targets are derived), so
  // a load→edit→save round-trip can't write stale values.
  async saveProfile(p: Profile): Promise<void> {
    const values = {
      userId: this.userId,
      sex: p.sex,
      birthYear: p.birth_year,
      heightCm: p.height_cm,
      activityLevel: p.activity_level,
      goal: p.goal,
      targetWeightKg: p.target_weight_kg ?? null,
      restrictions: p.restrictions ?? null,
      notes: p.notes ?? null,
      wristCm: p.wrist_cm ?? null,
      ankleCm: p.ankle_cm ?? null,
      units: p.units ?? null,
      language: p.language ?? null,
      waterGoalMl: p.water_goal_ml ?? null,
      gymMachineIds: p.gym_machine_ids ?? null,
      updatedAt: new Date(),
    };
    const targets = await this.computeTargetColumns(p);
    await db()
      .insert(schema.profile)
      .values({ ...values, ...targets })
      .onConflictDoUpdate({
        target: schema.profile.userId,
        // Note: activeDietPlanId is intentionally NOT in this set, so an
        // existing active pointer is preserved across profile edits.
        set: { ...values, ...targets },
      });
  }

  // Compute the cached recommended-target columns from a profile + the latest
  // body-comp entry. Returns all-null when there's no weigh-in yet (the formula
  // needs a current weight). Shared by saveProfile and recomputeProfileTargets.
  private async computeTargetColumns(
    p: Profile,
    exec: DbExecutor = db(),
  ): Promise<{
    targetKcal: number | null;
    targetProteinG: number | null;
    targetFatG: number | null;
    targetCarbsG: number | null;
    targetFiberG: number | null;
    targetsComputedAt: Date | null;
  }> {
    const [latest] = await exec
      .select()
      .from(schema.bodyCompEntry)
      .where(eq(schema.bodyCompEntry.userId, this.userId))
      .orderBy(desc(schema.bodyCompEntry.date), desc(schema.bodyCompEntry.id))
      .limit(1);
    const weight = latest?.weightKg ?? null;
    if (weight == null) {
      return {
        targetKcal: null,
        targetProteinG: null,
        targetFatG: null,
        targetCarbsG: null,
        targetFiberG: null,
        targetsComputedAt: null,
      };
    }
    let bf = latest.bodyFatPct ?? latest.bodyFatPctNavy ?? null;
    if (bf == null) {
      // The latest weigh-in has weight but no body-fat reading (the common
      // case — people weigh themselves far more often than they measure BF).
      // Body fat moves slowly while weight moves daily, so rather than dropping
      // to a BF-free BMR (which makes the calorie target jump on weight-only
      // days), carry forward the most recent prior reading within a staleness
      // window. This fallback is intentionally read-time only: the stored
      // body_comp row keeps BF null so its derived FFMI/fat-mass columns aren't
      // fabricated from stale data.
      const cutoff = isoDateMinusDays(latest.date, BF_CARRY_FORWARD_DAYS);
      const [prior] = await exec
        .select({
          bodyFatPct: schema.bodyCompEntry.bodyFatPct,
          bodyFatPctNavy: schema.bodyCompEntry.bodyFatPctNavy,
        })
        .from(schema.bodyCompEntry)
        .where(
          and(
            eq(schema.bodyCompEntry.userId, this.userId),
            lte(schema.bodyCompEntry.date, latest.date),
            gte(schema.bodyCompEntry.date, cutoff),
            sql`(${schema.bodyCompEntry.bodyFatPct} is not null or ${schema.bodyCompEntry.bodyFatPctNavy} is not null)`,
          ),
        )
        .orderBy(desc(schema.bodyCompEntry.date), desc(schema.bodyCompEntry.id))
        .limit(1);
      bf = prior?.bodyFatPct ?? prior?.bodyFatPctNavy ?? null;
    }
    const { daily_target } = computeTargets(p, { weight_kg: weight, body_fat_pct: bf });
    return {
      targetKcal: daily_target.kcal,
      targetProteinG: daily_target.p,
      targetFatG: daily_target.f,
      targetCarbsG: daily_target.c,
      targetFiberG: daily_target.fiber ?? null,
      targetsComputedAt: new Date(),
    };
  }

  // Recompute ONLY the cached target columns (leaves the rest of the profile
  // untouched). Called after a body-comp write — a new weigh-in shifts the
  // recommendation even though the profile's stable fields didn't change.
  // No-op when the user has no profile yet.
  async recomputeProfileTargets(exec: DbExecutor = db()): Promise<void> {
    const profile = await this.loadProfile();
    if (!profile) return;
    const targets = await this.computeTargetColumns(profile, exec);
    await exec.update(schema.profile).set(targets).where(eq(schema.profile.userId, this.userId));
  }

  // ---- diet plan (normalized template: plan → day → meal → portion) ----
  //
  // Hydrated as a tree in one transaction (like hydratePlan for workouts).
  // The tree keeps the legacy field names ({ start_date?, default_target?,
  // rotation }) so dayTargetFromPlan / buildShoppingList kept their call
  // shape — but every node carries its row id, and portion macro columns are
  // OVERRIDES (null = resolve live from the pantry at read time).

  // Load one plan by id, scoped to this user (mirrors loadWorkoutPlan).
  async loadDietPlan(id: number, exec: DbExecutor = db()): Promise<DietPlan | null> {
    const [row] = await exec
      .select()
      .from(schema.dietPlan)
      .where(and(eq(schema.dietPlan.id, id), eq(schema.dietPlan.userId, this.userId)))
      .limit(1);
    if (!row) return null;
    return this.hydrateDietPlan(row, exec);
  }

  // All of the user's diet plans, oldest first (mirrors listWorkoutPlans).
  async listDietPlans(exec: DbExecutor = db()): Promise<DietPlan[]> {
    const rows = await exec
      .select()
      .from(schema.dietPlan)
      .where(eq(schema.dietPlan.userId, this.userId))
      .orderBy(asc(schema.dietPlan.id));
    return Promise.all(rows.map((r) => this.hydrateDietPlan(r, exec)));
  }

  // The currently-active plan (profile.active_diet_plan_id) — what every
  // "today's target / shopping / ate as planned" consumer resolves against.
  // null when the user has no profile or no active plan.
  async loadActiveDietPlan(exec: DbExecutor = db()): Promise<DietPlan | null> {
    const [prof] = await exec
      .select({ activeId: schema.profile.activeDietPlanId })
      .from(schema.profile)
      .where(eq(schema.profile.userId, this.userId))
      .limit(1);
    if (!prof?.activeId) return null;
    return this.loadDietPlan(prof.activeId, exec);
  }

  private async hydrateDietPlan(
    p: typeof schema.dietPlan.$inferSelect,
    exec: DbExecutor = db(),
  ): Promise<DietPlan> {
    const dayRows = await exec
      .select()
      .from(schema.dietPlanDay)
      .where(eq(schema.dietPlanDay.planId, p.id))
      .orderBy(asc(schema.dietPlanDay.position), asc(schema.dietPlanDay.id));
    const dayIds = dayRows.map((d) => d.id);
    const mealRows = dayIds.length
      ? await exec
          .select()
          .from(schema.dietPlanMeal)
          .where(inArray(schema.dietPlanMeal.dayId, dayIds))
          .orderBy(asc(schema.dietPlanMeal.position), asc(schema.dietPlanMeal.id))
      : [];
    const mealIds = mealRows.map((m) => m.id);
    const portionRows = mealIds.length
      ? await exec
          .select()
          .from(schema.dietPlanPortion)
          .where(inArray(schema.dietPlanPortion.mealId, mealIds))
          .orderBy(asc(schema.dietPlanPortion.position), asc(schema.dietPlanPortion.id))
      : [];

    const portionsByMeal = new Map<number, DietPlanPortion[]>();
    for (const r of portionRows) {
      const arr = portionsByMeal.get(r.mealId) ?? [];
      arr.push(rowToDietPortion(r));
      portionsByMeal.set(r.mealId, arr);
    }
    const mealsByDay = new Map<number, DietPlanMeal[]>();
    for (const r of mealRows) {
      const arr = mealsByDay.get(r.dayId) ?? [];
      arr.push({
        id: r.id,
        slot: r.slot,
        ...(r.time ? { time: r.time } : {}),
        items: portionsByMeal.get(r.id) ?? [],
      });
      mealsByDay.set(r.dayId, arr);
    }

    const defaultTarget = macrosFromColumns(
      p.defaultTargetKcal,
      p.defaultTargetP,
      p.defaultTargetF,
      p.defaultTargetC,
      p.defaultTargetFiber,
    );
    return {
      id: p.id,
      name: p.name,
      ...(p.startDate ? { start_date: p.startDate } : {}),
      ...(defaultTarget ? { default_target: defaultTarget } : {}),
      rotation: dayRows.map((d): DietPlanDay => {
        const target = macrosFromColumns(
          d.targetKcal,
          d.targetP,
          d.targetF,
          d.targetC,
          d.targetFiber,
        );
        return {
          id: d.id,
          name: d.name,
          weekdays: coerceWeekdays(d.weekdays),
          ...(target ? { target } : {}),
          meals: mealsByDay.get(d.id) ?? [],
        };
      }),
    };
  }

  private async touchDietPlan(planId: number, exec: DbExecutor): Promise<void> {
    await exec
      .update(schema.dietPlan)
      .set({ updatedAt: new Date() })
      .where(eq(schema.dietPlan.id, planId));
  }

  // Insert the day → meal → portion tree under a plan. The caller owns the
  // plan row; this just (re)builds its children. Shared by create + update.
  //
  // A weekday can run at most ONE day, so weekdays are claimed first-come:
  // each day keeps only the weekdays not already taken by an earlier day. This
  // enforces the invariant for every writer (REST + agent), matching the UI's
  // per-day weekday disabling.
  private async insertDietDayTree(
    planId: number,
    days: DietPlanWriteInput["days"],
    tx: DbExecutor,
  ): Promise<void> {
    const claimedWeekdays = new Set<Weekday>();
    for (const [di, d] of days.entries()) {
      const weekdays = coerceWeekdays(d.weekdays).filter((w) => {
        if (claimedWeekdays.has(w)) return false;
        claimedWeekdays.add(w);
        return true;
      });
      const [day] = await tx
        .insert(schema.dietPlanDay)
        .values({
          planId,
          position: di,
          weekdays,
          name: d.name,
          targetKcal: d.target?.kcal ?? null,
          targetP: d.target?.p ?? null,
          targetF: d.target?.f ?? null,
          targetC: d.target?.c ?? null,
          targetFiber: d.target?.fiber ?? null,
        })
        .returning({ id: schema.dietPlanDay.id });
      for (const [mi, m] of d.meals.entries()) {
        const [meal] = await tx
          .insert(schema.dietPlanMeal)
          .values({
            dayId: day.id,
            slot: m.slot,
            time: m.time ?? null,
            position: mi,
          })
          .returning({ id: schema.dietPlanMeal.id });
        if (m.items.length) {
          await tx
            .insert(schema.dietPlanPortion)
            .values(m.items.map((p, pi) => dietPortionInsertValues(meal.id, p, pi)));
        }
      }
    }
  }

  private dietPlanRowValues(input: DietPlanWriteInput) {
    return {
      startDate: input.start_date ?? null,
      defaultTargetKcal: input.default_target?.kcal ?? null,
      defaultTargetP: input.default_target?.p ?? null,
      defaultTargetF: input.default_target?.f ?? null,
      defaultTargetC: input.default_target?.c ?? null,
      defaultTargetFiber: input.default_target?.fiber ?? null,
      updatedAt: new Date(),
    };
  }

  // Create a new plan (+ its day tree). The first plan a user creates becomes
  // active automatically; subsequent plans don't steal the active pointer.
  // Mirrors createWorkoutPlan. Returns the hydrated plan with fresh ids.
  async createDietPlan(input: DietPlanWriteInput): Promise<DietPlan> {
    return db().transaction(async (tx) => {
      const [plan] = await tx
        .insert(schema.dietPlan)
        .values({
          userId: this.userId,
          name: input.name ?? "My diet plan",
          ...this.dietPlanRowValues(input),
        })
        .returning({ id: schema.dietPlan.id });
      await this.insertDietDayTree(plan.id, input.days, tx);
      // First plan auto-activates (no active pointer yet).
      const [prof] = await tx
        .select({ activeId: schema.profile.activeDietPlanId })
        .from(schema.profile)
        .where(eq(schema.profile.userId, this.userId))
        .limit(1);
      if (prof && prof.activeId == null) {
        await tx
          .update(schema.profile)
          .set({ activeDietPlanId: plan.id })
          .where(eq(schema.profile.userId, this.userId));
      }
      return (await this.loadDietPlan(plan.id, tx))!;
    });
  }

  // Replace a plan's content (name + day tree). Wipe-and-reinsert like
  // updateWorkoutPlan. Returns the hydrated plan, or null if not owned.
  async updateDietPlan(id: number, input: DietPlanWriteInput): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.dietPlan)
        .set({
          ...this.dietPlanRowValues(input),
          ...(input.name != null ? { name: input.name } : {}),
        })
        .where(and(eq(schema.dietPlan.id, id), eq(schema.dietPlan.userId, this.userId)))
        .returning({ id: schema.dietPlan.id });
      if (!updated) return null;
      // Cascade delete via FK clears meals + portions.
      await tx.delete(schema.dietPlanDay).where(eq(schema.dietPlanDay.planId, id));
      await this.insertDietDayTree(id, input.days, tx);
      return (await this.loadDietPlan(id, tx))!;
    });
  }

  async deleteDietPlan(id: number): Promise<boolean> {
    // FK active_diet_plan_id is ON DELETE SET NULL, so deleting the active
    // plan just clears the pointer — no separate cleanup needed.
    const rows = await db()
      .delete(schema.dietPlan)
      .where(and(eq(schema.dietPlan.id, id), eq(schema.dietPlan.userId, this.userId)))
      .returning({ id: schema.dietPlan.id });
    return rows.length > 0;
  }

  // Point the profile's active pointer at one of the user's plans. Returns
  // false if the plan doesn't exist or belongs to someone else.
  async setActiveDietPlan(planId: number): Promise<boolean> {
    const [plan] = await db()
      .select({ id: schema.dietPlan.id })
      .from(schema.dietPlan)
      .where(and(eq(schema.dietPlan.id, planId), eq(schema.dietPlan.userId, this.userId)))
      .limit(1);
    if (!plan) return false;
    await db()
      .update(schema.profile)
      .set({ activeDietPlanId: planId })
      .where(eq(schema.profile.userId, this.userId));
    return true;
  }

  // compute_targets save_as_default → writes a plan's default-target columns.
  // Defaults to the active plan; returns false when no plan is targetable.
  async setDietDefaultTarget(target: Macros | null, planId?: number): Promise<boolean> {
    return db().transaction(async (tx) => {
      let id = planId;
      if (id == null) {
        const [prof] = await tx
          .select({ activeId: schema.profile.activeDietPlanId })
          .from(schema.profile)
          .where(eq(schema.profile.userId, this.userId))
          .limit(1);
        id = prof?.activeId ?? undefined;
      }
      if (id == null) return false;
      const rows = await tx
        .update(schema.dietPlan)
        .set({
          defaultTargetKcal: target?.kcal ?? null,
          defaultTargetP: target?.p ?? null,
          defaultTargetF: target?.f ?? null,
          defaultTargetC: target?.c ?? null,
          defaultTargetFiber: target?.fiber ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.dietPlan.id, id), eq(schema.dietPlan.userId, this.userId)))
        .returning({ id: schema.dietPlan.id });
      return rows.length > 0;
    });
  }

  // Ownership guards — every granular mutation resolves its target row
  // through the user's plan before touching anything, so edits can never
  // leak across users.
  private async ownedDietDay(dayId: number, exec: DbExecutor): Promise<{ planId: number } | null> {
    const [row] = await exec
      .select({
        planId: schema.dietPlanDay.planId,
        userId: schema.dietPlan.userId,
      })
      .from(schema.dietPlanDay)
      .innerJoin(schema.dietPlan, eq(schema.dietPlan.id, schema.dietPlanDay.planId))
      .where(eq(schema.dietPlanDay.id, dayId))
      .limit(1);
    if (!row || row.userId !== this.userId) return null;
    return { planId: row.planId };
  }

  private async ownedDietMeal(
    mealId: number,
    exec: DbExecutor,
  ): Promise<{ planId: number; dayId: number } | null> {
    const [row] = await exec
      .select({
        dayId: schema.dietPlanMeal.dayId,
        planId: schema.dietPlanDay.planId,
        userId: schema.dietPlan.userId,
      })
      .from(schema.dietPlanMeal)
      .innerJoin(schema.dietPlanDay, eq(schema.dietPlanDay.id, schema.dietPlanMeal.dayId))
      .innerJoin(schema.dietPlan, eq(schema.dietPlan.id, schema.dietPlanDay.planId))
      .where(eq(schema.dietPlanMeal.id, mealId))
      .limit(1);
    if (!row || row.userId !== this.userId) return null;
    return { planId: row.planId, dayId: row.dayId };
  }

  private async ownedDietPortion(
    portionId: number,
    exec: DbExecutor,
  ): Promise<{ planId: number; mealId: number } | null> {
    const [row] = await exec
      .select({
        mealId: schema.dietPlanPortion.mealId,
        planId: schema.dietPlanDay.planId,
        userId: schema.dietPlan.userId,
      })
      .from(schema.dietPlanPortion)
      .innerJoin(schema.dietPlanMeal, eq(schema.dietPlanMeal.id, schema.dietPlanPortion.mealId))
      .innerJoin(schema.dietPlanDay, eq(schema.dietPlanDay.id, schema.dietPlanMeal.dayId))
      .innerJoin(schema.dietPlan, eq(schema.dietPlan.id, schema.dietPlanDay.planId))
      .where(eq(schema.dietPlanPortion.id, portionId))
      .limit(1);
    if (!row || row.userId !== this.userId) return null;
    return { planId: row.planId, mealId: row.mealId };
  }

  // ---- granular diet mutations ----
  //
  // These let the agent apply natural-language edits ("swap rice for
  // potatoes on day 2", "move dinner to 19:00") without round-tripping the
  // whole plan — same shape as the granular workout-plan mutations. All
  // return the fully-hydrated plan (or null on ownership/lookup failure).

  // Patch a rotation day: rename, reschedule, or change its target. Pass
  // `target: null` to clear the per-day override (fall back to default).
  async updateDietPlanDay(
    dayId: number,
    patch: {
      name?: string;
      weekdays?: Weekday[];
      target?: Macros | null;
    },
  ): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedDietDay(dayId, tx);
      if (!owned) return null;
      const update: Record<string, unknown> = {};
      if (patch.name !== undefined) update.name = patch.name;
      if (patch.weekdays !== undefined) {
        update.weekdays = coerceWeekdays(patch.weekdays);
      }
      if (patch.target !== undefined) {
        update.targetKcal = patch.target?.kcal ?? null;
        update.targetP = patch.target?.p ?? null;
        update.targetF = patch.target?.f ?? null;
        update.targetC = patch.target?.c ?? null;
        update.targetFiber = patch.target?.fiber ?? null;
      }
      if (Object.keys(update).length > 0) {
        await tx.update(schema.dietPlanDay).set(update).where(eq(schema.dietPlanDay.id, dayId));
        await this.touchDietPlan(owned.planId, tx);
      }
      return (await this.loadDietPlan(owned.planId, tx))!;
    });
  }

  // Append a meal (with portions) to a rotation day.
  async addDietMeal(
    dayId: number,
    input: { slot: string; time?: string | null; items: Portion[] },
  ): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedDietDay(dayId, tx);
      if (!owned) return null;
      const [maxRow] = await tx
        .select({
          max: sql<number>`coalesce(max(${schema.dietPlanMeal.position}), -1)`,
        })
        .from(schema.dietPlanMeal)
        .where(eq(schema.dietPlanMeal.dayId, dayId));
      const [meal] = await tx
        .insert(schema.dietPlanMeal)
        .values({
          dayId,
          slot: input.slot,
          time: input.time ?? null,
          position: (maxRow?.max ?? -1) + 1,
        })
        .returning({ id: schema.dietPlanMeal.id });
      if (input.items.length) {
        await tx
          .insert(schema.dietPlanPortion)
          .values(input.items.map((p, pi) => dietPortionInsertValues(meal.id, p, pi)));
      }
      await this.touchDietPlan(owned.planId, tx);
      return (await this.loadDietPlan(owned.planId, tx))!;
    });
  }

  // Patch a meal's slot/time ("move dinner to 19:00"). Pass time: null to
  // clear the pinned time.
  async updateDietMeal(
    mealId: number,
    patch: { slot?: string; time?: string | null },
  ): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedDietMeal(mealId, tx);
      if (!owned) return null;
      const update: Record<string, unknown> = {};
      if (patch.slot !== undefined) update.slot = patch.slot;
      if (patch.time !== undefined) update.time = patch.time;
      if (Object.keys(update).length > 0) {
        await tx.update(schema.dietPlanMeal).set(update).where(eq(schema.dietPlanMeal.id, mealId));
        await this.touchDietPlan(owned.planId, tx);
      }
      return (await this.loadDietPlan(owned.planId, tx))!;
    });
  }

  async removeDietMeal(mealId: number): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedDietMeal(mealId, tx);
      if (!owned) return null;
      await tx.delete(schema.dietPlanMeal).where(eq(schema.dietPlanMeal.id, mealId));
      await this.touchDietPlan(owned.planId, tx);
      return (await this.loadDietPlan(owned.planId, tx))!;
    });
  }

  // Append one portion to a meal. Omitted macros = resolve live from pantry.
  async addDietPortion(mealId: number, portion: Portion): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedDietMeal(mealId, tx);
      if (!owned) return null;
      const [maxRow] = await tx
        .select({
          max: sql<number>`coalesce(max(${schema.dietPlanPortion.position}), -1)`,
        })
        .from(schema.dietPlanPortion)
        .where(eq(schema.dietPlanPortion.mealId, mealId));
      await tx
        .insert(schema.dietPlanPortion)
        .values(dietPortionInsertValues(mealId, portion, (maxRow?.max ?? -1) + 1));
      await this.touchDietPlan(owned.planId, tx);
      return (await this.loadDietPlan(owned.planId, tx))!;
    });
  }

  // Patch one portion ("swap rice for potatoes", "make it 150g"). Pass
  // `macros: null` to clear an override (back to live pantry resolution);
  // a `macros` value sets an explicit override.
  async updateDietPortion(
    portionId: number,
    patch: {
      food?: string;
      grams?: number;
      macros?: Macros | null;
      source?: Portion["source"] | null;
    },
  ): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedDietPortion(portionId, tx);
      if (!owned) return null;
      const update: Record<string, unknown> = {};
      if (patch.food !== undefined) update.food = patch.food;
      if (patch.grams !== undefined) update.grams = patch.grams;
      if (patch.macros !== undefined) {
        update.kcal = patch.macros?.kcal ?? null;
        update.proteinG = patch.macros?.p ?? null;
        update.fatG = patch.macros?.f ?? null;
        update.carbsG = patch.macros?.c ?? null;
        update.fiberG = patch.macros?.fiber ?? null;
      }
      if (patch.source !== undefined) update.source = patch.source;
      if (Object.keys(update).length > 0) {
        await tx
          .update(schema.dietPlanPortion)
          .set(update)
          .where(eq(schema.dietPlanPortion.id, portionId));
        await this.touchDietPlan(owned.planId, tx);
      }
      return (await this.loadDietPlan(owned.planId, tx))!;
    });
  }

  async removeDietPortion(portionId: number): Promise<DietPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedDietPortion(portionId, tx);
      if (!owned) return null;
      await tx.delete(schema.dietPlanPortion).where(eq(schema.dietPlanPortion.id, portionId));
      await this.touchDietPlan(owned.planId, tx);
      return (await this.loadDietPlan(owned.planId, tx))!;
    });
  }

  // ---- recipes ----
  //
  // A recipe is a named, reusable bundle of ingredient Portions — a
  // diet_plan_meal extracted to stand alone. Same hydrate/create/update/delete
  // shape as diet plans; ingredients are live-resolving Portions (NULL macros =
  // resolve from the pantry at read time), so a recipe reflects the current
  // pantry until it's frozen into the log by log_recipe.
  async loadRecipe(id: number, exec: DbExecutor = db()): Promise<Recipe | null> {
    const [row] = await exec
      .select()
      .from(schema.recipe)
      .where(and(eq(schema.recipe.id, id), eq(schema.recipe.userId, this.userId)))
      .limit(1);
    if (!row) return null;
    return this.hydrateRecipe(row, exec);
  }

  // Resolve a recipe by its canonical slug (what "log the chicken rice bowl"
  // turns into). Slugs are unique per user.
  async loadRecipeBySlug(slug: string, exec: DbExecutor = db()): Promise<Recipe | null> {
    const [row] = await exec
      .select()
      .from(schema.recipe)
      .where(and(eq(schema.recipe.slug, slug), eq(schema.recipe.userId, this.userId)))
      .limit(1);
    if (!row) return null;
    return this.hydrateRecipe(row, exec);
  }

  // All of the user's recipes, oldest first (mirrors listDietPlans).
  async listRecipes(exec: DbExecutor = db()): Promise<Recipe[]> {
    const rows = await exec
      .select()
      .from(schema.recipe)
      .where(eq(schema.recipe.userId, this.userId))
      .orderBy(asc(schema.recipe.id));
    return Promise.all(rows.map((r) => this.hydrateRecipe(r, exec)));
  }

  private async hydrateRecipe(
    r: typeof schema.recipe.$inferSelect,
    exec: DbExecutor = db(),
  ): Promise<Recipe> {
    const portionRows = await exec
      .select()
      .from(schema.recipePortion)
      .where(eq(schema.recipePortion.recipeId, r.id))
      .orderBy(asc(schema.recipePortion.position), asc(schema.recipePortion.id));
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      servings: r.servings,
      favorite: r.favorite,
      ...(r.notes ? { notes: r.notes } : {}),
      ...(r.instructions ? { instructions: r.instructions } : {}),
      ...(r.sourceUrl ? { source_url: r.sourceUrl } : {}),
      ingredients: portionRows.map(rowToRecipePortion),
    };
  }

  // Pick a slug for `name` that isn't already taken by another of this user's
  // recipes (the (user_id, slug) unique index would otherwise reject it).
  // `excludeId` lets an update keep its own slug. Appends _2, _3, … on clash.
  private async uniqueRecipeSlug(
    name: string,
    exec: DbExecutor,
    excludeId?: number,
  ): Promise<string> {
    const base = toPantryKey(name) || "recipe";
    const rows = await exec
      .select({ id: schema.recipe.id, slug: schema.recipe.slug })
      .from(schema.recipe)
      .where(eq(schema.recipe.userId, this.userId));
    const taken = new Set(rows.filter((r) => r.id !== excludeId).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}_${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async createRecipe(input: RecipeWriteInput): Promise<Recipe> {
    return db().transaction(async (tx) => {
      const slug = await this.uniqueRecipeSlug(input.name, tx);
      const [row] = await tx
        .insert(schema.recipe)
        .values({
          userId: this.userId,
          name: input.name,
          slug,
          servings: input.servings && input.servings > 0 ? input.servings : 1,
          favorite: input.favorite ?? false,
          notes: input.notes ?? null,
          instructions: input.instructions ?? null,
          sourceUrl: input.source_url ?? null,
          updatedAt: new Date(),
        })
        .returning({ id: schema.recipe.id });
      if (input.ingredients.length) {
        await tx
          .insert(schema.recipePortion)
          .values(input.ingredients.map((p, i) => recipePortionInsertValues(row.id, p, i)));
      }
      return (await this.loadRecipe(row.id, tx))!;
    });
  }

  // Replace a recipe's content (name + ingredients). Wipe-and-reinsert the
  // portions like updateDietPlan. The slug is re-derived from the name (kept
  // stable when the name is unchanged). Returns null if not owned.
  async updateRecipe(id: number, input: RecipeWriteInput): Promise<Recipe | null> {
    return db().transaction(async (tx) => {
      const slug = await this.uniqueRecipeSlug(input.name, tx, id);
      const [updated] = await tx
        .update(schema.recipe)
        .set({
          name: input.name,
          slug,
          servings: input.servings && input.servings > 0 ? input.servings : 1,
          // Only touch `favorite` when explicitly provided, so a plain content
          // edit (which omits it) preserves the star set via the toggle.
          ...(input.favorite != null ? { favorite: input.favorite } : {}),
          notes: input.notes ?? null,
          instructions: input.instructions ?? null,
          ...(input.source_url !== undefined ? { sourceUrl: input.source_url ?? null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.recipe.id, id), eq(schema.recipe.userId, this.userId)))
        .returning({ id: schema.recipe.id });
      if (!updated) return null;
      await tx.delete(schema.recipePortion).where(eq(schema.recipePortion.recipeId, id));
      if (input.ingredients.length) {
        await tx
          .insert(schema.recipePortion)
          .values(input.ingredients.map((p, i) => recipePortionInsertValues(id, p, i)));
      }
      return (await this.loadRecipe(id, tx))!;
    });
  }

  async deleteRecipe(id: number): Promise<boolean> {
    const rows = await db()
      .delete(schema.recipe)
      .where(and(eq(schema.recipe.id, id), eq(schema.recipe.userId, this.userId)))
      .returning({ id: schema.recipe.id });
    return rows.length > 0;
  }

  // Star / unstar a recipe without rewriting its content (the favourite-badge
  // toggle). Returns the hydrated recipe, or null if not owned.
  async setRecipeFavorite(id: number, favorite: boolean): Promise<Recipe | null> {
    const [updated] = await db()
      .update(schema.recipe)
      .set({ favorite, updatedAt: new Date() })
      .where(and(eq(schema.recipe.id, id), eq(schema.recipe.userId, this.userId)))
      .returning({ id: schema.recipe.id });
    if (!updated) return null;
    return this.loadRecipe(id);
  }

  // Ownership guard: resolve a portion's recipe through the user before any
  // granular edit, so edits can't leak across users (mirrors ownedDietPortion).
  private async ownedRecipePortion(
    portionId: number,
    exec: DbExecutor,
  ): Promise<{ recipeId: number } | null> {
    const [row] = await exec
      .select({ recipeId: schema.recipePortion.recipeId, userId: schema.recipe.userId })
      .from(schema.recipePortion)
      .innerJoin(schema.recipe, eq(schema.recipe.id, schema.recipePortion.recipeId))
      .where(eq(schema.recipePortion.id, portionId))
      .limit(1);
    if (!row || row.userId !== this.userId) return null;
    return { recipeId: row.recipeId };
  }

  // Patch one ingredient ("make it 150g", "swap rice for quinoa"). Pass
  // `macros: null` to clear an override (back to live pantry resolution).
  async updateRecipePortion(
    portionId: number,
    patch: {
      food?: string;
      grams?: number;
      macros?: Macros | null;
      source?: Portion["source"] | null;
    },
  ): Promise<Recipe | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedRecipePortion(portionId, tx);
      if (!owned) return null;
      const update: Record<string, unknown> = {};
      if (patch.food !== undefined) update.food = patch.food;
      if (patch.grams !== undefined) update.grams = patch.grams;
      if (patch.macros !== undefined) {
        update.kcal = patch.macros?.kcal ?? null;
        update.proteinG = patch.macros?.p ?? null;
        update.fatG = patch.macros?.f ?? null;
        update.carbsG = patch.macros?.c ?? null;
        update.fiberG = patch.macros?.fiber ?? null;
      }
      if (patch.source !== undefined) update.source = patch.source;
      if (Object.keys(update).length > 0) {
        await tx
          .update(schema.recipePortion)
          .set(update)
          .where(eq(schema.recipePortion.id, portionId));
        await tx
          .update(schema.recipe)
          .set({ updatedAt: new Date() })
          .where(eq(schema.recipe.id, owned.recipeId));
      }
      return (await this.loadRecipe(owned.recipeId, tx))!;
    });
  }

  // ---- pantry ----
  //
  // The pantry is the user's single food + supplement catalog: quantities AND
  // the per-100 macros that used to live in the global food_db.
  async loadPantry(): Promise<Pantry | null> {
    const rows = await db()
      .select()
      .from(schema.pantryItem)
      .where(eq(schema.pantryItem.userId, this.userId));
    if (!rows.length) return null;
    const items: Pantry["items"] = {};
    for (const r of rows) items[r.name] = rowToPantryItem(r);
    return { items };
  }

  // Server-side search / filter / sort / pagination over the pantry. Unlike
  // loadPantry (which returns the whole catalog as a name→item map for callers
  // that need everything, e.g. the agent), this pushes the work into SQL so the
  // pantry table can grow large without shipping it all to the client.
  //
  // `limit` omitted → no pagination (returns the full filtered set); the
  // datalist consumers (Diet, AddFoodDialog) rely on this. `total` is the count
  // matching the filters (ignoring limit/offset) for the pager; `categories` is
  // the user's full distinct category list (ignoring filters) for the dropdown.
  async queryPantry(opts: PantryQueryOpts = {}): Promise<PantryQueryResult> {
    const q = opts.q?.trim();
    const conds = [eq(schema.pantryItem.userId, this.userId)];
    if (q) conds.push(ilike(schema.pantryItem.name, `%${q}%`));
    if (opts.category) conds.push(eq(schema.pantryItem.category, opts.category));
    const where = and(...conds);

    const sortCols = {
      name: schema.pantryItem.name,
      quantity: schema.pantryItem.quantity,
      kcal: schema.pantryItem.kcal,
      protein: schema.pantryItem.proteinG,
      carbs: schema.pantryItem.carbsG,
      fat: schema.pantryItem.fatG,
    } as const;
    const sort = opts.sort ?? "name";
    const dir = opts.order === "desc" ? "desc" : "asc";
    // Macro/quantity sorts put NULLs last and fall back to name for a stable
    // order; the name sort is a plain asc/desc.
    const orderBy =
      sort === "name"
        ? [dir === "desc" ? desc(sortCols.name) : asc(sortCols.name)]
        : [sql`${sortCols[sort]} ${sql.raw(dir)} nulls last`, asc(sortCols.name)];

    const base = db()
      .select()
      .from(schema.pantryItem)
      .where(where)
      .orderBy(...orderBy);
    const rows =
      opts.limit != null ? await base.limit(opts.limit).offset(opts.offset ?? 0) : await base;

    const [{ total }] = await db()
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.pantryItem)
      .where(where);

    const catRows = await db()
      .selectDistinct({ category: schema.pantryItem.category })
      .from(schema.pantryItem)
      .where(eq(schema.pantryItem.userId, this.userId));
    const categories = catRows
      .map((r) => r.category)
      .filter((c): c is string => !!c)
      .sort((a, b) => a.localeCompare(b));

    return { items: rows.map(rowToPantryItem), total: total ?? 0, categories };
  }

  async getPantryItem(name: string): Promise<PantryItem | null> {
    const [row] = await db()
      .select()
      .from(schema.pantryItem)
      .where(and(eq(schema.pantryItem.userId, this.userId), eq(schema.pantryItem.name, name)))
      .limit(1);
    return row ? rowToPantryItem(row) : null;
  }

  async savePantry(p: Pantry): Promise<void> {
    // Full replacement semantics — the caller (doUpdatePantry) handles
    // merge-vs-replace before calling this.
    await db().transaction(async (tx) => {
      await tx.delete(schema.pantryItem).where(eq(schema.pantryItem.userId, this.userId));
      const rows = Object.values(p.items).map((it) =>
        this.pantryInsertValues(it.name, {
          quantity: it.quantity,
          unit: it.unit,
          grams_per_serving: it.grams_per_serving ?? null,
          to_buy: it.to_buy,
          category: it.category ?? null,
          barcode: it.barcode ?? null,
          macros: it.macros ?? null,
        }),
      );
      if (rows.length) await tx.insert(schema.pantryItem).values(rows);
    });
  }

  // Build the full insert row for a pantry item, applying column defaults for
  // any field the patch leaves undefined.
  private pantryInsertValues(name: string, patch: PantryItemPatch) {
    return {
      userId: this.userId,
      name,
      quantity: patch.quantity ?? 0,
      unit: patch.unit ?? "g",
      gramsPerServing: patch.grams_per_serving ?? null,
      toBuy: patch.to_buy ?? false,
      category: patch.category ?? null,
      barcode: patch.barcode ?? null,
      kcal: patch.macros?.kcal ?? null,
      proteinG: patch.macros?.p ?? null,
      fatG: patch.macros?.f ?? null,
      carbsG: patch.macros?.c ?? null,
      fiberG: patch.macros?.fiber ?? null,
      updatedAt: new Date(),
    };
  }

  // Upsert a set of pantry items, patching only the fields each entry carries
  // (merge semantics). On insert, missing fields take column defaults.
  async upsertPantryItems(items: Record<string, PantryItemPatch>): Promise<void> {
    const entries = Object.entries(items);
    if (!entries.length) return;
    await db().transaction(async (tx) => {
      for (const [name, patch] of entries) {
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (patch.quantity !== undefined) set.quantity = patch.quantity;
        if (patch.unit !== undefined) set.unit = patch.unit;
        if (patch.grams_per_serving !== undefined) {
          set.gramsPerServing = patch.grams_per_serving;
        }
        if (patch.to_buy !== undefined) set.toBuy = patch.to_buy;
        if (patch.category !== undefined) set.category = patch.category;
        if (patch.barcode !== undefined) set.barcode = patch.barcode;
        if (patch.macros !== undefined) {
          set.kcal = patch.macros?.kcal ?? null;
          set.proteinG = patch.macros?.p ?? null;
          set.fatG = patch.macros?.f ?? null;
          set.carbsG = patch.macros?.c ?? null;
          set.fiberG = patch.macros?.fiber ?? null;
        }
        await tx
          .insert(schema.pantryItem)
          .values(this.pantryInsertValues(name, patch))
          .onConflictDoUpdate({
            target: [schema.pantryItem.userId, schema.pantryItem.name],
            set,
          });
      }
    });
  }

  async removePantryItems(names: string[]): Promise<number> {
    if (!names.length) return 0;
    const rows = await db()
      .delete(schema.pantryItem)
      .where(and(eq(schema.pantryItem.userId, this.userId), inArray(schema.pantryItem.name, names)))
      .returning({ name: schema.pantryItem.name });
    return rows.length;
  }

  // Fuzzy name search over the user's pantry (the food catalog). Empty query
  // returns the whole pantry (capped). Case-insensitive substring match.
  async searchPantryByName(query: string, limit = 20): Promise<PantryItem[]> {
    const q = query.trim();
    const lim = Math.min(100, Math.max(1, limit));
    const where = q
      ? and(eq(schema.pantryItem.userId, this.userId), ilike(schema.pantryItem.name, `%${q}%`))
      : eq(schema.pantryItem.userId, this.userId);
    const rows = await db()
      .select()
      .from(schema.pantryItem)
      .where(where)
      .orderBy(asc(schema.pantryItem.name))
      .limit(lim);
    return rows.map(rowToPantryItem);
  }

  // Exact lookup by UPC/EAN/GTIN against this user's pantry. Caller passes
  // digits-only input (normalizeBarcode from @fa/shared).
  async findPantryByBarcode(barcode: string): Promise<PantryItem | null> {
    if (!barcode) return null;
    const [row] = await db()
      .select()
      .from(schema.pantryItem)
      .where(and(eq(schema.pantryItem.userId, this.userId), eq(schema.pantryItem.barcode, barcode)))
      .limit(1);
    return row ? rowToPantryItem(row) : null;
  }

  // ---- body composition (append-only) ----
  //
  // Body metrics are time-series source of truth: weight, BF%, waist, and
  // their derived values (BMI, FFMI, lean mass, Navy BF estimate) all live
  // here, never on the profile. appendBodyComp expects the caller to have
  // already run computeBodyMetrics() against the profile's height + sex.
  async appendBodyComp(e: BodyCompEntry): Promise<void> {
    await db()
      .insert(schema.bodyCompEntry)
      .values({
        userId: this.userId,
        date: e.date,
        weightKg: e.weight_kg,
        bodyFatPct: e.body_fat_pct,
        bodyFatMethod: e.body_fat_method ?? null,
        waistCm: e.waist_cm,
        neckCm: e.neck_cm ?? null,
        hipCm: e.hip_cm ?? null,
        bodyFatPctNavy: e.body_fat_pct_navy ?? null,
        bmi: e.bmi ?? null,
        ffmi: e.ffmi ?? null,
        ffmiNormalized: e.ffmi_normalized ?? null,
        fatFreeMassKg: e.fat_free_mass_kg ?? null,
        fatMassKg: e.fat_mass_kg ?? null,
        notes: e.notes ?? null,
        time: e.time ?? null,
      });
    // A new weigh-in shifts the recommended target — refresh the profile cache.
    await this.recomputeProfileTargets();
  }

  private rowToBodyCompEntry(r: typeof schema.bodyCompEntry.$inferSelect): BodyCompEntry {
    return {
      id: r.id,
      date: r.date,
      weight_kg: r.weightKg,
      body_fat_pct: r.bodyFatPct,
      body_fat_method: (r.bodyFatMethod as BodyCompEntry["body_fat_method"]) ?? null,
      waist_cm: r.waistCm,
      neck_cm: r.neckCm,
      hip_cm: r.hipCm,
      body_fat_pct_navy: r.bodyFatPctNavy,
      bmi: r.bmi,
      ffmi: r.ffmi,
      ffmi_normalized: r.ffmiNormalized,
      fat_free_mass_kg: r.fatFreeMassKg,
      fat_mass_kg: r.fatMassKg,
      ...(r.notes ? { notes: r.notes } : {}),
      time: r.time ?? null,
      logged_at: r.createdAt.toISOString(),
    };
  }

  async readBodyComp(): Promise<BodyCompEntry[]> {
    const rows = await db()
      .select()
      .from(schema.bodyCompEntry)
      .where(eq(schema.bodyCompEntry.userId, this.userId))
      .orderBy(asc(schema.bodyCompEntry.date), asc(schema.bodyCompEntry.id));
    return rows.map((r) => this.rowToBodyCompEntry(r));
  }

  async readBodyCompRange(from: string, to: string): Promise<BodyCompEntry[]> {
    const rows = await db()
      .select()
      .from(schema.bodyCompEntry)
      .where(
        and(
          eq(schema.bodyCompEntry.userId, this.userId),
          gte(schema.bodyCompEntry.date, from),
          lte(schema.bodyCompEntry.date, to),
        ),
      )
      .orderBy(asc(schema.bodyCompEntry.date), asc(schema.bodyCompEntry.id));
    return rows.map((r) => this.rowToBodyCompEntry(r));
  }

  // Latest weigh-in by (date, id). Used everywhere we need "current" weight or
  // body-fat — BMR/TDEE math, dashboard headline, MET-based kcal estimates.
  // Returns null when the user has never logged. Callers fall back gracefully
  // (compute_targets errors with a hint, dashboard shows "no entries yet").
  async latestBodyComp(): Promise<BodyCompEntry | null> {
    const [row] = await db()
      .select()
      .from(schema.bodyCompEntry)
      .where(eq(schema.bodyCompEntry.userId, this.userId))
      .orderBy(desc(schema.bodyCompEntry.date), desc(schema.bodyCompEntry.id))
      .limit(1);
    if (!row) return null;
    return this.rowToBodyCompEntry(row);
  }

  // ---- cardio fitness (append-only, VO₂max time-series) ----
  //
  // Mirrors body-comp: heart-rate readings are the raw inputs, VO₂max + its
  // category are derived at write time (the caller runs computeVo2Max with the
  // profile's age + sex). One row per reading; query by (userId, date).
  async appendCardio(e: CardioEntry): Promise<void> {
    await db()
      .insert(schema.cardioEntry)
      .values({
        userId: this.userId,
        date: e.date,
        restingHeartRate: e.resting_heart_rate,
        maxHeartRate: e.max_heart_rate ?? null,
        vo2Max: e.vo2_max ?? null,
        vo2MaxCategory: e.vo2_max_category ?? null,
        maxHeartRateEstimated: e.max_heart_rate_estimated ?? null,
        notes: e.notes ?? null,
      });
  }

  private rowToCardioEntry(r: typeof schema.cardioEntry.$inferSelect): CardioEntry {
    return {
      id: r.id,
      date: r.date,
      resting_heart_rate: r.restingHeartRate,
      max_heart_rate: r.maxHeartRate,
      vo2_max: r.vo2Max,
      vo2_max_category: (r.vo2MaxCategory as CardioEntry["vo2_max_category"]) ?? null,
      max_heart_rate_estimated: r.maxHeartRateEstimated,
      ...(r.notes ? { notes: r.notes } : {}),
    };
  }

  async readCardioRange(from: string, to: string): Promise<CardioEntry[]> {
    const rows = await db()
      .select()
      .from(schema.cardioEntry)
      .where(
        and(
          eq(schema.cardioEntry.userId, this.userId),
          gte(schema.cardioEntry.date, from),
          lte(schema.cardioEntry.date, to),
        ),
      )
      .orderBy(asc(schema.cardioEntry.date), asc(schema.cardioEntry.id));
    return rows.map((r) => this.rowToCardioEntry(r));
  }

  // Latest reading by (date, id) — the user's "current" cardio fitness.
  async latestCardio(): Promise<CardioEntry | null> {
    const [row] = await db()
      .select()
      .from(schema.cardioEntry)
      .where(eq(schema.cardioEntry.userId, this.userId))
      .orderBy(desc(schema.cardioEntry.date), desc(schema.cardioEntry.id))
      .limit(1);
    if (!row) return null;
    return this.rowToCardioEntry(row);
  }

  // Count of all readings — lets log_cardio report total_entries like
  // log_body_comp does, without a second round-trip from the caller.
  async countCardio(): Promise<number> {
    const [row] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.cardioEntry)
      .where(eq(schema.cardioEntry.userId, this.userId));
    return row?.n ?? 0;
  }

  // Delete one cardio reading by row id, scoped to the user. Returns false when
  // no matching row exists.
  async deleteCardioEntry(id: number): Promise<boolean> {
    const rows = await db()
      .delete(schema.cardioEntry)
      .where(and(eq(schema.cardioEntry.userId, this.userId), eq(schema.cardioEntry.id, id)))
      .returning({ id: schema.cardioEntry.id });
    return rows.length > 0;
  }

  // Fetch one cardio reading by row id (scoped to the user), or null. Used by
  // update_cardio_entry to merge the agent's patch over the existing values.
  async getCardioEntry(id: number): Promise<CardioEntry | null> {
    const [row] = await db()
      .select()
      .from(schema.cardioEntry)
      .where(and(eq(schema.cardioEntry.userId, this.userId), eq(schema.cardioEntry.id, id)))
      .limit(1);
    return row ? this.rowToCardioEntry(row) : null;
  }

  // Update one cardio reading in place (scoped to the user), preserving its id
  // and created_at. Returns the updated entry, or null when no row matched.
  async updateCardioEntry(
    id: number,
    patch: {
      date: string;
      resting_heart_rate: number;
      max_heart_rate: number | null;
      vo2_max: number | null;
      vo2_max_category: CardioEntry["vo2_max_category"];
      max_heart_rate_estimated: boolean | null;
      notes: string | null;
    },
  ): Promise<CardioEntry | null> {
    const [row] = await db()
      .update(schema.cardioEntry)
      .set({
        date: patch.date,
        restingHeartRate: patch.resting_heart_rate,
        maxHeartRate: patch.max_heart_rate,
        vo2Max: patch.vo2_max,
        vo2MaxCategory: patch.vo2_max_category,
        maxHeartRateEstimated: patch.max_heart_rate_estimated,
        notes: patch.notes,
      })
      .where(and(eq(schema.cardioEntry.userId, this.userId), eq(schema.cardioEntry.id, id)))
      .returning();
    return row ? this.rowToCardioEntry(row) : null;
  }

  // ---- body measurements (muscle girths, one session per day) ----
  //
  // Waist / neck / hip are not stored here — they stay on body_comp_entry,
  // where they also feed the Navy BF% estimate (see log_measurements).
  private rowToMeasurement(r: typeof schema.bodyMeasurement.$inferSelect): BodyMeasurementEntry {
    return {
      id: r.id,
      date: r.date,
      shoulders_cm: r.shouldersCm,
      chest_cm: r.chestCm,
      arm_cm: r.armCm,
      forearm_cm: r.forearmCm,
      thigh_cm: r.thighCm,
      calf_cm: r.calfCm,
      ...(r.notes ? { notes: r.notes } : {}),
      time: r.time ?? null,
      logged_at: r.updatedAt.toISOString(),
    };
  }

  // Insert or overwrite the day's measuring session.
  async upsertMeasurement(e: BodyMeasurementEntry): Promise<BodyMeasurementEntry> {
    const values = {
      shouldersCm: e.shoulders_cm,
      chestCm: e.chest_cm,
      armCm: e.arm_cm,
      forearmCm: e.forearm_cm,
      thighCm: e.thigh_cm,
      calfCm: e.calf_cm,
      notes: e.notes || null,
      time: e.time ?? null,
    };
    const [row] = await db()
      .insert(schema.bodyMeasurement)
      .values({ userId: this.userId, date: e.date, ...values })
      .onConflictDoUpdate({
        target: [schema.bodyMeasurement.userId, schema.bodyMeasurement.date],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return this.rowToMeasurement(row);
  }

  async getMeasurement(date: string): Promise<BodyMeasurementEntry | null> {
    const [row] = await db()
      .select()
      .from(schema.bodyMeasurement)
      .where(
        and(eq(schema.bodyMeasurement.userId, this.userId), eq(schema.bodyMeasurement.date, date)),
      )
      .limit(1);
    return row ? this.rowToMeasurement(row) : null;
  }

  // Sessions in [from, to], oldest first. Omit `from` for everything up to `to`.
  async readMeasurementsRange(from: string | null, to: string): Promise<BodyMeasurementEntry[]> {
    const rows = await db()
      .select()
      .from(schema.bodyMeasurement)
      .where(
        and(
          eq(schema.bodyMeasurement.userId, this.userId),
          from ? gte(schema.bodyMeasurement.date, from) : undefined,
          lte(schema.bodyMeasurement.date, to),
        ),
      )
      .orderBy(asc(schema.bodyMeasurement.date));
    return rows.map((r) => this.rowToMeasurement(r));
  }

  // Most recent value of every girth on or before `asOf`, each part on its own
  // — an arm measured last month still counts when today's session skipped it.
  // Merges both sources: muscle girths from body_measurement, waist / neck /
  // hips from the weigh-ins.
  async latestGirths(asOf: string): Promise<Partial<Record<ProportionPart, number>>> {
    return (await this.latestGirthsDated(asOf)).values;
  }

  /** latestGirths plus the day each value was measured on. */
  async latestGirthsDated(asOf: string): Promise<{
    values: Partial<Record<ProportionPart, number>>;
    dates: Partial<Record<ProportionPart, string>>;
  }> {
    const [sessions, weighIns] = await Promise.all([
      this.readMeasurementsRange(null, asOf),
      this.readBodyCompRange("0000-01-01", asOf),
    ]);
    const values: Partial<Record<ProportionPart, number>> = {};
    const dates: Partial<Record<ProportionPart, string>> = {};
    const take = (p: ProportionPart, v: number | null | undefined, date: string) => {
      if (values[p] === undefined && v != null) {
        values[p] = v;
        dates[p] = date;
      }
    };
    for (let i = sessions.length - 1; i >= 0; i--) {
      for (const p of MUSCLE_GIRTHS) take(p, sessions[i][`${p}_cm`], sessions[i].date);
    }
    for (let i = weighIns.length - 1; i >= 0; i--) {
      const e = weighIns[i];
      take("waist", e.waist_cm, e.date);
      take("neck", e.neck_cm, e.date);
      take("hips", e.hip_cm, e.date);
    }
    return { values, dates };
  }

  async deleteMeasurement(date: string): Promise<boolean> {
    const rows = await db()
      .delete(schema.bodyMeasurement)
      .where(
        and(eq(schema.bodyMeasurement.userId, this.userId), eq(schema.bodyMeasurement.date, date)),
      )
      .returning({ id: schema.bodyMeasurement.id });
    return rows.length > 0;
  }

  // ---- meal log (per day) ----
  async loadMealLog(date: string): Promise<MealLog | null> {
    const [row] = await db()
      .select()
      .from(schema.mealLog)
      .where(and(eq(schema.mealLog.userId, this.userId), eq(schema.mealLog.date, date)))
      .limit(1);
    if (!row) return null;
    return { date: row.date, meals: row.meals as MealLog["meals"] };
  }

  async loadMealLogsRange(from: string, to: string): Promise<MealLog[]> {
    const rows = await db()
      .select()
      .from(schema.mealLog)
      .where(
        and(
          eq(schema.mealLog.userId, this.userId),
          gte(schema.mealLog.date, from),
          lte(schema.mealLog.date, to),
        ),
      )
      .orderBy(asc(schema.mealLog.date));
    return rows.map((r) => ({
      date: r.date,
      meals: r.meals as MealLog["meals"],
    }));
  }

  async saveMealLog(log: MealLog): Promise<void> {
    const values = {
      userId: this.userId,
      date: log.date,
      meals: log.meals,
      updatedAt: new Date(),
    };
    await db()
      .insert(schema.mealLog)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.mealLog.userId, schema.mealLog.date],
        set: { ...values },
      });
  }

  // ---- water (daily intake aggregate) ----
  //
  // One upserted row per (user, date), mirroring daily_steps. `ml` is the
  // absolute daily total. The goal is not per-day — see setWaterGoal (profile).

  async loadWater(date: string): Promise<{ ml: number }> {
    const [row] = await db()
      .select()
      .from(schema.waterLog)
      .where(and(eq(schema.waterLog.userId, this.userId), eq(schema.waterLog.date, date)))
      .limit(1);
    return { ml: row?.ml ?? 0 };
  }

  // Upsert a day's absolute intake.
  async saveWater(opts: { date: string; ml: number }): Promise<{ ml: number }> {
    const ml = Math.max(0, Math.round(opts.ml));
    await db()
      .insert(schema.waterLog)
      .values({ userId: this.userId, date: opts.date, ml })
      .onConflictDoUpdate({
        target: [schema.waterLog.userId, schema.waterLog.date],
        set: { ml, updatedAt: new Date() },
      });
    return this.loadWater(opts.date);
  }

  // Set the user's persistent everyday hydration goal (ml) on the profile —
  // the single source of truth for the daily water target (null → app default).
  // Targeted profile-column update so callers don't need to round-trip a full
  // Profile. No-ops when the user has no profile row yet (nothing to update).
  async setWaterGoal(ml: number | null): Promise<void> {
    const goal = ml == null ? null : Math.max(0, Math.round(ml)) || null;
    await db()
      .update(schema.profile)
      .set({ waterGoalMl: goal, updatedAt: new Date() })
      .where(eq(schema.profile.userId, this.userId));
  }

  // ---- feature requests (append-only inbox) ----
  //
  // The agent files these on the user's behalf (submit_feature_request) when
  // they ask for a capability the app doesn't have. `status` defaults to 'open'
  // at the DB layer for later triage. Returns the new row's id + created_at.
  async addFeatureRequest(req: {
    title: string;
    details?: string | null;
  }): Promise<{ id: number; createdAt: Date }> {
    const [row] = await db()
      .insert(schema.toolFeatureRequest)
      .values({
        userId: this.userId,
        title: req.title,
        details: req.details ?? null,
      })
      .returning({
        id: schema.toolFeatureRequest.id,
        createdAt: schema.toolFeatureRequest.createdAt,
      });
    return row;
  }

  // ---- workout plans ----
  //
  // Plans are loaded and saved as a tree (plan → days → exercises) in a
  // single transaction. Read-modify-write is the easiest way to support the
  // editor UI where reordering days / exercises is common — rather than
  // shipping individual mutation endpoints for every nested change.

  async listWorkoutPlans(): Promise<WorkoutPlan[]> {
    const plans = await db()
      .select()
      .from(schema.workoutPlan)
      .where(eq(schema.workoutPlan.userId, this.userId))
      .orderBy(asc(schema.workoutPlan.id));
    if (!plans.length) return [];
    return Promise.all(plans.map((p) => this.hydratePlan(p)));
  }

  // Point the profile's active pointer at one of the user's workout plans.
  // Radio-style (exactly one active); returns false if the plan doesn't exist
  // or belongs to someone else. Mirrors setActiveDietPlan.
  async setActiveWorkoutPlan(planId: number): Promise<boolean> {
    const [plan] = await db()
      .select({ id: schema.workoutPlan.id })
      .from(schema.workoutPlan)
      .where(and(eq(schema.workoutPlan.id, planId), eq(schema.workoutPlan.userId, this.userId)))
      .limit(1);
    if (!plan) return false;
    await db()
      .update(schema.profile)
      .set({ activeWorkoutPlanId: planId })
      .where(eq(schema.profile.userId, this.userId));
    return true;
  }

  async loadWorkoutPlan(id: number, exec: DbExecutor = db()): Promise<WorkoutPlan | null> {
    const [row] = await exec
      .select()
      .from(schema.workoutPlan)
      .where(and(eq(schema.workoutPlan.id, id), eq(schema.workoutPlan.userId, this.userId)))
      .limit(1);
    if (!row) return null;
    return this.hydratePlan(row, exec);
  }

  private async hydratePlan(
    p: typeof schema.workoutPlan.$inferSelect,
    exec: DbExecutor = db(),
  ): Promise<WorkoutPlan> {
    const days = await exec
      .select()
      .from(schema.workoutPlanDay)
      .where(eq(schema.workoutPlanDay.planId, p.id))
      .orderBy(asc(schema.workoutPlanDay.id));
    const planDays: WorkoutPlanDay[] = await Promise.all(
      days.map(async (d) => {
        const exs = await exec
          .select()
          .from(schema.workoutPlanExercise)
          .where(eq(schema.workoutPlanExercise.planDayId, d.id))
          .orderBy(asc(schema.workoutPlanExercise.order));
        return {
          id: d.id,
          weekdays: coerceWeekdays(d.weekdays),
          name: d.name,
          focus: d.focus,
          exercises: exs.map((e): WorkoutPlanExercise => ({
            id: e.id,
            exercise_id: e.exerciseId,
            machine_id: e.machineId,
            order: e.order,
            target_sets: e.targetSets,
            target_reps: e.targetReps,
            target_weight_kg: e.targetWeightKg,
            target_duration_sec: e.targetDurationSec,
            notes: e.notes,
          })),
        };
      }),
    );
    return {
      id: p.id,
      name: p.name,
      notes: p.notes,
      days: planDays,
      created_at: p.createdAt.toISOString(),
      updated_at: p.updatedAt.toISOString(),
    };
  }

  // Create a brand-new plan. Returns the freshly-saved plan with server IDs
  // populated. `days[].exercises` are wholesale inserted; their `id` field
  // (if any) is ignored.
  async createWorkoutPlan(input: WorkoutPlanWriteInput): Promise<WorkoutPlan> {
    return db().transaction(async (tx) => {
      const [plan] = await tx
        .insert(schema.workoutPlan)
        .values({
          userId: this.userId,
          name: input.name,
          notes: input.notes ?? null,
          updatedAt: new Date(),
        })
        .returning();
      for (const d of input.days) {
        const [day] = await tx
          .insert(schema.workoutPlanDay)
          .values({
            planId: plan.id,
            weekdays: coerceWeekdays(d.weekdays),
            name: d.name,
            focus: d.focus ?? null,
          })
          .returning();
        if (d.exercises.length) {
          await tx.insert(schema.workoutPlanExercise).values(
            d.exercises.map((e, i) => ({
              planDayId: day.id,
              exerciseId: e.exercise_id,
              machineId: e.machine_id ?? null,
              order: e.order ?? i,
              targetSets: e.target_sets,
              ...planTargetColumns(e),
              targetWeightKg: e.target_weight_kg ?? null,
              notes: e.notes ?? null,
            })),
          );
        }
      }
      // First plan auto-activates (no active pointer yet) — mirrors
      // createDietPlan; subsequent plans don't steal the active pointer.
      const [prof] = await tx
        .select({ activeId: schema.profile.activeWorkoutPlanId })
        .from(schema.profile)
        .where(eq(schema.profile.userId, this.userId))
        .limit(1);
      if (prof && prof.activeId == null) {
        await tx
          .update(schema.profile)
          .set({ activeWorkoutPlanId: plan.id })
          .where(eq(schema.profile.userId, this.userId));
      }
      return (await this.loadWorkoutPlan(plan.id, tx))!;
    });
  }

  // Replace a plan's content (name/notes + full day/exercise tree). Wipes
  // and re-inserts days/exercises — simpler than computing a diff, and the
  // editor UI is the only writer so we don't have to worry about partial
  // updates colliding with concurrent edits.
  async updateWorkoutPlan(id: number, input: WorkoutPlanWriteInput): Promise<WorkoutPlan | null> {
    return db().transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.workoutPlan)
        .set({
          name: input.name,
          notes: input.notes ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.workoutPlan.id, id), eq(schema.workoutPlan.userId, this.userId)))
        .returning();
      if (!updated) return null;
      // Cascade delete via FK clears days + exercises.
      await tx.delete(schema.workoutPlanDay).where(eq(schema.workoutPlanDay.planId, id));
      for (const d of input.days) {
        const [day] = await tx
          .insert(schema.workoutPlanDay)
          .values({
            planId: id,
            weekdays: coerceWeekdays(d.weekdays),
            name: d.name,
            focus: d.focus ?? null,
          })
          .returning();
        if (d.exercises.length) {
          await tx.insert(schema.workoutPlanExercise).values(
            d.exercises.map((e, i) => ({
              planDayId: day.id,
              exerciseId: e.exercise_id,
              machineId: e.machine_id ?? null,
              order: e.order ?? i,
              targetSets: e.target_sets,
              ...planTargetColumns(e),
              targetWeightKg: e.target_weight_kg ?? null,
              notes: e.notes ?? null,
            })),
          );
        }
      }
      return (await this.loadWorkoutPlan(id, tx))!;
    });
  }

  async deleteWorkoutPlan(id: number): Promise<boolean> {
    const rows = await db()
      .delete(schema.workoutPlan)
      .where(and(eq(schema.workoutPlan.id, id), eq(schema.workoutPlan.userId, this.userId)))
      .returning({ id: schema.workoutPlan.id });
    return rows.length > 0;
  }

  // Confirm a plan-day belongs to a plan owned by this user. Used as a guard
  // before any granular mutation — read-modify-write code paths trust the
  // result so we never leak edits across users.
  private async ownedPlanDay(
    planDayId: number,
    exec: DbExecutor = db(),
  ): Promise<{ planId: number } | null> {
    const [row] = await exec
      .select({
        planId: schema.workoutPlanDay.planId,
        userId: schema.workoutPlan.userId,
      })
      .from(schema.workoutPlanDay)
      .innerJoin(schema.workoutPlan, eq(schema.workoutPlan.id, schema.workoutPlanDay.planId))
      .where(eq(schema.workoutPlanDay.id, planDayId))
      .limit(1);
    if (!row || row.userId !== this.userId) return null;
    return { planId: row.planId };
  }

  // ---- granular plan mutations ----
  //
  // These exist so the agent can apply natural-language edits ("move leg day
  // to Friday", "swap bench for incline press") without round-tripping the
  // whole plan. Each method validates ownership against the user before
  // touching anything; they all return the fully-hydrated plan so the form
  // gate can render the post-change state.

  // Patch a plan day: rename, change focus, or change which weekdays it
  // runs on. Pass `null` for fields you don't want to change; pass a value
  // (including `""` for focus or `[]` for weekdays) to overwrite.
  async updateWorkoutPlanDay(
    planDayId: number,
    patch: {
      name?: string;
      focus?: string | null;
      weekdays?: Weekday[];
    },
  ): Promise<WorkoutPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedPlanDay(planDayId, tx);
      if (!owned) return null;
      const update: Record<string, unknown> = {};
      if (patch.name !== undefined) update.name = patch.name;
      if (patch.focus !== undefined) update.focus = patch.focus || null;
      if (patch.weekdays !== undefined) {
        update.weekdays = coerceWeekdays(patch.weekdays);
      }
      if (Object.keys(update).length > 0) {
        await tx
          .update(schema.workoutPlanDay)
          .set(update)
          .where(eq(schema.workoutPlanDay.id, planDayId));
      }
      return (await this.loadWorkoutPlan(owned.planId, tx))!;
    });
  }

  // Append one exercise prescription to a plan day. `order` defaults to the
  // end of the existing list so the most common natural-language ask ("add
  // X to Chest Day 1") just works.
  async addExerciseToPlanDay(
    planDayId: number,
    input: {
      exercise_id: ExerciseId;
      machine_id?: MachineId | null;
      target_sets: number;
      target_reps?: number | null;
      target_weight_kg?: number | null;
      target_duration_sec?: number | null;
      notes?: string | null;
      order?: number;
    },
  ): Promise<WorkoutPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedPlanDay(planDayId, tx);
      if (!owned) return null;
      const existing = await tx
        .select({ order: schema.workoutPlanExercise.order })
        .from(schema.workoutPlanExercise)
        .where(eq(schema.workoutPlanExercise.planDayId, planDayId));
      const nextOrder =
        input.order ?? (existing.length ? Math.max(...existing.map((e) => e.order)) + 1 : 0);
      await tx.insert(schema.workoutPlanExercise).values({
        planDayId,
        exerciseId: input.exercise_id,
        machineId: input.machine_id ?? null,
        order: nextOrder,
        targetSets: input.target_sets,
        ...planTargetColumns(input),
        targetWeightKg: input.target_weight_kg ?? null,
        notes: input.notes ?? null,
      });
      return (await this.loadWorkoutPlan(owned.planId, tx))!;
    });
  }

  // Remove one exercise from a plan day. Returns null if the exercise
  // doesn't exist or belongs to another user's plan.
  async removeExerciseFromPlanDay(
    planDayId: number,
    exerciseRowId: number,
  ): Promise<WorkoutPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedPlanDay(planDayId, tx);
      if (!owned) return null;
      const rows = await tx
        .delete(schema.workoutPlanExercise)
        .where(
          and(
            eq(schema.workoutPlanExercise.id, exerciseRowId),
            eq(schema.workoutPlanExercise.planDayId, planDayId),
          ),
        )
        .returning({ id: schema.workoutPlanExercise.id });
      if (rows.length === 0) return null;
      return (await this.loadWorkoutPlan(owned.planId, tx))!;
    });
  }

  // Patch one exercise prescription. Pass only the fields you want to
  // change — leaving a field undefined keeps it. Use this for "switch the
  // bench press machine" or "bump the target weight to 70kg".
  async updatePlanExercise(
    planDayId: number,
    exerciseRowId: number,
    patch: {
      exercise_id?: ExerciseId;
      machine_id?: MachineId | null;
      target_sets?: number;
      target_reps?: number | null;
      target_weight_kg?: number | null;
      target_duration_sec?: number | null;
      notes?: string | null;
      order?: number;
    },
  ): Promise<WorkoutPlan | null> {
    return db().transaction(async (tx) => {
      const owned = await this.ownedPlanDay(planDayId, tx);
      if (!owned) return null;
      const update: Record<string, unknown> = {};
      if (patch.exercise_id !== undefined) update.exerciseId = patch.exercise_id;
      if (patch.machine_id !== undefined) update.machineId = patch.machine_id;
      if (patch.target_sets !== undefined) update.targetSets = patch.target_sets;
      if (patch.target_reps !== undefined) update.targetReps = patch.target_reps;
      if (patch.target_duration_sec !== undefined) {
        update.targetDurationSec = patch.target_duration_sec;
      }
      if (patch.target_weight_kg !== undefined) {
        update.targetWeightKg = patch.target_weight_kg;
      }
      if (patch.notes !== undefined) update.notes = patch.notes;
      if (patch.order !== undefined) update.order = patch.order;
      if (Object.keys(update).length === 0) {
        return (await this.loadWorkoutPlan(owned.planId, tx))!;
      }
      const rows = await tx
        .update(schema.workoutPlanExercise)
        .set(update)
        .where(
          and(
            eq(schema.workoutPlanExercise.id, exerciseRowId),
            eq(schema.workoutPlanExercise.planDayId, planDayId),
          ),
        )
        .returning({ id: schema.workoutPlanExercise.id });
      if (rows.length === 0) return null;
      return (await this.loadWorkoutPlan(owned.planId, tx))!;
    });
  }

  // ---- workout sessions + sets ----
  //
  // Sessions are mutable while open: the UI creates a session up-front,
  // appends sets one-by-one as the user logs them, then patches duration /
  // kcal_burned on "finish workout". Each set is its own row — set_index
  // is auto-assigned (1-based) per (session_id, exercise_id) so the agent
  // and UI just send {exercise_id, reps, weight_kg}.

  async startWorkoutSession(input: WorkoutSessionStartInput): Promise<WorkoutSession> {
    // Backdated/planned sessions: leave started_at null so the UI knows to
    // collect duration manually instead of subtracting wall-clock at Finish.
    const startedAt = input.backdated
      ? null
      : input.started_at
        ? new Date(input.started_at)
        : new Date();
    const [row] = await db()
      .insert(schema.workoutSession)
      .values({
        userId: this.userId,
        date: input.date,
        planDayId: input.plan_day_id ?? null,
        name: input.name ?? null,
        notes: input.notes ?? null,
        startedAt,
        updatedAt: new Date(),
      })
      .returning();
    return this.rowToSession(row, []);
  }

  async loadWorkoutSession(id: number): Promise<WorkoutSession | null> {
    const [row] = await db()
      .select()
      .from(schema.workoutSession)
      .where(and(eq(schema.workoutSession.id, id), eq(schema.workoutSession.userId, this.userId)))
      .limit(1);
    if (!row) return null;
    const sets = await this.loadSetsForSession(id);
    return this.rowToSession(row, sets);
  }

  // List sessions over an inclusive date range, newest-first. Sets are
  // included so the UI can render an at-a-glance summary without N+1
  // lookups. Used by the Today + (future) history views.
  async listWorkoutSessions(from: string, to: string): Promise<WorkoutSession[]> {
    const rows = await db()
      .select()
      .from(schema.workoutSession)
      .where(
        and(
          eq(schema.workoutSession.userId, this.userId),
          gte(schema.workoutSession.date, from),
          lte(schema.workoutSession.date, to),
        ),
      )
      .orderBy(desc(schema.workoutSession.date), desc(schema.workoutSession.id));
    if (!rows.length) return [];
    // One query for all sets in this range, then group in-process — keeps
    // the SQL count to O(1) regardless of how many sessions are listed.
    const sessionIds = rows.map((r) => r.id);
    const allSets = await db()
      .select()
      .from(schema.workoutSessionSet)
      .where(inArray(schema.workoutSessionSet.sessionId, sessionIds))
      .orderBy(asc(schema.workoutSessionSet.setIndex));
    const byId = new Map<number, WorkoutSet[]>();
    for (const s of allSets) {
      const arr = byId.get(s.sessionId) ?? [];
      arr.push(this.rowToSet(s));
      byId.set(s.sessionId, arr);
    }
    return rows.map((r) => this.rowToSession(r, byId.get(r.id) ?? []));
  }

  async patchWorkoutSession(
    id: number,
    patch: WorkoutSessionPatchInput,
  ): Promise<WorkoutSession | null> {
    const set: Partial<typeof schema.workoutSession.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) set.name = patch.name ?? null;
    if (patch.duration_min !== undefined) {
      set.durationMin = patch.duration_min ?? null;
    }
    if (patch.kcal_burned !== undefined) {
      set.kcalBurned = patch.kcal_burned ?? null;
    }
    if (patch.notes !== undefined) set.notes = patch.notes ?? null;
    const [row] = await db()
      .update(schema.workoutSession)
      .set(set)
      .where(and(eq(schema.workoutSession.id, id), eq(schema.workoutSession.userId, this.userId)))
      .returning();
    if (!row) return null;
    const sets = await this.loadSetsForSession(id);
    return this.rowToSession(row, sets);
  }

  async deleteWorkoutSession(id: number): Promise<boolean> {
    const rows = await db()
      .delete(schema.workoutSession)
      .where(and(eq(schema.workoutSession.id, id), eq(schema.workoutSession.userId, this.userId)))
      .returning({ id: schema.workoutSession.id });
    return rows.length > 0;
  }

  // Append a set. set_index is auto-assigned: (max existing index for this
  // session+exercise) + 1, starting at 1. Two-step lookup is fine because
  // workouts are inherently single-writer (one user, one phone) and a race
  // would at worst produce a duplicate index — not a correctness issue.
  // Returns null when the session doesn't exist or belongs to another user.
  async appendWorkoutSet(sessionId: number, input: WorkoutSetInput): Promise<WorkoutSet | null> {
    // Ownership check + existence check in one shot.
    const [owner] = await db()
      .select({ id: schema.workoutSession.id })
      .from(schema.workoutSession)
      .where(
        and(eq(schema.workoutSession.id, sessionId), eq(schema.workoutSession.userId, this.userId)),
      )
      .limit(1);
    if (!owner) return null;

    const [maxRow] = await db()
      .select({ max: sql<number>`coalesce(max(${schema.workoutSessionSet.setIndex}), 0)` })
      .from(schema.workoutSessionSet)
      .where(
        and(
          eq(schema.workoutSessionSet.sessionId, sessionId),
          eq(schema.workoutSessionSet.exerciseId, input.exercise_id),
        ),
      );
    const nextIndex = (maxRow?.max ?? 0) + 1;
    const [row] = await db()
      .insert(schema.workoutSessionSet)
      .values({
        sessionId,
        exerciseId: input.exercise_id,
        machineId: input.machine_id ?? null,
        setIndex: nextIndex,
        reps: input.reps,
        weightKg: input.weight_kg,
        rpe: input.rpe ?? null,
        durationSec: input.duration_sec ?? null,
        distanceM: input.distance_m ?? null,
        completedAt: input.completed_at ? new Date(input.completed_at) : new Date(),
      })
      .returning();
    // Bump session.updatedAt so the listing sorts by "last activity" too.
    await db()
      .update(schema.workoutSession)
      .set({ updatedAt: new Date() })
      .where(eq(schema.workoutSession.id, sessionId));
    return this.rowToSet(row);
  }

  async deleteWorkoutSet(sessionId: number, setId: number): Promise<boolean> {
    // Join through session for ownership; cheaper than a separate select.
    const rows = await db()
      .delete(schema.workoutSessionSet)
      .where(
        and(
          eq(schema.workoutSessionSet.id, setId),
          eq(schema.workoutSessionSet.sessionId, sessionId),
          // Subquery: session must belong to this user.
          sql`exists (
            select 1 from ${schema.workoutSession}
            where ${schema.workoutSession.id} = ${schema.workoutSessionSet.sessionId}
              and ${schema.workoutSession.userId} = ${this.userId}
          )`,
        ),
      )
      .returning({ id: schema.workoutSessionSet.id });
    return rows.length > 0;
  }

  // "Last time you did X" — most recent N sets of an exercise across any
  // session belonging to this user. Powers the per-exercise hint on Today.
  // Newest-first by completed_at (fallback session date), capped at `limit`.
  async lastSetsForExercise(exerciseId: string, limit = 10): Promise<LastExerciseSet[]> {
    const rows = await db()
      .select({
        setId: schema.workoutSessionSet.id,
        sessionId: schema.workoutSession.id,
        date: schema.workoutSession.date,
        reps: schema.workoutSessionSet.reps,
        weightKg: schema.workoutSessionSet.weightKg,
        rpe: schema.workoutSessionSet.rpe,
        durationSec: schema.workoutSessionSet.durationSec,
        completedAt: schema.workoutSessionSet.completedAt,
      })
      .from(schema.workoutSessionSet)
      .innerJoin(
        schema.workoutSession,
        eq(schema.workoutSession.id, schema.workoutSessionSet.sessionId),
      )
      .where(
        and(
          eq(schema.workoutSession.userId, this.userId),
          eq(schema.workoutSessionSet.exerciseId, exerciseId),
        ),
      )
      .orderBy(
        desc(schema.workoutSessionSet.completedAt),
        desc(schema.workoutSession.date),
        desc(schema.workoutSessionSet.id),
      )
      .limit(limit);
    return rows.map((r) => ({
      set_id: r.setId,
      session_id: r.sessionId,
      date: r.date,
      reps: r.reps,
      weight_kg: r.weightKg,
      rpe: r.rpe ?? null,
      duration_sec: r.durationSec ?? null,
      completed_at: r.completedAt ? r.completedAt.toISOString() : null,
    }));
  }

  // Target reps prescribed for each exercise on a plan day, as a
  // exercise_id → target_reps map. Powers the progressive-overload nudge:
  // after a logged session linked to a plan, we look up what rep target the
  // user was prescribed for each exercise. Exercises with a null target_reps
  // (cardio, etc.) are omitted.
  async targetRepsForPlanDay(planDayId: number): Promise<Map<string, number>> {
    const rows = await db()
      .select({
        exerciseId: schema.workoutPlanExercise.exerciseId,
        targetReps: schema.workoutPlanExercise.targetReps,
      })
      .from(schema.workoutPlanExercise)
      .innerJoin(
        schema.workoutPlanDay,
        eq(schema.workoutPlanDay.id, schema.workoutPlanExercise.planDayId),
      )
      .innerJoin(schema.workoutPlan, eq(schema.workoutPlan.id, schema.workoutPlanDay.planId))
      .where(
        and(
          eq(schema.workoutPlanExercise.planDayId, planDayId),
          eq(schema.workoutPlan.userId, this.userId),
        ),
      );
    const out = new Map<string, number>();
    for (const r of rows) {
      if (r.targetReps != null) out.set(r.exerciseId, r.targetReps);
    }
    return out;
  }

  // Flat set rows for progress aggregation — joins to workout_session so we
  // get the calendar date the set belongs to. Filtered by user and optionally
  // by exercise + date range. Returned oldest-first so running-max walks
  // (PR detection) can stream forward in time without re-sorting.
  async loadSetsForProgress(opts: { exerciseId?: string; from?: string; to?: string }): Promise<
    Array<{
      date: string;
      exercise_id: string;
      reps: number;
      weight_kg: number;
      completed_at: string | null;
    }>
  > {
    const conds = [eq(schema.workoutSession.userId, this.userId)];
    if (opts.exerciseId) {
      conds.push(eq(schema.workoutSessionSet.exerciseId, opts.exerciseId));
    }
    if (opts.from) conds.push(gte(schema.workoutSession.date, opts.from));
    if (opts.to) conds.push(lte(schema.workoutSession.date, opts.to));

    const rows = await db()
      .select({
        date: schema.workoutSession.date,
        exerciseId: schema.workoutSessionSet.exerciseId,
        reps: schema.workoutSessionSet.reps,
        weightKg: schema.workoutSessionSet.weightKg,
        completedAt: schema.workoutSessionSet.completedAt,
      })
      .from(schema.workoutSessionSet)
      .innerJoin(
        schema.workoutSession,
        eq(schema.workoutSession.id, schema.workoutSessionSet.sessionId),
      )
      .where(and(...conds))
      .orderBy(
        asc(schema.workoutSession.date),
        asc(schema.workoutSessionSet.completedAt),
        asc(schema.workoutSessionSet.id),
      );
    return rows.map((r) => ({
      date: r.date,
      exercise_id: r.exerciseId,
      reps: r.reps,
      weight_kg: r.weightKg,
      completed_at: r.completedAt ? r.completedAt.toISOString() : null,
    }));
  }

  private async loadSetsForSession(sessionId: number): Promise<WorkoutSet[]> {
    const rows = await db()
      .select()
      .from(schema.workoutSessionSet)
      .where(eq(schema.workoutSessionSet.sessionId, sessionId))
      .orderBy(asc(schema.workoutSessionSet.setIndex));
    return rows.map((r) => this.rowToSet(r));
  }

  private rowToSet(r: typeof schema.workoutSessionSet.$inferSelect): WorkoutSet {
    return {
      id: r.id,
      session_id: r.sessionId,
      exercise_id: r.exerciseId,
      machine_id: r.machineId,
      set_index: r.setIndex,
      reps: r.reps,
      weight_kg: r.weightKg,
      rpe: r.rpe,
      duration_sec: r.durationSec,
      distance_m: r.distanceM,
      completed_at: r.completedAt ? r.completedAt.toISOString() : null,
    };
  }

  private rowToSession(
    r: typeof schema.workoutSession.$inferSelect,
    sets: WorkoutSet[],
  ): WorkoutSession {
    return {
      id: r.id,
      date: r.date,
      plan_day_id: r.planDayId,
      name: r.name,
      duration_min: r.durationMin,
      kcal_burned: r.kcalBurned,
      notes: r.notes,
      sets,
      started_at: r.startedAt ? r.startedAt.toISOString() : null,
      updated_at: r.updatedAt.toISOString(),
    };
  }

  // ---- targeted deletions (corrections / undo) ----
  // Delete logged meals. With `index` (0-based position in the day's meal
  // list), removes exactly that one meal — the UI passes it so emptying one of
  // several meals that share an untimed slot can't take its siblings with it.
  // Without it, falls back to slot(+time) matching, which removes ALL matches.
  async deleteMeal(date: string, slot: string, time?: string, index?: number): Promise<number> {
    const log = await this.loadMealLog(date);
    if (!log) return 0;
    const before = log.meals.length;
    if (index != null) {
      if (!Number.isInteger(index) || index < 0 || index >= log.meals.length) return 0;
      log.meals.splice(index, 1);
    } else {
      log.meals = log.meals.filter((m) => {
        if (m.slot !== slot) return true;
        if (time && m.time !== time) return true;
        return false;
      });
    }
    await this.saveMealLog(log);
    return before - log.meals.length;
  }

  async deleteBodyCompEntries(date: string): Promise<number> {
    const rows = await db()
      .delete(schema.bodyCompEntry)
      .where(and(eq(schema.bodyCompEntry.userId, this.userId), eq(schema.bodyCompEntry.date, date)))
      .returning({ id: schema.bodyCompEntry.id });
    if (rows.length) await this.recomputeProfileTargets();
    return rows.length;
  }

  // Delete a single body-composition entry by its row id. Unlike
  // deleteBodyCompEntries (delete-by-date), this targets exactly one weigh-in,
  // so removing one of several entries on the same day leaves the rest intact.
  // Scoped to userId so a user can only delete their own rows. Returns false
  // when no matching row exists.
  async deleteBodyCompEntry(id: number): Promise<boolean> {
    const rows = await db()
      .delete(schema.bodyCompEntry)
      .where(and(eq(schema.bodyCompEntry.userId, this.userId), eq(schema.bodyCompEntry.id, id)))
      .returning({ id: schema.bodyCompEntry.id });
    if (rows.length) await this.recomputeProfileTargets();
    return rows.length > 0;
  }

  // ---- steps (daily pedometer aggregate, one row per user/day) ----

  // Read a single day's step total + goal. Missing rows read as 0 / null goal
  // — a day with no pedometer activity simply has no row yet.
  async readSteps(date: string): Promise<{ date: string; steps: number; goal: number | null }> {
    const [row] = await db()
      .select()
      .from(schema.dailySteps)
      .where(and(eq(schema.dailySteps.userId, this.userId), eq(schema.dailySteps.date, date)))
      .limit(1);
    return { date, steps: row?.steps ?? 0, goal: row?.goal ?? null };
  }

  async readStepsRange(
    from: string,
    to: string,
  ): Promise<{ date: string; steps: number; goal: number | null }[]> {
    const rows = await db()
      .select()
      .from(schema.dailySteps)
      .where(
        and(
          eq(schema.dailySteps.userId, this.userId),
          gte(schema.dailySteps.date, from),
          lte(schema.dailySteps.date, to),
        ),
      )
      .orderBy(asc(schema.dailySteps.date));
    return rows.map((r) => ({ date: r.date, steps: r.steps, goal: r.goal }));
  }

  // Upsert a day's ABSOLUTE step total. `goal` is only written when provided
  // (undefined leaves an existing goal alone; explicit null clears it).
  async upsertSteps(
    date: string,
    steps: number,
    goal?: number | null,
  ): Promise<{ date: string; steps: number; goal: number | null }> {
    const onConflictSet: { steps: number; updatedAt: Date; goal?: number | null } = {
      steps,
      updatedAt: new Date(),
    };
    if (goal !== undefined) onConflictSet.goal = goal;
    await db()
      .insert(schema.dailySteps)
      .values({ userId: this.userId, date, steps, goal: goal ?? null })
      .onConflictDoUpdate({
        target: [schema.dailySteps.userId, schema.dailySteps.date],
        set: onConflictSet,
      });
    return this.readSteps(date);
  }

  // Delete a day's step row entirely. Returns false when nothing matched.
  async deleteSteps(date: string): Promise<boolean> {
    const rows = await db()
      .delete(schema.dailySteps)
      .where(and(eq(schema.dailySteps.userId, this.userId), eq(schema.dailySteps.date, date)))
      .returning({ date: schema.dailySteps.date });
    return rows.length > 0;
  }

  // Update the most recent body-comp entry on `originalDate` in place. The
  // caller (doUpdateBodyCompEntry) has already merged the patch over the
  // existing row and recomputed the derived metrics (BMI/FFMI/Navy) against
  // the profile — same contract as appendBodyComp — so this just writes the
  // columns. `e.date` may differ from `originalDate` (the edit moved the entry
  // to a new day). Returns false when no entry exists for that date. Targeting
  // the newest row keeps the rare multi-weigh-in-per-day case deterministic and
  // matches delete-by-date semantics.
  async updateBodyCompForDate(originalDate: string, e: BodyCompEntry): Promise<boolean> {
    const [row] = await db()
      .select({ id: schema.bodyCompEntry.id })
      .from(schema.bodyCompEntry)
      .where(
        and(
          eq(schema.bodyCompEntry.userId, this.userId),
          eq(schema.bodyCompEntry.date, originalDate),
        ),
      )
      .orderBy(desc(schema.bodyCompEntry.id))
      .limit(1);
    if (!row) return false;
    await db()
      .update(schema.bodyCompEntry)
      .set({
        date: e.date,
        weightKg: e.weight_kg,
        bodyFatPct: e.body_fat_pct,
        bodyFatMethod: e.body_fat_method ?? null,
        waistCm: e.waist_cm,
        neckCm: e.neck_cm ?? null,
        hipCm: e.hip_cm ?? null,
        bodyFatPctNavy: e.body_fat_pct_navy ?? null,
        bmi: e.bmi ?? null,
        ffmi: e.ffmi ?? null,
        ffmiNormalized: e.ffmi_normalized ?? null,
        fatFreeMassKg: e.fat_free_mass_kg ?? null,
        fatMassKg: e.fat_mass_kg ?? null,
        notes: e.notes ?? null,
        time: e.time ?? null,
      })
      .where(eq(schema.bodyCompEntry.id, row.id));
    // Editing a weigh-in (esp. the latest) shifts the recommended target.
    await this.recomputeProfileTargets();
    return true;
  }

  // Update one specific weigh-in by its row id. Unlike updateBodyCompForDate
  // (which targets the newest row on a date), this edits exactly the row the
  // caller picked — the Body page passes the clicked row's id so editing the
  // older of two same-day entries can't silently overwrite the newer one. The
  // caller has already merged + recomputed; this just writes the columns.
  // Returns false when no row with that id belongs to the user.
  async updateBodyCompById(id: number, e: BodyCompEntry): Promise<boolean> {
    const rows = await db()
      .update(schema.bodyCompEntry)
      .set({
        date: e.date,
        weightKg: e.weight_kg,
        bodyFatPct: e.body_fat_pct,
        bodyFatMethod: e.body_fat_method ?? null,
        waistCm: e.waist_cm,
        neckCm: e.neck_cm ?? null,
        hipCm: e.hip_cm ?? null,
        bodyFatPctNavy: e.body_fat_pct_navy ?? null,
        bmi: e.bmi ?? null,
        ffmi: e.ffmi ?? null,
        ffmiNormalized: e.ffmi_normalized ?? null,
        fatFreeMassKg: e.fat_free_mass_kg ?? null,
        fatMassKg: e.fat_mass_kg ?? null,
        notes: e.notes ?? null,
        time: e.time ?? null,
      })
      .where(and(eq(schema.bodyCompEntry.userId, this.userId), eq(schema.bodyCompEntry.id, id)))
      .returning({ id: schema.bodyCompEntry.id });
    if (rows.length === 0) return false;
    // Editing a weigh-in (esp. the latest) shifts the recommended target.
    await this.recomputeProfileTargets();
    return true;
  }

  // ---- conversation persistence ----
  async loadConversation(): Promise<FaMessage[]> {
    const start = Date.now();
    const rows = await db()
      .select()
      .from(schema.conversationMessage)
      .where(eq(schema.conversationMessage.userId, this.userId))
      .orderBy(asc(schema.conversationMessage.id));
    log.debug("loadConversation", {
      user_id: this.userId,
      rows: rows.length,
      ms: Date.now() - start,
    });
    const out: FaMessage[] = [];
    for (const r of rows) {
      // Drop rows whose content is neither a string nor an array — the API
      // would reject the whole request, so one corrupt row can otherwise
      // brick the conversation. Causes are typically schema-version skew or
      // a half-formed save from a prior error path.
      if (typeof r.content !== "string" && !Array.isArray(r.content)) {
        log.warn("conversation: dropping row with invalid content shape", {
          user_id: this.userId,
          row_id: r.id,
          role: r.role,
          content_type: r.content === null ? "null" : typeof r.content,
        });
        continue;
      }
      out.push({
        role: r.role as FaMessage["role"],
        content: r.content as FaMessage["content"],
      });
    }
    return out;
  }

  // Paginated read for the chat UI's scroll-up history. Returns a contiguous
  // page of messages ending at (and excluding) `before`, newest page first when
  // `before` is omitted, but the page itself is returned oldest-first so the
  // client can prepend it directly. `nextCursor` is the id to pass as `before`
  // for the next (older) page, or null when this page reaches the start.
  //
  // We over-fetch one row to detect whether older messages exist, then drop it.
  // Invalid-content rows are skipped (as in loadConversation) but still count
  // toward the page limit — paging is by row id, not by surviving-row count, so
  // the cursor stays correct even when rows are dropped.
  async loadConversationPage(opts: {
    before?: number;
    limit: number;
  }): Promise<{ messages: FaMessage[]; nextCursor: number | null }> {
    const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit)));
    const where =
      opts.before != null
        ? and(
            eq(schema.conversationMessage.userId, this.userId),
            lt(schema.conversationMessage.id, opts.before),
          )
        : eq(schema.conversationMessage.userId, this.userId);
    const start = Date.now();
    const rows = await db()
      .select()
      .from(schema.conversationMessage)
      .where(where)
      .orderBy(desc(schema.conversationMessage.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows; // newest-first
    // Smallest id in this page — the boundary for the next older request.
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;
    log.debug("loadConversationPage", {
      user_id: this.userId,
      before: opts.before ?? null,
      rows: page.length,
      has_more: hasMore,
      ms: Date.now() - start,
    });
    const out: FaMessage[] = [];
    // Reverse to ascending (oldest-first) for rendering, dropping malformed rows.
    for (let i = page.length - 1; i >= 0; i--) {
      const r = page[i];
      if (typeof r.content !== "string" && !Array.isArray(r.content)) {
        log.warn("conversation: dropping row with invalid content shape", {
          user_id: this.userId,
          row_id: r.id,
          role: r.role,
          content_type: r.content === null ? "null" : typeof r.content,
        });
        continue;
      }
      out.push({
        role: r.role as FaMessage["role"],
        content: r.content as FaMessage["content"],
      });
    }
    return { messages: out, nextCursor };
  }

  // Append-only persistence. `startIndex` is the count of messages that were
  // already in the DB at the start of this chat() call (the in-memory array
  // contains those followed by everything generated this turn). Only the
  // suffix gets inserted, so previously-saved rows keep their original
  // provider/model attribution when the user switches models mid-conversation.
  async appendConversation(
    messages: FaMessage[],
    startIndex: number,
    meta: { provider: string; model: string },
  ): Promise<number[]> {
    if (startIndex < 0) startIndex = 0;
    const slice = messages.slice(startIndex);
    if (!slice.length) return [];
    // Strip image content before persisting (cost + GDPR + row size). Only
    // the new user message can plausibly contain images; doing it here keeps
    // the call site simple. Also drop transient gate-repair tool_results so an
    // unresolved gate stays dangling (savable) — see stripTransientToolResults.
    const cleaned = slice.map(stripImagesFromMessage).map(stripTransientToolResults);
    const rows = cleaned.map((m) => ({
      userId: this.userId,
      role: m.role,
      content: m.content as unknown,
      provider: meta.provider,
      model: meta.model,
    }));
    const start = Date.now();
    const inserted = await db()
      .insert(schema.conversationMessage)
      .values(rows)
      .returning({ id: schema.conversationMessage.id });
    log.debug("appendConversation", {
      user_id: this.userId,
      rows: rows.length,
      provider: meta.provider,
      model: meta.model,
      ms: Date.now() - start,
    });
    return inserted.map((r) => r.id);
  }

  async resetConversation(): Promise<void> {
    await db()
      .delete(schema.conversationMessage)
      .where(eq(schema.conversationMessage.userId, this.userId));
  }

  // True when `toolUseId` names a persisted tool_use that has no matching
  // tool_result yet — i.e. a gate that opened (persisting the pending card) but
  // was never resolved. Used to guard the dead-gate save path so we don't run a
  // tool whose result is already recorded.
  async isDanglingToolUse(toolUseId: string): Promise<boolean> {
    const messages = await this.loadConversation();
    let hasToolUse = false;
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (m.role === "assistant" && b.kind === "tool_call" && b.callId === toolUseId) {
          hasToolUse = true;
        }
        if (m.role === "user" && b.kind === "tool_result" && b.callId === toolUseId) {
          return false; // already resolved
        }
      }
    }
    return hasToolUse;
  }

  // Append a tool_result for a previously-persisted tool_use whose gate was
  // resolved after the live agent turn ended (the user saved a pending card
  // reopened from history). The dangling tool_use is the last message in that
  // case, so a trailing tool_result keeps the conversation well-formed.
  async appendToolResult(toolUseId: string, content: string): Promise<void> {
    await db()
      .insert(schema.conversationMessage)
      .values({
        userId: this.userId,
        role: "user",
        content: [{ kind: "tool_result", callId: toolUseId, output: content }] as unknown,
        provider: null,
        model: null,
      });
  }

  // ---- usage ledger (P3) ----
  // One row per provider API call (one agent loop iteration). `chatId`
  // groups iterations of a single /chat call; `iterationIndex` orders them.
  // `messageId` links to the assistant message produced by this iteration
  // (nullable so a later message deletion sets it to null rather than
  // cascading away the cost record).
  async logUsage(
    rows: Array<{
      chatId: string;
      iterationIndex: number;
      messageId: number | null;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      stopReason: string | null;
    }>,
  ): Promise<void> {
    if (!rows.length) return;
    await db()
      .insert(schema.usageLedger)
      .values(
        rows.map((r) => ({
          userId: this.userId,
          chatId: r.chatId,
          iterationIndex: r.iterationIndex,
          messageId: r.messageId,
          provider: r.provider,
          model: r.model,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadInputTokens: r.cacheReadInputTokens,
          cacheCreationInputTokens: r.cacheCreationInputTokens,
          stopReason: r.stopReason ?? null,
        })),
      );
    log.debug("logUsage", {
      user_id: this.userId,
      chat_id: rows[0]?.chatId,
      rows: rows.length,
      in_tokens: rows.reduce((a, r) => a + r.inputTokens, 0),
      out_tokens: rows.reduce((a, r) => a + r.outputTokens, 0),
    });
  }

  // Delete ledger rows older than `cutoff`. Returns the number of rows
  // deleted so callers can log it. Run periodically (e.g. nightly) to keep
  // the ledger from growing unboundedly — cost analysis windows are
  // typically months, not years.
  static async pruneUsageLedger(cutoff: Date): Promise<number> {
    const deleted = await db()
      .delete(schema.usageLedger)
      .where(lt(schema.usageLedger.createdAt, cutoff))
      .returning({ id: schema.usageLedger.id });
    return deleted.length;
  }

  async usageSince(since: Date): Promise<{
    input_tokens: number;
    output_tokens: number;
    calls: number;
  }> {
    const [row] = await db()
      .select({
        input: sql<number>`COALESCE(SUM(${schema.usageLedger.inputTokens}), 0)::int`,
        output: sql<number>`COALESCE(SUM(${schema.usageLedger.outputTokens}), 0)::int`,
        calls: sql<number>`COUNT(*)::int`,
      })
      .from(schema.usageLedger)
      .where(
        and(eq(schema.usageLedger.userId, this.userId), gte(schema.usageLedger.createdAt, since)),
      );
    return {
      input_tokens: row?.input ?? 0,
      output_tokens: row?.output ?? 0,
      calls: row?.calls ?? 0,
    };
  }
}

// =====================================================================
// Image stripping for conversation persistence
// =====================================================================

function stripImagesFromMessage(msg: FaMessage): FaMessage {
  if (typeof msg.content === "string") return msg;
  // Defensive: any non-string, non-array shape is invalid for the API. Don't
  // crash the save path on it — coerce to an empty array so the row is at
  // least syntactically valid and loadConversation can drop it next time.
  if (!Array.isArray(msg.content)) {
    log.warn("stripImagesFromMessage: unexpected content shape", {
      role: msg.role,
      content_type: msg.content === null ? "null" : typeof msg.content,
    });
    return { ...msg, content: [] };
  }
  const cleaned = msg.content.map((block) => {
    if (block.kind === "image") {
      // Fallback only: agent.ts normally swaps image blocks for an
      // `[image: <description>]` text block before persisting (see
      // applyImageDescriptions). This generic placeholder covers images
      // whose description failed and non-chat callers.
      const placeholder: FaTextBlock = {
        kind: "text",
        text: "[image: stripped from history — re-attach to reference]",
      };
      return placeholder;
    }
    return block;
  });
  return { ...msg, content: cleaned };
}

// Drop `transient` tool_result blocks before persisting. These are synthetic
// results injected by repairDanglingToolUses to satisfy the provider's
// "every tool_call needs a tool_result" rule for an unresolved gate. Persisting
// one would record a (canceled) result against a gate the user may still save,
// stranding the pending card as canceled and blocking the /resolve dead-gate
// path. They're re-derived in-memory on every load, so persistence doesn't need
// them. Length-shrinking is safe here: the caller re-reads inserted row ids by
// position, and the repair only ever prepends fills to the incoming user prompt,
// whose real content survives the filter.
function stripTransientToolResults(msg: FaMessage): FaMessage {
  if (!Array.isArray(msg.content)) return msg;
  if (!msg.content.some((b) => b.kind === "tool_result" && b.transient === true)) return msg;
  return {
    ...msg,
    content: msg.content.filter((b) => !(b.kind === "tool_result" && b.transient === true)),
  };
}
