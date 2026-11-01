/**
 * Tool executor: runs a tool by name against the user's storage.
 */
import { UserStorage } from "../storage.ts";
import {
  doDeleteBodyCompEntry,
  doLogBodyComp,
  doProgressReport,
  doUpdateBodyCompEntry,
} from "./handlers/body.ts";
import {
  doAssessStrengthLevel,
  doClassifyBodyShape,
  doComputeBmi,
  doComputeBmr,
  doComputeCalorieDeficit,
  doComputeFfmi,
  doComputeHeartRateZones,
  doComputeIdealProportions,
  doComputeIdealWeight,
  doComputeLeanBodyMass,
  doComputeMacroSplit,
  doComputeMaxPotential,
  doComputeOneRepMax,
  doComputePowerliftingScore,
  doComputeProteinTarget,
  doComputeStepCalories,
  doComputeTargets,
  doComputeTrainingVolume,
  doComputeWaterIntake,
  doConvertRpe,
  doDeleteCardioEntry,
  doEstimateBodyFat,
  doEstimateVo2Max,
  doGetBodyComposition,
  doLogCardio,
  doLogMeasurements,
  doPlanWarmupSets,
  doPlateBarbellRacking,
  doReviewTrainingPlan,
  doStrengthSymmetry,
  doUpdateCardioEntry,
} from "./handlers/calculators.ts";
import {
  doAskUser,
  doAskUserMulti,
  doShowScreen,
  doSubmitFeatureRequest,
  doUpdateProfile,
  doWebFetch,
  getTodaysMacros,
} from "./handlers/core.ts";
import {
  doActivateDietPlan,
  doAddDietMeal,
  doAddDietPortion,
  doDeleteDietPlan,
  doGetDietPlan,
  doListDietPlans,
  doLogPlannedMeal,
  doRemoveDietMeal,
  doRemoveDietPortion,
  doSaveDietPlan,
  doUpdateDietDay,
  doUpdateDietMeal,
  doUpdateDietPortion,
} from "./handlers/diets.ts";
import {
  doCite,
  doDeleteMeal,
  doGetWaterStatus,
  doLogMeal,
  doLogWater,
  doLookupFood,
  doLookupProduct,
  doPreviewMeal,
  doSearchKnowledge,
  doSubstituteFood,
  doUpdateMeal,
} from "./handlers/nutrition.ts";
import {
  doAddFood,
  doImportPantry,
  doShoppingList,
  doUpdateFood,
  doUpdatePantry,
} from "./handlers/pantry.ts";
import {
  doDeleteRecipe,
  doGetRecipe,
  doImportRecipeUrl,
  doListRecipes,
  doLogRecipe,
  doSaveRecipe,
  doSetRecipeFavorite,
  doUpdateRecipePortion,
} from "./handlers/recipes.ts";
import { doDeleteSteps, doGetSteps, doLogSteps } from "./handlers/steps.ts";
import {
  doActivateWorkoutPlan,
  doAddExerciseToPlanDay,
  doDeleteWorkoutPlan,
  doDeleteWorkoutSession,
  doEstimateTrainingKcal,
  doGetWorkoutPlans,
  doLastSetsForExercise,
  doListWorkoutSessions,
  doLogWorkoutSession,
  doRemoveExerciseFromPlanDay,
  doReplacePlanExercise,
  doSaveWorkoutPlan,
  doSearchExercises,
  doUpdatePlanExercise,
  doUpdateWorkoutPlanDay,
} from "./handlers/training.ts";
import type { ToolName } from "./registry.ts";

// ---------- executor ----------

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  storage: UserStorage,
): Promise<string> {
  try {
    const result = await runTool(name, input, storage);
    return JSON.stringify(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  storage: UserStorage,
): Promise<unknown> {
  // Provider builtin tools (e.g. Kimi's $web_search) are run server-side by
  // the provider. Per Moonshot's contract, the developer just echoes the
  // tool_call's arguments back as the tool_result content and the server
  // returns search results in the next iteration. Any future `$`-prefixed
  // builtin from any OpenAI-compat provider follows the same pattern.
  if (name.startsWith("$")) return input;
  // Cases are grouped to mirror the section order of the TOOLS array above.
  // Narrowing to ToolName makes the switch exhaustive: a tool added to
  // TOOL_DEFS without a case here leaves `toolName` non-`never` in the default
  // branch, which is a compile error (see the assignment there).
  const toolName = name as ToolName;
  switch (toolName) {
    // ----- Core · session, profile & navigation -----
    case "ask_user":
      return doAskUser(input);
    case "ask_user_multi":
      return doAskUserMulti(input);
    case "show_screen":
      return doShowScreen(input);
    case "web_fetch":
      return doWebFetch(input);
    case "get_todays_macros":
      return getTodaysMacros(storage, input);
    case "update_profile":
      return doUpdateProfile(storage, input);
    case "request_tools":
      // Intercepted by the agent loop before execution (it widens the active
      // tool list). Reaching the executor means there is no loop to widen —
      // headless callers already run with the full tool set.
      return {
        error:
          "request_tools only works inside the chat agent loop; all tools are already available here",
      };
    case "submit_feature_request":
      return doSubmitFeatureRequest(storage, input);
    // ----- Body math · stateless calculators -----
    case "compute_bmi":
      return doComputeBmi(input);
    case "compute_ffmi":
      return doComputeFfmi(input);
    case "compute_bmr":
      return doComputeBmr(input);
    case "compute_macro_split":
      return doComputeMacroSplit(input);
    case "compute_protein_target":
      return doComputeProteinTarget(input);
    case "compute_calorie_deficit":
      return doComputeCalorieDeficit(input);
    case "compute_ideal_weight":
      return doComputeIdealWeight(input);
    case "estimate_body_fat":
      return doEstimateBodyFat(input);
    case "compute_lean_body_mass":
      return doComputeLeanBodyMass(input);
    case "compute_water_intake":
      return doComputeWaterIntake(input);
    case "compute_step_calories":
      return doComputeStepCalories(input);
    case "convert_rpe":
      return doConvertRpe(input);
    case "plan_warmup_sets":
      return doPlanWarmupSets(input);
    case "compute_training_volume":
      return doComputeTrainingVolume(input);
    case "get_body_composition":
      return doGetBodyComposition(storage, input);
    case "estimate_vo2_max":
      return doEstimateVo2Max(input);
    case "compute_heart_rate_zones":
      return doComputeHeartRateZones(input);
    case "log_cardio":
      return doLogCardio(storage, input);
    case "delete_cardio_entry":
      return doDeleteCardioEntry(storage, input);
    case "update_cardio_entry":
      return doUpdateCardioEntry(storage, input);
    case "log_measurements":
      return doLogMeasurements(storage, input);
    case "compute_max_potential":
      return doComputeMaxPotential(storage, input);
    case "compute_ideal_proportions":
      return doComputeIdealProportions(storage, input);
    case "review_training_plan":
      return doReviewTrainingPlan(storage, input);
    case "classify_body_shape":
      return doClassifyBodyShape(storage, input);
    case "compute_one_rep_max":
      return doComputeOneRepMax(input);
    case "assess_strength_level":
      return doAssessStrengthLevel(input);
    case "compute_powerlifting_score":
      return doComputePowerliftingScore(input);
    case "strength_symmetry":
      return doStrengthSymmetry(input);
    case "plate_barbell_racking":
      return doPlateBarbellRacking(input);
    case "compute_targets":
      return doComputeTargets(storage, input);
    // ----- Nutrition · food lookup & meal logging -----
    case "lookup_food":
      return doLookupFood(storage, input);
    case "lookup_product":
      return doLookupProduct(input);
    case "search_knowledge":
      return doSearchKnowledge(input);
    case "cite":
      return doCite(input);
    case "log_meal":
      return doLogMeal(storage, input);
    case "update_meal":
      return doUpdateMeal(storage, input);
    case "delete_meal":
      return doDeleteMeal(storage, input);
    case "preview_meal":
      return doPreviewMeal(storage, input);
    case "substitute_food":
      return doSubstituteFood(storage, input);
    case "log_water":
      return doLogWater(storage, input);
    case "get_water_status":
      return doGetWaterStatus(storage, input);
    // ----- Diets · the recurring meal template -----
    case "get_diet_plan":
      return doGetDietPlan(storage, input);
    case "list_diet_plans":
      return doListDietPlans(storage);
    case "activate_diet_plan":
      return doActivateDietPlan(storage, input);
    case "save_diet_plan":
      return doSaveDietPlan(storage, input);
    case "delete_diet_plan":
      return doDeleteDietPlan(storage, input);
    case "update_diet_day":
      return doUpdateDietDay(storage, input);
    case "add_diet_meal":
      return doAddDietMeal(storage, input);
    case "update_diet_meal":
      return doUpdateDietMeal(storage, input);
    case "remove_diet_meal":
      return doRemoveDietMeal(storage, input);
    case "add_diet_portion":
      return doAddDietPortion(storage, input);
    case "update_diet_portion":
      return doUpdateDietPortion(storage, input);
    case "remove_diet_portion":
      return doRemoveDietPortion(storage, input);
    case "log_planned_meal":
      return doLogPlannedMeal(storage, input);
    // ----- Recipes · named, reusable ingredient bundles -----
    case "list_recipes":
      return doListRecipes(storage);
    case "get_recipe":
      return doGetRecipe(storage, input);
    case "save_recipe":
      return doSaveRecipe(storage, input);
    case "update_recipe_portion":
      return doUpdateRecipePortion(storage, input);
    case "delete_recipe":
      return doDeleteRecipe(storage, input);
    case "set_recipe_favorite":
      return doSetRecipeFavorite(storage, input);
    case "log_recipe":
      return doLogRecipe(storage, input);
    case "import_recipe_url":
      return doImportRecipeUrl(storage, input);
    // ----- Pantry · catalog & inventory -----
    case "add_food":
      return doAddFood(storage, input);
    case "update_food":
      return doUpdateFood(storage, input);
    case "update_pantry":
      return doUpdatePantry(storage, input);
    case "import_pantry":
      return doImportPantry(storage, input);
    case "shopping_list":
      return doShoppingList(storage, input);
    // ----- Body composition & progress -----
    case "log_body_comp":
      return doLogBodyComp(storage, input);
    case "update_body_comp_entry":
      return doUpdateBodyCompEntry(storage, input);
    case "delete_body_comp_entry":
      return doDeleteBodyCompEntry(storage, input);
    case "progress_report":
      return doProgressReport(storage, input);
    // ----- Training · exercises, plans & sessions -----
    case "estimate_training_kcal":
      return doEstimateTrainingKcal(storage, input);
    case "search_exercises":
      return doSearchExercises(storage, input);
    case "get_workout_plans":
      return doGetWorkoutPlans(storage, input);
    case "activate_workout_plan":
      return doActivateWorkoutPlan(storage, input);
    case "save_workout_plan":
      return doSaveWorkoutPlan(storage, input);
    case "delete_workout_plan":
      return doDeleteWorkoutPlan(storage, input);
    case "update_workout_plan_day":
      return doUpdateWorkoutPlanDay(storage, input);
    case "add_exercise_to_plan_day":
      return doAddExerciseToPlanDay(storage, input);
    case "remove_exercise_from_plan_day":
      return doRemoveExerciseFromPlanDay(storage, input);
    case "update_plan_exercise":
      return doUpdatePlanExercise(storage, input);
    case "replace_plan_exercise":
      return doReplacePlanExercise(storage, input);
    case "log_workout_session":
      return doLogWorkoutSession(storage, input);
    case "list_workout_sessions":
      return doListWorkoutSessions(storage, input);
    case "delete_workout_session":
      return doDeleteWorkoutSession(storage, input);
    case "last_sets_for_exercise":
      return doLastSetsForExercise(storage, input);
    // ----- Steps · daily pedometer aggregate -----
    case "get_steps":
      return doGetSteps(storage, input);
    case "log_steps":
      return doLogSteps(storage, input);
    case "delete_steps":
      return doDeleteSteps(storage, input);
    default: {
      // Exhaustiveness guard: if `toolName` is anything other than `never`
      // here, a TOOL_DEFS entry is missing a case above — a compile error.
      const _exhaustive: never = toolName;
      throw new Error(`unknown tool: ${String(_exhaustive)}`);
    }
  }
}
