import type { Macros, Pantry } from "./types.ts";

// Weights tuned so a 1-unit miss on each axis contributes comparably to the
// total error. Fiber is in grams like p/f/c, so it shares their weight.
const W = { kcal: 1 / 50, p: 1 / 5, f: 1 / 5, c: 1 / 5, fiber: 1 / 5 } as const;

// Closed-form least-squares: g* = 100 * Σ(w_i·food_i·target_i) / Σ(w_i·food_i²)
// Fiber participates only when both food and target carry it; absent on
// either side and the term drops out (so a legacy fiber-less target still
// scores correctly).
function bestGrams(food: Macros, target: Macros): { grams: number; err: number } {
  const useFiber = food.fiber != null && target.fiber != null;
  const num =
    W.kcal * food.kcal * target.kcal +
    W.p * food.p * target.p +
    W.f * food.f * target.f +
    W.c * food.c * target.c +
    (useFiber ? W.fiber * food.fiber! * target.fiber! : 0);
  const den =
    W.kcal * food.kcal ** 2 +
    W.p * food.p ** 2 +
    W.f * food.f ** 2 +
    W.c * food.c ** 2 +
    (useFiber ? W.fiber * food.fiber! ** 2 : 0);
  if (den === 0) return { grams: 0, err: Infinity };
  const g = Math.max(0, (100 * num) / den);
  let err = (["kcal", "p", "f", "c"] as const).reduce(
    (acc, k) => acc + W[k] * ((food[k] * g) / 100 - target[k]) ** 2,
    0,
  );
  if (useFiber) {
    err += W.fiber * ((food.fiber! * g) / 100 - target.fiber!) ** 2;
  }
  return { grams: Math.round(g), err: Math.round(err * 1000) / 1000 };
}

export type Candidate = {
  name: string;
  grams: number;
  macros: Macros;
  diff: Macros;
  score: number;
};

// Substitution now draws purely from the user's pantry — the only food catalog.
// Only items that carry macros (and have stock on hand, by default) are
// considered. Lower score = closer macro fit.
export type SubstituteOptions = {
  target: Macros;
  pantry?: Pantry | null;
  exclude?: string[];
  topN?: number;
  maxGrams?: number;
  // When true, skip pantry items the user is out of (quantity <= 0).
  inStockOnly?: boolean;
};

export function substituteFood(opts: SubstituteOptions): Candidate[] {
  const { target, pantry, exclude = [], topN = 5, maxGrams = 400, inStockOnly = false } = opts;

  const pantryItems = pantry?.items ?? {};
  const excludeSet = new Set(exclude);
  const scored: Candidate[] = [];

  for (const [name, item] of Object.entries(pantryItems)) {
    if (excludeSet.has(name)) continue;
    if (!item.macros) continue; // can't fit macros we don't know
    if (inStockOnly && item.quantity <= 0) continue;
    const food = item.macros;
    const { grams, err } = bestGrams(food, target);
    if (grams <= 0 || grams > maxGrams) continue;
    // Cap to grams on hand when the item is measured in grams.
    const avail = item.unit === "g" && item.quantity > 0 ? item.quantity : undefined;
    const capped = avail ? Math.min(grams, avail) : grams;
    const macros: Macros = {
      kcal: Math.round(((food.kcal * capped) / 100) * 10) / 10,
      p: Math.round(((food.p * capped) / 100) * 10) / 10,
      f: Math.round(((food.f * capped) / 100) * 10) / 10,
      c: Math.round(((food.c * capped) / 100) * 10) / 10,
    };
    if (food.fiber != null) {
      macros.fiber = Math.round(((food.fiber * capped) / 100) * 10) / 10;
    }
    const diff: Macros = {
      kcal: Math.round((macros.kcal - target.kcal) * 10) / 10,
      p: Math.round((macros.p - target.p) * 10) / 10,
      f: Math.round((macros.f - target.f) * 10) / 10,
      c: Math.round((macros.c - target.c) * 10) / 10,
    };
    if (macros.fiber != null && target.fiber != null) {
      diff.fiber = Math.round((macros.fiber - target.fiber) * 10) / 10;
    }
    scored.push({ name, grams: capped, macros, diff, score: err });
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, topN);
}
