import type { Macros, MealItem, Pantry, PantryItem, Portion } from "./types.ts";

// Resolve a food name against the user's pantry (the only food catalog now).
// Exact match first, then case-insensitive, then separator-insensitive
// (normalized) exact + substring.
export function lookupPantryItem(pantry: Pantry | null, name: string): PantryItem | null {
  const items = pantry?.items ?? {};
  if (items[name]) return items[name];
  const lname = name.toLowerCase();
  for (const [k, v] of Object.entries(items)) {
    if (k.toLowerCase() === lname) return v;
  }
  // Separator-insensitive fallback: collapse _, -, spaces (and case) so the
  // agent and the stored name don't have to agree on word boundaries. A query
  // of "hypermass" / "Hyper Mass" now finds "hyper_mass" or
  // "biotech_usa_hyper_mass" — the mismatch that used to drop the lookup.
  const nname = normalizeForMatch(name);
  if (nname.length >= 3) {
    for (const [k, v] of Object.entries(items)) {
      if (normalizeForMatch(k) === nname) return v;
    }
    // Substring either way: the query may be terser ("hypermass" in
    // "biotechusahypermass") or more verbose ("biotech hyper mass" wrapping
    // the stored "hyper_mass") than the stored key.
    for (const [k, v] of Object.entries(items)) {
      const nk = normalizeForMatch(k);
      if (nk.includes(nname) || nname.includes(nk)) return v;
    }
    // Fuzzy last resort: tolerate typos ("hypermas"), word reordering
    // ("mass hyper"), and plurals ("oats" → "oat"). Pick the single best
    // candidate, but only auto-resolve well above the noise floor so we fail
    // to null (and let the agent ask) rather than log the wrong food. Real
    // typos score ~0.9+; near-homophones of absent foods sit around ~0.7, so
    // the bar is deliberately high here. Lower-confidence near-misses are still
    // surfaced as a shortlist via rankPantryCandidates.
    let best: PantryItem | null = null;
    let bestScore = 0;
    for (const [k, v] of Object.entries(items)) {
      const score = nameSimilarity(name, k);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best && bestScore >= AUTO_RESOLVE_MIN) return best;
  }
  return null;
}

// Confidence needed for lookupPantryItem to silently resolve a fuzzy hit.
// Real typos/plurals score ~0.9+; near-homophones of foods that aren't in the
// pantry sit around ~0.7 — so the bar is high to avoid logging the wrong food.
const AUTO_RESOLVE_MIN = 0.85;
// Floor for surfacing an item as a *candidate* (agent confirms, so it can be
// laxer than auto-resolve). Below this is noise, not a near-miss.
const CANDIDATE_MIN = 0.5;

// A scored pantry match — used to offer the agent a shortlist when no single
// item resolves with confidence. `score` is the [0,1] similarity from
// nameSimilarity (1 = identical after normalization).
export interface PantryCandidate {
  item: PantryItem;
  score: number;
}

// Rank pantry items by fuzzy similarity to `query`, best first, dropping
// anything below `minScore`. This is the data behind #5: rather than silently
// committing to a best guess, lookup_food / add_food can hand the agent these
// candidates and let it confirm with the user.
export function rankPantryCandidates(
  pantry: Pantry | null,
  query: string,
  limit = 5,
  minScore = CANDIDATE_MIN,
): PantryCandidate[] {
  const out: PantryCandidate[] = [];
  for (const item of Object.values(pantry?.items ?? {})) {
    const score = nameSimilarity(query, item.name);
    if (score >= minScore) out.push({ item, score: round1(score * 100) / 100 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(0, limit));
}

// Collapse to lowercase alphanumerics so separator/spacing differences don't
// defeat a match: "hyper_mass", "Hyper Mass", "hyper-mass" all → "hypermass".
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Lowercase alphanumeric word tokens, e.g. "Biotech USA Hyper-Mass" →
// ["biotech", "usa", "hyper", "mass"].
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Similarity in [0,1] between a query and a stored name. Blends two signals
// and takes the stronger: a Dice coefficient over token sets (handles word
// order and extra/missing words) and a Jaro-Winkler character score on the
// separator-stripped strings (handles typos, and rewards a shared prefix —
// brand/food names usually agree at the front). Either alone is enough.
function nameSimilarity(query: string, key: string): number {
  const qn = normalizeForMatch(query);
  const kn = normalizeForMatch(key);
  if (!qn || !kn) return 0;

  const charSim = jaroWinkler(qn, kn);

  const qt = new Set(tokenize(query));
  const kt = new Set(tokenize(key));
  let inter = 0;
  for (const t of qt) if (kt.has(t)) inter++;
  const tokenSim = qt.size + kt.size > 0 ? (2 * inter) / (qt.size + kt.size) : 0;

  return Math.max(charSim, tokenSim);
}

// Jaro-Winkler string similarity in [0,1]. Jaro counts matched characters
// (within a sliding window) and transpositions; Winkler boosts strings that
// share a leading prefix. Better than raw edit distance on short names, which
// is exactly what food/brand strings are. Inputs are short, so cost is trivial.
function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length,
    lb = b.length;
  if (!la || !lb) return 0;

  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - range);
    const end = Math.min(i + range + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions: matched chars that appear out of order.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro = (matches / la + matches / lb + (matches - transpositions) / matches) / 3;

  // Winkler prefix bonus: up to 4 leading chars, scaling factor 0.1.
  let prefix = 0;
  const maxPrefix = Math.min(4, la, lb);
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Parse a gram/ml quantity out of an OpenFoodFacts-style serving_size string
// so we can store it as grams_per_serving and answer "one serving" without
// asking. Examples:
//   "65 g"            → 65
//   "30g"             → 30
//   "1 scoop (65 g)"  → 65   (prefers the metric weight behind a measure)
//   "0,5 cup (120 g)" → 120  (comma decimals, as some EU locales use)
// Returns null when there's no g/ml quantity to extract.
export function parseServingGrams(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const str = String(raw);
  const re = /(\d+(?:[.,]\d+)?)\s*(?:g|gram|grams|ml|milliliters?|millilitres?)\b/gi;
  let firstSeen: number | null = null;
  let insideParens: number | null = null;
  for (const m of str.matchAll(re)) {
    const val = parseFloat(m[1].replace(",", "."));
    if (!Number.isFinite(val) || val <= 0) continue;
    if (firstSeen == null) firstSeen = val;
    const before = str.slice(0, m.index ?? 0);
    const open = (before.match(/\(/g) ?? []).length;
    const close = (before.match(/\)/g) ?? []).length;
    if (open > close) insideParens = val; // a weight written inside "( … )"
  }
  return insideParens ?? firstSeen;
}

// Strip non-digits and trim — UPC/EAN/GTIN are digit strings of 8/12/13/14.
// Keeping the normalization here so callers don't have to know the format.
export function normalizeBarcode(raw: string): string {
  return String(raw).replace(/\D+/g, "");
}

export function lookupPantryByBarcode(pantry: Pantry | null, barcode: string): PantryItem | null {
  const norm = normalizeBarcode(barcode);
  if (!norm) return null;
  for (const v of Object.values(pantry?.items ?? {})) {
    if (v.barcode && v.barcode === norm) return v;
  }
  return null;
}

export function macrosFor(food: Macros, grams: number): Macros {
  const factor = grams / 100;
  const out: Macros = {
    kcal: round1(food.kcal * factor),
    p: round1(food.p * factor),
    f: round1(food.f * factor),
    c: round1(food.c * factor),
  };
  if (food.fiber != null) out.fiber = round1(food.fiber * factor);
  return out;
}

// Fiber: sum only when at least one input carries a known value. Keeping
// the field absent (vs zero) lets downstream tell "no fiber data tracked"
// apart from "ate truly zero fiber".
export function sumMacros(items: Partial<Macros>[]): Macros {
  let kcal = 0,
    p = 0,
    f = 0,
    c = 0;
  let fiberSum = 0;
  let anyFiber = false;
  for (const it of items) {
    kcal += Number(it.kcal ?? 0);
    p += Number(it.p ?? 0);
    f += Number(it.f ?? 0);
    c += Number(it.c ?? 0);
    if (it.fiber != null) {
      fiberSum += Number(it.fiber);
      anyFiber = true;
    }
  }
  const out: Macros = {
    kcal: round1(kcal),
    p: round1(p),
    f: round1(f),
    c: round1(c),
  };
  if (anyFiber) out.fiber = round1(fiberSum);
  return out;
}

export function remainingMacros(target: Macros, eaten: Macros): Macros {
  const out: Macros = {
    kcal: round1(target.kcal - eaten.kcal),
    p: round1(target.p - eaten.p),
    f: round1(target.f - eaten.f),
    c: round1(target.c - eaten.c),
  };
  if (target.fiber != null) {
    out.fiber = round1(target.fiber - (eaten.fiber ?? 0));
  }
  return out;
}

// Resolve a food from the pantry and scale its per-100 macros to `grams`.
// Returns null when the food isn't in the pantry or has no macros recorded.
export function buildMealItem(pantry: Pantry | null, food: string, grams: number): MealItem | null {
  const entry = lookupPantryItem(pantry, food);
  if (!entry?.macros) return null;
  const m = macrosFor(entry.macros, grams);
  return { food: entry.name, grams, ...m, source: "db" };
}

// Resolve a planned Portion to absolute macros: an explicit override wins;
// otherwise scale the pantry definition live. `null` means the portion needs
// enrichment (food missing from pantry / no macros recorded) — surface it,
// never crash, never count it as zero.
export function resolvePortion(pantry: Pantry | null, portion: Portion): Macros | null {
  if (portion.macros) return portion.macros;
  const item = buildMealItem(pantry, portion.food, portion.grams);
  if (!item) return null;
  const m: Macros = { kcal: item.kcal, p: item.p, f: item.f, c: item.c };
  if (item.fiber != null) m.fiber = item.fiber;
  return m;
}

// snake_case a free-text food name into a stable pantry key ("Fage Greek
// Yoghurt 0%" → "fage_greek_yoghurt_0").
export function toPantryKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// snake_case → human-readable display.
//   chicken_breast_raw     → "Chicken breast (raw)"
//   greek_yogurt_2pct      → "Greek yogurt 2%"
//   whey_protein           → "Whey protein"
//   biotech_usa_hyper_mass → "Biotech USA Hyper Mass"
//
// Trailing state words (_raw, _cooked, _dry, _dried) are bracketed because
// they're preparation modifiers, not part of the food's identity. Common
// brand acronyms (usa, uk, eu, ifc) get uppercased.
const PREP_SUFFIXES = new Set([
  "raw",
  "cooked",
  "dry",
  "dried",
  "boiled",
  "roasted",
  "fried",
  "grilled",
  "baked",
  "steamed",
]);
const UPPERCASE_TOKENS = new Set(["usa", "uk", "eu", "us", "bcaa", "eaa", "mct", "co2"]);

export function humanizeFoodName(snake: string): string {
  if (!snake) return "";
  const tokens = snake.split(/[_\s]+/).filter(Boolean);
  if (!tokens.length) return snake;

  // Strip + remember a trailing preparation modifier so it can be bracketed.
  let suffix: string | null = null;
  if (tokens.length > 1 && PREP_SUFFIXES.has(tokens[tokens.length - 1])) {
    suffix = tokens.pop()!;
  }

  // Pretty-print each token: percentages (2pct → 2%), brand acronyms, otherwise
  // capitalize first letter only (proper noun feel without aggressive title-casing).
  const pretty = tokens.map((t, i) => {
    const pctMatch = t.match(/^(\d+(?:\.\d+)?)pct$/);
    if (pctMatch) return `${pctMatch[1]}%`;
    if (UPPERCASE_TOKENS.has(t)) return t.toUpperCase();
    if (i === 0) return t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  });

  return suffix ? `${pretty.join(" ")} (${suffix})` : pretty.join(" ");
}

export const FOOD_CATEGORIES = [
  "protein",
  "dairy",
  "legume",
  "grain",
  "starch",
  "fruit",
  "vegetable",
  "fat",
  "nut",
  "condiment",
  "beverage",
  "supplement",
  "sweet",
  "other",
] as const;

export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

// Human-readable labels for the predefined category enum. Kept here so the
// agent's tool schemas and the web UI render the same wording.
export const CATEGORY_LABELS: Record<FoodCategory, string> = {
  protein: "Protein",
  dairy: "Dairy",
  legume: "Legumes",
  grain: "Grains",
  starch: "Starches",
  fruit: "Fruit",
  vegetable: "Vegetables",
  fat: "Fats & oils",
  nut: "Nuts & seeds",
  condiment: "Condiments",
  beverage: "Beverages",
  supplement: "Supplements",
  sweet: "Sweets",
  other: "Other",
};

export function humanizeCategory(c: string | null | undefined): string {
  if (!c) return "Uncategorized";
  if (c in CATEGORY_LABELS) return CATEGORY_LABELS[c as FoodCategory];
  return c.charAt(0).toUpperCase() + c.slice(1);
}

export const CATEGORY_ENUM_LABELS: string[] = FOOD_CATEGORIES.map((c) => CATEGORY_LABELS[c]);
