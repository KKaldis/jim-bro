/**
 * Tool definitions — Pantry · the food/supplement catalog & inventory.
 */
import { CATEGORY_ENUM_LABELS, FOOD_CATEGORIES } from "@fa/shared";

export const PANTRY_DEFS = [
  {
    name: "add_food",
    description:
      "Add a new food (or supplement) to the user's pantry with per-100 g/ml macros. This is how a food comes to 'exist' for the user — there is no shared database. ALWAYS include fiber if the source provides it (Nutrition Facts label, OpenFoodFacts via lookup_product, USDA, etc.) — fiber drives the daily fiber target. When it came from a barcode (image scan or lookup_product), ALWAYS pass `barcode` so the next scan resolves instantly. Optionally set the starting `quantity` on hand, `unit`, and `to_buy`. Supplements (vitamins, protein powder, creatine…) take `category: 'supplement'`. Confirm values with the user before calling.",
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "snake_case canonical name, e.g. 'chicken_thigh_roasted'",
        },
        kcal: { type: "number" },
        p: { type: "number", description: "protein g per 100 g/ml" },
        f: { type: "number", description: "fat g per 100 g/ml" },
        c: { type: "number", description: "total carbs g per 100 g/ml (includes fiber)" },
        fiber: {
          type: "number",
          description: "fiber g per 100 g/ml — omit only if the source genuinely doesn't expose it",
        },
        category: {
          type: "string",
          enum: [...FOOD_CATEGORIES],
          "x-enumLabels": CATEGORY_ENUM_LABELS,
          description: "One of the predefined food categories.",
        },
        barcode: {
          type: "string",
          description:
            "UPC/EAN/GTIN digits, e.g. '0049000028911'. Pass when adding from a scanned label or OpenFoodFacts product.",
        },
        unit: {
          type: "string",
          enum: ["g", "ml", "pcs"],
          description: "Serving/amount unit. Default 'g'. Macros are per 100 g/ml.",
        },
        grams_per_serving: {
          type: "number",
          description:
            "Weight of one serving/scoop/piece in grams (e.g. a 65 g scoop). Set it whenever the label/lookup_product exposes a serving size — it lets 'one serving' resolve without asking, and is required for unit='pcs' so macros convert.",
        },
        quantity: { type: "number", description: "Optional starting amount on hand, in `unit`." },
        to_buy: { type: "boolean", description: "Mark for restock on the shopping list." },
        force: {
          type: "boolean",
          description:
            "Skip the duplicate check. By default add_food refuses to create an item that closely matches an existing one (returns possible_duplicate); set true only when the user confirms it's genuinely a distinct food.",
        },
      },
      required: ["name", "kcal", "p", "f", "c"],
    },
  },
  {
    name: "update_food",
    description:
      "Partially update an existing pantry item's facts (macros / category / barcode / unit / grams_per_serving). Pass only the fields that change — others are left untouched. Use this to (a) patch in fiber after a label reading, (b) correct a wrong macro value, (c) tag a category, (d) attach a barcode so a scan resolves instantly, or (e) set the serving unit. The item MUST already exist in the pantry (use lookup_food for the canonical name; use add_food to create one). To change only the quantity on hand, use update_pantry. Confirm changes with the user before calling.",
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Canonical snake_case name as stored in the pantry.",
        },
        kcal: { type: "number" },
        p: { type: "number", description: "protein g per 100 g/ml" },
        f: { type: "number", description: "fat g per 100 g/ml" },
        c: { type: "number", description: "total carbs g per 100 g/ml" },
        fiber: {
          type: "number",
          description: "fiber g per 100 g/ml — pass null to clear an existing value",
        },
        category: {
          type: "string",
          enum: [...FOOD_CATEGORIES],
          "x-enumLabels": CATEGORY_ENUM_LABELS,
          description: "One of the predefined food categories.",
        },
        barcode: {
          type: "string",
          description: "UPC/EAN/GTIN digits — pass null to clear, omit to leave unchanged",
        },
        unit: { type: "string", enum: ["g", "ml", "pcs"] },
        grams_per_serving: {
          type: "number",
          description: "Grams per piece (for unit='pcs'); pass null to clear.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_pantry",
    description:
      "Create or update pantry items — the user's single food + supplement catalog. Pass `items` as a map of snake_case name → fields. Each item can carry a quantity on hand (in its `unit`), per-100 g/ml macros, a category (supplements use category 'supplement'), barcode, a `to_buy` restock flag, and (for `pcs` items) `grams_per_serving`. Only the fields you pass are changed on an existing item (merge); pass mode='replace' to rebuild the whole pantry from the listed items. Pass `remove` (a list of names) to delete items. Quantity for unit 'g'/'ml' is the base amount; for 'pcs' it's a count.",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              quantity: {
                type: "number",
                description: "Amount on hand, in `unit` (grams/ml, or a count for pcs).",
              },
              unit: {
                type: "string",
                enum: ["g", "ml", "pcs"],
                description: "Serving/amount unit. Default 'g'.",
              },
              grams_per_serving: {
                type: "number",
                description: "Grams in one piece — set for unit='pcs' so macros can be computed.",
              },
              to_buy: {
                type: "boolean",
                description: "Mark for restock; surfaces on the shopping list.",
              },
              category: {
                type: "string",
                enum: [...FOOD_CATEGORIES],
                "x-enumLabels": CATEGORY_ENUM_LABELS,
              },
              barcode: {
                type: "string",
                description: "UPC/EAN/GTIN digits; pass null to clear.",
              },
              macros: {
                type: "object",
                description: "Per-100 g/ml macros. Pass null to clear.",
                properties: {
                  kcal: { type: "number" },
                  p: { type: "number" },
                  f: { type: "number" },
                  c: { type: "number" },
                  fiber: { type: "number" },
                },
              },
            },
          },
        },
        mode: { type: "string", enum: ["merge", "replace"] },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "names to delete from the pantry",
        },
      },
    },
  },
  {
    name: "import_pantry",
    description:
      "Batch-import a whole shopping trip into the pantry in ONE call — from a receipt photo, a CSV, a pasted list, or a photo of the groceries. Parse every line item FIRST (translate receipt shorthand like 'KS ORG CHK BRST' into a real food name, convert package sizes to metric: 2.5 lb → 1134 g), then call this once with all items — never loop add_food/update_pantry per item. Each item is matched against the existing pantry by barcode (exact) then by name (fuzzy): matches are RESTOCKED (purchased quantity is ADDED to stock by default, and the to_buy flag is cleared); misses are CREATED. New items that carry a barcode get per-100g macros auto-fetched from OpenFoodFacts; anything left without macros comes back in `needs_macros` — offer to resolve those afterwards (lookup_product / web_search, then update_food). The form gate shows the full parsed list for review and editing before anything is written — that IS the confirmation, so don't read the items back in chat first. For a single item, use update_pantry or add_food instead.",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          description: "One entry per purchased line item.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "snake_case canonical name, e.g. 'chicken_breast'. Translate receipt/CSV shorthand into a real food name — never import 'ks_org_chk_brst'.",
              },
              quantity: {
                type: "number",
                description:
                  "Amount purchased, in `unit` (grams/ml, or a count for pcs). Convert package sizes to metric. Omit if unknown — existing stock is left untouched and new items start at 0.",
              },
              unit: {
                type: "string",
                enum: ["g", "ml", "pcs"],
                description: "Default 'g'.",
              },
              barcode: {
                type: "string",
                description:
                  "UPC/EAN/GTIN digits when available (CSV column, visible on packaging). Enables exact matching and automatic macro lookup.",
              },
              kcal: {
                type: "number",
                description:
                  "kcal per 100 g/ml — pass when known (CSV with macros, label visible in the photo).",
              },
              p: { type: "number", description: "protein g per 100 g/ml" },
              f: { type: "number", description: "fat g per 100 g/ml" },
              c: { type: "number", description: "total carbs g per 100 g/ml" },
              fiber: { type: "number", description: "fiber g per 100 g/ml" },
              category: {
                type: "string",
                enum: [...FOOD_CATEGORIES],
                "x-enumLabels": CATEGORY_ENUM_LABELS,
              },
              grams_per_serving: {
                type: "number",
                description: "Grams per piece — set for unit='pcs' so macros convert.",
              },
            },
            required: ["name"],
          },
        },
        quantity_mode: {
          type: "string",
          enum: ["add", "set"],
          description:
            "add (default): purchased quantities are ADDED to existing stock — right for shopping trips. set: stock is OVERWRITTEN with the given quantities — right for a full stocktake ('here's everything I have').",
        },
        lookup_barcodes: {
          type: "boolean",
          description:
            "Auto-fetch per-100g macros from OpenFoodFacts for NEW items that have a barcode but no inline macros. Default true.",
        },
        source: {
          type: "string",
          enum: ["receipt", "csv", "photo", "text"],
          description: "Where the list came from. Informational only.",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "shopping_list",
    description:
      "Generate a shopping list from the diet plan over N days, optionally subtracting pantry. Returns grouped quantities and 'to_buy_only' for the actual buy list.",
    schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "default 7" },
        from_date: { type: "string", description: "YYYY-MM-DD; default today" },
        use_pantry: { type: "boolean", description: "default true" },
      },
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
