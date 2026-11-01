import type { DietPlan, Pantry, PantryItem } from "./types.ts";
import { dietDayForDate } from "./diet.ts";

// Grams on hand for a pantry item. g/ml count 1:1; pcs convert via the
// per-serving weight (unknown → 0 so the item reads as "need to buy").
function gramsOnHand(item: PantryItem): number {
  if (item.unit === "pcs") return (item.grams_per_serving ?? 0) * item.quantity;
  return item.quantity;
}

export type ShoppingRow = {
  food: string;
  grams_needed: number;
  grams_on_hand: number;
  grams_to_buy: number;
  // True when the pantry item is explicitly flagged to restock (to_buy),
  // independent of whether the diet plan needs it this window.
  flagged: boolean;
};

export type ShoppingList = {
  from_date: string;
  days: number;
  use_pantry: boolean;
  items: ShoppingRow[];
  to_buy_only: ShoppingRow[];
};

export function buildShoppingList(opts: {
  plan: DietPlan;
  fromDate: string;
  days: number;
  pantry?: Pantry | null;
}): ShoppingList {
  const { plan, fromDate, days, pantry } = opts;
  const usePantry = !!pantry;
  const needed: Record<string, number> = {};

  const start = new Date(fromDate + "T00:00:00");
  for (let off = 0; off < days; off++) {
    const d = new Date(start.getTime() + off * 86_400_000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    const tpl = dietDayForDate(plan, iso);
    if (!tpl) continue;
    for (const meal of tpl.meals ?? []) {
      for (const item of meal.items ?? []) {
        const name = item.food;
        const grams = Number(item.grams ?? 0);
        if (!name || grams <= 0) continue;
        needed[name] = (needed[name] ?? 0) + grams;
      }
    }
  }

  const pantryItems = pantry?.items ?? {};
  const items: ShoppingRow[] = Object.keys(needed)
    .sort()
    .map((name) => {
      const totalG = needed[name];
      const it = pantryItems[name];
      const onHand = usePantry && it ? gramsOnHand(it) : 0;
      const deficit = Math.max(0, Math.round(totalG - onHand));
      return {
        food: name,
        grams_needed: Math.round(totalG),
        grams_on_hand: Math.round(onHand),
        grams_to_buy: deficit,
        flagged: !!it?.to_buy,
      };
    });

  // Pantry items the user explicitly flagged to restock (to_buy) but that the
  // plan doesn't already cover — surface them on the buy list regardless.
  const inList = new Set(items.map((r) => r.food));
  for (const [name, it] of Object.entries(pantryItems)) {
    if (!it.to_buy || inList.has(name)) continue;
    const onHand = gramsOnHand(it);
    items.push({
      food: name,
      grams_needed: 0,
      grams_on_hand: Math.round(onHand),
      grams_to_buy: 0,
      flagged: true,
    });
  }
  items.sort((a, b) => a.food.localeCompare(b.food));

  return {
    from_date: fromDate,
    days,
    use_pantry: usePantry,
    items,
    to_buy_only: items.filter((r) => r.grams_to_buy > 0 || r.flagged),
  };
}
