/**
 * Per-tool form overrides. The default <ToolForm> reads the JSON Schema and
 * renders generic inputs; an override here lets a specific tool ship a
 * polished bespoke layout (e.g. log_meal's food picker + grams steppers +
 * live macro preview, or ask_user's button picker).
 *
 * Two flavours:
 *   - Standard overrides edit `value`; the parent's Save/Cancel footer
 *     commits the gate.
 *   - Self-submitting overrides (selfSubmitting: true) receive an `onSubmit`
 *     prop and commit the gate themselves when the user interacts. The
 *     parent hides its footer in that case — the override is fully
 *     self-contained (e.g. button picker for ask_user).
 *
 * This is the INPUT half of the tool-UI scheme. The OUTPUT half — rendering a
 * read/compute tool's RESULT as a rich card instead of prose — lives in
 * apps/web/src/cards/resultCards.tsx. A new tool should prefer a bespoke form
 * here (if it mutates) and/or a bespoke result card there (if it returns
 * user-facing numbers).
 */
import type { ComponentType } from "react";
import type { JsonSchema } from "./ToolForm";
import type { FormContext } from "./formContext";
import { AskUserForm } from "./AskUserForm";
import { AskUserMultiForm } from "./AskUserMultiForm";
import { CONFIRM_CARDS } from "./ConfirmCard";
import { DietPlanForm } from "./DietPlanForm";
import {
  AddDietMealForm,
  AddDietPortionForm,
  LogPlannedMealForm,
  UpdateDietDayForm,
  UpdateDietMealForm,
  UpdateDietPortionForm,
} from "./DietEditForms";
import { FeatureRequestForm } from "./FeatureRequestForm";
import { FoodForm } from "./FoodForm";
import { ImportPantryForm } from "./ImportPantryForm";
import { LogBodyCompForm } from "./LogBodyCompForm";
import { LogMealForm } from "./LogMealForm";
import { LogRecipeForm } from "./LogRecipeForm";
import { LogStepsForm } from "./LogStepsForm";
import { LogWaterForm } from "./LogWaterForm";
import { LogWorkoutSessionForm } from "./LogWorkoutSessionForm";
import { PantryForm } from "./PantryForm";
import { RecipeForm, SetRecipeFavoriteForm, UpdateRecipePortionForm } from "./RecipeForm";
import {
  AddPlanExerciseForm,
  ReplacePlanExerciseForm,
  UpdatePlanDayForm,
  UpdatePlanExerciseForm,
} from "./PlanEditForms";
import { SaveWorkoutPlanForm } from "./SaveWorkoutPlanForm";
import { UpdateProfileForm } from "./UpdateProfileForm";
import { BODY_FAT_METHOD_LABELS, bodyCompFieldVisibility, type BodyFatMethod } from "./bodyComp";

export type ToolOverrideProps = {
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  // Only provided to self-submitting overrides. Calling this commits the
  // gate as if Save were clicked, with `value` as the final input. Standard
  // overrides leave this undefined and rely on the parent's Save button.
  onSubmit?: (value: unknown) => void;
};

// A tool override can take one of two shapes (or combine the schema-driven
// hooks):
//
//   - A full bespoke `component` that replaces the generic renderer entirely
//     (e.g. log_meal's food picker). Optionally `selfSubmitting`.
//   - Schema-driven refinements that keep the DEFAULT <ToolForm> renderer but
//     tailor it: `prefill` seeds initial values from profile / last reading,
//     and `refineSchema` returns a transformed schema (e.g. hiding fields via
//     `x-hide`) that reacts to the current input + context. This is the
//     general "conditional tool inputs" mechanism — any tool can opt in
//     without shipping a bespoke component.
export type OverrideDef = {
  component?: ComponentType<ToolOverrideProps>;
  // When true, the parent hides its Save/Cancel footer and passes onSubmit
  // to the override. The override is responsible for committing the gate.
  selfSubmitting?: boolean;
  // Seed values applied to the initial draft ONLY for keys the model didn't
  // already supply (model-proposed values always win). Runs once, after the
  // form context resolves.
  prefill?: (ctx: FormContext) => Record<string, unknown>;
  // Return a (new) schema tailored to the current input + context. The
  // default renderer honors `x-hide` / `x-enumLabels`, so this is enough to
  // drive conditional visibility and friendly labels. Hidden fields are
  // stripped from the submitted input by the parent.
  refineSchema?: (
    schema: JsonSchema,
    input: Record<string, unknown>,
    ctx: FormContext,
  ) => JsonSchema;
};

// Tailor log_body_comp's generic form: method-first + conditional inputs.
// The body_fat_method selector drives which measurement fields are relevant
// (see bodyCompFieldVisibility), and hip is sex-gated. Pure schema transform
// — the default <ToolForm> does the rendering.
function refineBodyCompSchema(
  schema: JsonSchema,
  input: Record<string, unknown>,
  ctx: FormContext,
): JsonSchema {
  const props = schema.properties;
  if (!props) return schema;
  const sex = ctx.profile?.sex ?? null;
  const method = input.body_fat_method as BodyFatMethod | undefined;
  // Method-first: when a method is chosen, it drives visibility. When it
  // isn't (e.g. the model passed raw values without a method), infer from the
  // values present so we never hide — and then strip — data the model sent.
  let vis: ReturnType<typeof bodyCompFieldVisibility>;
  if (method) {
    vis = bodyCompFieldVisibility(method, sex);
  } else if (input.body_fat_pct != null) {
    vis = { bodyFatPct: true, waist: false, neck: false, hip: false };
  } else if (input.waist_cm != null || input.neck_cm != null || input.hip_cm != null) {
    vis = bodyCompFieldVisibility("navy", sex);
  } else {
    vis = bodyCompFieldVisibility(null, sex); // nothing yet — pick a method
  }

  const hidden: Record<string, boolean> = {
    body_fat_pct: !vis.bodyFatPct,
    waist_cm: !vis.waist,
    neck_cm: !vis.neck,
    hip_cm: !vis.hip,
  };

  const nextProps: Record<string, JsonSchema> = {};
  for (const [key, sub] of Object.entries(props)) {
    if (key === "body_fat_method" && Array.isArray(sub.enum)) {
      // Friendly labels, parallel to the schema's own enum order.
      nextProps[key] = {
        ...sub,
        "x-enumLabels": sub.enum.map(
          (e) => BODY_FAT_METHOD_LABELS[e as BodyFatMethod] ?? String(e),
        ),
      };
    } else if (key in hidden) {
      nextProps[key] = { ...sub, "x-hide": hidden[key] };
    } else {
      nextProps[key] = sub;
    }
  }
  return { ...schema, properties: nextProps };
}

const OVERRIDES: Record<string, OverrideDef> = {
  // log_meal and update_meal share the same shape (slot + items[]) so they
  // get the same override. update_meal has a few extra fields (new_slot,
  // new_time) the form doesn't surface yet — they fall through to whatever
  // the model proposes initially. Phase 2 polish.
  log_meal: { component: LogMealForm },
  update_meal: { component: LogMealForm },
  // Pantry food facts. add_food (create, requires macros) and update_food
  // (partial patch, name is the identity key) share one macro-entry form.
  add_food: { component: FoodForm },
  update_food: { component: FoodForm },
  // Pantry catalog edits. update_pantry edits a map of items (merge/replace +
  // remove) as collapsible item cards; import_pantry reviews a parsed
  // receipt/CSV batch as a per-row-toggleable table. Both reuse foodControls.
  update_pantry: { component: PantryForm },
  import_pantry: { component: ImportPantryForm },
  // Workout logging + planning. log_workout_session is a session header + per
  // exercise reps×weight×RPE set grids (exercise picker from the bundled
  // catalog). save_workout_plan is collapsible day cards with prescribed
  // exercises + weekday scheduling.
  log_workout_session: { component: LogWorkoutSessionForm },
  save_workout_plan: { component: SaveWorkoutPlanForm },
  // Surgical plan-day edits — opaque ids shown as read-only context, exercise
  // picker + steppers for the editable fields.
  update_workout_plan_day: { component: UpdatePlanDayForm },
  add_exercise_to_plan_day: { component: AddPlanExerciseForm },
  update_plan_exercise: { component: UpdatePlanExerciseForm },
  replace_plan_exercise: { component: ReplacePlanExerciseForm },
  // Diet plan. save_diet_plan is the full rotation editor (days → meals →
  // portions + targets); the granular tools patch one row; log_planned_meal
  // freezes a planned meal into the log. Portions reuse the meal food-picker.
  save_diet_plan: { component: DietPlanForm },
  update_diet_day: { component: UpdateDietDayForm },
  add_diet_meal: { component: AddDietMealForm },
  update_diet_meal: { component: UpdateDietMealForm },
  add_diet_portion: { component: AddDietPortionForm },
  update_diet_portion: { component: UpdateDietPortionForm },
  log_planned_meal: { component: LogPlannedMealForm },
  // Recipe builder. The same RecipeForm card powers this gate and the Recipes
  // tab editor (Recipes.tsx) — name + servings + ingredient rows reusing the
  // shared FoodPicker + live macro math, with a per-serving total footer.
  save_recipe: { component: RecipeForm },
  // Surgical one-ingredient recipe edit (twin of update_diet_portion) — opaque
  // portion_id shown read-only, reusing the shared portion food-picker + macro
  // override + live preview instead of the generic schema form.
  update_recipe_portion: { component: UpdateRecipePortionForm },
  // Star / unstar toggle — no fields to edit, just a read-only confirmation of
  // which recipe (name + id) is being (un)favourited.
  set_recipe_favorite: { component: SetRecipeFavoriteForm },
  // "I ate the chicken rice bowl" — recipe identity read-only (model-chosen),
  // editable slot/time/date + a scale multiplier with a live scaled-totals
  // preview. Pure logging (no same-tool update), so the card goes read-only
  // after save like log_body_comp.
  log_recipe: { component: LogRecipeForm },
  // Daily aggregates with an editable card UI on the dashboard — the gate form
  // reuses those layouts. log_water shows the Hydration ring + quick-add chips
  // (submits an absolute set_ml); log_steps shows the StepProgress bar +
  // count/goal inputs (steps is already an absolute overwrite).
  log_water: { component: LogWaterForm },
  log_steps: { component: LogStepsForm },
  // Feature request filed with the team. Title + details the model pre-fills
  // from the user's ask; the Accept/Decline footer IS the confirmation. No
  // update_* counterpart, so the card goes read-only after save.
  submit_feature_request: { component: FeatureRequestForm },
  // Generic clarifying-question primitive: model proposes question + 2-6
  // button options; user taps one; the choice goes back to the model.
  ask_user: { component: AskUserForm, selfSubmitting: true },
  // Multi-select sibling: model proposes question + 2-8 options; user ticks any
  // number and confirms; the picked values go back to the model as `choices`.
  ask_user_multi: { component: AskUserMultiForm, selfSubmitting: true },
  // Confirmation-only deletes — no fields, just a destructive review of the
  // target (resolved from the input). One shared ConfirmCard skin, bound per
  // tool to its identity fields. The parent footer's Save commits the gate.
  delete_meal: { component: CONFIRM_CARDS.delete_meal },
  delete_body_comp_entry: { component: CONFIRM_CARDS.delete_body_comp_entry },
  delete_workout_plan: { component: CONFIRM_CARDS.delete_workout_plan },
  delete_diet_plan: { component: CONFIRM_CARDS.delete_diet_plan },
  delete_workout_session: { component: CONFIRM_CARDS.delete_workout_session },
  remove_diet_meal: { component: CONFIRM_CARDS.remove_diet_meal },
  remove_diet_portion: { component: CONFIRM_CARDS.remove_diet_portion },
  remove_exercise_from_plan_day: {
    component: CONFIRM_CARDS.remove_exercise_from_plan_day,
  },
  // Body composition: bespoke method-first form with a live Navy BF% preview.
  // Prefill seeds the last weigh-in as a starting weight. refineSchema stays as
  // a submit-time safety net — it strips any body-fat input that doesn't apply
  // to the chosen method even if a stale value lingered in the draft.
  log_body_comp: {
    component: LogBodyCompForm,
    prefill: (ctx) =>
      ctx.lastBodyComp?.weight_kg != null ? { weight_kg: ctx.lastBodyComp.weight_kg } : {},
    refineSchema: refineBodyCompSchema,
  },
  // Editing an existing weigh-in reuses the same method-first form; the
  // model-proposed values (the entry being corrected) win over any prefill.
  update_body_comp_entry: {
    component: LogBodyCompForm,
    refineSchema: refineBodyCompSchema,
  },
  // Bespoke onboarding/edit form: segmented sex, goal cards, activity ladder,
  // unit-suffixed fields, restrictions tag editor. Prefilled from the user's
  // current profile so a single-field edit (e.g. "change my goal") still shows
  // everything else — model-proposed values always win over the prefill.
  update_profile: {
    component: UpdateProfileForm,
    prefill: (ctx) => {
      const p = ctx.profile;
      if (!p) return {};
      const seed: Record<string, unknown> = {};
      if (p.sex) seed.sex = p.sex;
      if (p.birth_year != null) seed.birth_year = p.birth_year;
      if (p.height_cm != null) seed.height_cm = p.height_cm;
      if (p.activity_level) seed.activity_level = p.activity_level;
      if (p.goal) seed.goal = p.goal;
      if (p.target_weight_kg != null) seed.target_weight_kg = p.target_weight_kg;
      if (p.restrictions?.length) seed.restrictions = p.restrictions;
      if (p.notes) seed.notes = p.notes;
      if (p.wrist_cm != null) seed.wrist_cm = p.wrist_cm;
      if (p.ankle_cm != null) seed.ankle_cm = p.ankle_cm;
      if (p.units) seed.units = p.units;
      if (p.gym_machine_ids?.length) seed.gym_machine_ids = p.gym_machine_ids;
      return seed;
    },
  },
};

export function getOverride(toolName: string): OverrideDef | null {
  return OVERRIDES[toolName] ?? null;
}

// Tools where the resubmit-after-edit flow can be honored: the entry-in-flight
// can be UPDATED via the mapped tool. Pure logging tools (log_body_comp,
// log_supplement_taken) have no corresponding update tool, so after save their
// card becomes read-only — a phase-2 follow-up adds update primitives for those.
//
// Self-mapped entries (update_*: update_*) just mean "the same tool is
// idempotent" — resubmitting re-runs it with the new args.
export const UPDATE_TOOL: Record<string, string> = {
  log_meal: "update_meal",
  update_meal: "update_meal",
  update_profile: "update_profile",
  update_food: "update_food",
  add_food: "update_food",
  save_diet_plan: "save_diet_plan",
  update_diet_day: "update_diet_day",
  update_diet_meal: "update_diet_meal",
  update_diet_portion: "update_diet_portion",
  update_pantry: "update_pantry",
  save_recipe: "save_recipe",
  update_recipe_portion: "update_recipe_portion",
  set_recipe_favorite: "set_recipe_favorite",
};

export function getUpdateToolName(toolName: string): string | null {
  return UPDATE_TOOL[toolName] ?? null;
}

// Create-or-replace tools whose resubmit MUST target the entry the first save
// created, not spawn a second one. Their server handler branches on an id
// (recipe_id / plan_id): present → update in place, absent → INSERT a new row.
// A freshly created card's input has no id, so a naive resubmit duplicates.
// After the create resolves, the tool result carries the new row's id; folding
// it back into the card's input flips every later resubmit from create → update
// ("from create turn to edit"). Each entry pulls that id out of the tool result.
//
// NB: this is only for tools whose SAME tool updates by id. Add-only tools
// (add_diet_meal / add_diet_portion) have no same-tool update path — they always
// insert — so they're intentionally absent from UPDATE_TOOL above and go
// read-only after save instead (like log_body_comp).
export const SAVED_IDENTITY: Record<string, (result: unknown) => Record<string, unknown> | null> = {
  save_recipe: (r) => {
    const id = (r as { recipe?: { id?: number } } | null)?.recipe?.id;
    return typeof id === "number" ? { recipe_id: id } : null;
  },
  save_diet_plan: (r) => {
    const id = (r as { plan?: { id?: number } } | null)?.plan?.id;
    return typeof id === "number" ? { plan_id: id } : null;
  },
};

export function getSavedIdentity(
  toolName: string,
  result: unknown,
): Record<string, unknown> | null {
  return SAVED_IDENTITY[toolName]?.(result) ?? null;
}

// The input key that flips a create-or-replace tool from insert to update.
// A saved card may ONLY resubmit once this key is present (supplied by the model
// for an edit, or folded back by getSavedIdentity after a create) — without it
// the resubmit would insert a duplicate, so the card stays read-only instead.
export const REPLACE_ID_KEY: Record<string, string> = {
  save_recipe: "recipe_id",
  save_diet_plan: "plan_id",
};

// --- What is this pending gate about to mutate? -----------------------------
//
// The gate chip's title answers "approve WHAT?" — the single item's name, or a
// batch count ("3 items"). `count` drives which; `name` is null for batches.
export type MutationSummary = { count: number; name: string | null };

// Item objects name themselves under different keys across tools (meal items use
// `food`, pantry/import rows use `name`, exercises `exercise`…). Try them in a
// fixed order and take the first non-empty string.
const ITEM_NAME_KEYS = ["food", "name", "food_name", "title", "exercise", "label"] as const;

function itemDisplayName(it: unknown): string | null {
  if (typeof it === "string") return it.trim() || null;
  if (it == null || typeof it !== "object") return null;
  const o = it as Record<string, unknown>;
  for (const k of ITEM_NAME_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function describeMutation(
  toolName: string,
  input: Record<string, unknown>,
): MutationSummary {
  // update_pantry ships items as a MAP (name → fields) plus an optional
  // `remove` list — each key/removed name is one item being approved.
  if (toolName === "update_pantry") {
    const itemKeys =
      input.items && typeof input.items === "object" && !Array.isArray(input.items)
        ? Object.keys(input.items as object)
        : [];
    const removed = Array.isArray(input.remove)
      ? (input.remove as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    const count = itemKeys.length + removed.length;
    const only = [...itemKeys, ...removed][0] ?? null;
    return { count, name: count === 1 ? only : null };
  }

  // Batch-array tools: log_meal / update_meal / preview_meal / import_pantry
  // list independently-approved rows under `items`; update_meal's patch path
  // uses `update_item` (a single object or an array of them).
  const arr =
    (Array.isArray(input.items) && (input.items as unknown[])) ||
    (Array.isArray(input.update_item) && (input.update_item as unknown[])) ||
    null;
  if (arr) {
    return { count: arr.length, name: arr.length === 1 ? itemDisplayName(arr[0]) : null };
  }
  if (input.update_item && typeof input.update_item === "object") {
    return { count: 1, name: itemDisplayName(input.update_item) };
  }

  // Single-entity tools (save_recipe, save_workout_plan, update_food, the
  // delete_* confirmations…): one named thing, named by a field on the input.
  return { count: 1, name: itemDisplayName(input) };
}

// The primary CTA verb for a pending gate, by tool family: an add reads "Add", a
// delete/remove reads "Delete", everything else commits as "Save". Returns a
// `common.*` i18n key.
export function approveActionKey(toolName: string): string {
  if (/^(delete|remove)_/.test(toolName)) return "common.delete";
  if (/^add_/.test(toolName)) return "common.add";
  return "common.save";
}
