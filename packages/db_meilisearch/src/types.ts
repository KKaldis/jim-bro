// Shape of the self-hosted food reference index.
//
// We replaced the live OpenFoodFacts HTTP API with our own Meilisearch index.
// Every document here is a single food/product, normalized to per-100g macros
// at *import* time (see normalize.ts) so the runtime lookup path stays a dumb,
// fast read — no unit conversion or field guessing happens at request time.
//
// Two sources feed the same index:
//   - "off"  : OpenFoodFacts branded products (carry a barcode)
//   - "usda" : USDA FoodData Central generic foods (no barcode)

import type { Macros } from "@fa/shared";

export type FoodSource = "off" | "usda";

// One indexed food. `id` is the Meilisearch primary key and must be stable
// across re-imports so re-running the importer upserts instead of duplicating:
//   off  → "off:<barcode>"
//   usda → "usda:<fdcId>"
export type FoodDoc = {
  id: string;
  source: FoodSource;
  // Digits-only UPC/EAN/GTIN for OFF products; null for USDA generics.
  barcode: string | null;
  name: string;
  brand: string | null;
  generic_name: string | null;
  // Free-text package size, e.g. "1kg", "500 ml". Display-only.
  quantity: string | null;
  // Free-text serving, e.g. "1 scoop (65 g)". Display-only; the parsed grams
  // live in grams_per_serving.
  serving_size: string | null;
  grams_per_serving: number | null;
  image_url: string | null;
  // Per-100g macros, flattened so Meilisearch can rank/return them cheaply.
  kcal: number;
  p: number;
  f: number;
  c: number;
  fiber: number | null;
};

// The single index name. Kept here so the client and importer can't drift.
export const FOODS_INDEX = "foods";

// The primary key field on FoodDoc. Meilisearch needs this told explicitly
// when the index is created from a document batch.
export const FOODS_PRIMARY_KEY = "id";

// Index settings applied by the importer. Tuned for the lookup shapes the
// agent performs:
//   - barcode lookup → exact filter on `barcode`
//   - product search → typo-tolerant text search over name/brand/generic_name,
//     optionally narrowed by `source` / `brand` / per-100g macro bounds and
//     ordered by a macro.
// NOTE: changing filterable/sortable attributes only takes effect after the
// index re-indexes under them — re-run the importer, or `bun run sync-settings`
// (syncFoodsSettings) against the already-populated index.
export const FOODS_SETTINGS = {
  searchableAttributes: ["name", "brand", "generic_name"],
  // barcode/source/brand → exact filters; kcal/p/f/c/fiber → numeric range
  // filters so the agent can target a macro profile (e.g. high-protein,
  // low-calorie, keto-friendly).
  filterableAttributes: ["barcode", "source", "brand", "kcal", "p", "f", "c", "fiber"],
  // Let the agent rank by a macro (e.g. most protein, fewest calories) instead
  // of pure text relevance.
  sortableAttributes: ["kcal", "p", "f", "c", "fiber"],
  // We keep ranking explicit so the index is reproducible regardless of
  // Meilisearch version defaults. "sort" MUST be present (in its default slot,
  // before "exactness") or search-time `sort` is rejected with invalid_search_sort.
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
};

// Re-derive a Macros object from the flattened per-100g fields on a doc.
export function docMacros(doc: FoodDoc): Macros {
  return {
    kcal: doc.kcal,
    p: doc.p,
    f: doc.f,
    c: doc.c,
    ...(doc.fiber != null ? { fiber: doc.fiber } : {}),
  };
}
