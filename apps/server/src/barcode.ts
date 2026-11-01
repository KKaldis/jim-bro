/**
 * Pure mapping from the agent's food-lookup tool outputs into the unified
 * BarcodeLookupResponse the on-device scanner consumes. Kept out of index.ts
 * (which starts Bun.serve on import) so the cascade logic is unit-testable.
 *
 * The cascade itself lives in handleBarcodeLookup: pantry first (lookup_food),
 * then the self-hosted food index (lookup_product). These helpers translate
 * each tier's raw tool JSON into the canonical shape, or null on a miss.
 */
import type { Macros } from "@fa/shared";
import type { BarcodeLookupResponse } from "@fa/shared/schemas";

export const EMPTY_MACROS: Macros = { kcal: 0, p: 0, f: 0, c: 0 };

// Pantry hit (doLookupFood barcode path) → unified product, but only when the
// item carries macros. A barcode'd pantry item without macros is unusable for
// logging, so we return null and let the food-index tier (which always has
// complete per-100g) win instead.
export function pantryBarcodeHit(
  out: Record<string, unknown>,
  code: string,
): BarcodeLookupResponse | null {
  if (out.found !== true || out.has_macros !== true) return null;
  const num = (k: string): number | undefined =>
    typeof out[k] === "number" ? (out[k] as number) : undefined;
  const fiber = num("fiber");
  const per_100g: Macros = {
    kcal: num("kcal") ?? 0,
    p: num("p") ?? 0,
    f: num("f") ?? 0,
    c: num("c") ?? 0,
    ...(fiber != null ? { fiber } : {}),
  };
  const name = String(out.name ?? "");
  const unit = out.unit === "ml" || out.unit === "pcs" ? out.unit : "g";
  return {
    found: true,
    barcode: code,
    source: "pantry",
    product: {
      name,
      brand: null,
      source: "pantry",
      barcode: code,
      per_100g,
      serving_size: null,
      grams_per_serving: typeof out.grams_per_serving === "number" ? out.grams_per_serving : null,
      image_url: null,
      suggested_snake_name: name,
      in_pantry: true,
      on_hand: typeof out.quantity === "number" ? { quantity: out.quantity, unit } : null,
    },
  };
}

// Food-index hit (doLookupProduct barcode path) → unified product. `product`
// is summarizeFoodDoc's shape: name, brand, source ('off'|'usda'), per_100g, …
export function indexBarcodeHit(
  out: Record<string, unknown>,
  code: string,
): BarcodeLookupResponse | null {
  if (out.found !== true || typeof out.product !== "object" || out.product === null) return null;
  const p = out.product as Record<string, unknown>;
  const source = p.source === "usda" ? "usda" : "off";
  const per_100g =
    typeof p.per_100g === "object" && p.per_100g !== null ? (p.per_100g as Macros) : EMPTY_MACROS;
  return {
    found: true,
    barcode: code,
    source,
    product: {
      name: String(p.name ?? ""),
      brand: typeof p.brand === "string" ? p.brand : null,
      source,
      barcode: code,
      per_100g,
      serving_size: typeof p.serving_size === "string" ? p.serving_size : null,
      grams_per_serving: typeof p.grams_per_serving === "number" ? p.grams_per_serving : null,
      image_url: typeof p.image_url === "string" ? p.image_url : null,
      suggested_snake_name: String(p.suggested_snake_name ?? p.name ?? ""),
      in_pantry: false,
      on_hand: null,
    },
  };
}

// The miss result, shared by the handler when both tiers come up empty.
export function barcodeMiss(code: string): BarcodeLookupResponse {
  return { found: false, barcode: code, source: null, product: null };
}
