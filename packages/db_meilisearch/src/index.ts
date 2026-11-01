// @fa/db_meilisearch — self-hosted food reference data (OpenFoodFacts + USDA),
// served from Meilisearch. Replaces the live OpenFoodFacts HTTP API.
export * from "./types.ts";
export * from "./normalize.ts";
export {
  meili,
  foodsIndex,
  foodLookupByBarcode,
  foodSearch,
  syncFoodsSettings,
  summarizeFoodDoc,
} from "./client.ts";
export type { FoodSearchOpts, MacroRange } from "./client.ts";
