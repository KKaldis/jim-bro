/**
 * Tool registry: the full definition list, the progressive-disclosure groups,
 * the mutating (form-gated) and result-card sets, UI categories/labels, and
 * the input preparation applied before a tool runs.
 */
import {
  getExercise,
  MUTATING_TOOL_NAMES,
  resolveExerciseRef,
  RESULT_CARD_TOOL_NAMES,
} from "@fa/shared";

import type { FaToolDef, JsonObject } from "../schema/index.ts";
import { UserStorage } from "../storage.ts";
import { BODY_MATH_DEFS } from "./defs/body-math.ts";
import { BODY_DEFS } from "./defs/body.ts";
import { CORE_DEFS } from "./defs/core.ts";
import { DIETS_DEFS } from "./defs/diets.ts";
import { NUTRITION_DEFS } from "./defs/nutrition.ts";
import { PANTRY_DEFS } from "./defs/pantry.ts";
import { RECIPES_DEFS } from "./defs/recipes.ts";
import { STEPS_DEFS } from "./defs/steps.ts";
import { STRENGTH_DEFS } from "./defs/strength.ts";
import { TRAINING_DEFS } from "./defs/training.ts";
import { FOODREF_LIVE } from "./handlers/shared.ts";

// ---------- tool definitions (canonical Fa schema) ----------

// Anthropic-managed server tools. These execute on Anthropic's side — no
// client-side handler is needed. Results come back inline as
// web_search_tool_result content blocks in the same assistant turn.
// Billing: ~$10 / 1,000 searches at time of writing; max_uses caps cost
// per request. Set WEB_SEARCH_DISABLED=true in env to turn this off.
//
// Types here are loosely typed because SDK v0.40.0 doesn't yet expose
// WebSearchTool20250305 in Anthropic.Tool — agent.ts widens to `any` when
// passing to messages.create().
export const SERVER_TOOLS: ReadonlyArray<Record<string, unknown>> =
  process.env.WEB_SEARCH_DISABLED === "true"
    ? []
    : [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        },
      ];

// Web search for non-Anthropic providers is wired per-provider on the wire.
// Kimi/Moonshot exposes a `$web_search` builtin that the provider runs
// server-side: developer just echoes the tool_call's arguments back as the
// tool_result and Moonshot returns search content in the next iteration.
// See providers/kimi.ts (injection) + the `$`-prefixed echo branch in
// runTool() below (response).

const TOOL_DEFS = [
  ...CORE_DEFS,
  ...BODY_MATH_DEFS,
  ...STRENGTH_DEFS,
  ...NUTRITION_DEFS,
  ...DIETS_DEFS,
  ...RECIPES_DEFS,
  ...PANTRY_DEFS,
  ...BODY_DEFS,
  ...TRAINING_DEFS,
  ...STEPS_DEFS,
] as const;

// The single source of truth for client-tool names. Deriving the union from
// TOOL_DEFS means a typo or a stale entry in any of the name registries below
// (CORE_NAMES, MUTATING_TOOLS, RESULT_CARD_TOOLS, …) is a compile error rather
// than a silent miss that only the module-load guards would catch.
export type ToolName = (typeof TOOL_DEFS)[number]["name"];

// Public, mutable-typed view. TOOL_DEFS is deeply readonly (from `as const`,
// which is what preserves the literal names for ToolName), so cast back to the
// provider-neutral FaToolDef[] every consumer expects.
export const TOOLS: FaToolDef[] = TOOL_DEFS as unknown as FaToolDef[];

// ---------- tool groups (progressive disclosure) ----------
// Each group is a stable subset of TOOLS so each (tools + system) prefix gets
// its own prompt cache. The agent's intent router picks one group per request
// based on keywords in the user's message — see pickToolGroup in agent.ts.
//
// Every group includes CORE, so the system-prompt's "always call this" tools
// (get_todays_macros at session start, update_profile during onboarding, the
// math tools) are available regardless of intent. Routing decides what to add
// ON TOP of CORE, not whether to include it.
//
// Stability matters: subset() filters TOOLS in array order so the resulting
// array is byte-identical across requests for the same group — that's what
// makes each group cacheable.

// Build a name registry from ToolName-checked literals. Every element is
// validated against the union derived from TOOLS, so a typo or stale name is a
// compile error here — but the result is typed ReadonlySet<string> so callers
// can still `.has(arbitraryString)` (membership tests take untyped input).
const toolSet = (names: readonly ToolName[]): ReadonlySet<string> => new Set(names);

const CORE_NAMES = toolSet([
  "ask_user",
  "ask_user_multi",
  "show_screen",
  "get_todays_macros",
  "update_profile",
  // Onboarding pairs update_profile with log_body_comp, and onboarding can
  // start from ANY message (whatever group it routes to) — so both halves of
  // the pair must be in every group. compute_targets also hard-errors
  // without a body-comp entry, and it's core too.
  "log_body_comp",
  // log_meal / log_water are core for SYMMETRY with log_body_comp. If
  // log_body_comp were the only always-present mutating logger, any turn that
  // mis-routes away from `nutrition` (e.g. "add a hypermass serving" with a
  // stray weight keyword in the lookback → `progress`) would show the model a
  // log_body_comp but no log_meal — and it substitutes the wrong logger and
  // loops instead of calling request_tools. Keeping all the common loggers in
  // scope everywhere removes that magnet. (Macro lookup_food still lives in
  // nutrition; log_meal resolves pantry foods by name server-side, so logging
  // works from any group — the model widens to nutrition only when it needs
  // the richer lookup/preview tools.)
  "log_meal",
  "log_water",
  // Read-only hydration status renders the hydration card — core so "how is my
  // hydration / how much water today" works from any routed group, mirroring
  // log_water (and get_todays_macros) being core.
  "get_water_status",
  // The escape hatch for routing misses: lets the model unlock a domain the
  // keyword router didn't predict, instead of substituting a wrong tool.
  // Intercepted by the agent loop (see chat() in agent.ts), never executed
  // by runTool.
  "request_tools",
  // Filing a feature request can come up in any conversation, so keep it in
  // scope regardless of which domain the keyword router picked.
  "submit_feature_request",
  "compute_bmr",
  // Stateless energy / body calculators, core next to compute_bmr and
  // compute_bmi so "how much protein / what deficit / ideal weight" works from
  // any routed group.
  "compute_macro_split",
  "compute_protein_target",
  "compute_calorie_deficit",
  "compute_bmi",
  "compute_ideal_weight",
  "compute_ffmi",
  "estimate_body_fat",
  "compute_lean_body_mass",
  // Reads the user's stored body composition and renders the summary card —
  // core so "what's my body fat / BMI / composition" works from any routed group.
  "get_body_composition",
  "estimate_vo2_max",
  "compute_heart_rate_zones",
  "compute_water_intake",
  "compute_step_calories",
  // log_cardio / delete_cardio_entry pair with estimate_vo2_max so the user can
  // both compute and persist their cardio fitness from any routed group.
  "log_cardio",
  "delete_cardio_entry",
  "update_cardio_entry",
  // Saves the girths compute_ideal_proportions reads back, so it sits next to it.
  "log_measurements",
  "compute_max_potential",
  "compute_ideal_proportions",
  // Plan-vs-proportions verdict. Core next to compute_ideal_proportions: the
  // question mixes training and physique keywords, so it often routes to "all"
  // or progress rather than training.
  "review_training_plan",
  "classify_body_shape",
  // Strength calculators — always in scope so "what's my 1RM / bench strength
  // level / Wilks" works from any routed group, like compute_bmi / vo2max.
  "convert_rpe",
  "plan_warmup_sets",
  "compute_training_volume",
  "compute_one_rep_max",
  "assess_strength_level",
  "compute_powerlifting_score",
  "strength_symmetry",
  "plate_barbell_racking",
  "compute_targets",
  // web_fetch is always in scope so the model can pull a full page after a
  // web search hit. Set WEB_FETCH_DISABLED=true to hide it from the model.
  ...(process.env.WEB_FETCH_DISABLED === "true" ? [] : (["web_fetch"] as const)),
  // Cited evidence retrieval over the self-hosted scientific knowledge base
  // (hybrid search + rerank). Core so any message can ground a claim in sources;
  // gated off with KNOWLEDGE_DISABLED, and auto-off under FOODREF_LIVE (prod),
  // where the backing Qdrant vector DB isn't deployed.
  ...(process.env.KNOWLEDGE_DISABLED === "true" || FOODREF_LIVE
    ? []
    : (["search_knowledge"] as const)),
  // Renders the Sources card for evidence-based answers. Core so the model can
  // attach citations from any routed group (a nutrition, training, or recovery
  // question can each lean on studies) rather than only when `search_knowledge`
  // is in scope.
  "cite",
]);

const NUTRITION_NAMES = toolSet([
  "lookup_food",
  // Branded/generic food reference lookup. On the live path (FOODREF_LIVE) it
  // queries OpenFoodFacts (keyless) + USDA; USDA is skipped when FDC_API_KEY is
  // absent, so the tool stays useful OFF-only without a key.
  "lookup_product",
  "add_food",
  "update_food",
  // log_meal + log_water are in CORE_NAMES (always present, for symmetry with
  // log_body_comp — see the note there). They're implicitly in this group too
  // since every group unions CORE.
  "update_meal",
  "delete_meal",
  "preview_meal",
  "substitute_food",
  // "log lunch as planned" / "what's on my plan today" route as nutrition
  // intent, so the read + freeze pair lives here too (full diet editing is
  // in the pantry group).
  "get_diet_plan",
  "list_diet_plans",
  "activate_diet_plan",
  "log_planned_meal",
  // Recipes — named, reusable ingredient bundles. The whole flow (build from a
  // logged meal or a webpage, list/read, log, edit, delete) is nutrition intent.
  "list_recipes",
  "get_recipe",
  "save_recipe",
  "update_recipe_portion",
  "delete_recipe",
  "set_recipe_favorite",
  "log_recipe",
  "import_recipe_url",
]);

const TRAINING_NAMES = toolSet([
  "estimate_training_kcal",
  "search_exercises",
  "get_workout_plans",
  "activate_workout_plan",
  "save_workout_plan",
  "delete_workout_plan",
  "update_workout_plan_day",
  "add_exercise_to_plan_day",
  "remove_exercise_from_plan_day",
  "update_plan_exercise",
  "replace_plan_exercise",
  "log_workout_session",
  "list_workout_sessions",
  "delete_workout_session",
  "last_sets_for_exercise",
  "get_steps",
  "log_steps",
  "delete_steps",
]);

const PROGRESS_NAMES = toolSet([
  // log_body_comp moved to CORE_NAMES (needed for onboarding from any group).
  "delete_body_comp_entry",
  "update_body_comp_entry",
  "progress_report",
]);

const PANTRY_NAMES = toolSet([
  "update_pantry",
  "import_pantry",
  "shopping_list",
  "get_diet_plan",
  "list_diet_plans",
  "activate_diet_plan",
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
]);

export type ToolGroup = "all" | "nutrition" | "training" | "progress" | "pantry";

// Tools that mutate user data. The agent pauses on these and asks the UI to
// confirm (and optionally edit) the proposed input before executing — see
// the pre-execution gate in agent.ts. Keep in sync with the runTool switch
// statement above: every name here MUST be dispatchable by executeTool.
export const MUTATING_TOOLS: ReadonlySet<string> = toolSet([
  // The canonical data-writing tools live in @fa/shared (MUTATING_TOOL_NAMES) so
  // the web app's gate-form set can't drift from this one. toolSet re-checks
  // every entry against ToolName, so a name there that isn't a real tool is
  // still a compile error here.
  ...MUTATING_TOOL_NAMES,
  // ask_user / ask_user_multi are not actually mutating, but they go through
  // the same gate so the UI can render their option pickers. The handlers echo
  // the user's choice(s) back to the model; nothing is written to storage.
  // They're kept out of the shared list because the web side tracks them
  // separately (writes nothing → shouldn't rehydrate as a saved card).
  "ask_user",
  "ask_user_multi",
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

// Tools whose structured result the chat UI renders as a rich "result card"
// (the calorie ring, macro bars, metric gauges) instead of leaving the agent to
// describe the numbers in prose. When one of these finishes successfully, the
// agent loop attaches the parsed result to the `tool_finished` event (see
// agent.ts) so the client can populate the card live; on history reload the same
// card is rebuilt from the persisted tool_result content. Keep in sync with the
// RESULT_CARDS registry in apps/web/src/cards/registry.tsx.
//
// This is the OUTPUT half of the input-form gate scheme: a mutating tool gets a
// bespoke input form (MUTATING_TOOLS + forms/overrides.tsx); a read/compute tool
// gets a bespoke output card (here + cards/registry.tsx). New tools that return
// user-facing numbers should opt into a card here rather than relying on prose.
// Canonical list lives in @fa/shared (RESULT_CARD_TOOL_NAMES) so the web app's
// card registry (typed Record<ResultCardToolName, …>) can't drift from this set.
// toolSet re-checks every entry against ToolName.
export const RESULT_CARD_TOOLS: ReadonlySet<string> = toolSet([...RESULT_CARD_TOOL_NAMES]);

export function hasResultCard(name: string): boolean {
  return RESULT_CARD_TOOLS.has(name);
}

// Carded tools whose result the model never needs back: `cite` only echoes the
// sources the model itself just passed, so it sees a "card shown" sentinel
// (stops it re-listing them as prose). Every OTHER carded tool shows the model
// its real data under the "don't restate" directive. Hiding the numbers was
// tried for the display cards and backfired: asked a follow-up, the model had
// nothing to go on and invented values (a 82.8 kg weight for a 71.5 kg user).
export const HIDDEN_RESULT_CARD_TOOLS: ReadonlySet<string> = toolSet(["cite"]);

// The model still sees the original JSON (parsed for the UI card) for non-display
// tools, but prefixed with this so it knows the user already has the numbers.
const CARD_RESTATE_DIRECTIVE =
  "[RESULT CARD SHOWN TO USER — the user already SEES every number/row below in a visual card. Do NOT restate, summarize, list, or recap any of it. If the user asked for a judgement or advice that this data feeds (e.g. 'is my plan enough'), you MUST still answer it — interpret, don't recite. Otherwise reply with NOTHING unless a one-line caveat or a required next step needs words. Do not call this tool again with the same input. The JSON below is for your own reasoning and tool-chaining, not to be read back — when a later answer or tool call needs one of its values (weight, targets, sets…), copy it exactly from here, never estimate it.]\n";

// Output the loop feeds back when the model repeats a read/compute call it
// already made this turn (see the duplicate-read guard in agent.ts). Plain text,
// not JSON, so the UI's history reload builds no card for it; the prefix lets
// modelFacingToolResult pass it through without the card directive.
export const DUPLICATE_READ_PREFIX = "[DUPLICATE CALL]";

// Tools whose input carries catalog exercise refs (`exercise_id`, and
// `new_exercise_id` on replace) anywhere in its tree.
const EXERCISE_REF_TOOLS: ReadonlySet<string> = toolSet([
  "save_workout_plan",
  "add_exercise_to_plan_day",
  "update_plan_exercise",
  "replace_plan_exercise",
  "log_workout_session",
  "last_sets_for_exercise",
]);
// Of those, the PLANNING tools respect the user's gym machines when a name is
// resolved. Logging records what was actually done, wherever that was.
const GYM_FILTERED_TOOLS: ReadonlySet<string> = toolSet([
  "save_workout_plan",
  "add_exercise_to_plan_day",
  "update_plan_exercise",
  "replace_plan_exercise",
]);
const EXERCISE_REF_KEYS = new Set(["exercise_id", "new_exercise_id"]);

export type PreparedToolInput =
  { ok: true; input: Record<string, unknown> } | { ok: false; error: Record<string, unknown> };

// Normalize a tool's input BEFORE the confirm gate opens, so the form shows
// what will actually run and an unusable input never reaches the user. Today:
// exercise refs may be plain names ("barbell bench press") — resolved to
// catalog ids here, limited to what the user's gym has (profile
// gym_machine_ids, same rule as search_exercises available_only), which lets
// the agent build a whole plan in one call instead of a search_exercises
// round-trip first. Any ref that doesn't resolve to exactly one exercise fails
// the call (no gate) with candidates to choose from. Every other tool passes
// through untouched.
export async function prepareToolInput(
  name: string,
  input: Record<string, unknown>,
  storage: UserStorage,
): Promise<PreparedToolInput> {
  if (!EXERCISE_REF_TOOLS.has(name)) return { ok: true, input };
  // Only names need the gym list; skip the profile read when every ref is an id.
  const needsGym = /"(?:new_)?exercise_id":"([^"]+)"/g;
  let names = false;
  for (const m of JSON.stringify(input).matchAll(needsGym)) {
    if (!getExercise(m[1])) names = true;
  }
  const gym =
    names && GYM_FILTERED_TOOLS.has(name)
      ? new Set((await storage.loadProfile())?.gym_machine_ids ?? [])
      : new Set();
  const available = gym.size
    ? (e: { machine_id?: string }) => !e.machine_id || gym.has(e.machine_id)
    : undefined;
  const unresolved: Array<{ ref: string; candidates: Array<{ id: string; name: string }> }> = [];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (EXERCISE_REF_KEYS.has(k) && typeof val === "string" && val.trim()) {
        const r = resolveExerciseRef(val, { available });
        if (r.ok) {
          out[k] = r.exercise.id;
        } else {
          unresolved.push({
            ref: val,
            candidates: r.candidates.map((e) => ({ id: e.id, name: e.name })),
          });
          out[k] = val;
        }
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  };
  const resolved = walk(input) as Record<string, unknown>;
  if (unresolved.length) {
    return {
      ok: false,
      error: {
        error: "unresolved_exercises",
        message:
          "These exercise names don't match exactly one catalog exercise, so nothing was shown to the user or saved. Re-send the SAME call with each one replaced by a candidate id (pick the best fit; search_exercises only if none fits). Every other exercise in the call resolved fine.",
        unresolved,
      },
    };
  }
  return { ok: true, input: resolved };
}

// What the MODEL sees as the tool result: for carded tools, the real output
// with a leading "the user already sees this" directive (a bare sentinel for
// HIDDEN_RESULT_CARD_TOOLS); everything else as-is.
export function modelFacingToolResult(name: string, rawOutput: string): string {
  if (rawOutput.startsWith(DUPLICATE_READ_PREFIX)) return rawOutput;
  if (HIDDEN_RESULT_CARD_TOOLS.has(name)) {
    return `{"_card_shown":true,"_note":"Rendered to the user as a visual card. Don't restate it."}`;
  }
  if (RESULT_CARD_TOOLS.has(name)) {
    return CARD_RESTATE_DIRECTIVE + rawOutput;
  }
  return rawOutput;
}

// Look up a tool's JSON-Schema by name. Returns null for unknown tools and
// server tools (which have no client-side schema). Used by the gate to ship
// the schema inline on the tool_proposed event so the UI can render a form.
export function getToolSchema(name: string): JsonObject | null {
  const t = TOOLS.find((x) => x.name === name);
  return t ? t.schema : null;
}

// Dump of every tool's schema, keyed by tool name. Shipped to the frontend
// via GET /tools/schemas so it can rehydrate saved tool_form cards (which need
// the schema to render) after a page reload.
export function toolSchemas(): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = {};
  for (const t of TOOLS) out[t.name] = t.schema;
  return out;
}

function subset(...sets: ReadonlySet<string>[]): FaToolDef[] {
  const union = new Set<string>();
  for (const s of sets) for (const n of s) union.add(n);
  return TOOLS.filter((t) => union.has(t.name));
}

export const TOOL_GROUPS: Record<ToolGroup, FaToolDef[]> = {
  all: TOOLS,
  nutrition: subset(CORE_NAMES, NUTRITION_NAMES),
  training: subset(CORE_NAMES, TRAINING_NAMES),
  progress: subset(CORE_NAMES, PROGRESS_NAMES),
  pantry: subset(CORE_NAMES, PANTRY_NAMES),
};

// Groups the model may unlock via request_tools ("all" is internal-only).
// Keep in sync with the enum in the request_tools input_schema above.
export const REQUESTABLE_GROUPS = ["nutrition", "training", "progress", "pantry"] as const;

// Union of several groups, in stable TOOLS order. Used by the agent loop
// when the model unlocks an extra domain mid-turn via request_tools. The
// combined array is deterministic for a given group set, so later
// iterations in the same turn still share a cacheable prefix.
export function toolsForGroups(groups: Iterable<ToolGroup>): FaToolDef[] {
  const names = new Set<string>();
  for (const g of groups) for (const t of TOOL_GROUPS[g]) names.add(t.name);
  return TOOLS.filter((t) => names.has(t.name));
}

// ---------- tool categories (UI presentation) ----------
// Finer-grained than the routing TOOL_GROUPS above: groups exist to gate which
// tools the model sees, categories exist so the chat UI can show a per-tool
// icon + badge color. Surfaced on the tool_started / tool_proposed /
// tool_finished stream events (see agent.ts) and mirrored client-side for
// history rehydration (apps/web/src/lib/toolCategory.tsx — keep in sync).
export type ToolCategory =
  "body-comp" | "nutrition" | "pantry" | "training" | "progress" | "navigation" | "macros" | "info";

// Presentation metadata for every tool: the gerund `label` the frontend shows
// as a status pill ("computing max potential") and the `category` that drives
// its icon + badge tint. This is the SINGLE source of truth for both — the
// agent loop reads it when emitting tool_started / tool_proposed, so the wire
// already carries the friendly strings and no consumer re-maps tool names.
//
// Every tool in TOOLS / SERVER_TOOLS MUST have an entry here; the assertion
// below this map throws at import time if one is missing, so a newly-added tool
// can never silently render as raw snake_case (which is exactly how
// compute_max_potential and compute_bmi used to leak through).
const TOOL_META: Record<string, { label: string; category: ToolCategory }> = {
  // navigation
  show_screen: { label: "opening a screen", category: "navigation" },
  // body composition + body math
  log_body_comp: { label: "logging weigh-in", category: "body-comp" },
  delete_body_comp_entry: { label: "deleting weigh-in", category: "body-comp" },
  update_body_comp_entry: { label: "updating weigh-in", category: "body-comp" },
  compute_bmi: { label: "computing BMI", category: "body-comp" },
  compute_ffmi: { label: "computing FFMI", category: "body-comp" },
  compute_bmr: { label: "computing BMR", category: "body-comp" },
  compute_macro_split: { label: "splitting macros", category: "body-comp" },
  compute_protein_target: { label: "working out protein", category: "body-comp" },
  compute_calorie_deficit: { label: "planning the deficit", category: "body-comp" },
  compute_ideal_weight: { label: "computing ideal weight", category: "body-comp" },
  estimate_body_fat: { label: "estimating body fat", category: "body-comp" },
  compute_lean_body_mass: { label: "computing lean mass", category: "body-comp" },
  compute_water_intake: { label: "working out water intake", category: "nutrition" },
  get_body_composition: { label: "reading body composition", category: "body-comp" },
  estimate_vo2_max: { label: "estimating VO₂max", category: "training" },
  compute_heart_rate_zones: { label: "computing heart rate zones", category: "training" },
  compute_step_calories: { label: "counting step calories", category: "training" },
  log_cardio: { label: "logging cardio reading", category: "training" },
  delete_cardio_entry: { label: "deleting cardio reading", category: "training" },
  update_cardio_entry: { label: "updating cardio reading", category: "training" },
  log_measurements: { label: "logging measurements", category: "body-comp" },
  compute_max_potential: {
    label: "computing max potential",
    category: "body-comp",
  },
  compute_ideal_proportions: { label: "comparing to ideal proportions", category: "body-comp" },
  review_training_plan: { label: "reviewing your plan", category: "training" },
  classify_body_shape: { label: "classifying body shape", category: "body-comp" },
  // strength calculators
  compute_one_rep_max: { label: "estimating 1-rep max", category: "training" },
  convert_rpe: { label: "converting RPE", category: "training" },
  plan_warmup_sets: { label: "planning warm-up sets", category: "training" },
  compute_training_volume: { label: "adding up volume", category: "training" },
  assess_strength_level: { label: "ranking strength level", category: "training" },
  compute_powerlifting_score: { label: "computing lifting score", category: "training" },
  strength_symmetry: { label: "checking strength balance", category: "training" },
  plate_barbell_racking: { label: "racking the barbell", category: "training" },
  // nutrition: food lookups, meals, diet plan, targets
  lookup_food: { label: "searching your pantry", category: "nutrition" },
  lookup_product: {
    label: "looking up food info",
    category: "nutrition",
  },
  log_meal: { label: "logging meal", category: "nutrition" },
  update_meal: { label: "updating meal", category: "nutrition" },
  delete_meal: { label: "deleting meal", category: "nutrition" },
  preview_meal: { label: "previewing macros", category: "nutrition" },
  substitute_food: { label: "finding substitutions", category: "nutrition" },
  log_water: { label: "logging water", category: "nutrition" },
  get_water_status: { label: "checking hydration", category: "nutrition" },
  compute_targets: { label: "computing targets", category: "nutrition" },
  get_diet_plan: { label: "reading diet plan", category: "nutrition" },
  list_diet_plans: { label: "listing diet plans", category: "nutrition" },
  activate_diet_plan: { label: "activating diet plan", category: "nutrition" },
  save_diet_plan: { label: "saving diet plan", category: "nutrition" },
  delete_diet_plan: { label: "deleting diet plan", category: "nutrition" },
  update_diet_day: { label: "updating diet day", category: "nutrition" },
  add_diet_meal: { label: "adding planned meal", category: "nutrition" },
  update_diet_meal: { label: "updating planned meal", category: "nutrition" },
  remove_diet_meal: { label: "removing planned meal", category: "nutrition" },
  add_diet_portion: { label: "adding planned portion", category: "nutrition" },
  update_diet_portion: {
    label: "updating planned portion",
    category: "nutrition",
  },
  remove_diet_portion: {
    label: "removing planned portion",
    category: "nutrition",
  },
  log_planned_meal: { label: "logging planned meal", category: "nutrition" },
  // recipes — named, reusable ingredient bundles
  list_recipes: { label: "listing recipes", category: "nutrition" },
  get_recipe: { label: "reading recipe", category: "nutrition" },
  save_recipe: { label: "saving recipe", category: "nutrition" },
  update_recipe_portion: { label: "updating recipe ingredient", category: "nutrition" },
  delete_recipe: { label: "deleting recipe", category: "nutrition" },
  set_recipe_favorite: { label: "updating recipe favourite", category: "nutrition" },
  log_recipe: { label: "logging recipe", category: "nutrition" },
  import_recipe_url: { label: "importing recipe", category: "nutrition" },
  // pantry / inventory
  add_food: { label: "adding to pantry", category: "pantry" },
  update_food: { label: "updating pantry item", category: "pantry" },
  update_pantry: { label: "updating pantry", category: "pantry" },
  import_pantry: { label: "importing groceries", category: "pantry" },
  shopping_list: { label: "building shopping list", category: "pantry" },
  // training
  estimate_training_kcal: {
    label: "estimating kcal burned",
    category: "training",
  },
  search_exercises: { label: "searching exercises", category: "training" },
  get_workout_plans: { label: "reading workout plans", category: "training" },
  activate_workout_plan: {
    label: "activating workout plan",
    category: "training",
  },
  save_workout_plan: { label: "saving workout plan", category: "training" },
  delete_workout_plan: { label: "deleting workout plan", category: "training" },
  update_workout_plan_day: {
    label: "updating workout day",
    category: "training",
  },
  add_exercise_to_plan_day: {
    label: "adding exercise to plan",
    category: "training",
  },
  remove_exercise_from_plan_day: {
    label: "removing exercise from plan",
    category: "training",
  },
  update_plan_exercise: {
    label: "updating planned exercise",
    category: "training",
  },
  replace_plan_exercise: {
    label: "replacing planned exercise",
    category: "training",
  },
  log_workout_session: { label: "logging workout", category: "training" },
  list_workout_sessions: { label: "listing workouts", category: "training" },
  delete_workout_session: {
    label: "deleting workout session",
    category: "training",
  },
  last_sets_for_exercise: { label: "checking last sets", category: "training" },
  get_steps: { label: "reading step counts", category: "training" },
  log_steps: { label: "logging steps", category: "training" },
  delete_steps: { label: "deleting steps", category: "training" },
  // progress
  progress_report: { label: "computing progress", category: "progress" },
  // info / meta / read-only context (default)
  ask_user: { label: "asking you a question", category: "info" },
  ask_user_multi: { label: "asking you a question", category: "info" },
  update_profile: { label: "saving profile", category: "info" },
  get_todays_macros: { label: "checking today's macros", category: "macros" },
  request_tools: { label: "unlocking more tools", category: "info" },
  submit_feature_request: { label: "filing a feature request", category: "info" },
  web_search: { label: "searching the web", category: "info" },
  $web_search: { label: "searching the web", category: "info" },
  web_fetch: { label: "fetching a page", category: "info" },
  search_knowledge: { label: "checking the research", category: "info" },
  cite: { label: "citing sources", category: "info" },
};

// Coverage guard: fail loudly at import time if any exposed tool is missing
// presentation metadata. No test runner exists in this repo, so a module-load
// assertion is the earliest deterministic catch — a tool added to TOOLS without
// a TOOL_META entry crashes server startup instead of silently rendering raw.
{
  const missing = [...TOOLS, ...SERVER_TOOLS]
    .map((t) => t.name)
    .filter((name): name is string => typeof name === "string")
    .filter((name) => !(name in TOOL_META));
  if (missing.length > 0) {
    throw new Error(
      `TOOL_META is missing presentation metadata (label + category) for: ${missing.join(
        ", ",
      )}. Add an entry in tools.ts.`,
    );
  }
}

// Category for a tool by name. Unknown tools fall back to "info" so the UI
// always has something to render (the guard above keeps TOOLS itself complete).
export function getToolCategory(name: string): ToolCategory {
  return TOOL_META[name]?.category ?? "info";
}

// Friendly gerund label for a tool name, shown by frontends as a status pill.
// Falls back to the raw name only for tools outside TOOLS (none in practice).
export function getToolLabel(name: string): string {
  return TOOL_META[name]?.label ?? name;
}
