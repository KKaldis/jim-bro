/**
 * Tool definitions — Recipes · named, reusable ingredient bundles.
 */
export const RECIPES_DEFS = [
  {
    name: "list_recipes",
    description:
      "List the user's saved recipes (id, name, slug, servings, ingredient_count, and live kcal_per_serving). Use to answer 'what recipes do I have' or to find the recipe_id/slug before logging, editing, or deleting one. kcal_per_serving resolves live from the pantry, so it shifts if an ingredient's pantry macros change.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "get_recipe",
    description:
      "Read one recipe (a named bundle of ingredients) by recipe_id or name/slug. Returns the ingredient list with each portion's macros LIVE-resolved from the pantry, plus whole-recipe totals and per_serving macros. Ingredients that can't resolve (food missing from pantry / no macros) come back resolved=null and are listed in needs_enrichment. ALWAYS call this before update_recipe_portion / delete_recipe — the portion_id args come from here.",
    schema: {
      type: "object",
      properties: {
        recipe_id: { type: "integer", description: "Which recipe to read." },
        name: { type: "string", description: "Recipe name or slug (alternative to recipe_id)." },
      },
    },
  },
  {
    name: "save_recipe",
    description:
      "Create a NEW recipe, or REPLACE an existing one (a named, reusable bundle of ingredient portions — e.g. 'chicken rice bowl' = 180g chicken + 150g rice + 30g avocado). Omit recipe_id to create; pass recipe_id (from list_recipes) to fully replace that recipe. Ingredients carry {food, grams} only — macros resolve LIVE from the pantry, so DO NOT pass kcal/p/f/c for pantry foods; pass them only as an absolute override for a food that isn't in the pantry (estimated/inline). Set `servings` for a batch-cooked recipe so per-serving macros divide out. To build from a recipe webpage, call import_recipe_url first, then map its ingredients to pantry foods here. Confirm the ingredient list with the user before calling.",
    schema: {
      type: "object",
      properties: {
        recipe_id: {
          type: "integer",
          description: "Replace this existing recipe. Omit to create a new one.",
        },
        name: { type: "string", description: "Display name, e.g. 'Chicken Rice Bowl'. Required." },
        servings: {
          type: "number",
          description: "Batch yield (how many servings the whole recipe makes). Default 1.",
        },
        favorite: {
          type: "boolean",
          description:
            "Star this recipe as a favourite for quick access. Omit to leave the current star unchanged on a replace; defaults to false on create.",
        },
        notes: { type: "string", description: "Optional short free-text notes (tags, tips)." },
        instructions: {
          type: "string",
          description:
            "Optional method / preparation steps (the 'how to make it'). ALWAYS FORMAT AS RICH MARKDOWN — it's rendered, never shown raw. Make it lively and scannable:\n" +
            "• Group the method into its natural components/phases. Put each phase title on its own line in **bold** (e.g. **Caramel cream**, **Assembly**) — do NOT use '#' headings. A single-phase recipe needs no title.\n" +
            "• Under each title, write the steps as a numbered list ('1. …\\n2. …'), one action per step, and **bold** the key action / ingredient / temperature / time in each step.\n" +
            "Example:\n**Caramel cream**\\n1. **Whip** the cream to soft peaks.\\n2. Fold in the **dulce de leche**.\\n\\n**Assembly**\\n1. Layer biscuits, banana, then the cream.\\n2. **Chill 2 h** before serving.\n" +
            "When importing from a URL, convert import_recipe_url's instructions[] into this form.",
        },
        source_url: { type: "string", description: "Origin URL when imported from a recipe page." },
        ingredients: {
          type: "array",
          description: "The ingredient portions.",
          items: {
            type: "object",
            properties: {
              food: { type: "string", description: "Pantry food name (snake_case)." },
              grams: { type: "number" },
              kcal: {
                type: "number",
                description:
                  "OVERRIDE only — absolute for this portion (NOT per-100g). Pass only when the food isn't in the pantry.",
              },
              p: { type: "number" },
              f: { type: "number" },
              c: { type: "number" },
              fiber: { type: "number" },
            },
            required: ["food", "grams"],
          },
        },
      },
      required: ["name", "ingredients"],
    },
  },
  {
    name: "update_recipe_portion",
    description:
      "Edit ONE ingredient of a recipe without rewriting the whole thing — change its grams, swap the food, or set/clear a macro override. Get recipe_id + portion_id from get_recipe first. To change several ingredients in one go, pass an `edits` array (each entry an object with portion_id + the fields to change). Returns the hydrated recipe.",
    schema: {
      type: "object",
      properties: {
        recipe_id: { type: "integer", description: "The recipe being edited." },
        portion_id: { type: "integer", description: "The ingredient row id (from get_recipe)." },
        food: { type: "string", description: "Swap to this pantry food (snake_case)." },
        grams: { type: "number", description: "New grams (> 0)." },
        kcal: { type: "number", description: "Set an absolute macro override (with p/f/c/fiber)." },
        p: { type: "number" },
        f: { type: "number" },
        c: { type: "number" },
        fiber: { type: "number" },
        clear_override: {
          type: "boolean",
          description: "Drop any macro override so the food resolves live from the pantry.",
        },
        edits: {
          type: "array",
          description: "Batch: apply several portion edits in one call.",
          items: { type: "object" },
        },
      },
    },
  },
  {
    name: "delete_recipe",
    description:
      "Delete a saved recipe. Get recipe_id from list_recipes. Does not touch any meals already logged from it.",
    schema: {
      type: "object",
      properties: { recipe_id: { type: "integer" } },
      required: ["recipe_id"],
    },
  },
  {
    name: "set_recipe_favorite",
    description:
      "Star or unstar a recipe as a favourite ('favourite the chicken rice bowl', 'remove it from favourites'). Just flips the favourite flag — leaves the recipe's ingredients and everything else untouched. Identify the recipe by recipe_id (from list_recipes) or name/slug.",
    schema: {
      type: "object",
      properties: {
        recipe_id: { type: "integer", description: "Which recipe to (un)favourite." },
        name: { type: "string", description: "Recipe name or slug (alternative to recipe_id)." },
        favorite: {
          type: "boolean",
          description: "true = star as favourite, false = unstar. Defaults to true.",
        },
      },
    },
  },
  {
    name: "log_recipe",
    description:
      "'I ate the chicken rice bowl' — resolve a recipe's ingredients against the pantry NOW and freeze them into the meal log as one grouped meal (each ingredient a real frozen MealItem tagged with the recipe, so the meal card collapses to one row that expands to the breakdown). Identify the recipe by recipe_id or name/slug. `scale` multiplies every ingredient's grams + macros (0.5 = half, 2 = double). Errors with needs_enrichment if any ingredient can't resolve — fix those foods first instead of logging zeros.",
    schema: {
      type: "object",
      properties: {
        recipe_id: { type: "integer", description: "Which recipe to log." },
        name: { type: "string", description: "Recipe name or slug (alternative to recipe_id)." },
        date: { type: "string", description: "YYYY-MM-DD; defaults to today." },
        slot: {
          type: "string",
          description: "Meal slot to log under (breakfast | lunch | dinner | snack | free text).",
        },
        time: { type: "string", description: "HH:MM, optional." },
        servings: {
          type: "number",
          description:
            "How many SERVINGS the user ate. The recipe makes a fixed number of servings (its `servings` field), so this logs that fraction of the batch — 'a serving/portion of X' → servings: 1. PREFER this whenever the user talks in servings/portions; it saves you computing a fraction and prevents accidentally logging the whole batch.",
        },
        grams: {
          type: "number",
          description:
            "How many GRAMS of the finished recipe the user ate ('300g of the chicken rice bowl'). Logs grams / (sum of ingredient grams) of the batch. Takes precedence over `servings` and `scale` — use it whenever the user gives a weight.",
        },
        scale: {
          type: "number",
          description:
            "Whole-recipe multiplier (default 1 = the ENTIRE batch, ALL servings). 0.5 = half the batch, 2 = two batches. Use `servings` instead when the user ate a number of servings; reserve `scale` for whole-batch multiples.",
        },
      },
    },
  },
  {
    name: "import_recipe_url",
    description:
      "Fetch a recipe webpage and extract its structured recipe — name, servings, the raw ingredient lines, instructions, and per-serving nutrition when the page publishes it (schema.org/Recipe JSON-LD). Use this as the FIRST step of 'add this recipe: <url>'. It does NOT save anything, but it DOES pre-match every ingredient line against the pantry and the food index (`ingredient_matches`), so the next step is add_food for anything missing and then save_recipe with the resolved portions (pass source_url) — no separate lookups. If the page has no structured recipe, falls back to cleaned page text for you to parse.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The recipe page URL (https)." },
      },
      required: ["url"],
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
