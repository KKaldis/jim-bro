/**
 * Receipt scanning → pantry (TODO #3).
 *
 * One-off vision pass: hand a grocery-receipt photo to the configured LLM and
 * get back structured line items mapped to pantry entries (snake_case food
 * name + estimated grams). This is read-only — it never writes the pantry.
 * The caller (the web ReceiptScanDialog) shows the items for confirm/edit,
 * then writes via the existing `update_pantry` tool. No agent conversation /
 * history is touched: we make a single, tool-less `streamIteration` call and
 * parse the JSON out of the reply.
 *
 * Why not route this through the chat agent? The chat loop persists history,
 * runs the full tool registry, and streams to the SSE UI — none of which we
 * want for a structured one-shot extraction behind a dedicated UI affordance
 * (mirrors how `lookup_product` powers the add-food dialog via a thin wrapper
 * rather than chat).
 */
import { FOOD_CATEGORIES } from "@fa/shared";
import { logger } from "@fa/logger";

import {
  extractJsonObject,
  humanizeSnake,
  snakeize,
  visionComplete,
  type VisionImageInput,
} from "./vision.ts";

const log = logger.child({ pkg: "agent", fn: "scanReceiptImage" });

// Image as accepted by the Anthropic content-block format (base64 or URL).
// Same shape the chat path already supports (see server buildUserMessage).
export type ReceiptImageInput = VisionImageInput;

// One extracted grocery line, mapped to a pantry entry. `grams_available` is
// the model's best estimate of how much the purchased quantity is in grams —
// the user edits this in the confirm step before it's written.
export type ReceiptItem = {
  // The line as printed on the receipt — shown so the user can sanity-check
  // the mapping ("MILK 2% 2L" → milk_2_percent).
  raw_text: string;
  // snake_case canonical name, suitable as a pantry key.
  food: string;
  // Human-readable label for the UI.
  display_name: string;
  // Estimated grams on hand for the purchased quantity.
  grams_available: number;
  // One of FOOD_CATEGORIES, or null when the model can't tell.
  category: string | null;
  // How sure the model is this is a real, edible grocery item (vs. a
  // non-food line like a bag fee or a quantity it couldn't read).
  confidence: "high" | "medium" | "low";
};

export type ReceiptScanResult = {
  items: ReceiptItem[];
  // Optional free-text note the model surfaces (e.g. "image was blurry").
  note?: string;
};

const SYSTEM = `You extract grocery items from a photo of a store receipt and map each to a pantry entry. You are precise and conservative: you only emit lines you are confident are edible food/drink the user would stock at home.`;

// Built once — the category list is static.
const INSTRUCTION =
  `This image is a grocery receipt. Read every line item and return the edible food & drink items as JSON.\n\n` +
  `For each item, output:\n` +
  `- "raw_text": the line exactly as printed on the receipt.\n` +
  `- "food": a short snake_case canonical name (e.g. "chicken_breast", "whole_milk", "rolled_oats"). Lowercase, words joined by underscores, no brand names unless they are the only identifier.\n` +
  `- "display_name": a clean human-readable name (e.g. "Chicken breast").\n` +
  `- "grams_available": your best estimate of the purchased quantity in GRAMS. Convert from the printed quantity/weight when shown (1 kg = 1000 g, 1 L of a watery drink/milk ≈ 1000 g). If only a unit count is shown (e.g. "2"), estimate a sensible per-unit weight and multiply. When you truly cannot tell, use 0.\n` +
  `- "category": one of ${FOOD_CATEGORIES.join(", ")} — or null if unsure.\n` +
  `- "confidence": "high", "medium", or "low" — how sure you are this is a real edible grocery item correctly read.\n\n` +
  `EXCLUDE non-food lines entirely: totals, subtotals, tax, discounts, loyalty points, bag fees, deposits, household/cleaning/pet items, and anything inedible.\n` +
  `If the image is not a receipt or you can read no items, return an empty "items" array and explain in "note".\n\n` +
  `Respond with ONLY a JSON object, no prose, no markdown fences:\n` +
  `{"items": [ ... ], "note": "<optional short note, omit if nothing to say>"}`;

export async function scanReceiptImage(
  image: ReceiptImageInput,
  billTo?: string,
): Promise<ReceiptScanResult> {
  const start = Date.now();
  // Single tool-less vision pass. 8k tokens covers a long receipt.
  const text = await visionComplete({
    image,
    system: SYSTEM,
    instruction: INSTRUCTION,
    ...(billTo ? { bill: { userId: billTo, source: "receipt_scan" as const } } : {}),
    maxTokens: 8_000,
  });
  const parsed = parseReceiptJson(text);
  log.info("receipt scanned", {
    ms: Date.now() - start,
    items: parsed.items.length,
  });
  return parsed;
}

// Validate/normalize the extracted JSON into receipt items. A model that
// ignores the "no fences" instruction (or adds a stray sentence) still parses
// thanks to the tolerant extractor.
function parseReceiptJson(raw: string): ReceiptScanResult {
  const root = extractJsonObject(raw) as { items?: unknown; note?: unknown };
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items: ReceiptItem[] = [];
  for (const r of rawItems) {
    const item = normalizeItem(r);
    if (item) items.push(item);
  }
  const note = typeof root.note === "string" && root.note.trim() ? root.note.trim() : undefined;
  return { items, ...(note ? { note } : {}) };
}

const CATEGORY_SET = new Set<string>(FOOD_CATEGORIES);
const CONFIDENCE_SET = new Set(["high", "medium", "low"]);

function normalizeItem(r: unknown): ReceiptItem | null {
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;

  // Derive a snake_case key from `food`, falling back to the display name or
  // raw text — we never want to emit an item without a usable pantry key.
  const display =
    typeof o.display_name === "string" && o.display_name.trim()
      ? o.display_name.trim()
      : typeof o.food === "string"
        ? o.food.trim()
        : "";
  const food = snakeize(
    (typeof o.food === "string" && o.food.trim()) ||
      display ||
      (typeof o.raw_text === "string" ? o.raw_text : ""),
  );
  if (!food) return null;

  const gramsRaw = Number(o.grams_available);
  const grams_available = Number.isFinite(gramsRaw) && gramsRaw > 0 ? Math.round(gramsRaw) : 0;

  const category =
    typeof o.category === "string" && CATEGORY_SET.has(o.category) ? o.category : null;

  const confidence =
    typeof o.confidence === "string" && CONFIDENCE_SET.has(o.confidence)
      ? (o.confidence as ReceiptItem["confidence"])
      : "low";

  return {
    raw_text: typeof o.raw_text === "string" ? o.raw_text.trim() : display || food,
    food,
    display_name: display || humanizeSnake(food),
    grams_available,
    category,
    confidence,
  };
}
