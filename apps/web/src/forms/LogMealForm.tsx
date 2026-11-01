import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, Utensils } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker, TimeInput } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";
import { useFormContext } from "./formContext";
import { LogMacroPreview } from "./LogMacroPreview";
import { FoodPicker, macrosForItem, useFoodDb, type Portion } from "./mealControls";
import type { JsonSchema } from "./ToolForm";
import type { ToolOverrideProps } from "./overrides";
import { MEAL_SLOTS } from "../lib/mealSlots";

type MealItem = Portion;

type MealInput = {
  date?: string;
  slot?: string;
  time?: string;
  items?: MealItem[];
  // update_meal only: slot/time above identify the meal to find; these rename
  // it. Surfaced through the same slot/time controls in update mode.
  new_slot?: string;
  new_time?: string;
  // update_meal's item-patch path: change one or more items (by name) without
  // restating the whole list. A single object or an array. Mutually exclusive
  // with `items`.
  update_item?: MealItem | MealItem[];
};

export function LogMealForm({ schema, value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const meal = (value as MealInput) ?? {};
  const { ctx } = useFormContext();
  // useMemo so the `[]` fallback keeps a stable identity across renders;
  // otherwise the totals useMemo below would recompute every render.
  const items = useMemo(() => meal.items ?? [], [meal.items]);
  // When the model proposes an item patch (update_meal's update_item), render a
  // focused editor for the patched item(s) instead of the full items list —
  // they're mutually exclusive, so the list is empty in this mode and would
  // otherwise show "No items yet" while the proposed change stayed invisible.
  // update_item is either one patch or an array of them (a multi-item edit is a
  // single tool call); normalize to a list and remember the original shape so
  // edits write back in kind.
  const patchIsArray = Array.isArray(meal.update_item);
  const patches = useMemo<MealItem[]>(
    () =>
      Array.isArray(meal.update_item)
        ? meal.update_item
        : meal.update_item != null
          ? [meal.update_item]
          : [],
    [meal.update_item],
  );
  const isPatch = patches.length > 0;

  // Per-field help text from the tool's JSON Schema for the (i) hints.
  const props = (schema as JsonSchema | undefined)?.properties ?? {};
  const fieldDesc = (key: string) => props[key]?.description;
  const itemDesc = (key: string) => props.items?.items?.properties?.[key]?.description;

  const { db, foodNames } = useFoodDb();

  const updatePatch = (idx: number, p: Partial<MealItem>) => {
    const next = patches.slice();
    next[idx] = { ...next[idx], ...p };
    // Preserve the shape the model sent: a lone patch stays an object so the
    // backend's single-item path is unaffected; a batch stays an array.
    onChange({ ...meal, update_item: patchIsArray ? next : next[0] });
  };
  const totals = useMemo(() => {
    let kcal = 0,
      p = 0,
      f = 0,
      c = 0,
      fiber = 0,
      anyFiber = false;
    for (const it of items) {
      const m = macrosForItem(it, db);
      kcal += m.kcal;
      p += m.p;
      f += m.f;
      c += m.c;
      if (m.fiber != null) {
        fiber += m.fiber;
        anyFiber = true;
      }
    }
    return { kcal, p, f, c, fiber: anyFiber ? fiber : null };
  }, [items, db]);

  const update = (patch: Partial<MealInput>) => onChange({ ...meal, ...patch });

  const updateItem = (idx: number, patch: Partial<MealItem>) => {
    const next = items.slice();
    next[idx] = { ...next[idx], ...patch };
    update({ items: next });
  };

  const removeItem = (idx: number) => {
    const next = items.slice();
    next.splice(idx, 1);
    update({ items: next });
  };

  const addItem = () => update({ items: [...items, { food: "", grams: 100 }] });

  // update_meal vs log_meal: only update_meal's schema carries new_slot /
  // new_time / update_item. In update mode `slot` + `time` are the IDENTITY
  // (which logged meal to find) and must stay fixed; the user-facing slot/time
  // controls instead drive `new_slot` / `new_time` (the rename target). Binding
  // them to `slot` directly — as a plain log_meal would — silently re-targets a
  // non-existent meal ("move dinner→lunch" looked up slot=lunch and errored,
  // making the agent retry and the gate reappear). The date is identity-only in
  // update mode (there's no new_date), so it's read-only there.
  const isUpdate = props.new_slot != null || props.update_item != null;
  const effSlot = isUpdate ? (meal.new_slot ?? meal.slot) : meal.slot;
  const effTime = isUpdate ? (meal.new_time ?? meal.time) : meal.time;
  const setSlot = (v: string | undefined) => update(isUpdate ? { new_slot: v } : { slot: v });
  const setTime = (v: string | undefined) => update(isUpdate ? { new_time: v } : { time: v });

  const slotIsCustom =
    effSlot != null && !MEAL_SLOTS.includes(effSlot as (typeof MEAL_SLOTS)[number]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {t("forms.logMeal.slot")} *{fieldDesc("slot") && <InfoHint text={fieldDesc("slot")!} />}
          </Label>
          <Select
            value={slotIsCustom ? "__custom" : (effSlot ?? "")}
            onValueChange={(v) => {
              if (v === "__custom") setSlot(effSlot ?? "");
              else setSlot(v);
            }}
            disabled={disabled}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder={t("forms.logMeal.choose")} />
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
              value={effSlot ?? ""}
              disabled={disabled}
              placeholder={t("forms.logMeal.slotName")}
              onChange={(e) => setSlot(e.target.value || undefined)}
              className="h-9"
            />
          )}
        </div>
        <div className="space-y-1">
          <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {t("forms.logMeal.time")}
            {fieldDesc("time") && <InfoHint text={fieldDesc("time")!} />}
          </Label>
          <TimeInput
            value={effTime ?? ""}
            disabled={disabled}
            onChange={(hhmm) => setTime(hhmm || undefined)}
          />
        </div>
        <div className="space-y-1">
          <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {t("forms.logMeal.date")}
            {fieldDesc("date") && <InfoHint text={fieldDesc("date")!} />}
          </Label>
          <DatePicker
            value={meal.date ?? ""}
            disabled={disabled || isUpdate}
            onChange={(iso) => update({ date: iso || undefined })}
          />
        </div>
      </div>

      {isPatch && (
        <div className="space-y-1.5">
          <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {patches.length > 1
              ? t("forms.logMeal.updateItems", { count: patches.length })
              : t("forms.logMeal.updateItem")}{" "}
            *{props.update_item?.description && <InfoHint text={props.update_item.description} />}
          </Label>
          {patches.map((patch, idx) => {
            const patchMacros = macrosForItem(patch, db);
            const patchKnown = patch.food != null && db[patch.food] != null;
            return (
              <div
                key={idx}
                className="rounded-md border border-edge bg-background/40 p-2 shadow-well"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <FoodPicker
                      value={patch.food ?? ""}
                      foodNames={foodNames}
                      db={db}
                      disabled={disabled}
                      onChange={(canonical) => updatePatch(idx, { food: canonical })}
                    />
                  </div>
                  <div className="w-24">
                    <Input
                      type="number"
                      step="any"
                      value={patch.grams ?? ""}
                      disabled={disabled}
                      placeholder={t("forms.logMeal.gramsPlaceholder")}
                      onChange={(e) => {
                        const v = e.target.value;
                        updatePatch(idx, { grams: v === "" ? undefined : Number(v) });
                      }}
                      className="h-9"
                    />
                  </div>
                </div>
                {patchMacros && (
                  <div
                    className={cn(
                      "mt-1 text-[10px] text-muted-foreground",
                      !patchKnown && patch.food && "text-amber-500",
                    )}
                  >
                    {patch.food && !patchKnown && (
                      <span title={t("forms.logMeal.notInFoodDbPatch")}>
                        {t("forms.logMeal.notInFoodDb")}
                      </span>
                    )}
                    {patchMacros.kcal.toFixed(0)} kcal · P{patchMacros.p.toFixed(0)} F
                    {patchMacros.f.toFixed(0)} C{patchMacros.c.toFixed(0)}
                    {patchMacros.fiber != null && ` · fiber ${patchMacros.fiber.toFixed(1)}g`}
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[10px] text-muted-foreground italic">
            {patches.length > 1
              ? t("forms.logMeal.onlyTheseChange")
              : t("forms.logMeal.onlyThisChanges")}
          </p>
        </div>
      )}

      {!isPatch && (
        <div className="space-y-1.5">
          <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            {t("forms.logMeal.items")} *{itemDesc("food") && <InfoHint text={itemDesc("food")!} />}
          </Label>
          {items.length === 0 && (
            <EmptyState icon={Utensils} compact>
              {t("forms.logMeal.noItems")}
            </EmptyState>
          )}
          {items.map((item, i) => {
            const m = macrosForItem(item, db);
            const known = item.food != null && db[item.food] != null;
            return (
              <div
                key={i}
                className="rounded-md border border-edge bg-background/40 p-2 shadow-well"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <FoodPicker
                      value={item.food ?? ""}
                      foodNames={foodNames}
                      db={db}
                      disabled={disabled}
                      onChange={(canonical) => updateItem(i, { food: canonical })}
                    />
                  </div>
                  <div className="w-24">
                    <Input
                      type="number"
                      step="any"
                      value={item.grams ?? ""}
                      disabled={disabled}
                      placeholder={t("forms.logMeal.gramsPlaceholder")}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateItem(i, { grams: v === "" ? undefined : Number(v) });
                      }}
                      className="h-9"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    onClick={() => removeItem(i)}
                    aria-label={t("forms.logMeal.removeItem")}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <div
                  className={cn(
                    "mt-1 text-[10px] text-muted-foreground",
                    !known && item.food && "text-amber-500",
                  )}
                >
                  {item.food && !known && (
                    <span title={t("forms.logMeal.notInFoodDbItem")}>
                      {t("forms.logMeal.notInFoodDb")}
                    </span>
                  )}
                  {m.kcal.toFixed(0)} kcal · P{m.p.toFixed(0)} F{m.f.toFixed(0)} C{m.c.toFixed(0)}
                  {m.fiber != null && ` · fiber ${m.fiber.toFixed(1)}g`}
                </div>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={addItem}
            className="gap-1"
          >
            <Plus className="size-3.5" />
            {t("forms.logMeal.addItem")}
          </Button>
        </div>
      )}

      {!isPatch && (
        <div className="rounded-md border border-dashed bg-background/40 px-2 py-1.5 text-xs">
          <strong>{t("forms.logMeal.total")}</strong> · {totals.kcal.toFixed(0)} kcal · P
          {totals.p.toFixed(0)} F{totals.f.toFixed(0)} C{totals.c.toFixed(0)}
          {totals.fiber != null && ` · fiber ${totals.fiber.toFixed(1)}g`}
        </div>
      )}

      {/* New meals only: an update replaces a meal that's already in the day's
          totals, so stacking it on top would double-count. */}
      {!isUpdate && items.length > 0 && (
        <LogMacroPreview
          item={{ ...totals, fiber: totals.fiber ?? undefined }}
          dateIso={meal.date ?? ctx.selectedDateIso}
        />
      )}
    </div>
  );
}
