// Pure mappers: raw dump rows → FoodDoc. No I/O, no Meilisearch — just shape
// translation + the subset filter. Kept side-effect-free so they're trivially
// unit-testable (see normalize.test.ts).
//
// The *subset* decision lives here: a row that lacks a usable name or complete
// per-100g macros (kcal + protein + fat + carbs) returns null and is dropped.
// That's what shrinks the ~3.7M-row OpenFoodFacts dump down to the useful core.

import { normalizeBarcode, parseServingGrams, round1 } from "@fa/shared";
import type { FoodDoc } from "./types.ts";

// Physical sanity bounds for per-100g values. A macro is grams measured within
// 100 g, so it can't exceed 100; energy tops out at pure fat ≈ 9 kcal/g × 100 g
// = 900 kcal. Source rows outside these (e.g. USDA Branded entries that report
// per-package amounts — "kcal 90000, p 3400") are mis-scaled, not real foods,
// so we drop them from the subset rather than let them pollute macro-targeted
// search/sort. Exported so the prune script deletes by the SAME bounds.
export const MACRO_BOUNDS = { maxKcal: 900, maxGrams: 100 } as const;

// True when per-100g macros are physically plausible (and non-negative).
export function plausibleMacros(m: {
  kcal: number;
  p: number;
  f: number;
  c: number;
  fiber: number | null;
}): boolean {
  const { maxKcal, maxGrams } = MACRO_BOUNDS;
  if (m.kcal < 0 || m.p < 0 || m.f < 0 || m.c < 0) return false;
  if (m.kcal > maxKcal) return false;
  if (m.p > maxGrams || m.f > maxGrams || m.c > maxGrams) return false;
  if (m.fiber != null && (m.fiber < 0 || m.fiber > maxGrams)) return false;
  return true;
}

// ---- OpenFoodFacts ----------------------------------------------------------

// Subset of OFF nutriments we read. OFF stores per-100g and per-serving
// variants; we only ever use per-100g to match our internal contract.
type OffNutriments = {
  ["energy-kcal_100g"]?: number;
  ["energy_100g"]?: number; // kJ fallback when kcal is missing
  proteins_100g?: number;
  fat_100g?: number;
  carbohydrates_100g?: number;
  fiber_100g?: number;
};

// One line of the OpenFoodFacts JSONL dump (only the fields we care about).
export type OffRow = {
  code?: string;
  product_name?: string;
  brands?: string;
  generic_name?: string;
  quantity?: string;
  serving_size?: string;
  image_url?: string;
  nutriments?: OffNutriments;
};

// Pull per-100g macros out of OFF nutriments, or null if incomplete.
// kcal falls back to converting the kJ field (1 kcal ≈ 4.184 kJ).
function offPer100g(n: OffNutriments) {
  let kcal = n["energy-kcal_100g"];
  if (kcal == null && n["energy_100g"] != null) {
    kcal = n["energy_100g"] / 4.184;
  }
  const p = n.proteins_100g;
  const f = n.fat_100g;
  const c = n.carbohydrates_100g;
  if (kcal == null || p == null || f == null || c == null) return null;
  return {
    kcal: round1(kcal),
    p: round1(p),
    f: round1(f),
    c: round1(c),
    fiber: n.fiber_100g != null ? round1(n.fiber_100g) : null,
  };
}

// Map one OFF JSONL row → FoodDoc, or null to drop it from the subset.
export function offRowToDoc(row: OffRow): FoodDoc | null {
  if (!row) return null;
  const code = row.code ? normalizeBarcode(String(row.code)) : "";
  if (!code) return null; // no barcode → can't key it as an OFF product

  const name = (row.product_name || row.generic_name || "").trim();
  if (!name) return null; // unusable without a name

  const macros = offPer100g(row.nutriments ?? {});
  if (!macros) return null; // incomplete macros → out of subset
  if (!plausibleMacros(macros)) return null; // mis-scaled (per-package etc.) → drop

  const brand = row.brands?.trim() || null;
  return {
    // Meilisearch document ids allow only [A-Za-z0-9_-] — no colon separator.
    id: `off_${code}`,
    source: "off",
    barcode: code,
    name,
    brand,
    generic_name: row.generic_name?.trim() || null,
    quantity: row.quantity?.trim() || null,
    serving_size: row.serving_size?.trim() || null,
    grams_per_serving: parseServingGrams(row.serving_size),
    image_url: row.image_url?.trim() || null,
    ...macros,
  };
}

// ---- USDA FoodData Central --------------------------------------------------

// USDA reports a macro under different nutrient *numbers* depending on the
// dataset/download: Foundation & SR Legacy JSON downloads use the legacy 2xx
// numbers, while the FoodData Central API uses 1xxx ids. Energy is frequently
// present only as Atwater General/Specific factors rather than a direct kcal
// row. So for each macro we accept the FIRST present number in priority order
// (all reported per 100g). Direct kcal beats Atwater-general beats -specific.
const USDA_NUTRIENT: Record<string, string[]> = {
  kcal: ["208", "1008", "957", "2047", "958", "2048"],
  protein: ["203", "1003"],
  fat: ["204", "1004"],
  carbs: ["205", "1005", "205.2", "1050"],
  fiber: ["291", "1079"],
};

// First matching nutrient amount from a priority list, or undefined.
function pickNutrient(n: Record<string, number>, numbers: string[]): number | undefined {
  for (const num of numbers) if (n[num] != null) return n[num];
  return undefined;
}

// One food object from a USDA FoodData Central JSON download (Foundation or
// SR Legacy shape). `foodNutrients[].nutrient.number` + `.amount` per 100g.
export type UsdaFood = {
  fdcId?: number;
  description?: string;
  brandOwner?: string;
  gtinUpc?: string; // present on Branded foods; absent on generics
  servingSize?: number;
  servingSizeUnit?: string;
  foodNutrients?: Array<{
    nutrient?: { number?: string };
    amount?: number;
  }>;
};

// Index USDA nutrient rows by number → amount for O(1) lookup.
function usdaNutrientMap(food: UsdaFood): Record<string, number> {
  const out: Record<string, number> = {};
  for (const fn of food.foodNutrients ?? []) {
    const num = fn.nutrient?.number;
    if (num != null && fn.amount != null) out[num] = fn.amount;
  }
  return out;
}

// Map one USDA food → FoodDoc, or null to drop it from the subset.
export function usdaFoodToDoc(food: UsdaFood): FoodDoc | null {
  if (!food || food.fdcId == null) return null;
  const name = food.description?.trim();
  if (!name) return null;

  const n = usdaNutrientMap(food);
  const kcal = pickNutrient(n, USDA_NUTRIENT.kcal);
  const p = pickNutrient(n, USDA_NUTRIENT.protein);
  const f = pickNutrient(n, USDA_NUTRIENT.fat);
  const c = pickNutrient(n, USDA_NUTRIENT.carbs);
  if (kcal == null || p == null || f == null || c == null) return null;

  const fiber = pickNutrient(n, USDA_NUTRIENT.fiber);
  if (!plausibleMacros({ kcal, p, f, c, fiber: fiber ?? null })) return null; // mis-scaled → drop

  // Only Branded USDA foods carry a barcode; generics (Foundation/SR) don't.
  const barcode = food.gtinUpc ? normalizeBarcode(String(food.gtinUpc)) || null : null;
  const servingSize =
    food.servingSize != null && food.servingSizeUnit
      ? `${food.servingSize} ${food.servingSizeUnit}`
      : null;

  return {
    // Meilisearch document ids allow only [A-Za-z0-9_-] — no colon separator.
    id: `usda_${food.fdcId}`,
    source: "usda",
    barcode,
    name,
    brand: food.brandOwner?.trim() || null,
    generic_name: null,
    quantity: null,
    serving_size: servingSize,
    grams_per_serving: parseServingGrams(servingSize),
    image_url: null,
    kcal: round1(kcal),
    p: round1(p),
    f: round1(f),
    c: round1(c),
    fiber: fiber != null ? round1(fiber) : null,
  };
}
