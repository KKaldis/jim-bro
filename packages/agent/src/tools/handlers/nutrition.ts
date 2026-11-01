/**
 * Nutrition tools: food lookup, meal and water logging.
 */
import { type FoodSearchOpts, summarizeFoodDoc } from "@fa/db_meilisearch";
import { getSource, searchKnowledge } from "@fa/db_qdrant";
import {
  dayTargetFromPlan,
  dayTotals,
  lookupPantryItem,
  type Macros,
  macrosFor,
  type Meal,
  type MealItem,
  type MealLog,
  normalizeBarcode,
  substituteFood,
  sumMacros,
} from "@fa/shared";

import { UserStorage } from "../../storage.ts";
import {
  pantryFoodView,
  refLookupByBarcode,
  refSearch,
  resolveFoodBothSources,
  todayIso,
} from "./shared.ts";

export async function doLookupFood(storage: UserStorage, input: Record<string, unknown>) {
  // Batch path: resolve MANY foods in one call (recipe / multi-item meal
  // building) so the agent doesn't spend one tool-loop iteration per ingredient
  // and hit MAX_ITERATIONS on a big recipe. Mirrors update_meal's array input.
  // The pantry is loaded once and reused across every name.
  if (Array.isArray(input.names)) {
    const names = input.names.map((n) => String(n ?? "").trim()).filter(Boolean);
    const pantry = await storage.loadPantry();
    return {
      batch: true,
      results: await Promise.all(
        names.map(async (name) => ({
          query: { name },
          ...(await resolveFoodBothSources(pantry, name)),
        })),
      ),
    };
  }

  const rawBarcode = input.barcode != null ? String(input.barcode) : "";
  const name = String(input.name ?? "").trim();

  // Barcode path: exact hit against this user's pantry. A pantry miss falls
  // through to lookup_product (the food index) — the agent's existing next step,
  // and the /foods/barcode scanner's own second tier — so we don't duplicate
  // that index call here.
  if (rawBarcode) {
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode) {
      return { found: false, query: { barcode: rawBarcode }, note: "barcode had no digits" };
    }
    const hit = await storage.findPantryByBarcode(barcode);
    if (hit) return { found: true, matched_by: "barcode", ...pantryFoodView(hit) };
    if (!name) return { found: false, query: { barcode } };
    // Fall through to name lookup so a missing barcode doesn't strand the agent.
  }

  if (!name) {
    return { found: false, error: "pass either name, names[], or barcode" };
  }
  const pantry = await storage.loadPantry();
  const r = await resolveFoodBothSources(pantry, name);
  return r.found ? r : { ...r, query: { name } };
}

// ---- Food reference lookup (self-hosted) ----
//
// lookup_product resolves foods from OUR OWN Meilisearch index, not the live
// OpenFoodFacts API. The index is built by the packages/db_meilisearch importer from a
// filtered subset of the OpenFoodFacts dump (branded products, with barcodes)
// plus USDA FoodData Central (generic foods, no barcodes). Nothing leaves the
// box at request time.
//   - barcode → exact filter        (foodLookupByBarcode)
//   - query   → typo-tolerant search (foodSearch)
// Because we only index rows with complete per-100g macros, a hit always has
// usable nutriments. A miss returns { found: false } so the agent falls back to
// asking the user or reading the label.
//
// The original live-API implementation is preserved, commented out, in the
// "LEGACY LIVE API" block below — re-enable it there if you ever want a network
// fallback on a local miss.

// sort enum (tool-facing) → Meilisearch sort expression(s) over the macro
// columns. "relevance" (or anything unknown) → no sort, i.e. text relevance.
const PRODUCT_SORT: Record<string, string[]> = {
  relevance: [],
  protein_desc: ["p:desc"],
  kcal_asc: ["kcal:asc"],
  kcal_desc: ["kcal:desc"],
  fiber_desc: ["fiber:desc"],
  carbs_asc: ["c:asc"],
};

// Read a numeric input field, treating null/""/non-numbers as absent.
function numField(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Build a {min,max} range from a pair of input fields, or undefined if neither.
function rangeField(
  input: Record<string, unknown>,
  minKey: string,
  maxKey: string,
): FoodSearchOpts["kcal"] {
  const min = numField(input, minKey);
  const max = numField(input, maxKey);
  if (min == null && max == null) return undefined;
  return { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) };
}

// Translate the flat lookup_product inputs into structured FoodSearchOpts.
function buildProductSearchOpts(input: Record<string, unknown>, top: number): FoodSearchOpts {
  const opts: FoodSearchOpts = { top };
  if (input.source === "off" || input.source === "usda") opts.source = input.source;
  const brand = typeof input.brand === "string" ? input.brand.trim() : "";
  if (brand) opts.brand = brand;
  const kcal = rangeField(input, "min_kcal", "max_kcal");
  const p = rangeField(input, "min_protein", "max_protein");
  const f = rangeField(input, "min_fat", "max_fat");
  const c = rangeField(input, "min_carbs", "max_carbs");
  const fiber = rangeField(input, "min_fiber", "max_fiber");
  if (kcal) opts.kcal = kcal;
  if (p) opts.p = p;
  if (f) opts.f = f;
  if (c) opts.c = c;
  if (fiber) opts.fiber = fiber;
  const sort = typeof input.sort === "string" ? PRODUCT_SORT[input.sort] : undefined;
  if (sort?.length) opts.sort = sort;
  return opts;
}

// Does the input carry any narrowing filter (so a blank query is still a valid
// search)? Mirrors the fields buildProductSearchOpts reads.
function hasProductFilters(opts: FoodSearchOpts): boolean {
  return Boolean(
    opts.source || opts.brand || opts.kcal || opts.p || opts.f || opts.c || opts.fiber,
  );
}

// A query that is 8–14 digits (ignoring spaces/dashes) is a UPC/EAN/GTIN, so
// route it to the exact-barcode path; otherwise it's free text to search.
// Returns the normalized digit string, or null when it isn't barcode-shaped.
function asBarcode(query: string): string | null {
  const digits = query.replace(/[\s-]/g, "");
  return /^\d{8,14}$/.test(digits) ? digits : null;
}

// Resolve one product query against the self-hosted food index. Shared by the
// single-query path and the batch (`queries[]`) path. The narrowing filters
// (source / brand / macro bounds / sort) come from `input` and apply to every
// query in a batch.
async function lookupOneProduct(
  query: string,
  input: Record<string, unknown>,
  top: number,
): Promise<Record<string, unknown>> {
  // Self-routing: barcode-shaped query → exact lookup (filters/sort don't apply).
  const barcode = query ? asBarcode(query) : null;
  if (barcode) {
    const doc = await refLookupByBarcode(barcode);
    if (!doc) {
      return { found: false, source: "foodref", barcode };
    }
    return {
      found: true,
      source: doc.source === "usda" ? "usda" : "openfoodfacts",
      barcode,
      product: summarizeFoodDoc(doc),
    };
  }

  const opts = buildProductSearchOpts(input, top);
  if (!query && !hasProductFilters(opts)) {
    throw new Error(
      "pass a query (barcode or food name) or at least one filter (source / a macro bound)",
    );
  }

  const docs = await refSearch(query, opts);
  return {
    found: docs.length > 0,
    source: "foodref",
    query: query || null,
    // Echo the narrowing back so the UI/agent can see what shaped the results.
    filters: {
      source: opts.source ?? null,
      brand: opts.brand ?? null,
      kcal: opts.kcal ?? null,
      protein: opts.p ?? null,
      fat: opts.f ?? null,
      carbs: opts.c ?? null,
      fiber: opts.fiber ?? null,
      sort: typeof input.sort === "string" ? input.sort : "relevance",
    },
    count: docs.length,
    results: docs.map(summarizeFoodDoc),
  };
}

export async function doLookupProduct(input: Record<string, unknown>) {
  const top = Math.min(20, Math.max(1, Number(input.top ?? 5)));

  // Batch path: resolve MANY products in one call (recipe import of several new
  // ingredients) so the agent doesn't spend one tool-loop iteration per item and
  // hit MAX_ITERATIONS. Index lookups run concurrently; shared filters apply to
  // every query.
  if (Array.isArray(input.queries)) {
    const queries = input.queries.map((q) => String(q ?? "").trim()).filter(Boolean);
    const results = await Promise.all(
      queries.map(async (query) => ({ query, ...(await lookupOneProduct(query, input, top)) })),
    );
    return { batch: true, results };
  }

  const query = input.query != null ? String(input.query).trim() : "";
  return lookupOneProduct(query, input, top);
}

// search_knowledge is the real evidence-retrieval tool: hybrid (semantic +
// lexical) search over the scientific knowledge base with cross-encoder
// reranking, returning cited passages so the agent can ground claims in sources
// instead of training-data recall. Each hit is enriched with its full source
// record (journal, authors, pmid/doi) for a proper citation. A transport failure
// (Qdrant down) comes back as { ok: false, error } rather than throwing, so the
// agent can say the knowledge base is unavailable instead of silently looping.
export async function doSearchKnowledge(input: Record<string, unknown>) {
  const query = input.query != null ? String(input.query).trim() : "";
  if (!query) return { ok: false, error: "query is required" };
  const top = Math.min(20, Math.max(1, Number(input.top ?? 6)));
  const evidenceOnly = input.evidence_only === true;

  // Bias to the strongest study designs when asked (high-stakes / contested).
  const filter = evidenceOnly
    ? { must: [{ key: "evidence_level", match: { any: ["meta-analysis", "systematic-review"] } }] }
    : undefined;

  try {
    const hits = await searchKnowledge(query, { top, filter });
    // Enrich with the full source-of-truth record for accurate citations.
    const sources = await Promise.all(
      hits.map((h) => (h.parent_id ? getSource(h.parent_id).catch(() => null) : null)),
    );

    const results = hits.map((h, i) => {
      const s = sources[i];
      return {
        title: h.title,
        passage: h.text,
        score: Number(h.score.toFixed(4)),
        evidence_level: h.evidence_level ?? s?.evidence_level ?? null,
        citation: {
          source: h.source,
          journal: s?.journal ?? null,
          year: h.year ?? s?.year ?? null,
          authors: s?.authors?.slice(0, 4) ?? [],
          pmid: s?.pmid ?? null,
          doi: s?.doi ?? null,
          url: h.url ?? s?.url ?? null,
        },
      };
    });

    return { ok: true, query, evidence_only: evidenceOnly, count: results.length, results };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      hint: "Is the `qdrant` service running and QDRANT_URL reachable? Start it with `docker compose up -d qdrant`.",
    };
  }
}

// cite is provider-agnostic citation rendering: the model hands us the sources
// behind its answer and we echo them straight back so the chat UI can draw the
// Sources card (cards/resultCards.tsx). No storage, no external call — the value
// is purely presentational. Kimi's $web_search keeps its result URLs server-side
// (we never see them), so this tool is the only way to surface real sources on
// that provider; it works identically on every other provider too.
export function doCite(input: Record<string, unknown>) {
  const raw = Array.isArray(input.sources) ? input.sources : [];
  const sources = raw
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s) => ({
      title: typeof s.title === "string" ? s.title : "",
      ...(typeof s.authors === "string" && s.authors ? { authors: s.authors } : {}),
      ...(typeof s.journal === "string" && s.journal ? { journal: s.journal } : {}),
      ...(typeof s.year === "number" && Number.isFinite(s.year) ? { year: s.year } : {}),
      ...(typeof s.url === "string" && s.url ? { url: s.url } : {}),
      ...(typeof s.finding === "string" && s.finding ? { finding: s.finding } : {}),
    }))
    .filter((s) => s.title);
  return { ok: true, count: sources.length, sources };
}

// A recipe grouping tag (set by log_recipe) echoed back on an item — kept so
// re-saving a recipe meal's items (update_meal) doesn't ungroup it.
function recipeTagOf(raw: unknown): { recipe: NonNullable<MealItem["recipe"]> } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.slug !== "string" || typeof r.name !== "string") return null;
  const servings = Number(r.servings);
  return {
    recipe: { slug: r.slug, name: r.name, servings: Number.isFinite(servings) ? servings : 1 },
  };
}

// Resolve raw meal items to macro'd MealItems. Items with inline kcal are
// taken as-is ("manual"); otherwise the food is resolved against the user's
// pantry (the food catalog) and its per-100 macros are scaled to grams.
async function resolveMealItems(
  storage: UserStorage,
  rawItems: Array<Record<string, unknown>>,
): Promise<Meal["items"]> {
  const needsPantry = rawItems.some((it) => it.kcal == null);
  const pantry = needsPantry ? await storage.loadPantry() : null;
  return rawItems.map((it) => {
    const food = String(it.food);
    const grams = Number(it.grams);
    if (it.kcal != null) {
      return {
        food,
        grams,
        kcal: Number(it.kcal),
        p: Number(it.p ?? 0),
        f: Number(it.f ?? 0),
        c: Number(it.c ?? 0),
        ...(it.fiber != null ? { fiber: Number(it.fiber) } : {}),
        source: "manual" as const,
        ...recipeTagOf(it.recipe),
      };
    }
    const entry = lookupPantryItem(pantry, food);
    if (!entry?.macros) {
      throw new Error(
        `food '${food}' not in the pantry (or has no macros) — add_food first, or pass kcal/p/f/c inline`,
      );
    }
    const m = macrosFor(entry.macros, grams);
    return {
      food: entry.name,
      grams,
      ...m,
      source: "db" as const,
      ...recipeTagOf(it.recipe),
    };
  });
}

// Patch a SINGLE item inside a meal's item list, leaving the others intact.
// This is the partial-edit path for update_meal — "make the kefir 50ml" should
// touch only the kefir line, not force the model to restate every item (the
// items-replaces-all footgun that made it thrash). Matches by food name (exact
// case-insensitive first, then substring) and errors on zero or ambiguous
// matches so we never silently patch the wrong line.
async function patchMealItem(
  storage: UserStorage,
  items: Meal["items"],
  patch: Record<string, unknown>,
): Promise<Meal["items"]> {
  const name = String(patch.food ?? "").trim();
  if (!name) throw new Error("update_item.food required — name the item to change");
  const lname = name.toLowerCase();
  const have = items.map((it) => it.food).join(", ");
  let matches = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.food.toLowerCase() === lname);
  if (matches.length === 0) {
    matches = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.food.toLowerCase().includes(lname));
  }
  if (matches.length === 0) {
    throw new Error(`no item named '${name}' in this meal (have: ${have})`);
  }
  if (matches.length > 1) {
    throw new Error(
      `'${name}' matches ${matches.length} items in this meal — be more specific (have: ${have})`,
    );
  }
  const { it: cur, i } = matches[0];

  const hasExplicitMacros =
    patch.kcal != null ||
    patch.p != null ||
    patch.f != null ||
    patch.c != null ||
    patch.fiber != null;
  const gramsChanged = patch.grams != null && Number(patch.grams) !== cur.grams;
  if (!hasExplicitMacros && !gramsChanged) {
    throw new Error(
      "update_item changed nothing — pass a new grams and/or macro overrides (kcal/p/f/c/fiber)",
    );
  }
  const newGrams = patch.grams != null ? Number(patch.grams) : cur.grams;

  let next: MealItem;
  if (hasExplicitMacros) {
    // Caller supplied macros directly — trust them; this line becomes manual.
    next = {
      food: cur.food,
      grams: newGrams,
      kcal: patch.kcal != null ? Number(patch.kcal) : cur.kcal,
      p: patch.p != null ? Number(patch.p) : cur.p,
      f: patch.f != null ? Number(patch.f) : cur.f,
      c: patch.c != null ? Number(patch.c) : cur.c,
      source: "manual",
    };
    const fiber = patch.fiber != null ? Number(patch.fiber) : cur.fiber;
    if (fiber != null) next.fiber = fiber;
  } else {
    // Grams-only change. Re-resolve from the pantry for catalog lines so the
    // macros stay authoritative; scale the frozen macros for everything else.
    const entry =
      cur.source === "db" ? lookupPantryItem(await storage.loadPantry(), cur.food) : null;
    if (entry?.macros) {
      next = {
        food: cur.food,
        grams: newGrams,
        ...macrosFor(entry.macros, newGrams),
        source: "db",
      };
    } else {
      const r1 = (n: number) => Math.round(n * 10) / 10;
      const factor = cur.grams > 0 ? newGrams / cur.grams : 0;
      next = {
        food: cur.food,
        grams: newGrams,
        kcal: r1(cur.kcal * factor),
        p: r1(cur.p * factor),
        f: r1(cur.f * factor),
        c: r1(cur.c * factor),
        source: cur.source ?? "manual",
      };
      if (cur.fiber != null) next.fiber = r1(cur.fiber * factor);
    }
  }

  const out = items.slice();
  out[i] = next;
  return out;
}

// Food names referenced by an update_item patch (single object or array of
// them). Used to disambiguate which meal to patch when several share a slot —
// the named item points at the right meal without needing a time.
function itemPatchFoodNames(raw: unknown): string[] {
  if (raw == null || typeof raw !== "object") return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((p) =>
      p && typeof p === "object" ? String((p as Record<string, unknown>).food ?? "").trim() : "",
    )
    .filter((s) => s.length > 0);
}

// Does a meal contain an item matching this food name? Mirrors patchMealItem's
// matcher: exact case-insensitive first, then substring.
function mealHasItem(meal: Meal, food: string): boolean {
  const lname = food.toLowerCase();
  return meal.items.some(
    (it) => it.food.toLowerCase() === lname || it.food.toLowerCase().includes(lname),
  );
}

export async function doLogMeal(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? todayIso());
  const slot = String(input.slot ?? "snack");
  const time = input.time ? String(input.time) : undefined;
  const rawItems = (input.items as Array<Record<string, unknown>>) ?? [];
  const items = await resolveMealItems(storage, rawItems);

  const log: MealLog = (await storage.loadMealLog(date)) ?? { date, meals: [] };
  const meal: Meal = { slot, items, ...(time ? { time } : {}) };
  log.meals.push(meal);
  await storage.saveMealLog(log);

  const dietPlan = await storage.loadActiveDietPlan();
  const profile = await storage.loadProfile();
  const target = dayTargetFromPlan(dietPlan, date, profile);
  const totals = dayTotals(log, target, date);

  return {
    logged: { date, slot, time, item_count: items.length, macros_added: sumMacros(items) },
    day_totals: totals,
  };
}

export async function doSubstituteFood(storage: UserStorage, input: Record<string, unknown>) {
  const target = input.target as Macros;
  const pantry = await storage.loadPantry();
  return {
    candidates: substituteFood({
      target,
      pantry,
      exclude: (input.exclude as string[]) ?? [],
      topN: input.top ? Number(input.top) : 5,
      inStockOnly: input.in_stock_only === true,
    }),
  };
}

// Default daily water goal (ml) when the user hasn't set one. Mirrors the
// HydrationCard's DEFAULT_GOAL_ML so chat and UI agree on "% of goal".
const DEFAULT_WATER_GOAL_ML = 2500;

export async function doLogWater(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? todayIso());
  const hasAdd = input.add_ml != null;
  const hasSet = input.set_ml != null;
  const hasGoal = input.goal_ml != null;
  if (!hasAdd && !hasSet && !hasGoal) {
    throw new Error("pass add_ml (to add), set_ml (to overwrite), or goal_ml");
  }
  if (hasAdd && hasSet) {
    throw new Error("pass only one of add_ml / set_ml, not both");
  }

  const current = await storage.loadWater(date);
  let ml = current.ml;
  if (hasSet) ml = Math.max(0, Number(input.set_ml));
  else if (hasAdd) ml = Math.max(0, current.ml + Number(input.add_ml));

  // The hydration goal is persistent — a single everyday target on the profile
  // — so goal_ml writes there and applies to every day, not just this one.
  // 0 clears it (revert to the app default).
  let profileGoal = (await storage.loadProfile())?.water_goal_ml ?? null;
  if (hasGoal) {
    profileGoal = Number(input.goal_ml) > 0 ? Math.round(Number(input.goal_ml)) : null;
    await storage.setWaterGoal(profileGoal);
  }

  const saved = await storage.saveWater({ date, ml });
  const effectiveGoal = profileGoal ?? DEFAULT_WATER_GOAL_ML;
  return {
    date,
    ml: saved.ml,
    liters: Math.round((saved.ml / 1000) * 100) / 100,
    goal_ml: profileGoal,
    pct_of_goal: effectiveGoal > 0 ? Math.round((saved.ml / effectiveGoal) * 100) : null,
  };
}

// Read-only hydration status for a day — feeds the hydration result card.
// Mirrors doLogWater's return shape (so chat and the card agree on "% of goal")
// and adds remaining_ml / is_today for the card's intake-vs-goal readout.
export async function doGetWaterStatus(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? todayIso());
  const current = await storage.loadWater(date);
  const profileGoal = (await storage.loadProfile())?.water_goal_ml ?? null;
  const effectiveGoal = profileGoal ?? DEFAULT_WATER_GOAL_ML;
  return {
    date,
    is_today: date === todayIso(),
    ml: current.ml,
    liters: Math.round((current.ml / 1000) * 100) / 100,
    goal_ml: profileGoal,
    pct_of_goal: effectiveGoal > 0 ? Math.round((current.ml / effectiveGoal) * 100) : null,
    remaining_ml: Math.max(0, effectiveGoal - current.ml),
  };
}

export async function doPreviewMeal(storage: UserStorage, input: Record<string, unknown>) {
  const rawItems = (input.items as Array<Record<string, unknown>>) ?? [];
  const items = await resolveMealItems(storage, rawItems);

  const totals = sumMacros(items);
  const requested = typeof input.date === "string" ? input.date.trim() : "";
  if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    return { error: `date must be YYYY-MM-DD (got: ${JSON.stringify(input.date)})` };
  }
  const date = requested || todayIso();
  const [dietPlan, mealLog, profile] = await Promise.all([
    storage.loadActiveDietPlan(),
    storage.loadMealLog(date),
    storage.loadProfile(),
  ]);
  const target = dayTargetFromPlan(dietPlan, date, profile);
  const dayBefore = dayTotals(mealLog, target, date);
  const projected_remaining = dayBefore.remaining
    ? {
        kcal: dayBefore.remaining.kcal - totals.kcal,
        p: dayBefore.remaining.p - totals.p,
        f: dayBefore.remaining.f - totals.f,
        c: dayBefore.remaining.c - totals.c,
      }
    : null;
  // Where the day lands after this (un-logged) meal — the projected-dashboard
  // overlay the MealPreviewCard draws on the calorie ring + macro bars: the
  // committed `eaten_before` stays solid, the gap up to `projected_eaten`
  // ghosts. Same shape as get_todays_macros's eaten_today so the card reuses the
  // dashboard widgets unchanged.
  const projected_eaten = {
    kcal: dayBefore.eaten.kcal + totals.kcal,
    p: dayBefore.eaten.p + totals.p,
    f: dayBefore.eaten.f + totals.f,
    c: dayBefore.eaten.c + totals.c,
    ...(dayBefore.eaten.fiber != null || totals.fiber != null
      ? { fiber: (dayBefore.eaten.fiber ?? 0) + (totals.fiber ?? 0) }
      : {}),
  };

  return {
    preview: true,
    date,
    is_today: date === todayIso(),
    items,
    totals,
    target_today: target,
    // The goal-based daily recommendation (goal + latest weigh-in), cached on the
    // profile — the PRIMARY target the preview ring steers toward, mirroring the
    // dashboard. The diet plan's `target_today` rides along as the triangle marker
    // (dietKcal) when it differs. null until there's a profile + a weigh-in.
    recommended_target:
      profile?.target_kcal != null
        ? {
            kcal: profile.target_kcal,
            p: profile.target_protein_g ?? null,
            f: profile.target_fat_g ?? null,
            c: profile.target_carbs_g ?? null,
            fiber: profile.target_fiber_g ?? null,
          }
        : null,
    eaten_before: dayBefore.eaten,
    projected_eaten,
    remaining_before: dayBefore.remaining,
    projected_remaining,
    // Goal drives the ring's over-target colouring (a lean-bulk target is a floor
    // to reach, not a ceiling) — mirrors get_todays_macros's profile_summary.
    profile_summary: profile ? { goal: profile.goal } : null,
  };
}

export async function doUpdateMeal(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? todayIso());
  const slot = String(input.slot ?? "").trim();
  if (!slot) throw new Error("slot required");
  const time = input.time ? String(input.time) : undefined;

  const log = await storage.loadMealLog(date);
  if (!log) throw new Error(`no meal log for ${date}`);

  // meal_index pinpoints the exact meal (the UI's edit dialog always knows
  // which one was tapped), bypassing slot+time matching entirely so siblings
  // that share an untimed slot can never collide.
  const hasIndex = input.meal_index != null;
  let target: Meal;
  if (hasIndex) {
    const idx = Number(input.meal_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= log.meals.length) {
      throw new Error(
        `meal_index ${input.meal_index} out of range — ${date} has ${log.meals.length} meal(s)`,
      );
    }
    target = log.meals[idx];
  } else {
    let matches = log.meals.filter(
      (m) => m.slot === slot && (time === undefined || m.time === time),
    );
    if (matches.length === 0) {
      throw new Error(`no meal found for ${date} slot=${slot}${time ? ` time=${time}` : ""}`);
    }
    // When several meals share a slot (e.g. two untimed snacks), the time is
    // often not enough — neither may have one. If the edit names a specific
    // item via update_item, narrow to the meal that actually contains it: the
    // food itself disambiguates, so the user never has to supply a time they
    // didn't log.
    if (matches.length > 1) {
      const patchFoods = itemPatchFoodNames(input.update_item);
      if (patchFoods.length > 0) {
        const narrowed = matches.filter((m) => patchFoods.every((f) => mealHasItem(m, f)));
        if (narrowed.length >= 1) matches = narrowed;
      }
    }
    if (matches.length > 1) {
      const have = matches
        .map((m) => {
          const items = m.items.map((it) => it.food).join("/") || "empty";
          return `${m.time ?? "(no time)"}: ${items}`;
        })
        .join("; ");
      throw new Error(
        `${matches.length} meals match ${date} slot=${slot} — pass 'time' to disambiguate, ` +
          `or name the item to change via update_item (have: ${have})`,
      );
    }
    target = matches[0];
  }

  const hasItems = Array.isArray(input.items);
  const hasItemPatch = input.update_item != null && typeof input.update_item === "object";
  const newSlot = input.new_slot != null ? String(input.new_slot).trim() : undefined;
  const hasNewTime = Object.prototype.hasOwnProperty.call(input, "new_time");
  const newTimeRaw = hasNewTime ? String(input.new_time ?? "").trim() : undefined;
  const hasNewDate = Object.prototype.hasOwnProperty.call(input, "new_date");
  const newDateRaw = hasNewDate ? String(input.new_date ?? "").trim() : undefined;
  if (newDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(newDateRaw)) {
    throw new Error(`new_date must be YYYY-MM-DD (got: ${JSON.stringify(newDateRaw)})`);
  }
  // Only an actual change of day counts as a move (new_date === date is a no-op).
  const moveTo = newDateRaw && newDateRaw !== date ? newDateRaw : null;

  if (hasItems && hasItemPatch) {
    throw new Error(
      "pass either items (replaces the whole list) or update_item (patches one line), not both",
    );
  }

  if (!hasItems && !hasItemPatch && newSlot === undefined && !hasNewTime && !moveTo) {
    throw new Error(
      "nothing to update — pass at least one of: items, update_item, new_slot, new_time, new_date",
    );
  }

  if (hasItems) {
    const rawItems = input.items as Array<Record<string, unknown>>;
    if (rawItems.length === 0) {
      throw new Error("items must be non-empty — use delete_meal to remove the meal");
    }
    target.items = await resolveMealItems(storage, rawItems);
  }
  if (hasItemPatch) {
    // update_item is either a single patch or an array of them — normalize to a
    // list and apply each in turn so a multi-item edit stays ONE tool call (one
    // gate card) instead of one call per ingredient. patchMealItem matches by
    // food name and preserves it, so later patches still resolve against the
    // updated list.
    const rawPatch = input.update_item;
    const patches = Array.isArray(rawPatch)
      ? (rawPatch as Array<Record<string, unknown>>)
      : [rawPatch as Record<string, unknown>];
    if (patches.length === 0) {
      throw new Error("update_item is empty — name at least one item to change");
    }
    for (const patch of patches) {
      target.items = await patchMealItem(storage, target.items, patch);
    }
  }
  if (newSlot !== undefined && newSlot !== "") {
    target.slot = newSlot;
  }
  if (hasNewTime) {
    if (newTimeRaw === "") {
      delete target.time;
    } else {
      target.time = newTimeRaw;
    }
  }

  // Where the meal lives after this edit, and which day's totals to report.
  let totalsDate = date;
  let totalsLog = log;
  if (moveTo) {
    // Pull it out of the source day, then append to the destination day's log
    // (creating the row if the day had none). Two writes, same target object —
    // the meal's items/slot/time edits above carry over intact.
    log.meals = log.meals.filter((m) => m !== target);
    await storage.saveMealLog(log);
    const destLog = (await storage.loadMealLog(moveTo)) ?? { date: moveTo, meals: [] };
    destLog.meals.push(target);
    await storage.saveMealLog(destLog);
    totalsDate = moveTo;
    totalsLog = destLog;
  } else {
    await storage.saveMealLog(log);
  }

  const dietPlan = await storage.loadActiveDietPlan();
  const profile = await storage.loadProfile();
  const dayTarget = dayTargetFromPlan(dietPlan, totalsDate, profile);
  const totals = dayTotals(totalsLog, dayTarget, totalsDate);

  return {
    updated: {
      date: totalsDate,
      slot: target.slot,
      ...(target.time ? { time: target.time } : {}),
      item_count: target.items.length,
      macros: sumMacros(target.items),
    },
    ...(moveTo ? { moved: { from: date, to: moveTo } } : {}),
    day_totals: totals,
  };
}

export async function doDeleteMeal(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? todayIso());
  const slot = String(input.slot ?? "").trim();
  if (!slot) throw new Error("slot required");
  const time = input.time ? String(input.time) : undefined;
  const index = input.meal_index != null ? Number(input.meal_index) : undefined;
  const removed = await storage.deleteMeal(date, slot, time, index);
  return { removed_count: removed, date, slot, ...(time ? { time } : {}) };
}
