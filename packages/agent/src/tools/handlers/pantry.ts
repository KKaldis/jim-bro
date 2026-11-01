/**
 * Pantry tools: the food/supplement catalog & inventory.
 */
import { docMacros } from "@fa/db_meilisearch";
import {
  buildShoppingList,
  lookupPantryByBarcode,
  lookupPantryItem,
  type Macros,
  normalizeBarcode,
  type Pantry,
  type PantryItem,
  rankPantryCandidates,
  type ServingUnit,
  toPantryKey,
} from "@fa/shared";

import { type PantryItemPatch, UserStorage } from "../../storage.ts";
import { pantryFoodView, refLookupByBarcode, todayIso } from "./shared.ts";

/* ───────────────────────── LEGACY LIVE API (disabled) ─────────────────────────
 *
 * This is the original OpenFoodFacts HTTP integration, kept verbatim (renamed
 * `*_api`) for reference and as a drop-in network fallback. It is NOT compiled
 * or called — the active path above reads from our self-hosted Meilisearch
 * index instead. To re-enable as a fallback: uncomment this block, then in
 * doLookupProduct / doImportPantry call offFetchByBarcode_api / doLookupProduct_api
 * when the local lookup misses.
 *
 * Public free API. No auth, but they ask for a polite User-Agent.
 *   Barcode:  GET /api/v2/product/{barcode}.json
 *   Search:   GET /cgi/search.pl?search_terms=...&search_simple=1&json=1
 * Nutriments come in per-100g and per-serving variants; we always use per-100g.

const OFF_USER_AGENT = "jim-bro/0.1";

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

// Pull per-100g macros out of OFF nutriments, kJ→kcal fallback, or null if
// incomplete. (Now lives in @fa/db_meilisearch/normalize for the importer.)
function extractPer100g_api(p: OffProduct) {
  const n = p.nutriments ?? {};
  let kcal = n["energy-kcal_100g"];
  if (kcal == null && n["energy_100g"] != null) {
    kcal = Math.round((n["energy_100g"] / 4.184) * 10) / 10;
  }
  const p100 = n.proteins_100g;
  const f100 = n.fat_100g;
  const c100 = n.carbohydrates_100g;
  const fiber100 = n.fiber_100g;
  if (kcal == null || p100 == null || f100 == null || c100 == null) return null;
  return {
    kcal: Math.round(kcal * 10) / 10,
    p: Math.round(p100 * 10) / 10,
    f: Math.round(f100 * 10) / 10,
    c: Math.round(c100 * 10) / 10,
    ...(fiber100 != null ? { fiber: Math.round(fiber100 * 10) / 10 } : {}),
  };
}

function summarizeOffProduct_api(p: OffProduct) {
  const macros = extractPer100g_api(p);
  return {
    name: p.product_name ?? p.generic_name ?? "(unnamed)",
    brand: p.brands ?? null,
    barcode: p.code ?? null,
    quantity: p.quantity ?? null,
    serving_size: p.serving_size ?? null,
    grams_per_serving: parseServingGrams(p.serving_size),
    image_url: p.image_url ?? null,
    suggested_snake_name: toPantryKey(
      [p.brands, p.product_name].filter(Boolean).join(" ") || p.generic_name || "product",
    ),
    per_100g: macros, // null when nutriments incomplete
  };
}

const OFF_PRODUCT_FIELDS =
  "code,product_name,generic_name,brands,quantity,serving_size,nutriments,image_url";

// Fetch a single product by barcode from the live API. Returns null on miss;
// throws on HTTP-level failure (callers catch to keep a batch going).
async function offFetchByBarcode_api(barcode: string): Promise<OffProduct | null> {
  const url =
    `https://world.openfoodfacts.org/api/v2/product/${barcode}.json` +
    `?fields=${OFF_PRODUCT_FIELDS}`;
  const res = await fetch(url, { headers: { "User-Agent": OFF_USER_AGENT } });
  if (!res.ok) {
    throw new Error(`OpenFoodFacts barcode lookup ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { status?: number; product?: OffProduct };
  return json.status === 1 && json.product ? json.product : null;
}

async function doLookupProduct_api(input: Record<string, unknown>) {
  const barcode =
    input.barcode != null
      ? String(input.barcode)
          .trim()
          .replace(/[^0-9]/g, "")
      : "";
  const query = input.query != null ? String(input.query).trim() : "";
  const top = Math.min(10, Math.max(1, Number(input.top ?? 5)));

  if (!barcode && !query) {
    throw new Error("pass either barcode or query");
  }

  if (barcode) {
    const product = await offFetchByBarcode_api(barcode);
    if (!product) {
      return { found: false, source: "openfoodfacts", barcode };
    }
    const summary = summarizeOffProduct_api(product);
    return {
      found: true,
      source: "openfoodfacts",
      barcode,
      product: summary,
      ...(summary.per_100g
        ? {}
        : {
            note: "OpenFoodFacts has this product but per-100g nutriments are incomplete — confirm with the user or read the label.",
          }),
    };
  }

  const url =
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(
      query,
    )}&search_simple=1&action=process&json=1&page_size=${top}` + `&fields=${OFF_PRODUCT_FIELDS}`;
  const res = await fetch(url, { headers: { "User-Agent": OFF_USER_AGENT } });
  if (!res.ok) {
    throw new Error(`OpenFoodFacts search ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { products?: OffProduct[] };
  const results = (json.products ?? []).map(summarizeOffProduct_api);
  return {
    found: results.length > 0,
    source: "openfoodfacts",
    query,
    count: results.length,
    results,
  };
}

 * ─────────────────────────── end LEGACY LIVE API ─────────────────────────── */

function parseServingUnit(raw: unknown): ServingUnit | undefined {
  if (raw == null || raw === "") return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "g" || v === "ml" || v === "pcs") return v;
  throw new Error("unit must be one of: g, ml, pcs");
}

function parseBarcodeInput(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === "") return null;
  const norm = normalizeBarcode(String(raw));
  if (!norm) throw new Error("barcode must contain digits (UPC/EAN/GTIN)");
  return norm;
}

export async function doUpdateFood(storage: UserStorage, input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name required");
  const existing = await storage.getPantryItem(name);
  if (!existing) {
    throw new Error(
      `'${name}' not in the pantry — call lookup_food for the canonical name, or add_food to create it`,
    );
  }

  const patch: PantryItemPatch = {};
  // Merge provided macro fields onto the item's existing macros.
  const macros: Macros = { ...(existing.macros ?? { kcal: 0, p: 0, f: 0, c: 0 }) };
  let macrosTouched = false;
  for (const k of ["kcal", "p", "f", "c"] as const) {
    if (input[k] === undefined) continue;
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be >= 0`);
    macros[k] = v;
    macrosTouched = true;
  }
  if (input.fiber !== undefined) {
    if (input.fiber === null) {
      delete macros.fiber;
    } else {
      const v = Number(input.fiber);
      if (!Number.isFinite(v) || v < 0) throw new Error("fiber must be >= 0");
      macros.fiber = v;
    }
    macrosTouched = true;
  }
  if (macrosTouched) patch.macros = macros;
  if (input.category !== undefined) {
    patch.category = input.category === null ? null : String(input.category);
  }
  const barcode = parseBarcodeInput(input.barcode);
  if (barcode !== undefined) patch.barcode = barcode;
  const unit = parseServingUnit(input.unit);
  if (unit) patch.unit = unit;
  if (input.grams_per_serving !== undefined) {
    patch.grams_per_serving =
      input.grams_per_serving === null ? null : Number(input.grams_per_serving);
  }

  if (Object.keys(patch).length === 0) {
    throw new Error(
      "pass at least one field to update (kcal, p, f, c, fiber, category, barcode, unit, grams_per_serving)",
    );
  }
  await storage.upsertPantryItems({ [name]: patch });
  const current = await storage.getPantryItem(name);
  return { updated: true, name, current: current ? pantryFoodView(current) : null };
}

export async function doAddFood(storage: UserStorage, input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name required");
  const macros: Macros = { kcal: 0, p: 0, f: 0, c: 0 };
  for (const k of ["kcal", "p", "f", "c"] as const) {
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} required and must be >= 0`);
    macros[k] = v;
  }
  if (input.fiber != null) macros.fiber = Number(input.fiber);

  const patch: PantryItemPatch = { macros };
  if (input.category) patch.category = String(input.category);
  const barcode = parseBarcodeInput(input.barcode);
  if (barcode) patch.barcode = barcode;
  const unit = parseServingUnit(input.unit);
  if (unit) patch.unit = unit;
  if (input.grams_per_serving != null) {
    patch.grams_per_serving = Number(input.grams_per_serving);
  }
  if (input.quantity != null) patch.quantity = Number(input.quantity);
  if (input.to_buy != null) patch.to_buy = Boolean(input.to_buy);

  // Dedup guard: a near-identical item under a different spelling
  // ("hyper_mass" vs "hypermass") would create a SECOND pantry row, which is
  // exactly how the original mismatch arose. Unless the caller passes
  // `force`, surface the existing item instead of creating a duplicate.
  if (!input.force) {
    const pantry = await storage.loadPantry();
    const top = rankPantryCandidates(pantry, name, 1, 0.85)[0];
    if (top && top.item.name !== name) {
      return {
        added: false,
        possible_duplicate: true,
        existing: pantryFoodView(top.item),
        score: top.score,
        note: `'${name}' looks like the existing pantry item '${top.item.name}'. Use that name (update_food to edit its facts), or pass force:true to add '${name}' as a separate item.`,
      };
    }
  }

  await storage.upsertPantryItems({ [name]: patch });
  const current = await storage.getPantryItem(name);
  return { added: name, item: current ? pantryFoodView(current) : null };
}

// Parse one raw pantry item (from update_pantry) into a patch. Accepts the
// legacy `grams_available` alias for `quantity`, and macros either nested
// under `macros` or flat (kcal/p/f/c/fiber).
function parsePantryItemPatch(raw: Record<string, unknown>): PantryItemPatch {
  const patch: PantryItemPatch = {};
  if (raw.quantity !== undefined) patch.quantity = Number(raw.quantity);
  else if (raw.grams_available !== undefined) {
    patch.quantity = Number(raw.grams_available);
  }
  const unit = parseServingUnit(raw.unit);
  if (unit) patch.unit = unit;
  if (raw.grams_per_serving !== undefined) {
    patch.grams_per_serving = raw.grams_per_serving === null ? null : Number(raw.grams_per_serving);
  }
  if (raw.to_buy !== undefined) patch.to_buy = Boolean(raw.to_buy);
  if (raw.category !== undefined) {
    patch.category = raw.category === null ? null : String(raw.category);
  }
  const barcode = parseBarcodeInput(raw.barcode);
  if (barcode !== undefined) patch.barcode = barcode;
  const macroSrc =
    raw.macros && typeof raw.macros === "object" ? (raw.macros as Record<string, unknown>) : raw;
  if (macroSrc.kcal !== undefined) {
    patch.macros = {
      kcal: Number(macroSrc.kcal),
      p: Number(macroSrc.p ?? 0),
      f: Number(macroSrc.f ?? 0),
      c: Number(macroSrc.c ?? 0),
      ...(macroSrc.fiber != null ? { fiber: Number(macroSrc.fiber) } : {}),
    };
  } else if (raw.macros === null) {
    patch.macros = null;
  }
  return patch;
}

export async function doUpdatePantry(storage: UserStorage, input: Record<string, unknown>) {
  const rawItems = (input.items as Record<string, Record<string, unknown>>) ?? {};
  const mode = (input.mode as "merge" | "replace") ?? "merge";
  const remove = Array.isArray(input.remove)
    ? (input.remove as unknown[]).map((n) => String(n))
    : [];

  const patches: Record<string, PantryItemPatch> = {};
  for (const [name, raw] of Object.entries(rawItems)) {
    patches[name] = parsePantryItemPatch(raw ?? {});
  }

  if (mode === "replace") {
    // Build a full pantry from the provided items; column defaults fill gaps.
    const items: Pantry["items"] = {};
    for (const [name, patch] of Object.entries(patches)) {
      const item: PantryItem = {
        name,
        quantity: patch.quantity ?? 0,
        unit: patch.unit ?? "g",
        to_buy: patch.to_buy ?? false,
      };
      if (patch.grams_per_serving != null) {
        item.grams_per_serving = patch.grams_per_serving;
      }
      if (patch.category) item.category = patch.category;
      if (patch.barcode) item.barcode = patch.barcode;
      if (patch.macros) item.macros = patch.macros;
      items[name] = item;
    }
    await storage.savePantry({ items });
    return { mode, item_count: Object.keys(items).length, removed: 0 };
  }

  await storage.upsertPantryItems(patches);
  const removed = remove.length ? await storage.removePantryItems(remove) : 0;
  const pantry = await storage.loadPantry();
  return {
    mode,
    item_count: pantry ? Object.keys(pantry.items).length : 0,
    upserted: Object.keys(patches).length,
    removed,
  };
}

// Batch import of a shopping trip (receipt / CSV / photo / pasted list).
// Resolution per item: barcode (exact) → name (fuzzy) → create. Matches are
// restocked (quantity added by default); new items with a barcode get macros
// from OpenFoodFacts. One upsert at the end so the whole haul is a single
// write. Per-item soft failures (bad unit, OFF outage) land in `errors` /
// `needs_macros` instead of aborting the batch.
export async function doImportPantry(storage: UserStorage, input: Record<string, unknown>) {
  const rawItems = input.items as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("items[] required (at least one purchased item)");
  }
  const quantityMode = input.quantity_mode === "set" ? "set" : "add";
  const lookupBarcodes = input.lookup_barcodes !== false;
  const source = input.source != null ? String(input.source) : undefined;

  const pantry = await storage.loadPantry();

  const patches: Record<string, PantryItemPatch> = {};
  const restocked: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const needsMacros: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const raw of rawItems) {
    const rawName = String(raw?.name ?? "").trim();
    if (!rawName) {
      errors.push({ name: "(unnamed)", error: "item has no name — skipped" });
      continue;
    }
    let patch: PantryItemPatch;
    try {
      patch = parsePantryItemPatch(raw ?? {});
    } catch (err) {
      errors.push({
        name: rawName,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const qty = patch.quantity;

    // Resolve against the existing pantry: barcode (exact) wins, then fuzzy
    // name — try the raw text and its snake_case form.
    let existing: PantryItem | null = null;
    let matchedBy: "barcode" | "name" | null = null;
    if (patch.barcode) {
      existing = lookupPantryByBarcode(pantry, patch.barcode);
      if (existing) matchedBy = "barcode";
    }
    if (!existing) {
      existing =
        lookupPantryItem(pantry, rawName) ?? lookupPantryItem(pantry, toPantryKey(rawName));
      if (existing) matchedBy = "name";
    }

    const key = existing ? existing.name : toPantryKey(rawName);
    // A second line item can hit the same pantry row (two packs of the same
    // thing) — accumulate on top of the pending patch, not the stored value.
    const prior = patches[key];
    const before = prior?.quantity ?? existing?.quantity ?? 0;

    if (qty == null) {
      delete patch.quantity; // unknown amount — leave stock untouched
    } else if (quantityMode === "add") {
      patch.quantity = Math.round((before + qty) * 100) / 100;
    }
    // Purchased = in stock: clear a pending restock flag unless the caller
    // explicitly passed to_buy.
    if (raw.to_buy === undefined && qty != null) patch.to_buy = false;

    if (existing) {
      patches[key] = { ...prior, ...patch };
      restocked.push({
        name: key,
        matched_by: matchedBy,
        quantity_before: existing.quantity,
        quantity_after: patch.quantity ?? existing.quantity,
        unit: patch.unit ?? existing.unit,
      });
      continue;
    }

    let macrosSource: "input" | "openfoodfacts" | "none" = patch.macros ? "input" : "none";
    if (!patch.macros && patch.barcode && lookupBarcodes) {
      try {
        // Resolve the barcode against the active food backend (Meilisearch in
        // dev, live OpenFoodFacts in prod). A miss leaves the item without
        // macros (flagged below).
        const doc = await refLookupByBarcode(patch.barcode);
        if (doc) {
          patch.macros = docMacros(doc);
          macrosSource = "openfoodfacts";
        }
      } catch {
        // Food backend unreachable — import the item anyway; it just lands
        // without macros and gets flagged below.
      }
    }
    if (!patch.macros && !prior?.macros) needsMacros.push(key);
    patches[key] = { ...prior, ...patch };
    const dup = created.find((c) => c.name === key);
    if (dup) {
      dup.quantity = patch.quantity ?? dup.quantity;
    } else {
      created.push({
        name: key,
        quantity: patch.quantity ?? 0,
        unit: patch.unit ?? "g",
        macros_source: macrosSource,
      });
    }
  }

  if (Object.keys(patches).length) {
    await storage.upsertPantryItems(patches);
  }
  const after = await storage.loadPantry();
  return {
    mode: quantityMode,
    ...(source ? { source } : {}),
    imported: restocked.length + created.length,
    restocked,
    created,
    needs_macros: needsMacros,
    errors,
    pantry_size: after ? Object.keys(after.items).length : 0,
    ...(needsMacros.length
      ? {
          note: "needs_macros items have no per-100g macros yet, so they can't be meal-logged. Offer to resolve them (lookup_product / web_search, then update_food).",
        }
      : {}),
  };
}

export async function doShoppingList(storage: UserStorage, input: Record<string, unknown>) {
  const plan = await storage.loadActiveDietPlan();
  if (!plan?.rotation?.length) return { error: "no diet plan yet — call save_diet_plan first" };
  const pantry = input.use_pantry === false ? null : await storage.loadPantry();
  return buildShoppingList({
    plan,
    fromDate: input.from_date ? String(input.from_date) : todayIso(),
    days: input.days ? Number(input.days) : 7,
    pantry,
  });
}
