// Live food-reference lookup: OpenFoodFacts + USDA FoodData Central HTTP APIs.
//
// This is the PRODUCTION path. Meilisearch (the self-hosted food index) and
// Qdrant (the vector knowledge base) aren't deployed to prod yet, so when
// FOODREF_LIVE=true the agent's food lookups reach out to the live public APIs
// instead of reading our own index. Dev leaves the flag unset and keeps using
// Meilisearch — see the dispatchers in tools/handlers/shared.ts (refSearch / refLookupByBarcode).
//
// Both clients return `FoodDoc` (the Meilisearch index shape) so this is a
// drop-in swap: summarizeFoodDoc / docMacros and every downstream consumer work
// unchanged regardless of which backend served the row. We only ever emit a doc
// when its per-100g macros are complete, preserving the index's guarantee that
// "a hit always has usable nutriments".

import { logger } from "@fa/logger";
import { normalizeBarcode, parseServingGrams } from "@fa/shared";
import type { FoodDoc, FoodSearchOpts } from "@fa/db_meilisearch";

const log = logger.child({ mod: "foodref-live" });

// ─────────────────────────── OpenFoodFacts ───────────────────────────
// Public free API. No auth, but they ask for a polite User-Agent.
//   Barcode:  GET /api/v2/product/{barcode}.json
//   Search:   GET /cgi/search.pl?search_terms=...&search_simple=1&json=1
// Nutriments come in per-100g and per-serving variants; we always use per-100g.

const OFF_USER_AGENT = "jim-bro/0.1";
const OFF_PRODUCT_FIELDS =
  "code,product_name,generic_name,brands,quantity,serving_size,nutriments,image_url";

type OffNutriments = {
  ["energy-kcal_100g"]?: number;
  ["energy_100g"]?: number; // kJ fallback
  proteins_100g?: number;
  fat_100g?: number;
  carbohydrates_100g?: number;
  fiber_100g?: number;
};

type OffProduct = {
  code?: string;
  product_name?: string;
  brands?: string;
  generic_name?: string;
  quantity?: string;
  nutriments?: OffNutriments;
  serving_size?: string;
  image_url?: string;
};

type Per100g = { kcal: number; p: number; f: number; c: number; fiber: number | null };

const round1 = (n: number) => Math.round(n * 10) / 10;

// Pull per-100g macros out of OFF nutriments (kJ→kcal fallback), or null when
// the core macros (kcal/protein/fat/carbs) are incomplete.
function offPer100g(p: OffProduct): Per100g | null {
  const n = p.nutriments ?? {};
  let kcal = n["energy-kcal_100g"];
  if (kcal == null && n["energy_100g"] != null) kcal = n["energy_100g"] / 4.184;
  const p100 = n.proteins_100g;
  const f100 = n.fat_100g;
  const c100 = n.carbohydrates_100g;
  if (kcal == null || p100 == null || f100 == null || c100 == null) return null;
  return {
    kcal: round1(kcal),
    p: round1(p100),
    f: round1(f100),
    c: round1(c100),
    fiber: n.fiber_100g != null ? round1(n.fiber_100g) : null,
  };
}

// OFF product → FoodDoc, or null when macros are incomplete (skipped).
function offToDoc(p: OffProduct): FoodDoc | null {
  const macros = offPer100g(p);
  if (!macros) return null;
  const code = p.code ? normalizeBarcode(p.code) : "";
  const name = p.product_name ?? p.generic_name ?? "(unnamed)";
  return {
    id: `off:${code || name}`,
    source: "off",
    barcode: code || null,
    name,
    brand: p.brands ?? null,
    generic_name: p.generic_name ?? null,
    quantity: p.quantity ?? null,
    serving_size: p.serving_size ?? null,
    grams_per_serving: parseServingGrams(p.serving_size),
    image_url: p.image_url ?? null,
    kcal: macros.kcal,
    p: macros.p,
    f: macros.f,
    c: macros.c,
    fiber: macros.fiber,
  };
}

async function offFetchByBarcode(barcode: string): Promise<FoodDoc | null> {
  const norm = normalizeBarcode(barcode);
  if (!norm) return null;
  const url = `https://world.openfoodfacts.org/api/v2/product/${norm}.json?fields=${OFF_PRODUCT_FIELDS}`;
  const res = await fetch(url, { headers: { "User-Agent": OFF_USER_AGENT } });
  if (!res.ok) throw new Error(`OpenFoodFacts barcode lookup ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { status?: number; product?: OffProduct };
  if (json.status !== 1 || !json.product) return null;
  return offToDoc(json.product);
}

async function offSearch(query: string, top: number): Promise<FoodDoc[]> {
  const url =
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=${top}&fields=${OFF_PRODUCT_FIELDS}`;
  const res = await fetch(url, { headers: { "User-Agent": OFF_USER_AGENT } });
  if (!res.ok) throw new Error(`OpenFoodFacts search ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { products?: OffProduct[] };
  return (json.products ?? []).map(offToDoc).filter((d): d is FoodDoc => d !== null);
}

// ─────────────────────── USDA FoodData Central ───────────────────────
// Requires a free API key (FDC_API_KEY). We query the generic datasets
// (Foundation / SR Legacy / Survey) — these are per-100g and carry no barcode,
// which is exactly the "usda generic" role the Meilisearch index filled.
//   Search: GET /fdc/v1/foods/search?api_key=...&query=...
// Docs: https://fdc.nal.usda.gov/api-guide.html

const FDC_DATA_TYPES = "Foundation,SR Legacy,Survey (FNDDS)";

// nutrientId → macro field. Energy(1008,kcal), Protein(1003), Fat(1004),
// Carbs by difference(1005), Fiber(1079). Energy in kJ (1062) is a fallback.
const FDC_ENERGY_KCAL = 1008;
const FDC_ENERGY_KJ = 1062;
const FDC_PROTEIN = 1003;
const FDC_FAT = 1004;
const FDC_CARBS = 1005;
const FDC_FIBER = 1079;

type FdcNutrient = { nutrientId?: number; value?: number };
type FdcFood = { fdcId?: number; description?: string; foodNutrients?: FdcNutrient[] };

function fdcPer100g(food: FdcFood): Per100g | null {
  const byId = new Map<number, number>();
  for (const n of food.foodNutrients ?? []) {
    if (n.nutrientId != null && n.value != null) byId.set(n.nutrientId, n.value);
  }
  let kcal = byId.get(FDC_ENERGY_KCAL);
  const kj = byId.get(FDC_ENERGY_KJ);
  if (kcal == null && kj != null) kcal = kj / 4.184;
  const p100 = byId.get(FDC_PROTEIN);
  const f100 = byId.get(FDC_FAT);
  const c100 = byId.get(FDC_CARBS);
  if (kcal == null || p100 == null || f100 == null || c100 == null) return null;
  const fiber = byId.get(FDC_FIBER);
  return {
    kcal: round1(kcal),
    p: round1(p100),
    f: round1(f100),
    c: round1(c100),
    fiber: fiber != null ? round1(fiber) : null,
  };
}

function fdcToDoc(food: FdcFood): FoodDoc | null {
  const macros = fdcPer100g(food);
  if (!macros || food.fdcId == null) return null;
  const name = food.description ?? "(unnamed)";
  return {
    id: `usda:${food.fdcId}`,
    source: "usda",
    barcode: null,
    name,
    brand: null,
    generic_name: name,
    quantity: null,
    serving_size: null,
    grams_per_serving: null,
    image_url: null,
    kcal: macros.kcal,
    p: macros.p,
    f: macros.f,
    c: macros.c,
    fiber: macros.fiber,
  };
}

// Warn once if the key is missing so a misconfigured prod is obvious in logs
// without spamming every request.
let fdcKeyWarned = false;

async function fdcSearch(query: string, top: number): Promise<FoodDoc[]> {
  const key = process.env.FDC_API_KEY?.trim();
  if (!key) {
    if (!fdcKeyWarned) {
      log.warn("FDC_API_KEY not set — USDA generics are unavailable on the live path");
      fdcKeyWarned = true;
    }
    return [];
  }
  const params = new URLSearchParams({
    api_key: key,
    query,
    pageSize: String(top),
    dataType: FDC_DATA_TYPES,
  });
  const res = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`);
  if (!res.ok) throw new Error(`USDA FDC search ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { foods?: FdcFood[] };
  return (json.foods ?? []).map(fdcToDoc).filter((d): d is FoodDoc => d !== null);
}

// ─────────────────────── client-side narrowing ───────────────────────
// The live APIs can't express the FoodSearchOpts filters/sort server-side, so
// we honor the tool's contract by applying them to the merged result set.

const MACRO_FIELDS = ["kcal", "p", "f", "c", "fiber"] as const;

function inRange(v: number | null, r?: { min?: number; max?: number }): boolean {
  if (!r) return true;
  if (v == null) return false;
  if (r.min != null && v < r.min) return false;
  if (r.max != null && v > r.max) return false;
  return true;
}

function applyOpts(docs: FoodDoc[], opts: FoodSearchOpts): FoodDoc[] {
  let out = docs;
  if (opts.brand) {
    const b = opts.brand.toLowerCase();
    out = out.filter((d) => (d.brand ?? "").toLowerCase().includes(b));
  }
  out = out.filter((d) => MACRO_FIELDS.every((k) => inRange(d[k], opts[k])));
  // opts.sort is Meilisearch-style, e.g. ["p:desc"], ["kcal:asc"].
  const first = opts.sort?.[0];
  if (first) {
    const [field, dir] = first.split(":");
    if ((MACRO_FIELDS as readonly string[]).includes(field)) {
      const k = field as (typeof MACRO_FIELDS)[number];
      const sign = dir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => ((a[k] ?? 0) - (b[k] ?? 0)) * sign);
    }
  }
  return out;
}

// ──────────────── unified API (mirrors the Meilisearch fns) ────────────────

// Barcode → exact product. OFF only: USDA generics carry no barcode, so a
// barcode can only resolve against OpenFoodFacts.
export async function liveFoodLookupByBarcode(barcode: string): Promise<FoodDoc | null> {
  return offFetchByBarcode(barcode);
}

// Free-text search across OFF + USDA (routed by opts.source), then narrowed and
// sorted client-side. A blank query returns nothing — the live APIs need a term
// (unlike the index, which can browse purely by macro filters).
export async function liveFoodSearch(query: string, opts: FoodSearchOpts = {}): Promise<FoodDoc[]> {
  const q = query.trim();
  const top = Math.min(20, Math.max(1, opts.top ?? 5));
  if (!q) return [];

  const wantOff = opts.source !== "usda";
  const wantUsda = opts.source !== "off";
  const [off, usda] = await Promise.all([
    wantOff
      ? offSearch(q, top).catch((err) => {
          log.error("OFF search failed", err as Error);
          return [] as FoodDoc[];
        })
      : Promise.resolve([] as FoodDoc[]),
    wantUsda
      ? fdcSearch(q, top).catch((err) => {
          log.error("USDA FDC search failed", err as Error);
          return [] as FoodDoc[];
        })
      : Promise.resolve([] as FoodDoc[]),
  ]);

  return applyOpts([...off, ...usda], opts).slice(0, top);
}
