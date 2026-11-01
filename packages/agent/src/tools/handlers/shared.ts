/**
 * Helpers shared by several tool domains.
 */
import {
  type FoodDoc,
  foodLookupByBarcode,
  foodSearch,
  type FoodSearchOpts,
  summarizeFoodDoc,
} from "@fa/db_meilisearch";
import {
  lookupPantryItem,
  normalizePortion,
  type PantryItem,
  type Portion,
  rankPantryCandidates,
  type Weekday,
} from "@fa/shared";

import { liveFoodLookupByBarcode, liveFoodSearch } from "../../foodref-live.ts";
import { UserStorage } from "../../storage.ts";
import { getTodaysMacros } from "./core.ts";

// Prod toggle. Meilisearch (food index) and Qdrant (vector KB) aren't deployed
// to production yet, so setting FOODREF_LIVE=true routes food lookups to the
// live OpenFoodFacts + USDA APIs and hides the Qdrant-backed search_knowledge
// tool. Dev leaves it unset and keeps the self-hosted paths. Toggle only — no
// code is removed on either side.
export const FOODREF_LIVE = process.env.FOODREF_LIVE === "true";

// Food-reference dispatchers: same signatures as the Meilisearch fns, so every
// call site stays backend-agnostic. Live APIs in prod, Meilisearch in dev.
export function refLookupByBarcode(barcode: string): Promise<FoodDoc | null> {
  return FOODREF_LIVE ? liveFoodLookupByBarcode(barcode) : foodLookupByBarcode(barcode);
}
export function refSearch(query: string, opts: FoodSearchOpts): Promise<FoodDoc[]> {
  return FOODREF_LIVE ? liveFoodSearch(query, opts) : foodSearch(query, opts);
}

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function stripHtmlToText(html: string): { title: string | null; content: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 200) : null;
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<\/?(p|div|li|tr|br|h[1-6]|section|article|header|footer|nav|figure|table)[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  const content = decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, content };
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => named[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

// One-line `[State: …]` tag the agent loop prepends to each user message: the
// facts most turns otherwise spend a whole model round-trip fetching (profile
// language, the day's eaten vs target, the active plans and today's session).
// Ambient context only — the cards still come from their tools, and the
// system prompt says when a tool call is still required. Best-effort: any
// failure yields null and the turn runs without it.
export async function buildStateTag(storage: UserStorage, date?: string): Promise<string | null> {
  try {
    const day = await getTodaysMacros(storage, date ? { date } : {});
    if ("error" in day) return null;
    if ("profile_missing" in day) return "[State: profile_missing — onboard the user first]";
    const [plan, dietPlan] = await Promise.all([
      (async () => {
        const id = (await storage.loadProfile())?.active_workout_plan_id;
        return id != null ? storage.loadWorkoutPlan(id) : null;
      })(),
      storage.loadActiveDietPlan(),
    ]);
    const r = (n: number) => Math.round(n);
    // User-authored names must not close the tag early (the UI strips tags with
    // a `[^\]\n]*` match).
    const name = (s: string) => `"${s.replace(/[[\]\n"]/g, " ").trim()}"`;
    const parts = [`date=${day.date}`, `language=${day.profile_summary.language}`];
    const bc = day.profile_summary.latest_body_comp;
    if (bc) {
      parts.push(
        `weight ${bc.weight_kg} kg${bc.body_fat_pct != null ? `, body fat ${bc.body_fat_pct}%` : ""} (weighed ${bc.date})`,
      );
    } else {
      parts.push("no weigh-in on file");
    }
    const t = day.target_today;
    const e = day.eaten_today;
    parts.push(
      t
        ? `eaten ${r(e.kcal)}/${r(t.kcal)} kcal, protein ${r(e.p)}/${r(t.p)} g (${day.meal_count_today} meals)`
        : `eaten ${r(e.kcal)} kcal (no target)`,
    );
    parts.push(dietPlan ? `diet plan ${name(dietPlan.name)}` : "no active diet plan");
    if (plan) {
      const session = plan.days.find((d) => d.weekdays.includes(day.weekday as Weekday));
      parts.push(
        `workout plan ${name(plan.name)} (id ${plan.id}), ${day.weekday}: ${session ? name(session.name) : "rest day"}`,
      );
    } else {
      parts.push("no active workout plan");
    }
    return `[State: ${parts.join(" · ")}]`;
  } catch {
    return null;
  }
}

// Flatten a pantry item into the "food view" the agent + UI consume: macros
// spread to the top level (per-100 g/ml), plus the catalog/stock fields.
export function pantryFoodView(item: PantryItem) {
  return {
    name: item.name,
    unit: item.unit,
    quantity: item.quantity,
    to_buy: item.to_buy,
    ...(item.grams_per_serving != null ? { grams_per_serving: item.grams_per_serving } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.barcode ? { barcode: item.barcode } : {}),
    ...(item.macros ?? {}),
    has_macros: !!item.macros,
  };
}

type LoadedPantry = Awaited<ReturnType<UserStorage["loadPantry"]>>;

// Resolve one free-text food name against an already-loaded pantry. Shared by
// the single-food path and the batch (`names[]`) path so both return the same
// shape; pulled out so a batch lookup loads the pantry ONCE and reuses it.
function lookupNameInPantry(pantry: LoadedPantry, name: string) {
  const item = lookupPantryItem(pantry, name);
  if (item) return { found: true as const, matched_by: "name" as const, ...pantryFoodView(item) };
  // No confident hit. Surface near-misses so the agent can confirm one with the
  // user ("did you mean Hyper Mass?") instead of re-adding a duplicate spelling.
  const candidates = rankPantryCandidates(pantry, name).map((c) => ({
    ...pantryFoodView(c.item),
    score: c.score,
  }));
  return {
    found: false as const,
    candidates,
  };
}

// Search the self-hosted food index (OpenFoodFacts + USDA — the "other DBs"
// beyond the user's own pantry) for a free-text name and project to the summary
// shape add_food consumes. Best-effort: a transport error yields [] so a pantry
// miss still returns cleanly. Kept small (top 3) because these ride along on
// every pantry miss.
async function foodIndexMatches(name: string, top = 3) {
  const q = name.trim();
  if (!q) return [];
  try {
    const docs = await refSearch(q, { top });
    return docs.map(summarizeFoodDoc);
  } catch {
    return [];
  }
}

// The agent-facing hint for a pantry miss, tailored to what we actually have to
// offer (pantry near-matches and/or food-index products), so the agent knows
// which source to reach for next. Pantry candidates are still preferred first.
function foodMissNote(candidateCount: number, productCount: number): string {
  if (candidateCount && productCount)
    return "not resolved in the pantry. `candidates` are near-matches already in the pantry (confirm one to reuse it, preferred when it's clearly the same food); `products` are matches from the food index (OpenFoodFacts/USDA) — read one back and add_food to put it in the pantry.";
  if (candidateCount)
    return "no confident pantry match and nothing in the food index. If a `candidates` entry is what the user meant, use its `name`; otherwise ask the user or web_search, then add_food.";
  if (productCount)
    return "not in the pantry. `products` are matches from the food index (OpenFoodFacts/USDA) — read one back and add_food to put it in the pantry.";
  return "not in the pantry and no food-index match — ask the user for macros or web_search, then add_food.";
}

// Resolve one food name against BOTH sources, pantry first: return the pantry
// item when it resolves; otherwise attach food-index `products` (the OFF/USDA
// matches) alongside the fuzzy pantry `candidates` so a single lookup_food
// surfaces both without a follow-up lookup_product call. Mirrors the add-food
// dialog's combined, pantry-first search.
export async function resolveFoodBothSources(pantry: LoadedPantry, name: string) {
  const base = lookupNameInPantry(pantry, name);
  if (base.found) return base;
  const products = await foodIndexMatches(name);
  return {
    ...base,
    products,
    note: foodMissNote(base.candidates.length, products.length),
  };
}
const CM_PER_IN = 2.54;

// Read a length: prefer the *_cm field; fall back to *_in when units=imperial.
// Returns { value_cm, source } so the caller can echo the conversion.
export function readLength(
  input: Record<string, unknown>,
  cmKey: string,
  inKey: string,
  units: "metric" | "imperial",
  required: boolean,
  label: string,
): { cm: number | null; converted_from_in?: number } {
  const cmRaw = input[cmKey];
  const inRaw = input[inKey];
  if (cmRaw != null) {
    const v = Number(cmRaw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${cmKey} must be > 0`);
    return { cm: v };
  }
  if (inRaw != null) {
    const v = Number(inRaw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${inKey} must be > 0`);
    return { cm: v * CM_PER_IN, converted_from_in: v };
  }
  if (required) {
    throw new Error(
      `${label} required — pass ${cmKey} (metric) or ${inKey} (imperial; units=${units})`,
    );
  }
  return { cm: null };
}

// Upsert the day's measuring session. Muscle girths go to body_measurement;
// waist / neck / hip go onto the day's weigh-in so the Navy BF% estimate and
// the proportions read the same number. Everything is validated before the
// first write, so a missing weight can't leave half a session saved.
// A user-picked HH:MM time: undefined → not passed, null / "" → clear.
export function readTime(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error("time must be HH:MM (24h)");
  return s;
}

// Parse a raw portion (food + grams + optional inline macro OVERRIDE) from
// any diet tool's items into a Portion. Inline kcal marks the portion as a
// manual override; otherwise it live-resolves from the pantry.
// Tool portions carry a flat kcal/p/f/c override; the shared normalizer (and
// the HTTP API) take it nested under `macros`. Inline kcal marks the portion
// as a manual override; otherwise it live-resolves from the pantry.
export function nestPortion(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.kcal != null
    ? { food: raw.food, grams: raw.grams, macros: raw, source: "manual" }
    : { food: raw.food, grams: raw.grams };
}

export function parsePortionInput(raw: Record<string, unknown>): Portion {
  return normalizePortion(nestPortion(raw));
}

// Apply a single-item mutation once per `edits` entry — the path taken when the
// model batches a multi-row change into ONE tool call (one gate card) instead of
// calling the tool once per row. Returns the LAST result (each handler returns
// the full updated plan view), so the user sees the final state. Sequential: a
// mid-batch failure leaves earlier edits saved, same as separate calls would.
export async function runBatchEdits<T>(
  edits: unknown,
  single: (one: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const list = edits as Array<Record<string, unknown>>;
  if (list.length === 0) throw new Error("edits is empty — include at least one change");
  let last: T | undefined;
  for (const one of list) last = await single(one);
  return last as T;
}
