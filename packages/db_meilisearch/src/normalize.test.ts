import { expect, test, describe } from "bun:test";
import { toPantryKey } from "@fa/shared";

import { offRowToDoc, usdaFoodToDoc, plausibleMacros } from "./normalize.ts";

describe("offRowToDoc", () => {
  test("maps a complete OFF row to a FoodDoc", () => {
    const doc = offRowToDoc({
      code: "737628064502",
      product_name: "Greek Yoghurt",
      brands: "Fage",
      quantity: "500 g",
      serving_size: "1 scoop (65 g)",
      image_url: "http://img",
      nutriments: {
        "energy-kcal_100g": 97,
        proteins_100g: 9,
        fat_100g: 5,
        carbohydrates_100g: 3.6,
        fiber_100g: 0,
      },
    });
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe("off_737628064502");
    expect(doc!.source).toBe("off");
    expect(doc!.barcode).toBe("737628064502");
    expect(doc!.name).toBe("Greek Yoghurt");
    expect(doc!.brand).toBe("Fage");
    expect(doc!.grams_per_serving).toBe(65);
    expect(doc!).toMatchObject({ kcal: 97, p: 9, f: 5, c: 3.6, fiber: 0 });
  });

  test("converts kJ when kcal field is absent", () => {
    const doc = offRowToDoc({
      code: "111",
      product_name: "Oats",
      nutriments: {
        energy_100g: 1568, // kJ → /4.184 ≈ 374.8 kcal
        proteins_100g: 13,
        fat_100g: 7,
        carbohydrates_100g: 60,
      },
    });
    expect(doc!.kcal).toBe(374.8);
    expect(doc!.fiber).toBeNull();
  });

  test("drops rows with incomplete macros", () => {
    expect(
      offRowToDoc({
        code: "222",
        product_name: "Mystery",
        nutriments: { "energy-kcal_100g": 100, proteins_100g: 5 }, // missing fat/carbs
      }),
    ).toBeNull();
  });

  test("drops rows without a barcode or name", () => {
    expect(
      offRowToDoc({
        product_name: "No Code",
        nutriments: { "energy-kcal_100g": 1, proteins_100g: 1, fat_100g: 1, carbohydrates_100g: 1 },
      }),
    ).toBeNull();
    expect(
      offRowToDoc({
        code: "333",
        nutriments: { "energy-kcal_100g": 1, proteins_100g: 1, fat_100g: 1, carbohydrates_100g: 1 },
      }),
    ).toBeNull();
  });
});

describe("usdaFoodToDoc", () => {
  test("maps a Foundation food via nutrient numbers (per 100g)", () => {
    const doc = usdaFoodToDoc({
      fdcId: 171688,
      description: "Cheese, cheddar",
      foodNutrients: [
        { nutrient: { number: "1008" }, amount: 403 },
        { nutrient: { number: "1003" }, amount: 24.9 },
        { nutrient: { number: "1004" }, amount: 33.1 },
        { nutrient: { number: "1005" }, amount: 1.28 },
        { nutrient: { number: "1079" }, amount: 0 },
      ],
    });
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe("usda_171688");
    expect(doc!.source).toBe("usda");
    expect(doc!.barcode).toBeNull();
    expect(doc!).toMatchObject({ kcal: 403, p: 24.9, f: 33.1, c: 1.3, fiber: 0 });
  });

  test("picks up gtinUpc as barcode for Branded foods", () => {
    const doc = usdaFoodToDoc({
      fdcId: 999,
      description: "Branded Bar",
      gtinUpc: "0049000000443",
      foodNutrients: [
        { nutrient: { number: "1008" }, amount: 200 },
        { nutrient: { number: "1003" }, amount: 10 },
        { nutrient: { number: "1004" }, amount: 5 },
        { nutrient: { number: "1005" }, amount: 30 },
      ],
    });
    expect(doc!.barcode).toBe("0049000000443");
    expect(doc!.fiber).toBeNull();
  });

  test("drops foods missing required macros or fdcId", () => {
    expect(
      usdaFoodToDoc({
        fdcId: 1,
        description: "x",
        foodNutrients: [{ nutrient: { number: "1008" }, amount: 1 }],
      }),
    ).toBeNull();
    expect(usdaFoodToDoc({ description: "no id", foodNutrients: [] })).toBeNull();
  });

  test("drops mis-scaled rows with impossible per-100g macros", () => {
    // Per-package amounts mislabeled as per-100g (the "VEGGIE BURRITO" case).
    expect(
      usdaFoodToDoc({
        fdcId: 42,
        description: "VEGGIE BURRITO",
        foodNutrients: [
          { nutrient: { number: "1008" }, amount: 90000 },
          { nutrient: { number: "1003" }, amount: 3400 },
          { nutrient: { number: "1004" }, amount: 100 },
          { nutrient: { number: "1005" }, amount: 100 },
        ],
      }),
    ).toBeNull();
  });
});

describe("plausibleMacros", () => {
  test("accepts real per-100g foods (incl. pure fat ≈ 900 kcal)", () => {
    expect(plausibleMacros({ kcal: 403, p: 24.9, f: 33.1, c: 1.3, fiber: 0 })).toBe(true);
    expect(plausibleMacros({ kcal: 900, p: 0, f: 100, c: 0, fiber: null })).toBe(true);
  });

  test("rejects impossible energy or macro mass and negatives", () => {
    expect(plausibleMacros({ kcal: 90000, p: 3400, f: 1, c: 1, fiber: null })).toBe(false);
    expect(plausibleMacros({ kcal: 901, p: 1, f: 1, c: 1, fiber: null })).toBe(false);
    expect(plausibleMacros({ kcal: 100, p: 101, f: 1, c: 1, fiber: null })).toBe(false);
    expect(plausibleMacros({ kcal: 100, p: 1, f: 1, c: 1, fiber: 200 })).toBe(false);
    expect(plausibleMacros({ kcal: -1, p: 1, f: 1, c: 1, fiber: null })).toBe(false);
  });
});

describe("toPantryKey", () => {
  test("normalizes names to snake_case keys", () => {
    expect(toPantryKey("Fage Greek Yoghurt 0%")).toBe("fage_greek_yoghurt_0");
    expect(toPantryKey("  Hyper-Mass  ")).toBe("hyper_mass");
  });
});
