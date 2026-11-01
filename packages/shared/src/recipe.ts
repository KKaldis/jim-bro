/**
 * Resolved recipe view — the recipe template + live pantry macros.
 *
 * Mirrors the diet-plan resolver (resolveDietMeal): each ingredient Portion
 * carries its resolved absolute macros (or null = needs enrichment), and the
 * recipe sums the resolvable ones into totals + per-serving macros. This is
 * what get_recipe / save_recipe return and what a recipe card renders.
 */
import type { Macros, Pantry, Recipe, RecipePortion } from "./types.ts";
import { resolvePortion, round1, sumMacros } from "./food.ts";

export type ResolvedRecipePortion = RecipePortion & {
  resolved: Macros | null;
  // True when `resolved` came from an explicit per-portion override rather
  // than the live pantry definition.
  override: boolean;
};

export type ResolvedRecipe = Omit<Recipe, "ingredients"> & {
  ingredients: ResolvedRecipePortion[];
  totals: Macros; // whole recipe (all servings)
  per_serving: Macros; // totals / servings
  unresolved: number; // ingredients whose macros can't resolve
};

function divideMacros(m: Macros, by: number): Macros {
  const d = by > 0 ? by : 1;
  const out: Macros = {
    kcal: round1(m.kcal / d),
    p: round1(m.p / d),
    f: round1(m.f / d),
    c: round1(m.c / d),
  };
  if (m.fiber != null) out.fiber = round1(m.fiber / d);
  return out;
}

// Leading tokens that are amounts or units, not the food ("1.5 cups all-purpose
// flour", "200 γρ. γιαούρτι στραγγιστό", "1 κ.γ. εκχύλισμα βανίλιας"). English
// and Greek, the product languages. Compared lowercased with trailing dots
// stripped, so "γρ." and "γρ" both match.
const AMOUNT_RX = /^[\d.,/½¼¾⅓⅔⅛-]+$/;
const UNIT_TOKENS = new Set([
  "g",
  "gr",
  "gram",
  "grams",
  "kg",
  "mg",
  "ml",
  "l",
  "lt",
  "cl",
  "dl",
  "oz",
  "ounce",
  "ounces",
  "lb",
  "lbs",
  "pound",
  "pounds",
  "cup",
  "cups",
  "tbsp",
  "tablespoon",
  "tablespoons",
  "tsp",
  "teaspoon",
  "teaspoons",
  "pinch",
  "dash",
  "clove",
  "cloves",
  "slice",
  "slices",
  "piece",
  "pieces",
  "can",
  "cans",
  "package",
  "packages",
  "handful",
  "bunch",
  "sprig",
  "sprigs",
  "large",
  "medium",
  "small",
  "γρ",
  "γραμ",
  "γραμμάρια",
  "κιλό",
  "κιλά",
  "λίτρο",
  "λίτρα",
  "κ.σ",
  "κ.γ",
  "κ.τ.γ",
  "κσ",
  "κγ",
  "κουταλιά",
  "κουταλιές",
  "κουταλάκι",
  "κουταλάκια",
  "φλιτζάνι",
  "φλιτζάνια",
  "πρέζα",
  "σκελίδα",
  "σκελίδες",
  "τεμάχιο",
  "τεμάχια",
  "κουτί",
  "κονσέρβα",
  "πακέτο",
  "ματσάκι",
  "χούφτα",
  "μεγάλο",
  "μεγάλα",
  "μέτριο",
  "μέτρια",
  "μικρό",
  "μικρά",
]);
// Joiners that only appear inside a unit phrase ("κουταλιά της σούπας",
// "a pinch of").
const UNIT_FILLERS = new Set(["of", "a", "an", "της", "του", "σούπας", "γλυκού", "από"]);

// Best-guess food name from a free-text recipe ingredient line, for matching
// against the pantry / food index: drops the leading amount + unit, anything
// in parentheses, and trailing preparation notes after a comma or "or".
// Returns "" when nothing food-like is left.
export function ingredientFoodName(line: string): string {
  const head = line
    .replace(/\([^)]*\)/g, " ")
    .split(/,|\s(?:or|ή)\s/i)[0]
    .trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  let i = 0;
  let inUnit = false;
  while (i < tokens.length) {
    const t = tokens[i].toLowerCase().replace(/\.+$/, "");
    // A leading article stands in for the amount ("a pinch of salt").
    if (AMOUNT_RX.test(t) || UNIT_TOKENS.has(t) || (i === 0 && (t === "a" || t === "an"))) {
      inUnit = true;
      i++;
    } else if (inUnit && UNIT_FILLERS.has(t)) {
      i++;
    } else {
      break;
    }
  }
  return tokens.slice(i).join(" ").trim();
}

export function resolveRecipe(recipe: Recipe, pantry: Pantry | null): ResolvedRecipe {
  const ingredients = recipe.ingredients.map((p): ResolvedRecipePortion => ({
    ...p,
    resolved: resolvePortion(pantry, p),
    override: p.macros != null,
  }));
  const totals = sumMacros(
    ingredients.map((i) => i.resolved).filter((m): m is Macros => m != null),
  );
  return {
    ...recipe,
    ingredients,
    totals,
    per_serving: divideMacros(totals, recipe.servings),
    unresolved: ingredients.filter((i) => i.resolved == null).length,
  };
}
