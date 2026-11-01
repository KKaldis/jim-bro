/**
 * Tool definitions — Nutrition · food lookup & meal logging.
 */
export const NUTRITION_DEFS = [
  {
    name: "lookup_food",
    description:
      "Look up a food by NAME, checking the user's pantry (their personal food + supplement catalog) FIRST and, when the pantry has no confident match, ALSO our food index (OpenFoodFacts branded products + USDA generics) — so one call surfaces both sources, pantry first. Pass `name` for a fuzzy match by free text (or `names[]` to resolve many at once). A pantry hit returns that item's per-100 g/ml macros + quantity on hand (log it by name). A miss returns `candidates` (near-match pantry items to confirm) and `products` (food-index matches, each with per-100g macros + a suggested_snake_name) — read one back to the user and `add_food` to put it in the pantry. Pass `barcode` (UPC/EAN/GTIN digits) instead for an exact match against the pantry — use this when you read a barcode off a label image; on a pantry miss fall back to lookup_product with the digits. At least one of name/barcode is required; barcode wins if both are passed. Use this BEFORE logging a meal so macros are correct. For a filtered/branded search (pin a brand, bound macros, restrict to one dataset, or browse), use lookup_product instead.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Food name (free text — fuzzy matched)" },
        names: {
          type: "array",
          items: { type: "string" },
          description:
            "Resolve MULTIPLE foods in ONE call — pass EVERY ingredient name at once when building a recipe or a multi-item meal (e.g. importing a recipe with many ingredients). Strongly preferred over calling lookup_food once per food: a single batched call keeps the agent from exhausting its per-turn step budget on large recipes/workouts. Returns a `results` array with one entry per name, each carrying its own `found`/`candidates`. Use EITHER `names` (batch) OR `name`/`barcode` (single).",
        },
        barcode: {
          type: "string",
          description: "UPC/EAN/GTIN digits, e.g. '0049000028911'. Non-digits are stripped.",
        },
      },
    },
  },
  {
    name: "lookup_product",
    description:
      "Look up a packaged / branded product or generic food against our self-hosted food index (OpenFoodFacts branded products + USDA FoodData Central generics). Use this BEFORE add_food when the user mentions a brand or a barcode and lookup_food returned nothing. " +
      "Pass whatever you have as `query` — the tool routes itself: a string of 8–14 digits (typed or read off a label) is treated as a UPC/EAN/GTIN barcode and resolved by EXACT match; anything else is a typo-tolerant text search over product + brand + generic name (e.g. 'Optimum Nutrition Gold Standard Whey' or 'cheddar cheese'). " +
      "Searches can be narrowed: `source` restricts to one dataset, `brand` pins to one exact brand, the per-100g macro bounds (min_/max_ kcal/protein/carbs/fat/fiber) target a macro profile, and `sort` orders by a macro. Filters work WITH or WITHOUT `query` — omit `query` to browse purely by filter (e.g. high-protein USDA generics, or every product of one brand). (Filters/sort are ignored for a barcode lookup, which is always a single exact hit.) " +
      'Brand note: `brand` is an EXACT, whole-string match (case-insensitive) — "Lagg\'s" matches, "Lagg" does NOT. For partial/uncertain brands, put the brand in `query` instead (text search spans name + brand + generic_name). A good pattern: search by `query` first, read the exact `brand` off a result, then re-query with that `brand` to pull the brand\'s full catalog. ' +
      "Each result carries: name; brand; source ('off' = OpenFoodFacts branded product with a barcode, 'usda' = USDA generic, no barcode); barcode; quantity (package size, display only); serving_size + grams_per_serving (parsed grams in one serving — pass through to add_food so 'one serving' resolves without asking); image_url; suggested_snake_name (a ready pantry key); and per_100g { kcal, p = protein g, f = fat g, c = carbs g, fiber g (when known) }. " +
      "Read back the values to the user and confirm before calling add_food. Prefer this over web_search for foods that are in the index — it's authoritative and structured.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look up. A barcode (8–14 digits, non-digits ignored) → exact match; free text ('brand product' or a generic food) → typo-tolerant search. Optional only when at least one filter (source / macro bound) is set.",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Look up MULTIPLE products in ONE call — pass every item at once when resolving several new ingredients (e.g. importing a recipe whose foods aren't in the pantry yet). Strongly preferred over one lookup_product call per item: a single batched call keeps the agent from exhausting its per-turn step budget on large recipes. Each entry may be a barcode or free text; the narrowing filters (source / brand / macro bounds / sort) apply to every query. Returns a `results` array, one entry per query. Use EITHER `queries` (batch) OR `query` (single).",
        },
        top: {
          type: "integer",
          description:
            "Max results for a text/filter search (ignored for barcode); default 5, max 20.",
        },
        source: {
          type: "string",
          enum: ["off", "usda"],
          description:
            "Restrict to a dataset. 'off' = OpenFoodFacts branded products (carry a barcode + brand). 'usda' = USDA FoodData Central generic foods (no barcode). " +
            "DEFAULT TO 'usda' whenever the user names a raw material, whole food, or unbranded generic — fruits ('banana', 'apple'), vegetables ('raw spinach', 'broccoli'), raw meats/fish ('chicken breast', 'salmon'), grains/legumes ('white rice', 'lentils'), eggs, plain dairy, nuts, etc. These are authoritative and clean in USDA; OpenFoodFacts floods them with noisy branded near-matches. " +
            "Only use 'off' (or omit to search both) when the user names a BRAND or a clearly packaged/processed product ('Optimum Nutrition Whey', 'Oreos', 'Fage 0%'). Omit to search both. " +
            "Fallback: if a 'usda' search returns no results, retry the SAME query with `source` omitted (both datasets) before giving up to web_search — the food may only exist as a branded OFF entry.",
        },
        brand: {
          type: "string",
          description:
            'Pin results to ONE brand by EXACT, whole-string match (case-insensitive), e.g. "Lagg\'s". Partial values don\'t match ("Lagg" ≠ "Lagg\'s") — for fuzzy/uncertain brands put it in `query` instead. Use the `brand` value returned on a prior result to list that brand\'s full catalog (works with or without a `query`).',
        },
        min_protein: {
          type: "number",
          description: "Min protein per 100g (g). e.g. min_protein=20 for high-protein foods.",
        },
        max_protein: { type: "number", description: "Max protein per 100g (g)." },
        min_kcal: { type: "number", description: "Min energy per 100g (kcal)." },
        max_kcal: {
          type: "number",
          description: "Max energy per 100g (kcal). e.g. max_kcal=60 for low-calorie foods.",
        },
        min_carbs: { type: "number", description: "Min carbohydrate per 100g (g)." },
        max_carbs: {
          type: "number",
          description: "Max carbohydrate per 100g (g). e.g. max_carbs=5 for keto-friendly.",
        },
        min_fat: { type: "number", description: "Min fat per 100g (g)." },
        max_fat: { type: "number", description: "Max fat per 100g (g)." },
        min_fiber: {
          type: "number",
          description: "Min fiber per 100g (g). e.g. min_fiber=6 for high-fiber.",
        },
        max_fiber: { type: "number", description: "Max fiber per 100g (g)." },
        sort: {
          type: "string",
          enum: ["relevance", "protein_desc", "kcal_asc", "kcal_desc", "fiber_desc", "carbs_asc"],
          description:
            "Result ordering. Default 'relevance' (text match). e.g. 'protein_desc' = most protein first, 'kcal_asc' = fewest calories first. Pair with a query+filters to rank the matches.",
        },
      },
    },
  },
  {
    name: "search_knowledge",
    description:
      "Retrieve evidence from the self-hosted scientific knowledge base (PubMed abstracts, guidelines, reference texts) to ground an answer in sources. Runs hybrid semantic + keyword search with cross-encoder reranking and returns the most relevant passages, each with its citation (title, journal, year, evidence level, and a URL). USE THIS before making specific scientific claims about training, nutrition, supplements, or recovery — then cite the sources you used (prefer meta-analyses and systematic reviews over single studies). Returns an empty list if nothing relevant is indexed; do not fabricate citations.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The natural-language question to find evidence for, e.g. 'optimal protein per meal for muscle protein synthesis' or 'does creatine improve strength'.",
        },
        top: {
          type: "integer",
          description: "How many passages to return; default 6, max 20.",
        },
        evidence_only: {
          type: "boolean",
          description:
            "When true, restrict results to the strongest study designs (meta-analyses and systematic reviews). Use for high-stakes or contested claims; omit for broad exploration.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "cite",
    description:
      "Attach the sources behind an evidence-based answer so the app can render them as a clean 'Sources' card BELOW your reply — instead of you writing citations inline as prose. Whenever your answer leans on specific studies, meta-analyses, or guidelines (training, nutrition, supplements, recovery, physiology), write the answer WITHOUT inline citations, then call `cite` ONCE at the very end with every source you drew on. Do NOT restate the sources in text — the card shows them. Prefer meta-analyses / systematic reviews and never fabricate a source; only cite what you're confident is real. Skip this for casual chat, logging, or math that isn't grounded in a study.",
    schema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          minItems: 1,
          description: "The sources behind the answer, most authoritative first.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description:
                  "Short human-facing title: the finding or paper name, e.g. 'Protein intake ceiling for lean mass' or the study's topic.",
              },
              authors: {
                type: "string",
                description: "Lead author et al., e.g. 'Morton et al.' — optional.",
              },
              journal: {
                type: "string",
                description:
                  "Journal or publisher, e.g. 'British Journal of Sports Medicine' — optional.",
              },
              year: {
                type: "integer",
                description: "Publication year, e.g. 2018 — optional.",
              },
              url: {
                type: "string",
                description:
                  "Direct link (DOI / PubMed / publisher URL) when you are confident it is correct. Omit rather than guess.",
              },
              finding: {
                type: "string",
                description:
                  "One-sentence takeaway this source supports, e.g. 'No added lean-mass gains beyond ~1.62 g/kg/day.' — optional.",
              },
            },
            required: ["title"],
          },
        },
      },
      required: ["sources"],
    },
  },
  {
    name: "log_meal",
    description:
      "Append a meal to a day's meal log. Call lookup_food for each item first to ensure macros are correct (or pass kcal/p/f/c directly if you have estimated values). After logging, the response includes day totals + remaining vs target.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today if omitted" },
        slot: {
          type: "string",
          description: "breakfast | lunch | dinner | snack (or any free-text slot)",
        },
        time: { type: "string", description: "HH:MM, optional" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              food: {
                type: "string",
                description: "Food name (must exist in your pantry, or pass kcal/p/f/c inline)",
              },
              grams: { type: "number" },
              kcal: { type: "number", description: "Optional override" },
              p: { type: "number" },
              f: { type: "number" },
              c: { type: "number" },
              fiber: { type: "number", description: "Optional fiber g override" },
            },
            required: ["food", "grams"],
          },
        },
      },
      required: ["slot", "items"],
    },
  },
  {
    name: "update_meal",
    description:
      "Modify an already-logged meal in place. Use when the user wants to correct a meal they logged earlier — fix grams ('I had 200g of chicken, not 100'), swap an item, change the slot ('that was dinner, not a snack'), set/change the time, or move it to a different day (`new_date` — 'that was yesterday's lunch', moves it in place rather than delete + re-log). Find the meal by date + slot (+ optional time to disambiguate when multiple meals exist in the same slot). To change ONE item without touching the others (e.g. 'make the kefir 50ml'), use `update_item` — it patches a single line by name and leaves the rest intact. Use `items` ONLY to replace the meal's WHOLE item list at once (same shape as log_meal — DB lookup or inline overrides); it wipes any item you don't restate, so prefer `update_item` for single-line edits. `items` and `update_item` are mutually exclusive. Omit both to rename slot/time without touching macros. Errors if no match. When multiple meals share the slot, disambiguate by passing `time`, or — when using `update_item` — just by naming the item (the meal containing it is selected automatically).",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        slot: { type: "string", description: "slot of the meal to update" },
        time: {
          type: "string",
          description:
            "HH:MM, optional — required only if multiple meals share the slot on this date",
        },
        meal_index: {
          type: "number",
          description:
            "Optional 0-based index into the day's meal list — pinpoints the exact meal regardless of slot/time. Used by the UI's edit dialog, which always knows which meal was tapped; agents rarely need it (prefer time, or just name the item via update_item).",
        },
        new_slot: {
          type: "string",
          description: "Optional — rename the slot (e.g. 'snack' → 'dinner')",
        },
        new_time: {
          type: "string",
          description: "Optional — change/set the time (HH:MM); pass empty string to clear",
        },
        new_date: {
          type: "string",
          description:
            "YYYY-MM-DD — pass ONLY to move the meal to a different day (e.g. 'that was yesterday's lunch'). Moves the meal in place rather than deleting and re-logging. Omit to keep it on `date`.",
        },
        items: {
          type: "array",
          description:
            "Optional — when provided, REPLACES the meal's items entirely. Same shape as log_meal.items. Mutually exclusive with update_item; prefer update_item for a single-line change.",
          items: {
            type: "object",
            properties: {
              food: {
                type: "string",
                description: "Food name (must exist in your pantry, or pass kcal/p/f/c inline)",
              },
              grams: { type: "number" },
              kcal: { type: "number", description: "Optional override" },
              p: { type: "number" },
              f: { type: "number" },
              c: { type: "number" },
              fiber: { type: "number", description: "Optional fiber g override" },
            },
            required: ["food", "grams"],
          },
        },
        update_item: {
          description:
            "Optional — patch existing item(s) in the meal by name, leaving every other item untouched. For ONE change pass a single object ('change the kefir to 50ml'); to change SEVERAL items pass an ARRAY of these objects and apply them in this ONE call — do NOT make a separate update_meal call per item. Match `food` against the items already in the meal (case-insensitive; substring ok if unambiguous). Pass `grams` for a portion change — macros recompute from the pantry for catalog items, or scale proportionally for manual ones. Pass kcal/p/f/c/fiber to override macros directly. Mutually exclusive with `items`.",
          anyOf: [
            {
              type: "object",
              properties: {
                food: { type: "string", description: "Name of the item in this meal to change" },
                grams: {
                  type: "number",
                  description: "New portion in g/ml; macros recompute from it",
                },
                kcal: { type: "number", description: "Optional explicit macro override" },
                p: { type: "number" },
                f: { type: "number" },
                c: { type: "number" },
                fiber: { type: "number", description: "Optional fiber g override" },
              },
              required: ["food"],
            },
            {
              type: "array",
              description: "Several item patches applied in a single update.",
              items: {
                type: "object",
                properties: {
                  food: { type: "string", description: "Name of the item in this meal to change" },
                  grams: {
                    type: "number",
                    description: "New portion in g/ml; macros recompute from it",
                  },
                  kcal: { type: "number", description: "Optional explicit macro override" },
                  p: { type: "number" },
                  f: { type: "number" },
                  c: { type: "number" },
                  fiber: { type: "number", description: "Optional fiber g override" },
                },
                required: ["food"],
              },
            },
          ],
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "delete_meal",
    description:
      "Remove a logged meal from a day. Use when the user says 'I didn't actually eat that' or 'remove the snack I logged'. If multiple meals match the slot, pass time to disambiguate (otherwise all matching are removed). Pass `meal_index` to remove exactly one meal by its position in the day (used by the UI when several meals share a slot).",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        slot: { type: "string" },
        time: {
          type: "string",
          description:
            "HH:MM, optional — required only if there are multiple meals in the same slot",
        },
        meal_index: {
          type: "number",
          description:
            "Optional 0-based index into the day's meal list — removes exactly that one meal, ignoring slot/time. Prevents deleting sibling meals that share an untimed slot.",
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "preview_meal",
    description:
      "Compute total kcal/p/f/c for a list of items WITHOUT logging. Use when the user shares a photo of ingredients they're about to cook, or asks 'what would X + Y + Z be'. Same item shape as log_meal. Returns per-item macros + totals + remaining-vs-target for the day. Defaults to today; pass `date` to preview against another day (the remaining-vs-target is computed against that day's plan target + what's already logged). Confirm with the user before calling log_meal to actually log it.",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              food: {
                type: "string",
                description: "Food name (must exist in your pantry, or pass kcal/p/f/c inline)",
              },
              grams: { type: "number" },
              kcal: { type: "number" },
              p: { type: "number" },
              f: { type: "number" },
              c: { type: "number" },
            },
            required: ["food", "grams"],
          },
        },
        date: {
          type: "string",
          description:
            "Day to preview against (YYYY-MM-DD). Defaults to today; pass the day the user is viewing to compare against that day's remaining macros.",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "substitute_food",
    description:
      "Suggest pantry foods that fit a target macro profile (typically the day's remaining macros, or the macros of a meal item the user wants to swap). Draws from the user's pantry only — the single food catalog. Pass `in_stock_only` to consider only items the user currently has on hand.",
    schema: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            kcal: { type: "number" },
            p: { type: "number" },
            f: { type: "number" },
            c: { type: "number" },
            fiber: { type: "number", description: "include to favor fiber-rich substitutes" },
          },
          required: ["kcal", "p", "f", "c"],
        },
        in_stock_only: {
          type: "boolean",
          description: "Only suggest items with quantity on hand (default false).",
        },
        exclude: { type: "array", items: { type: "string" } },
        top: { type: "integer" },
      },
      required: ["target"],
    },
  },
  {
    name: "log_water",
    description:
      "Log or correct the user's water intake for a day (a single daily total in ml). Use when the user says they drank something ('I had a glass of water', 'drank a 500ml bottle', 'log 2 liters today') or wants to set/adjust the total or their daily goal. Pass `add_ml` to ADD to the day's running total (the usual case — 'I drank 500ml' → add_ml: 500); pass `set_ml` to OVERWRITE it to an absolute amount ('I've had 1.5L so far' → set_ml: 1500). Exactly one of add_ml / set_ml is required unless you're only changing the goal. Convert other units at the boundary (1 glass≈250ml, 1 cup≈240ml, 1 L=1000ml) and state the conversion. `goal_ml` sets the daily target (optional). Returns the new total, goal, and percent of goal.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        add_ml: {
          type: "number",
          description: "Milliliters to ADD to the day's total (use for 'I drank …').",
        },
        set_ml: {
          type: "number",
          description: "Set the day's total to this absolute ml (use for corrections).",
        },
        goal_ml: {
          type: "number",
          description:
            "Optional persistent daily hydration goal in ml — applies to every day (single source of truth, stored on the profile), not just this date. Pass 0 to clear it (revert to the app default). Same target as update_profile's water_goal_ml.",
        },
      },
    },
  },
  {
    name: "get_water_status",
    description:
      "Read the user's water intake for a day WITHOUT changing it — the day's total (ml), the daily goal, and percent/remaining toward it. Use to answer 'how is my hydration', 'how much water have I had today', 'am I hitting my water goal'. Renders the hydration card (water ring + intake/goal/remaining); do NOT restate the numbers in prose. For logging or correcting intake, use log_water instead. Today's total is also in get_todays_macros (water_today) — call this when hydration is the focus of the question so the user sees the dedicated card.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today." },
      },
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
