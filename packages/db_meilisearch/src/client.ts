// Runtime client for the self-hosted food index.
//
// This is the replacement for the live OpenFoodFacts HTTP calls that used to
// live in packages/agent/src/tools.ts. The agent's lookup_product /
// import_pantry tools now read from our own Meilisearch instance instead of
// reaching out to world.openfoodfacts.org on every request.

import { MeiliSearch, type Index, type SearchParams } from "meilisearch";
import { logger } from "@fa/logger";
import { normalizeBarcode, toPantryKey } from "@fa/shared";
import { FOODS_INDEX, FOODS_SETTINGS, docMacros, type FoodDoc, type FoodSource } from "./types.ts";

const log = logger.child({ mod: "foodref" });

// Lazily-built singleton so importing this module doesn't open a connection.
// Reads config from env: MEILI_URL (default localhost) + MEILI_MASTER_KEY.
let _client: MeiliSearch | null = null;
export function meili(): MeiliSearch {
  if (!_client) {
    const host = process.env.MEILI_URL ?? "http://localhost:7700";
    const apiKey = process.env.MEILI_MASTER_KEY || undefined;
    _client = new MeiliSearch({ host, apiKey });
  }
  return _client;
}

export function foodsIndex(): Index<FoodDoc> {
  return meili().index<FoodDoc>(FOODS_INDEX);
}

// Quote a filter value for Meilisearch and escape embedded quotes.
function quote(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}

// Exact barcode lookup. Returns the single matching product, or null when the
// index doesn't know the code. Mirrors the old offFetchByBarcode contract
// (null on miss) but never throws on a "not found" — only on a transport error.
export async function foodLookupByBarcode(barcode: string): Promise<FoodDoc | null> {
  const norm = normalizeBarcode(barcode);
  if (!norm) return null;
  try {
    const res = await foodsIndex().search("", {
      filter: [`barcode = ${quote(norm)}`],
      limit: 1,
    });
    return (res.hits[0] as FoodDoc) ?? null;
  } catch (err) {
    log.error("barcode lookup failed", err as Error, { barcode: norm });
    throw err;
  }
}

// A per-100g macro bound. Either end is optional; both combine into a range.
export type MacroRange = { min?: number; max?: number };

// Optional narrowing for foodSearch. Every field is ANDed together (and with
// the text query). All macro bounds are per 100g, matching FoodDoc's units.
export type FoodSearchOpts = {
  // Max results, clamped to [1, 20]. Default 5.
  top?: number;
  // Restrict to one data source: "off" (OpenFoodFacts branded) | "usda" (USDA generic).
  source?: FoodSource;
  // Exact brand match (case-insensitive in Meilisearch).
  brand?: string;
  kcal?: MacroRange;
  p?: MacroRange;
  f?: MacroRange;
  c?: MacroRange;
  fiber?: MacroRange;
  // Meilisearch sort expressions, e.g. ["p:desc"], ["kcal:asc"]. Empty → text relevance.
  sort?: string[];
};

// The numeric macro fields that can be range-filtered. Keys line up with both
// FoodSearchOpts and the FoodDoc columns / index filterableAttributes.
const MACRO_FIELDS = ["kcal", "p", "f", "c", "fiber"] as const;

// Turn the structured opts into Meilisearch filter clauses (all ANDed).
function buildFilter(opts: FoodSearchOpts): string[] {
  const filter: string[] = [];
  if (opts.source) filter.push(`source = ${quote(opts.source)}`);
  if (opts.brand) filter.push(`brand = ${quote(opts.brand)}`);
  for (const field of MACRO_FIELDS) {
    const range = opts[field];
    if (!range) continue;
    if (range.min != null) filter.push(`${field} >= ${range.min}`);
    if (range.max != null) filter.push(`${field} <= ${range.max}`);
  }
  return filter;
}

// Typo-tolerant free-text search over name/brand/generic_name, optionally
// narrowed by source/brand/macro bounds and ordered by a macro. Returns up to
// `opts.top` ranked products. A blank query is allowed AS LONG AS at least one
// filter is set (e.g. "high-protein USDA foods" with no name); a blank query
// with no filters → no results.
export async function foodSearch(query: string, opts: FoodSearchOpts = {}): Promise<FoodDoc[]> {
  const q = query.trim();
  const filter = buildFilter(opts);
  if (!q && filter.length === 0) return [];
  const params: SearchParams = { limit: Math.min(20, Math.max(1, opts.top ?? 5)) };
  if (filter.length) params.filter = filter;
  if (opts.sort?.length) params.sort = opts.sort;
  const res = await foodsIndex().search(q, params);
  return res.hits as FoodDoc[];
}

// Apply FOODS_SETTINGS to the live index without re-importing the dump. New
// filterable/sortable attributes only take effect once Meilisearch re-indexes
// under them, so run this after editing FOODS_SETTINGS (the importer applies it
// too, but a full re-import is overkill for a settings-only change). Returns
// the enqueued Meilisearch task.
export async function syncFoodsSettings() {
  return foodsIndex().updateSettings(FOODS_SETTINGS);
}

// Project a FoodDoc into the summary shape the agent tools return. This is the
// exact contract the old summarizeOffProduct produced, so the tool layer, the
// add_food hand-off, and the web form gates are all unchanged.
export function summarizeFoodDoc(doc: FoodDoc) {
  return {
    name: doc.name,
    brand: doc.brand,
    // "off" = OpenFoodFacts branded product, "usda" = USDA generic food.
    source: doc.source,
    barcode: doc.barcode,
    quantity: doc.quantity,
    serving_size: doc.serving_size,
    grams_per_serving: doc.grams_per_serving,
    image_url: doc.image_url,
    suggested_snake_name: snakeFromDoc(doc),
    per_100g: docMacros(doc),
  };
}

// Suggested pantry key: brand + name, or just name.
function snakeFromDoc(doc: FoodDoc): string {
  return toPantryKey(
    [doc.brand, doc.name].filter(Boolean).join(" ") || doc.generic_name || "product",
  );
}
