import { describe, expect, test } from "bun:test";
import { barcodeMiss, indexBarcodeHit, pantryBarcodeHit } from "./barcode.ts";

// Sample of the raw JSON each food-lookup tool returns, so the mapping is
// pinned to the real tool contracts (doLookupFood / doLookupProduct).
const CODE = "737628064502";

describe("pantryBarcodeHit", () => {
  test("maps a macro-bearing pantry hit, carrying on-hand quantity", () => {
    // Shape of doLookupFood's barcode hit: { found, matched_by, ...pantryFoodView }
    const out = {
      found: true,
      matched_by: "barcode",
      name: "fage_greek_yoghurt",
      unit: "g",
      quantity: 500,
      to_buy: false,
      grams_per_serving: 170,
      barcode: CODE,
      kcal: 97,
      p: 9,
      f: 5,
      c: 3.6,
      fiber: 0,
      has_macros: true,
    };
    const res = pantryBarcodeHit(out, CODE);
    expect(res).not.toBeNull();
    expect(res!.found).toBe(true);
    expect(res!.source).toBe("pantry");
    expect(res!.product).toMatchObject({
      name: "fage_greek_yoghurt",
      source: "pantry",
      in_pantry: true,
      barcode: CODE,
      grams_per_serving: 170,
      suggested_snake_name: "fage_greek_yoghurt",
      per_100g: { kcal: 97, p: 9, f: 5, c: 3.6, fiber: 0 },
      on_hand: { quantity: 500, unit: "g" },
    });
  });

  test("omits fiber when the pantry item didn't carry it", () => {
    const res = pantryBarcodeHit(
      {
        found: true,
        name: "x",
        unit: "g",
        quantity: 1,
        kcal: 1,
        p: 1,
        f: 1,
        c: 1,
        has_macros: true,
      },
      CODE,
    );
    expect(res!.product!.per_100g).not.toHaveProperty("fiber");
  });

  test("returns null for a pantry item without macros (food-index tier should win)", () => {
    const out = { found: true, name: "mystery", unit: "g", quantity: 1, has_macros: false };
    expect(pantryBarcodeHit(out, CODE)).toBeNull();
  });

  test("returns null on a pantry miss", () => {
    expect(pantryBarcodeHit({ found: false, query: { barcode: CODE } }, CODE)).toBeNull();
  });
});

describe("indexBarcodeHit", () => {
  test("maps an OpenFoodFacts (off) hit", () => {
    // Shape of doLookupProduct's barcode hit: { found, source, barcode, product: summarizeFoodDoc }
    const out = {
      found: true,
      source: "openfoodfacts",
      barcode: CODE,
      product: {
        name: "Greek Yoghurt",
        brand: "Fage",
        source: "off",
        barcode: CODE,
        serving_size: "170 g",
        grams_per_serving: 170,
        image_url: "http://img/x.jpg",
        suggested_snake_name: "fage_greek_yoghurt",
        per_100g: { kcal: 97, p: 9, f: 5, c: 3.6, fiber: 0 },
      },
    };
    const res = indexBarcodeHit(out, CODE);
    expect(res).not.toBeNull();
    expect(res!.source).toBe("off");
    expect(res!.product).toMatchObject({
      name: "Greek Yoghurt",
      brand: "Fage",
      source: "off",
      in_pantry: false,
      on_hand: null,
      image_url: "http://img/x.jpg",
      per_100g: { kcal: 97, p: 9, f: 5, c: 3.6, fiber: 0 },
    });
  });

  test("maps a usda hit and defaults a missing brand to null", () => {
    const out = {
      found: true,
      source: "usda",
      barcode: CODE,
      product: {
        name: "Spinach, raw",
        brand: null,
        source: "usda",
        barcode: CODE,
        serving_size: null,
        grams_per_serving: null,
        image_url: null,
        suggested_snake_name: "spinach_raw",
        per_100g: { kcal: 23, p: 2.9, f: 0.4, c: 3.6 },
      },
    };
    const res = indexBarcodeHit(out, CODE);
    expect(res!.source).toBe("usda");
    expect(res!.product!.brand).toBeNull();
    expect(res!.product!.serving_size).toBeNull();
  });

  test("returns null on an index miss", () => {
    expect(indexBarcodeHit({ found: false, source: "foodref", barcode: CODE }, CODE)).toBeNull();
  });
});

describe("barcodeMiss", () => {
  test("is the explicit fall-through-to-AI signal", () => {
    expect(barcodeMiss(CODE)).toEqual({ found: false, barcode: CODE, source: null, product: null });
  });
});
