/**
 * Food recognition from an image (powers the Add-food dialog's photo flow).
 *
 * One-off vision pass (see vision.ts): given a photo of a plate, a single
 * food, a packaged product, or a nutrition label, identify the edible item(s)
 * and return per-100g macros plus an estimated portion in grams. The web
 * dialog drops the result into its existing confirm/log step — so the output
 * mirrors what that step needs (snake_case name + per_100g + grams).
 *
 * This is an ESTIMATE for plates/portions; for a clear nutrition label the
 * model should read the printed per-100g values. Either way the user reviews
 * macros + grams before logging.
 */
import { FOOD_CATEGORIES, type Macros } from "@fa/shared";
import { logger } from "@fa/logger";

import {
  extractJsonObject,
  humanizeSnake,
  snakeize,
  visionComplete,
  type VisionImageInput,
} from "./vision.ts";

const log = logger.child({ pkg: "agent", fn: "recognizeFoodImage" });

export type FoodImageInput = VisionImageInput;

// One recognized food, shaped to feed the web confirm step directly.
export type RecognizedFood = {
  // snake_case canonical name (e.g. "grilled_chicken_breast").
  food: string;
  // Human-readable label for the UI.
  display_name: string;
  // Per-100g macros — the model's best estimate, or read from a label.
  // null when it genuinely can't tell (item still selectable but not loggable).
  per_100g: Macros | null;
  // One of FOOD_CATEGORIES, or null.
  category: string | null;
  // Estimated grams of this item visible in the photo (the portion to log).
  // null when not a portion shot (e.g. a bare label) — defaults to 100 in UI.
  estimated_grams: number | null;
  confidence: "high" | "medium" | "low";
};

export type FoodVisionResult = {
  items: RecognizedFood[];
  note?: string;
};

const SYSTEM = `You identify edible food and drink in a photo for a nutrition-tracking app and estimate its macros. You are precise and only report items you can actually see.`;

const INSTRUCTION =
  `Identify the edible food/drink in this image and return it as JSON. The photo may be a plated meal, a single food, a packaged product, or a nutrition-facts label.\n\n` +
  `For each distinct food, output:\n` +
  `- "food": a short snake_case canonical name (e.g. "grilled_chicken_breast", "white_rice", "greek_yogurt"). Lowercase, words joined by underscores.\n` +
  `- "display_name": a clean human-readable name (e.g. "Grilled chicken breast").\n` +
  `- "per_100g": an object {kcal, p, f, c, fiber} of macros PER 100 GRAMS (protein/fat/carbs/fiber in grams). If a nutrition label is visible, read its per-100g values. Otherwise estimate from typical values for that food. Omit "fiber" only if you truly can't estimate it. Use null for the whole object only if you cannot identify the food at all.\n` +
  `- "estimated_grams": your estimate of how many grams of THIS item are shown in the photo (the portion). For a plated portion, estimate the serving size. For a bare label with no food shown, use null.\n` +
  `- "category": one of ${FOOD_CATEGORIES.join(", ")} — or null if unsure.\n` +
  `- "confidence": "high", "medium", or "low".\n\n` +
  `List multiple items only when the photo clearly shows distinct foods (e.g. a plate with chicken + rice + salad). For a single product or label, return one item.\n` +
  `If there is no edible food in the image, return an empty "items" array and explain in "note".\n\n` +
  `Respond with ONLY a JSON object, no prose, no markdown fences:\n` +
  `{"items": [ ... ], "note": "<optional short note, omit if nothing to say>"}`;

export async function recognizeFoodImage(
  image: FoodImageInput,
  billTo?: string,
): Promise<FoodVisionResult> {
  const start = Date.now();
  const text = await visionComplete({
    image,
    system: SYSTEM,
    instruction: INSTRUCTION,
    ...(billTo ? { bill: { userId: billTo, source: "food_scan" as const } } : {}),
    maxTokens: 4_000,
  });
  const root = extractJsonObject(text) as { items?: unknown; note?: unknown };
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items: RecognizedFood[] = [];
  for (const r of rawItems) {
    const item = normalizeItem(r);
    if (item) items.push(item);
  }
  const note = typeof root.note === "string" && root.note.trim() ? root.note.trim() : undefined;
  log.info("food recognized", { ms: Date.now() - start, items: items.length });
  return { items, ...(note ? { note } : {}) };
}

const CATEGORY_SET = new Set<string>(FOOD_CATEGORIES);
const CONFIDENCE_SET = new Set(["high", "medium", "low"]);

function normalizeItem(r: unknown): RecognizedFood | null {
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;

  const display =
    typeof o.display_name === "string" && o.display_name.trim()
      ? o.display_name.trim()
      : typeof o.food === "string"
        ? o.food.trim()
        : "";
  const food = snakeize((typeof o.food === "string" && o.food.trim()) || display);
  if (!food) return null;

  const per_100g = normalizeMacros(o.per_100g);

  const gramsRaw = Number(o.estimated_grams);
  const estimated_grams = Number.isFinite(gramsRaw) && gramsRaw > 0 ? Math.round(gramsRaw) : null;

  const category =
    typeof o.category === "string" && CATEGORY_SET.has(o.category) ? o.category : null;

  const confidence =
    typeof o.confidence === "string" && CONFIDENCE_SET.has(o.confidence)
      ? (o.confidence as RecognizedFood["confidence"])
      : "low";

  return {
    food,
    display_name: display || humanizeSnake(food),
    per_100g,
    category,
    estimated_grams,
    confidence,
  };
}

// Coerce the model's per_100g object into a clean Macros, or null if the core
// fields are missing/invalid. Negatives are clamped to 0; fiber is optional.
function normalizeMacros(v: unknown): Macros | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  };
  const kcal = num(o.kcal);
  const p = num(o.p);
  const f = num(o.f);
  const c = num(o.c);
  if (kcal == null || p == null || f == null || c == null) return null;
  const fiber = num(o.fiber);
  return {
    kcal: Math.round(kcal * 10) / 10,
    p: Math.round(p * 10) / 10,
    f: Math.round(f * 10) / 10,
    c: Math.round(c * 10) / 10,
    ...(fiber != null ? { fiber: Math.round(fiber * 10) / 10 } : {}),
  };
}
