import { describe, expect, test } from "bun:test";
import { ingredientFoodName } from "./recipe.ts";

describe("ingredientFoodName", () => {
  test.each([
    // Real lines from allrecipes.com
    ["1.5 cups all-purpose flour", "all-purpose flour"],
    ["3.5 teaspoons baking powder", "baking powder"],
    ["0.25 teaspoon salt, or more to taste", "salt"],
    ["3 tablespoons butter, melted", "butter"],
    ["1 egg", "egg"],
    // Real lines from akispetretzikis.com
    ["200 γρ.  γιαούρτι στραγγιστό", "γιαούρτι στραγγιστό"],
    ["1  αυγό", "αυγό"],
    ["1 πρέζα αλάτι", "αλάτι"],
    ["1 κ.γ.  εκχύλισμα βανίλιας", "εκχύλισμα βανίλιας"],
    ["120 γρ.  αλεύρι που φουσκώνει μόνο του", "αλεύρι που φουσκώνει μόνο του"],
    ["σιρόπι σφενδάμου", "σιρόπι σφενδάμου"],
    // Unit phrases, fractions, parentheses
    ["2 κουταλιές της σούπας ελαιόλαδο", "ελαιόλαδο"],
    ["½ cup (120 ml) milk", "milk"],
    ["a pinch of salt", "salt"],
    ["200 g φέτα", "φέτα"],
  ])("%s → %s", (line, want) => {
    expect(ingredientFoodName(line)).toBe(want);
  });

  test("a line that is only an amount yields nothing", () => {
    expect(ingredientFoodName("2 cups")).toBe("");
  });
});
