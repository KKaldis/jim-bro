/**
 * Recipe tools: named, reusable ingredient bundles.
 */
import {
  dayTargetFromPlan,
  dayTotals,
  ingredientFoodName,
  type Macros,
  type Meal,
  type MealLog,
  type Recipe,
  type RecipeWriteInput,
  resolveRecipe,
  round1,
  sumMacros,
  toPantryKey,
} from "@fa/shared";

import { UserStorage } from "../../storage.ts";
import {
  decodeEntities,
  parsePortionInput,
  resolveFoodBothSources,
  runBatchEdits,
  stripHtmlToText,
  todayIso,
} from "./shared.ts";

// ---- recipe extraction (schema.org/Recipe JSON-LD) ----

type ImportedRecipe = {
  name: string;
  servings: number | null;
  ingredients: string[];
  instructions: string[];
  nutrition_per_serving?: Record<string, number>;
};

// Pull the first number out of a schema.org value ("4 servings" → 4,
// "240 kcal" → 240, ["6"] → 6, 6 → 6). Returns null when none is present.
function firstNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const n = firstNumber(x);
      if (n != null) return n;
    }
    return null;
  }
  if (typeof v === "string") {
    const m = v.match(/[\d.]+/);
    if (m) {
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// schema.org `@type` may be a string or array; does it include `wanted`?
function typeIncludes(node: Record<string, unknown>, wanted: string): boolean {
  const t = node["@type"];
  if (typeof t === "string") return t.toLowerCase() === wanted.toLowerCase();
  if (Array.isArray(t)) return t.some((x) => String(x).toLowerCase() === wanted.toLowerCase());
  return false;
}

// Walk an arbitrarily-nested JSON-LD value (object, array, or @graph) and
// return the first node typed Recipe.
function findRecipeNode(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    if (typeIncludes(node, "Recipe")) return node;
    if (node["@graph"]) return findRecipeNode(node["@graph"]);
  }
  return null;
}

// recipeInstructions can be a string, an array of strings, or an array of
// HowToStep / HowToSection objects. Flatten to plain step strings.
function flattenInstructions(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) out.push(t);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      const node = v as Record<string, unknown>;
      if (node.itemListElement) visit(node.itemListElement);
      else if (typeof node.text === "string") visit(node.text);
      else if (typeof node.name === "string") visit(node.name);
    }
  };
  visit(value);
  return out;
}

const NUTRITION_FIELDS: Record<string, string> = {
  calories: "kcal",
  proteinContent: "p",
  fatContent: "f",
  carbohydrateContent: "c",
  fiberContent: "fiber",
};

// Extract a schema.org/Recipe from a page's JSON-LD blocks. Returns null when
// the page has no machine-readable recipe (caller falls back to page text).
// Exported for the recipe-import test.
export function parseRecipeFromHtml(html: string): ImportedRecipe | null {
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  let node: Record<string, unknown> | null = null;
  for (const m of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue; // malformed block — skip, try the next
    }
    node = findRecipeNode(data);
    if (node) break;
  }
  if (!node) return null;

  const name = typeof node.name === "string" ? decodeEntities(node.name.trim()) : "Imported recipe";
  const rawIngredients = node.recipeIngredient ?? node.ingredients;
  const ingredients = Array.isArray(rawIngredients)
    ? rawIngredients
        .map((x) => (typeof x === "string" ? decodeEntities(x.trim()) : ""))
        .filter((s) => s.length > 0)
    : [];
  if (!ingredients.length) return null; // not a usable recipe without ingredients

  const servings = firstNumber(node.recipeYield);
  const instructions = flattenInstructions(node.recipeInstructions).map(decodeEntities);

  let nutrition_per_serving: Record<string, number> | undefined;
  if (node.nutrition && typeof node.nutrition === "object") {
    const n = node.nutrition as Record<string, unknown>;
    const macros: Record<string, number> = {};
    for (const [src, key] of Object.entries(NUTRITION_FIELDS)) {
      const val = firstNumber(n[src]);
      if (val != null) macros[key] = val;
    }
    if (Object.keys(macros).length) nutrition_per_serving = macros;
  }

  return {
    name,
    servings,
    ingredients,
    instructions,
    ...(nutrition_per_serving ? { nutrition_per_serving } : {}),
  };
}

// ===== Recipes · named, reusable ingredient bundles =====

// The hydrated, resolved recipe a recipe tool returns: ingredients with live
// pantry macros, whole-recipe totals + per_serving, and a needs_enrichment
// list for any ingredient that can't resolve. Mirrors dietPlanView.
async function recipeView(storage: UserStorage, recipe: Recipe | null) {
  if (!recipe) {
    return { recipe: null, note: "no such recipe — list_recipes shows current ids" };
  }
  const pantry = await storage.loadPantry();
  const resolved = resolveRecipe(recipe, pantry);
  const needsEnrichment = [
    ...new Set(resolved.ingredients.filter((i) => i.resolved == null).map((i) => i.food)),
  ];
  return {
    recipe: resolved,
    ...(needsEnrichment.length
      ? {
          needs_enrichment: needsEnrichment,
          note: "needs_enrichment foods aren't in the pantry (or lack macros), so the recipe can't fully total or be logged. Offer to add/enrich them (lookup_product / web_search → add_food).",
        }
      : {}),
  };
}

// Resolve which recipe a tool acts on: explicit recipe_id, else name/slug
// (tried verbatim first, then snakeized so "Chicken Rice Bowl" finds the slug).
async function recipeForInput(
  storage: UserStorage,
  input: Record<string, unknown>,
): Promise<Recipe | null> {
  if (input.recipe_id != null) return storage.loadRecipe(Number(input.recipe_id));
  if (input.name != null) {
    const raw = String(input.name).trim();
    if (!raw) return null;
    return (
      (await storage.loadRecipeBySlug(raw)) ?? (await storage.loadRecipeBySlug(toPantryKey(raw)))
    );
  }
  return null;
}

function parseRecipeWrite(input: Record<string, unknown>): RecipeWriteInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name required");
  const rawIngredients = input.ingredients;
  if (!Array.isArray(rawIngredients)) {
    throw new Error("ingredients[] required (at least one ingredient)");
  }
  // Tolerate trailing empty rows from the form UI (blank food / no grams) —
  // skip them rather than erroring, but require at least one real ingredient.
  const ingredients = (rawIngredients as Array<Record<string, unknown>>)
    .filter((raw) => String(raw.food ?? "").trim() && Number(raw.grams) > 0)
    .map(parsePortionInput);
  if (!ingredients.length) {
    throw new Error("at least one ingredient with a food name and grams > 0 is required");
  }
  return {
    name,
    servings: input.servings != null ? Number(input.servings) : null,
    favorite: input.favorite != null ? Boolean(input.favorite) : null,
    notes: input.notes != null ? String(input.notes) : null,
    instructions: input.instructions != null ? String(input.instructions) : null,
    source_url: input.source_url != null ? String(input.source_url) : null,
    ingredients,
  };
}

export async function doListRecipes(storage: UserStorage) {
  const [recipes, pantry] = await Promise.all([storage.listRecipes(), storage.loadPantry()]);
  return {
    recipes: recipes.map((r) => {
      const resolved = resolveRecipe(r, pantry);
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        servings: r.servings,
        ...(r.favorite ? { favorite: true } : {}),
        ingredient_count: r.ingredients.length,
        kcal_per_serving: resolved.per_serving.kcal,
        ...(resolved.unresolved ? { unresolved: resolved.unresolved } : {}),
      };
    }),
  };
}

export async function doGetRecipe(storage: UserStorage, input: Record<string, unknown>) {
  return recipeView(storage, await recipeForInput(storage, input));
}

export async function doSaveRecipe(storage: UserStorage, input: Record<string, unknown>) {
  const write = parseRecipeWrite(input);
  if (input.recipe_id != null) {
    const id = Number(input.recipe_id);
    const recipe = await storage.updateRecipe(id, write);
    if (!recipe) return { error: `recipe ${id} not found — call list_recipes for current ids` };
    return { saved: true, ...(await recipeView(storage, recipe)) };
  }
  const recipe = await storage.createRecipe(write);
  return { saved: true, created: true, ...(await recipeView(storage, recipe)) };
}

export async function doUpdateRecipePortion(
  storage: UserStorage,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Array.isArray(input.edits)) {
    return runBatchEdits(input.edits, (one) => doUpdateRecipePortion(storage, one));
  }
  const portionId = Number(input.portion_id);
  if (!Number.isFinite(portionId)) throw new Error("portion_id required — get it from get_recipe");
  const patch: Parameters<UserStorage["updateRecipePortion"]>[1] = {};
  if (input.food !== undefined) patch.food = String(input.food);
  if (input.grams !== undefined) {
    const grams = Number(input.grams);
    if (!Number.isFinite(grams) || grams <= 0) throw new Error("grams must be > 0");
    patch.grams = grams;
  }
  if (input.clear_override === true) {
    patch.macros = null;
    patch.source = null;
  } else if (input.kcal != null) {
    patch.macros = {
      kcal: Number(input.kcal),
      p: Number(input.p ?? 0),
      f: Number(input.f ?? 0),
      c: Number(input.c ?? 0),
      ...(input.fiber != null ? { fiber: Number(input.fiber) } : {}),
    };
    patch.source = "manual";
  } else if (patch.food !== undefined) {
    // Swapping the food without an explicit override: drop any stale override
    // so the new food resolves live from the pantry.
    patch.macros = null;
    patch.source = null;
  }
  const recipe = await storage.updateRecipePortion(portionId, patch);
  if (!recipe) {
    return { error: `recipe ingredient ${portionId} not found — call get_recipe for current ids` };
  }
  return { updated: true, ...(await recipeView(storage, recipe)) };
}

export async function doDeleteRecipe(storage: UserStorage, input: Record<string, unknown>) {
  const id = Number(input.recipe_id);
  if (!Number.isFinite(id)) throw new Error("recipe_id required — get it from list_recipes");
  const removed = await storage.deleteRecipe(id);
  return { removed };
}

export async function doSetRecipeFavorite(storage: UserStorage, input: Record<string, unknown>) {
  const recipe = await recipeForInput(storage, input);
  if (!recipe) return { error: "no such recipe — call list_recipes for current ids/names" };
  const favorite = input.favorite != null ? Boolean(input.favorite) : true;
  const updated = await storage.setRecipeFavorite(recipe.id, favorite);
  if (!updated) return { error: `recipe ${recipe.id} not found` };
  return { updated: true, favorite, ...(await recipeView(storage, updated)) };
}

function scaleMacros(m: Macros, scale: number): Macros {
  const out: Macros = {
    kcal: round1(m.kcal * scale),
    p: round1(m.p * scale),
    f: round1(m.f * scale),
    c: round1(m.c * scale),
  };
  if (m.fiber != null) out.fiber = round1(m.fiber * scale);
  return out;
}

// "I ate the chicken rice bowl" — resolve the recipe against the pantry NOW,
// scale it, and freeze each ingredient into the meal log as a real MealItem
// tagged with the recipe (so the meal card groups them). Same resolve-then-
// freeze path as log_planned_meal.
export async function doLogRecipe(storage: UserStorage, input: Record<string, unknown>) {
  const recipe = await recipeForInput(storage, input);
  if (!recipe) return { error: "no such recipe — call list_recipes for current ids/names" };
  const date = String(input.date ?? todayIso());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: `date must be YYYY-MM-DD (got: ${JSON.stringify(date)})` };
  }
  const scaleRaw = input.scale != null ? Number(input.scale) : 1;
  let scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1;
  // `servings` is the friendlier knob: how many of the recipe's servings the
  // user ate. The recipe makes `recipe.servings` total, so N servings logs
  // N/servings of the batch. Takes precedence over `scale` — "a serving of X"
  // → servings:1 → the model never computes the fraction (nor logs the whole
  // batch by mistake, the #1 log_recipe error). A recipe with no serving count
  // is treated as 1 serving.
  let servingsEaten: number | null = null;
  if (input.servings != null) {
    const s = Number(input.servings);
    if (Number.isFinite(s) && s > 0) {
      servingsEaten = s;
      const recipeServings =
        typeof recipe.servings === "number" && recipe.servings > 0 ? recipe.servings : 1;
      scale = s / recipeServings;
    }
  }
  // `grams` — the user weighed their plate. The batch weighs the sum of its
  // ingredient grams, so G grams logs G/total of the batch. Takes precedence
  // over both `servings` and `scale`.
  let gramsEaten: number | null = null;
  if (input.grams != null) {
    const g = Number(input.grams);
    const batchGrams = recipe.ingredients.reduce((sum, i) => sum + (i.grams || 0), 0);
    // Reject rather than ignore: falling through would log the whole batch.
    if (!Number.isFinite(g) || g <= 0) return { error: "grams must be a positive number" };
    if (batchGrams <= 0)
      return { error: "recipe has no ingredient weights — log by servings instead" };
    gramsEaten = g;
    servingsEaten = null;
    scale = g / batchGrams;
  }

  const pantry = await storage.loadPantry();
  const resolved = resolveRecipe(recipe, pantry);
  const unresolvable = resolved.ingredients.filter((i) => i.resolved == null);
  if (unresolvable.length) {
    return {
      error:
        "some recipe ingredients can't resolve macros — fix them before logging (never log zeros)",
      needs_enrichment: [...new Set(unresolvable.map((i) => i.food))],
      hint: "add/enrich these foods (lookup_product / web_search → add_food or update_food), then retry",
    };
  }

  const slot = input.slot != null && String(input.slot).trim() ? String(input.slot).trim() : "meal";
  const time = input.time != null && String(input.time).trim() ? String(input.time).trim() : null;
  const tag = { slug: recipe.slug, name: recipe.name, servings: recipe.servings };
  const items: Meal["items"] = resolved.ingredients.map((i) => ({
    food: i.food,
    grams: round1(i.grams * scale),
    ...scaleMacros(i.resolved!, scale),
    source: i.override ? (i.source ?? "manual") : ("db" as const),
    recipe: tag,
  }));
  const log: MealLog = (await storage.loadMealLog(date)) ?? { date, meals: [] };
  const entry: Meal = { slot, items, ...(time ? { time } : {}) };
  log.meals.push(entry);
  await storage.saveMealLog(log);

  const dietPlan = await storage.loadActiveDietPlan();
  const profile = await storage.loadProfile();
  const target = dayTargetFromPlan(dietPlan, date, profile);
  const totals = dayTotals(log, target, date);
  return {
    logged: {
      date,
      slot,
      ...(time ? { time } : {}),
      recipe: recipe.name,
      ...(servingsEaten != null ? { servings_eaten: servingsEaten } : {}),
      ...(gramsEaten != null ? { grams_eaten: gramsEaten } : {}),
      ...(scale !== 1 ? { scale: Math.round(scale * 1000) / 1000 } : {}),
      item_count: items.length,
      macros_added: sumMacros(items),
    },
    day_totals: totals,
  };
}

// Fetch a recipe webpage and extract its structured recipe (schema.org/Recipe
// JSON-LD when present) so the agent can map ingredients → pantry foods and
// call save_recipe. Read-only: it saves nothing. Falls back to cleaned page
// text when the page carries no machine-readable recipe.
// Pre-resolve each imported ingredient line against the pantry + food index
// (the same pantry-first search lookup_food's batch path runs), so the agent
// goes straight from import to add_food / save_recipe instead of spending a
// round-trip on lookups. Lines that strip to the same food name share a search.
async function matchRecipeIngredients(storage: UserStorage, lines: string[]) {
  const pantry = await storage.loadPantry();
  const guesses = lines.map(ingredientFoodName);
  const unique = [...new Set(guesses.filter(Boolean))];
  const resolved = new Map(
    await Promise.all(
      unique.map(async (g) => [g, await resolveFoodBothSources(pantry, g)] as const),
    ),
  );
  return lines.map((line, i) => ({
    line,
    food_guess: guesses[i] || null,
    ...(guesses[i] ? resolved.get(guesses[i]) : { found: false as const, candidates: [] }),
  }));
}

export async function doImportRecipeUrl(
  storage: UserStorage,
  input: Record<string, unknown>,
): Promise<unknown> {
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  if (!rawUrl) return { error: "url is required" };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `invalid url: ${rawUrl}` };
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") return { error: `unsupported protocol: ${url.protocol}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "user-agent": "jim-bro/1.0 import_recipe_url",
        accept: "text/html,application/xhtml+xml,*/*;q=0.5",
      },
      redirect: "follow",
    });
    const ctype = res.headers.get("content-type") ?? "";
    if (!(ctype.includes("text/") || ctype.includes("xml") || ctype.includes("json"))) {
      return { url: res.url, status: res.status, error: `non-text content-type: ${ctype}` };
    }
    const html = await res.text();
    const parsed = parseRecipeFromHtml(html);
    if (parsed) {
      return {
        url: res.url,
        source: "json-ld",
        ...parsed,
        ingredient_matches: await matchRecipeIngredients(storage, parsed.ingredients),
        hint: "`ingredient_matches` already resolves every line against the pantry and the food index (same shape as lookup_food's batch results) — do NOT call lookup_food / lookup_product again for these. found=true → use that pantry food; else confirm a `candidates` entry or add_food from a `products` match (only search again for a line whose food_guess is clearly wrong). Convert each line's amount to grams yourself, then call save_recipe with the {food, grams} portions and source_url. nutrition_per_serving (when present) is a cross-check on your totals, not per-ingredient.",
      };
    }
    const { title, content } = stripHtmlToText(html);
    return {
      url: res.url,
      source: "text",
      title,
      content: content.slice(0, 8000),
      truncated: content.length > 8000,
      note: "No structured schema.org/Recipe found on the page. Parse the ingredient list out of this text yourself, then save_recipe.",
    };
  } catch (err) {
    return { url: url.toString(), error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
