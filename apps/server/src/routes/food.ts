/**
 * Food search, barcode lookup, the pantry, and image scans (food photos,
 * receipts).
 */
import {
  executeTool,
  recognizeFoodImage,
  scanReceiptImage,
  type VisionImageInput,
} from "@fa/agent";
import { humanizeFoodName, type Macros, normalizeBarcode, type Pantry } from "@fa/shared";
import {
  type BarcodeLookupResponse,
  FoodScanRequest,
  type ImageInput,
  PantryQuery,
  ReceiptScanRequest,
} from "@fa/shared/schemas";

import { barcodeMiss, indexBarcodeHit, pantryBarcodeHit } from "../barcode.ts";
import { aiPreflight } from "../extensions.ts";
import { authed, type AuthedCtx, jsonError, readBody } from "../http.ts";
import { consumeToken } from "../rate-limit.ts";
import { type Route, route } from "../router.ts";

// Full food DB for client-side autocomplete / live macro preview inside the
// log_meal form override. Small payload (under ~100KB even with hundreds of
// entries) so we ship it whole rather than paginating — the form needs both
// the name list AND per-food macros to compute previews without a roundtrip.
// Local food catalog. With no params, returns the whole DB (used by the chat
// log-meal form's autocomplete). With ?query=, filters server-side by snake +
// humanized name and caps the result — this powers the add-food dialog's
// debounced search so typing doesn't ship the whole catalog to the client.
const FOOD_SEARCH_LIMIT = 50;

// Flattened "food view" of a pantry item: per-100 macros at the top level plus
// category/barcode. This is the shape the add-food dialog consumes (formerly
// the global food_db row). Built only for items that carry macros.
type FoodView = Macros & { category?: string; barcode?: string };

function pantryFoodsMap(pantry: Pantry | null): Record<string, FoodView> {
  const out: Record<string, FoodView> = {};
  for (const [name, item] of Object.entries(pantry?.items ?? {})) {
    if (!item.macros) continue;
    out[name] = {
      ...item.macros,
      ...(item.category ? { category: item.category } : {}),
      ...(item.barcode ? { barcode: item.barcode } : {}),
    };
  }
  return out;
}

// The user's pantry foods, in food_db-compatible shape. No shared catalog
// anymore — "foods" are the macro-bearing items in the caller's own pantry.
async function handleFoods({ url, log, storage }: AuthedCtx): Promise<Response> {
  const db = pantryFoodsMap(await storage.loadPantry());
  const query = url.searchParams.get("query")?.trim().toLowerCase();
  if (query) {
    const matches: Record<string, FoodView> = {};
    let count = 0;
    for (const [name, entry] of Object.entries(db)) {
      if (
        name.toLowerCase().includes(query) ||
        humanizeFoodName(name).toLowerCase().includes(query)
      ) {
        matches[name] = entry;
        if (++count >= FOOD_SEARCH_LIMIT) break;
      }
    }
    log.debug("pantry foods searched", { query, count });
    return Response.json(matches, {
      headers: { "cache-control": "private, max-age=60" },
    });
  }
  log.debug("pantry foods served", { count: Object.keys(db).length });
  return Response.json(db, {
    headers: { "cache-control": "private, max-age=60" },
  });
}

// OpenFoodFacts product search for the Nutrition page's add-food dialog.
// Thin GET wrapper over the agent's read-only `lookup_product` tool — accepts
// either ?barcode= (exact) or ?query= (free text), passes through the same
// per-100g summary the agent sees. Logging the chosen food still goes through
// /tools/run → log_meal; local-DB search reuses GET /foods?query= (filtered
// server-side). executeTool never throws — failures come back as {error} JSON.
async function handleFoodLookup({ url, log, userId, storage }: AuthedCtx): Promise<Response> {
  const barcode = url.searchParams.get("barcode")?.trim();
  const query = url.searchParams.get("query")?.trim();
  const topRaw = url.searchParams.get("top");
  if (!barcode && !query) {
    return jsonError(400, "pass barcode or query");
  }
  const out = await executeTool(
    "lookup_product",
    {
      ...(barcode ? { barcode } : {}),
      ...(query ? { query } : {}),
      ...(topRaw ? { top: Number(topRaw) } : {}),
    },
    storage,
  );
  log.debug("food lookup", {
    user_id: userId,
    by: barcode ? "barcode" : "query",
  });
  return new Response(out, {
    headers: { "content-type": "application/json" },
  });
}

// Deterministic barcode resolution for the on-device scanner. The client
// decodes the barcode locally (BarcodeDetector / wasm) and hits this with the
// digits; we resolve it WITHOUT the LLM in a two-tier cascade:
//   1. the user's own pantry (lookup_food) — instant re-scan of items they've
//      already added, and carries their on-hand quantity.
//   2. the self-hosted food index (lookup_product → Meilisearch: OpenFoodFacts
//      branded + USDA generics).
// A miss (found:false) is the client's signal to fall back to the AI vision
// path (POST /foods/scan). executeTool never throws on a "not found", but a
// transport error (index down) does — we catch it and treat it as a miss so a
// flaky index still degrades to the vision fallback rather than 500ing.
// The pure mapping lives in ./barcode.ts (unit-tested).
async function handleBarcodeLookup(
  { log, userId, storage }: AuthedCtx,
  rawCode: string,
): Promise<Response> {
  const code = normalizeBarcode(decodeURIComponent(rawCode));
  if (!code) return jsonError(400, "barcode must contain digits");

  const parseTool = async (name: string, input: Record<string, unknown>) => {
    try {
      return JSON.parse(await executeTool(name, input, storage)) as Record<string, unknown>;
    } catch (err) {
      // Treat a tool/index failure as a miss so the scan degrades to the AI
      // fallback instead of erroring the request.
      log.warn("barcode tier failed", { tool: name, barcode: code, err: String(err) });
      return { found: false } as Record<string, unknown>;
    }
  };

  // Tier 1: pantry. Tier 2: food index. First hit wins.
  let result = pantryBarcodeHit(await parseTool("lookup_food", { barcode: code }), code);
  if (!result) {
    result = indexBarcodeHit(await parseTool("lookup_product", { query: code }), code);
  }
  const body: BarcodeLookupResponse = result ?? barcodeMiss(code);
  log.debug("barcode lookup", { user_id: userId, barcode: code, source: body.source });
  return Response.json(body);
}

// Current user's pantry — the unified food + supplement catalog. Each item
// carries its quantity (in `unit`), per-100 macros, category, barcode, type
// (food | supplement) and to_buy flag. Read-only; mutations flow through the
// agent's update_pantry tool. `foods` is a flattened macro map (a convenience
// for the add-food dialog) derived from the same items.
async function handlePantry({ url, log, userId, storage }: AuthedCtx): Promise<Response> {
  const sp = url.searchParams;
  const parsed = PantryQuery.safeParse({
    q: sp.get("q") ?? undefined,
    category: sp.get("category") ?? undefined,
    sort: sp.get("sort") ?? undefined,
    order: sp.get("order") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    offset: sp.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") || "(root)";
    return jsonError(400, `${path}: ${issue?.message ?? "invalid"}`);
  }
  const { items, total, categories } = await storage.queryPantry(parsed.data);
  // foods map is built from the returned items (the full set when limit is
  // omitted) — it's the per-100 macro catalog the add-food dialog consumes.
  const foods = pantryFoodsMap({
    items: Object.fromEntries(items.map((it) => [it.name, it])),
  });
  log.debug("pantry served", {
    user_id: userId,
    count: items.length,
    total,
  });
  return Response.json({ items, total, categories, foods });
}

// Receipt scanning → pantry (TODO #3). Read-only vision pass: OCR + parse a
// receipt photo into pantry line items (snake_case food + estimated grams).
// Does NOT write — the client confirms/edits the items then writes them via
// POST /tools/run with update_pantry. Rate-limited like chat since it's an
// LLM call. executeTool-style errors come back as 500s (scanReceiptImage
// throws on a bad image / unparsable response).
async function handleScanReceipt({ req, log, userId }: AuthedCtx): Promise<Response> {
  const ulog = log.child({ user_id: userId });
  if (!consumeToken(userId)) {
    ulog.warn("scan-receipt rate limited");
    return jsonError(429, "rate limit exceeded — try again shortly");
  }
  const blocked = await aiPreflight(userId, "ai_image", ulog);
  if (blocked) return jsonError(blocked.status, blocked.error);
  const parsed = await readBody(req, ReceiptScanRequest);
  if ("error" in parsed) return parsed.error;
  const start = Date.now();
  try {
    const result = await scanReceiptImage(toVisionImage(parsed.data.image), userId);
    ulog.info("receipt scanned", {
      ms: Date.now() - start,
      items: result.items.length,
    });
    return Response.json(result);
  } catch (err) {
    ulog.error("scan-receipt failed", err instanceof Error ? err : new Error(String(err)), {
      ms: Date.now() - start,
    });
    return jsonError(500, err instanceof Error ? err.message : String(err));
  }
}

// Food recognition for the add-food dialog's photo flow. Read-only vision
// pass: identify the food(s) in a photo (plate / product / nutrition label)
// and return per-100g macros + an estimated portion. Does NOT log — the
// client confirms macros/grams then logs via POST /tools/run with log_meal.
// Rate-limited like chat since it's an LLM call.
async function handleFoodScan({ req, log, userId }: AuthedCtx): Promise<Response> {
  const ulog = log.child({ user_id: userId });
  if (!consumeToken(userId)) {
    ulog.warn("food-scan rate limited");
    return jsonError(429, "rate limit exceeded — try again shortly");
  }
  const blocked = await aiPreflight(userId, "ai_image", ulog);
  if (blocked) return jsonError(blocked.status, blocked.error);
  const parsed = await readBody(req, FoodScanRequest);
  if ("error" in parsed) return parsed.error;
  const start = Date.now();
  try {
    const result = await recognizeFoodImage(toVisionImage(parsed.data.image), userId);
    ulog.info("food scanned", {
      ms: Date.now() - start,
      items: result.items.length,
    });
    return Response.json(result);
  } catch (err) {
    ulog.error("food-scan failed", err instanceof Error ? err : new Error(String(err)), {
      ms: Date.now() - start,
    });
    return jsonError(500, err instanceof Error ? err.message : String(err));
  }
}

// Normalize a validated ImageInput (base64 or url) into the agent's
// VisionImageInput discriminated union. Shared by the two scan handlers.
function toVisionImage(img: ImageInput): VisionImageInput {
  return "url" in img
    ? { kind: "url", url: img.url }
    : { kind: "base64", media_type: img.media_type, data: img.data };
}

// ---------- routes ----------

export const foodRoutes: Route[] = [
  route("GET", "/foods", authed(handleFoods)),
  route("GET", "/foods/lookup", authed(handleFoodLookup)),
  route(
    "GET",
    "/foods/barcode/:code",
    authed((c) => handleBarcodeLookup(c, c.params.code)),
  ),
  route("POST", "/foods/scan", authed(handleFoodScan)),
  route("GET", "/pantry", authed(handlePantry)),
  route("POST", "/pantry/scan-receipt", authed(handleScanReceipt)),
];
