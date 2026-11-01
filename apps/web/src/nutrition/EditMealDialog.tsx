// Edit a logged meal's slot, time and items.
import { humanizeFoodName } from "@fa/shared";
import { ChefHat, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { MacroBars } from "../Dashboard";
import { Button } from "../components/ui/button";
import { TimeInput } from "../components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { isoToDisplay } from "../lib/dateFormat";
import { isMealSlot, MEAL_SLOTS } from "../lib/mealSlots";
import { runTool } from "../lib/runTool";
import { useDayEnergy } from "./DayView";
import { type Day, dayTargets, type Macros, type Meal, type MealItem, sumItems } from "./shared";

// Editable working copy of a meal item: the food keeps its identity + original
// portion/macros, so macros rescale proportionally as the grams change (works
// for catalog and manual items alike, since we send the resulting macros
// inline to update_meal rather than relying on a re-lookup).
type EditItem = {
  food: string;
  display: string;
  grams: number;
  // log_recipe grouping tag, echoed back so saving keeps the recipe grouped.
  recipe?: MealItem["recipe"];
  base: {
    g0: number;
    kcal: number;
    p: number;
    f: number;
    c: number;
    fiber?: number;
  };
};

export function EditMealDialog({
  day,
  date,
  slot,
  meal,
  mealIndex,
  onClose,
  onSaved,
}: {
  // The day the meal belongs to — its totals + target drive the live macro bars.
  day: Day;
  date: string;
  slot: string;
  meal: Meal;
  // Stable position of this meal in the day's list — sent as meal_index so the
  // update/delete targets exactly this meal, not a slot+time-ambiguous sibling.
  mealIndex: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<EditItem[]>(() =>
    meal.items.map((it) => ({
      food: it.food,
      display: it.display_name ?? humanizeFoodName(it.food),
      grams: it.grams,
      ...(it.recipe ? { recipe: it.recipe } : {}),
      base: {
        g0: it.grams,
        kcal: it.kcal,
        p: it.p,
        f: it.f,
        c: it.c,
        ...(it.fiber != null ? { fiber: it.fiber } : {}),
      },
    })),
  );
  // The slot picker offers the canonical slots plus "custom…" (a free-text
  // name, like LogRecipeForm). A meal logged under a free-text slot opens in
  // custom mode with its name prefilled, so editing it never drops the name.
  const canonicalSlot = isMealSlot(slot.toLowerCase()) ? slot.toLowerCase() : null;
  const [slotName, setSlotName] = useState(canonicalSlot ?? slot);
  const slotIsCustom = !isMealSlot(slotName);
  const [time, setTime] = useState(meal.time ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setGrams = (idx: number, v: number) =>
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, grams: v } : it)));
  const removeItem = (idx: number) => setItems((arr) => arr.filter((_, i) => i !== idx));

  // A meal logged from a recipe (every item carries the same recipe tag) gets a
  // single TOTAL weight control: weigh the plate, type it, and every ingredient
  // rescales in proportion — nobody wants to work out each ingredient's share.
  // Grams stay unrounded in state so repeated rescales don't drift.
  const recipeName =
    meal.items.length > 0 &&
    meal.items.every((it) => it.recipe && it.recipe.slug === meal.items[0].recipe?.slug)
      ? meal.items[0].recipe!.name
      : null;
  const totalGrams = items.reduce((sum, it) => sum + (Number.isFinite(it.grams) ? it.grams : 0), 0);
  const [totalText, setTotalText] = useState(() => String(Math.round(totalGrams)));
  const setTotal = (text: string) => {
    setTotalText(text);
    const next = Number(text);
    if (!Number.isFinite(next) || next <= 0 || totalGrams <= 0) return;
    const ratio = next / totalGrams;
    setItems((arr) => arr.map((it) => ({ ...it, grams: it.grams * ratio })));
  };
  // Per-item edits / removals change the sum — reflect it in the total box,
  // unless the box itself is what's driving the change.
  useEffect(() => {
    if (Math.round(Number(totalText)) !== Math.round(totalGrams)) {
      setTotalText(String(Math.round(totalGrams)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalGrams]);

  // Scale an item's macros by how its grams changed from what was logged.
  function scaled(it: EditItem): Macros {
    const ratio = it.base.g0 > 0 ? it.grams / it.base.g0 : 0;
    return {
      kcal: it.base.kcal * ratio,
      p: it.base.p * ratio,
      f: it.base.f * ratio,
      c: it.base.c * ratio,
      ...(it.base.fiber != null ? { fiber: it.base.fiber * ratio } : {}),
    };
  }

  const mealTotal = items.reduce(
    (acc, it) => {
      const m = scaled(it);
      return { kcal: acc.kcal + m.kcal, p: acc.p + m.p, f: acc.f + m.f, c: acc.c + m.c };
    },
    { kcal: 0, p: 0, f: 0, c: 0 },
  );

  // Live day preview: the day's totals with this meal swapped for its edited
  // version, drawn as a projection over the committed totals so the bars grow
  // or shrink as portions change.
  const { goalTarget } = useDayEnergy(date);
  const { target: dayTarget } = dayTargets(day, goalTarget);
  const original = sumItems(meal.items).total;
  const edited = sumItems(
    items.map((it) => ({ grams: it.grams, ...scaled(it) }) as MealItem),
  ).total;
  const dayAfter: Macros = {
    kcal: day.eaten.kcal - original.kcal + edited.kcal,
    p: day.eaten.p - original.p + edited.p,
    f: day.eaten.f - original.f + edited.f,
    c: day.eaten.c - original.c + edited.c,
    ...(day.eaten.fiber != null || edited.fiber != null
      ? { fiber: (day.eaten.fiber ?? 0) - (original.fiber ?? 0) + (edited.fiber ?? 0) }
      : {}),
  };

  async function save() {
    setErr(null);
    for (const it of items) {
      if (!Number.isFinite(it.grams) || it.grams <= 0) {
        setErr(t("nutrition.editMeal.gramsInvalid"));
        return;
      }
    }
    const newSlot = slotName.trim();
    if (items.length > 0 && !newSlot) {
      setErr(t("nutrition.editMeal.slotRequired"));
      return;
    }
    setSaving(true);
    let error: string | null;
    if (items.length === 0) {
      // Removing every item is a delete, not an update (update_meal rejects an
      // empty item list).
      error = await runTool("delete_meal", {
        date,
        slot,
        meal_index: mealIndex,
        ...(meal.time ? { time: meal.time } : {}),
      });
    } else {
      const outItems = items.map((it) => {
        const m = scaled(it);
        return {
          food: it.food,
          grams: Math.round(it.grams * 10) / 10,
          ...(it.recipe ? { recipe: it.recipe } : {}),
          kcal: Math.round(m.kcal),
          p: Math.round(m.p * 10) / 10,
          f: Math.round(m.f * 10) / 10,
          c: Math.round(m.c * 10) / 10,
          ...(m.fiber != null ? { fiber: Math.round(m.fiber * 10) / 10 } : {}),
        };
      });
      // meal_index targets exactly this meal; slot/time are still sent for the
      // rename/retime logic below and as a harmless fallback.
      const input: Record<string, unknown> = { date, slot, meal_index: mealIndex, items: outItems };
      if (meal.time) input.time = meal.time;
      if (newSlot !== slot) input.new_slot = newSlot;
      const newTime = time.trim();
      // Empty string clears the time; only send when it actually changed.
      if (newTime !== (meal.time ?? "")) input.new_time = newTime;
      error = await runTool("update_meal", input);
    }
    setSaving(false);
    if (error) {
      setErr(error);
      return;
    }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="modal-cap flex flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("nutrition.editMeal.title", { date: isoToDisplay(date) })}</DialogTitle>
          <DialogDescription>{t("nutrition.editMeal.description")}</DialogDescription>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1">
          {items.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              {t("nutrition.editMeal.noItemsLeft")}
            </p>
          ) : (
            items.map((it, idx) => {
              const m = scaled(it);
              return (
                <div
                  key={`${it.food}-${idx}`}
                  className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{it.display}</div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">
                      {m.kcal.toFixed(0)} kcal · P {m.p.toFixed(0)} · C {m.c.toFixed(0)} · F{" "}
                      {m.f.toFixed(0)}
                    </div>
                  </div>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={Number.isFinite(it.grams) ? Math.round(it.grams * 10) / 10 : ""}
                    disabled={saving}
                    onChange={(e) =>
                      setGrams(idx, e.target.value === "" ? NaN : Number(e.target.value))
                    }
                    className="h-8 w-20 text-end text-sm tabular-nums"
                    aria-label={t("nutrition.editMeal.gramsOf", { name: it.display })}
                  />
                  <span className="text-xs text-muted-foreground">g</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    disabled={saving}
                    onClick={() => removeItem(idx)}
                    aria-label={t("nutrition.editMeal.remove", { name: it.display })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })
          )}
        </div>

        {recipeName && items.length > 0 && (
          // Same row shape as the items above (name + macros left, grams right),
          // tinted so the TOTAL reads as the primary control.
          <div
            className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5"
            title={t("nutrition.editMeal.recipeTotalHint")}
          >
            <ChefHat aria-hidden className="size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{recipeName}</div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {t("nutrition.editMeal.total")} · {mealTotal.kcal.toFixed(0)} kcal · P{" "}
                {mealTotal.p.toFixed(0)} · C {mealTotal.c.toFixed(0)} · F {mealTotal.f.toFixed(0)}
              </div>
            </div>
            <Input
              type="number"
              inputMode="decimal"
              value={totalText}
              disabled={saving}
              onChange={(e) => setTotal(e.target.value)}
              className="h-8 w-20 border-primary/50 text-end text-sm font-semibold tabular-nums"
              aria-label={t("nutrition.editMeal.recipeTotal", { name: recipeName })}
            />
            <span className="text-xs text-muted-foreground">g</span>
            {/* Spacer matching the items' delete-button column. */}
            <span aria-hidden className="size-8 shrink-0" />
          </div>
        )}

        <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
          <div className="text-xs font-medium">{t("nutrition.editMeal.dayAfterEdit")}</div>
          <MacroBars eaten={day.eaten} target={dayTarget} projected={dayAfter} showPct />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t("nutrition.editMeal.slot")}</Label>
            <Select
              value={slotIsCustom ? "__custom" : slotName}
              onValueChange={(next) => {
                // Switching to custom keeps the current name as a starting point.
                if (next !== "__custom") setSlotName(next);
                else if (!slotIsCustom) setSlotName("");
              }}
              disabled={saving}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEAL_SLOTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
                <SelectItem value="__custom">{t("forms.logMeal.custom")}</SelectItem>
              </SelectContent>
            </Select>
            {slotIsCustom && (
              <Input
                autoFocus={slotName === ""}
                value={slotName}
                disabled={saving}
                placeholder={t("forms.logMeal.slotName")}
                onChange={(e) => setSlotName(e.target.value)}
                className="h-9"
              />
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t("nutrition.editMeal.time")}</Label>
            <TimeInput value={time} disabled={saving} onChange={(hhmm) => setTime(hhmm || "")} />
          </div>
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>
            {saving ? t("common.saving") : t("nutrition.editMeal.saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
