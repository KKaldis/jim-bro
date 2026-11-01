import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { humanizeCategory, humanizeFoodName } from "@fa/shared";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getFoods, getFoodsLookup } from "@/api/endpoints/default/default";
import { runTool } from "@/lib/runTool";

// Shared meal/portion controls, factored out of LogMealForm so the diet-plan
// forms (save_diet_plan portions, add/update_diet_portion) reuse the exact same
// food combobox + live macro math instead of re-implementing them.

// Loose typing of /foods response. Keys are canonical food names; values are
// the per-100g macro profile lookup_food returns. Extra fields are tolerated.
export type FoodEntry = {
  kcal: number;
  p: number;
  f: number;
  c: number;
  fiber?: number;
  category?: string;
};
export type FoodDb = Record<string, FoodEntry>;

// A portion / meal item: a food (by canonical name) + grams, with optional
// absolute macro overrides for foods not in the pantry.
export type Portion = {
  food?: string;
  grams?: number;
  kcal?: number;
  p?: number;
  f?: number;
  c?: number;
  fiber?: number;
};

// Live macros for one portion: pantry-resolved (per-100g × grams) unless the
// portion carries an absolute override, falling back to overrides-or-zero when
// the food isn't known.
export function macrosForItem(item: Portion, db: FoodDb) {
  if (item.food && db[item.food] && typeof item.grams === "number") {
    const f = db[item.food];
    const g = item.grams / 100;
    return {
      kcal: item.kcal ?? f.kcal * g,
      p: item.p ?? f.p * g,
      f: item.f ?? f.f * g,
      c: item.c ?? f.c * g,
      fiber: item.fiber ?? (f.fiber != null ? f.fiber * g : undefined),
    };
  }
  return {
    kcal: item.kcal ?? 0,
    p: item.p ?? 0,
    f: item.f ?? 0,
    c: item.c ?? 0,
    fiber: item.fiber,
  };
}

// One row of the food index search (GET /foods/lookup → lookup_product summary,
// OpenFoodFacts + USDA). `per_100g` is null when the nutriments are incomplete.
type IndexHit = {
  name: string;
  brand: string | null;
  barcode: string | null;
  suggested_snake_name: string;
  per_100g: { kcal: number; p: number; f: number; c: number; fiber?: number } | null;
};

// Every mounted useFoodDb() hears about foods a FoodPicker added to the catalog,
// so the new entry resolves macros immediately without refetching /foods.
const foodAddedListeners = new Set<(name: string, entry: FoodEntry) => void>();

// Add a food-index hit to the user's catalog (the pantry) with its per-100g
// macros + barcode, so portions referencing it resolve live like any pantry
// food. No quantity: new rows default to 0 on hand, and merge leaves an
// existing row's stock alone. Returns the canonical name, or null on failure.
async function addIndexHitToCatalog(hit: IndexHit): Promise<string | null> {
  if (!hit.per_100g) return null;
  const name = hit.suggested_snake_name;
  const error = await runTool("update_pantry", {
    items: {
      [name]: { macros: hit.per_100g, ...(hit.barcode ? { barcode: hit.barcode } : {}) },
    },
    mode: "merge",
  });
  if (error) return null;
  for (const listener of foodAddedListeners) listener(name, { ...hit.per_100g });
  return name;
}

// Fetch the user's food catalog once for autocomplete + macro preview. Returns
// the map and its sorted name list; degrades to empty (free-text still works).
export function useFoodDb(): { db: FoodDb; foodNames: string[] } {
  const [db, setDb] = useState<FoodDb>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = (await getFoods()) as unknown as FoodDb;
        if (!cancelled && body && typeof body === "object") setDb((prev) => ({ ...body, ...prev }));
      } catch {
        // Autocomplete just won't have suggestions.
      }
    })();
    const onAdded = (name: string, entry: FoodEntry) =>
      setDb((prev) => ({ ...prev, [name]: entry }));
    foodAddedListeners.add(onAdded);
    return () => {
      cancelled = true;
      foodAddedListeners.delete(onAdded);
    };
  }, []);
  const foodNames = useMemo(() => Object.keys(db).sort(), [db]);
  return { db, foodNames };
}

const GROUP_HEADER =
  "sticky top-0 bg-popover px-2 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground";

// Combobox for the canonical snake_case food id. Shows the humanized label to
// the user but stores/returns the canonical name, so the backend contract is
// unchanged. Falls back to free text for a brand-new food the agent resolves.
export function FoodPicker({
  value,
  foodNames,
  db,
  disabled,
  onChange,
}: {
  value: string;
  foodNames: string[];
  db: FoodDb;
  disabled?: boolean;
  onChange: (canonical: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // null = display reflects `value`; string = user is mid-edit. Cleared on commit.
  const [query, setQuery] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const known = !!value && db[value] != null;
  const displayValue = query ?? (known ? humanizeFoodName(value) : value);

  const filtered = useMemo(() => {
    const q = (query ?? "").toLowerCase().trim();
    if (!q) return foodNames.slice(0, 50);
    return foodNames
      .filter((n) => n.toLowerCase().includes(q) || humanizeFoodName(n).toLowerCase().includes(q))
      .slice(0, 50);
  }, [foodNames, query]);

  // Debounced food-index search (OpenFoodFacts + USDA) alongside the pantry
  // filter, so a food the user doesn't have yet can still be picked. Rendered
  // below the pantry matches; silent on error (pantry + free text still work).
  const [hits, setHits] = useState<IndexHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const term = (query ?? "").trim();
    if (!open || term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const json = (await getFoodsLookup({ query: term })) as {
            error?: string;
            product?: IndexHit;
            results?: IndexHit[];
          };
          if (cancelled) return;
          setHits(json.error ? [] : (json.results ?? (json.product ? [json.product] : [])));
        } catch {
          if (!cancelled) setHits([]);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  // Only hits we can resolve macros for, minus ones already in the catalog
  // (those show — and are picked — as pantry foods).
  const indexHits = useMemo(
    () =>
      hits.filter(
        // An all-non-Latin name snakeizes to "" — no usable pantry key.
        (h) => h.per_100g != null && !!h.suggested_snake_name && db[h.suggested_snake_name] == null,
      ),
    [hits, db],
  );

  const commit = (canonical: string) => {
    onChange(canonical);
    setQuery(null);
    setOpen(false);
  };

  const pickHit = async (hit: IndexHit) => {
    setAdding(true);
    const name = await addIndexHitToCatalog(hit);
    setAdding(false);
    if (name) commit(name);
  };

  const showIndexGroup = indexHits.length > 0 || searching;

  return (
    <div ref={rootRef} className="relative">
      <Input
        value={displayValue}
        disabled={disabled}
        placeholder={t("forms.mealControls.foodName")}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          if (query == null) return;
          const trimmed = query.trim();
          // Focusing clears the field to `""` to start a fresh search; blurring
          // WITHOUT typing anything must not commit that empty value (it would
          // wipe the current food). Treat an empty query as "no change" and
          // restore the display to the existing value.
          if (trimmed === "") {
            setQuery(null);
            return;
          }
          const lower = trimmed.toLowerCase();
          const match =
            foodNames.find((n) => n.toLowerCase() === lower) ??
            foodNames.find((n) => humanizeFoodName(n).toLowerCase() === lower);
          onChange(match ?? trimmed);
          setQuery(null);
        }}
        className="h-9"
      />
      {open && (filtered.length > 0 || showIndexGroup) && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover shadow-overlay"
        >
          {showIndexGroup && filtered.length > 0 && (
            <li role="presentation" className={GROUP_HEADER}>
              {t("forms.mealControls.pantryGroup")}
            </li>
          )}
          {filtered.map((n) => {
            const cat = db[n]?.category;
            return (
              <li
                key={n}
                role="option"
                aria-selected={n === value}
                className={cn(
                  "cursor-pointer px-2 py-1.5 hover:bg-accent",
                  n === value && "bg-accent/50",
                )}
                onMouseDown={(e) => {
                  // mousedown beats blur — keeps the picked value from being
                  // overwritten by the input's onBlur free-text fallback.
                  e.preventDefault();
                  commit(n);
                }}
              >
                <div className="text-sm">{humanizeFoodName(n)}</div>
                <div className="text-[10px] text-muted-foreground">
                  {n}
                  {cat ? ` · ${humanizeCategory(cat)}` : ""}
                </div>
              </li>
            );
          })}
          {showIndexGroup && (
            <li role="presentation" className={GROUP_HEADER}>
              {searching || adding
                ? t("forms.mealControls.searchingIndex")
                : t("forms.mealControls.indexGroup")}
            </li>
          )}
          {indexHits.map((h) => (
            <li
              key={`${h.suggested_snake_name}:${h.barcode ?? ""}`}
              role="option"
              aria-selected={false}
              aria-disabled={adding}
              className={cn(
                "cursor-pointer px-2 py-1.5 hover:bg-accent",
                adding && "pointer-events-none opacity-50",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                void pickHit(h);
              }}
            >
              <div className="text-sm">{[h.brand, h.name].filter(Boolean).join(" — ")}</div>
              <div className="text-[10px] text-muted-foreground">
                {t("forms.mealControls.per100", { kcal: Math.round(h.per_100g!.kcal) })}
                {" · "}
                {t("forms.mealControls.addsToPantry")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
