import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CalendarCheck, CalendarDays, Pencil, Plus, Sigma, Utensils, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DatePicker, TimeInput } from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";
import { today, toIso } from "../dateRange";
import { BatchRepeater, Field, SectionLabel, UnitInput } from "./formKit";
import { WeekdayPicker, type Weekday } from "./workoutControls";
import { TargetLine } from "./PlanEditForms";
import { TargetGrid, targetEmpty, type MacroTarget } from "./DietPlanForm";
import { FoodPicker, macrosForItem, useFoodDb, type FoodDb, type Portion } from "./mealControls";
import type { ToolOverrideProps } from "./overrides";
import { toggleItemClass } from "../lib/navItem";

// Bespoke gate forms for the surgical diet-plan edits. Each targets an existing
// row by an opaque id (day_id / meal_id / portion_id from get_diet_plan), shown
// as read-only context and passed through untouched. They reuse the shared
// TargetGrid, WeekdayPicker, and FoodPicker so they read like save_diet_plan.

// Small toggle button used for boolean flags (clear_target / clear_override).
export function FlagToggle({
  active,
  label,
  disabled,
  onToggle,
}: {
  active: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-60",
        toggleItemClass(active, { tone: "warning" }),
      )}
    >
      <X className={cn("size-4", active && "text-warning")} />
      {label}
    </button>
  );
}

// Absolute per-portion macro override (for foods not in the pantry). Optional
// across the portion tools.
export function OverrideMacros({
  v,
  set,
  disabled,
}: {
  v: Portion;
  set: (patch: Partial<Portion>) => void;
  disabled?: boolean;
}) {
  const { t: tr } = useTranslation();
  return (
    <div className="space-y-2 rounded-md border border-dashed bg-background/40 p-2">
      <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        <Sigma className="size-3" />
        {tr("formsAdmin.dietEdit.macroOverride")}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <UnitInput
          suffix="kcal"
          value={v.kcal ?? ""}
          disabled={disabled}
          placeholder="kcal"
          step="any"
          onChange={(n) => set({ kcal: n })}
        />
        <UnitInput
          suffix="g P"
          value={v.p ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.dietEdit.proteinPlaceholder")}
          step="any"
          onChange={(n) => set({ p: n })}
        />
        <UnitInput
          suffix="g F"
          value={v.f ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.dietEdit.fatPlaceholder")}
          step="any"
          onChange={(n) => set({ f: n })}
        />
        <UnitInput
          suffix="g C"
          value={v.c ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.dietEdit.carbsPlaceholder")}
          step="any"
          onChange={(n) => set({ c: n })}
        />
      </div>
    </div>
  );
}

// FoodPicker + grams + live macro preview for a single portion.
export function PortionFields({
  v,
  set,
  db,
  foodNames,
  disabled,
}: {
  v: Portion;
  set: (patch: Partial<Portion>) => void;
  db: FoodDb;
  foodNames: string[];
  disabled?: boolean;
}) {
  const { t: tr } = useTranslation();
  const m = macrosForItem(v, db);
  const known = v.food != null && db[v.food] != null;
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Field label={tr("formsAdmin.dietEdit.food")}>
            <FoodPicker
              value={v.food ?? ""}
              foodNames={foodNames}
              db={db}
              disabled={disabled}
              onChange={(canonical) => set({ food: canonical })}
            />
          </Field>
        </div>
        <div className="w-24">
          <Field label={tr("formsAdmin.dietEdit.grams")}>
            <UnitInput
              suffix="g"
              value={v.grams ?? ""}
              disabled={disabled}
              placeholder="g"
              step="any"
              onChange={(n) => set({ grams: n })}
            />
          </Field>
        </div>
      </div>
      <div className={cn("text-[11px] text-muted-foreground", !known && v.food && "text-warning")}>
        {v.food && !known && tr("formsAdmin.dietEdit.notInPantry")}
        {m.kcal.toFixed(0)} kcal · P{m.p.toFixed(0)} F{m.f.toFixed(0)} C{m.c.toFixed(0)}
      </div>
    </div>
  );
}

// Portion list for a meal's items[] (no slot/time — those are top-level here).
function PortionList({
  items,
  db,
  foodNames,
  disabled,
  onChange,
}: {
  items: Portion[];
  db: FoodDb;
  foodNames: string[];
  disabled?: boolean;
  onChange: (next: Portion[]) => void;
}) {
  const { t: tr } = useTranslation();
  const patch = (i: number, p: Partial<Portion>) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...p } : it)));
  return (
    <div className="space-y-2">
      {items.map((it, i) => {
        const m = macrosForItem(it, db);
        const known = it.food != null && db[it.food] != null;
        return (
          <div key={i} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <FoodPicker
                value={it.food ?? ""}
                foodNames={foodNames}
                db={db}
                disabled={disabled}
                onChange={(canonical) => patch(i, { food: canonical })}
              />
              <div
                className={cn(
                  "mt-0.5 text-[10px] text-muted-foreground",
                  !known && it.food && "text-warning",
                )}
              >
                {it.food && !known && tr("formsAdmin.dietEdit.notInPantry")}
                {m.kcal.toFixed(0)} kcal · P{m.p.toFixed(0)} F{m.f.toFixed(0)} C{m.c.toFixed(0)}
              </div>
            </div>
            <div className="w-20">
              <UnitInput
                suffix="g"
                value={it.grams ?? ""}
                disabled={disabled}
                placeholder="g"
                step="any"
                onChange={(n) => patch(i, { grams: n })}
              />
            </div>
            <button
              type="button"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              disabled={disabled}
              className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
              aria-label={tr("formsAdmin.dietEdit.removePortion")}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...items, { food: "", grams: 100 }])}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
      >
        <Plus className="size-3" />
        {tr("formsAdmin.dietEdit.portion")}
      </button>
    </div>
  );
}

// ── update_diet_day ───────────────────────────────────────────────────────
type DietDayPatch = {
  day_id?: number;
  name?: string;
  weekdays?: Weekday[];
  target?: MacroTarget;
  clear_target?: boolean;
};

export function UpdateDietDayForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const v = (value as DietDayPatch) ?? {};
  const set = (patch: Partial<DietDayPatch>) => onChange({ ...v, ...patch });
  return (
    <div className="space-y-4">
      <SectionLabel Icon={CalendarDays}>{tr("formsAdmin.dietEdit.editDietDay")}</SectionLabel>
      <TargetLine parts={[[tr("formsAdmin.dietEdit.dayLabel"), v.day_id]]} />
      <Field label={tr("formsAdmin.dietEdit.name")} optional>
        <Input
          value={v.name ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.dietEdit.nameHighDayPlaceholder")}
          onChange={(e) => set({ name: e.target.value || undefined })}
          className="h-9"
        />
      </Field>
      <Field
        label={tr("formsAdmin.dietEdit.runsOn")}
        optional
        info={tr("formsAdmin.dietEdit.runsOnInfo")}
      >
        <WeekdayPicker
          value={v.weekdays}
          disabled={disabled}
          onChange={(wds) => set({ weekdays: wds })}
        />
      </Field>
      {!v.clear_target && (
        <div className="space-y-2">
          <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {tr("formsAdmin.dietEdit.dailyTarget")}
          </div>
          <TargetGrid
            value={v.target}
            disabled={disabled}
            onChange={(t) => set({ target: targetEmpty(t) ? undefined : t })}
          />
        </div>
      )}
      <FlagToggle
        active={!!v.clear_target}
        label={
          v.clear_target
            ? tr("formsAdmin.dietEdit.willClearTarget")
            : tr("formsAdmin.dietEdit.clearTarget")
        }
        disabled={disabled}
        onToggle={() => set({ clear_target: !v.clear_target, target: undefined })}
      />
    </div>
  );
}

// ── add_diet_meal ─────────────────────────────────────────────────────────
type AddDietMeal = {
  day_id?: number;
  slot?: string;
  time?: string;
  items?: Portion[];
};

export function AddDietMealForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const v = (value as AddDietMeal) ?? {};
  const { db, foodNames } = useFoodDb();
  const set = (patch: Partial<AddDietMeal>) => onChange({ ...v, ...patch });
  const items = v.items ?? [];
  return (
    <div className="space-y-4">
      <SectionLabel Icon={Utensils}>{tr("formsAdmin.dietEdit.addPlannedMeal")}</SectionLabel>
      <TargetLine parts={[[tr("formsAdmin.dietEdit.dayLabel"), v.day_id]]} />
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label={tr("formsAdmin.dietEdit.slot")}>
          <Input
            value={v.slot ?? ""}
            disabled={disabled}
            placeholder={tr("formsAdmin.dietEdit.slotPlaceholder")}
            onChange={(e) => set({ slot: e.target.value || undefined })}
            className="h-9"
          />
        </Field>
        <Field label={tr("formsAdmin.dietEdit.time")} optional>
          <TimeInput
            value={v.time ?? ""}
            disabled={disabled}
            onChange={(hhmm) => set({ time: hhmm || undefined })}
          />
        </Field>
      </div>
      <Field label={tr("formsAdmin.dietEdit.portions")}>
        <PortionList
          items={items}
          db={db}
          foodNames={foodNames}
          disabled={disabled}
          onChange={(next) => set({ items: next })}
        />
      </Field>
    </div>
  );
}

// ── update_diet_meal ──────────────────────────────────────────────────────
type UpdateDietMeal = { meal_id?: number; slot?: string; time?: string };

export function UpdateDietMealForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const v = (value as UpdateDietMeal) ?? {};
  const set = (patch: Partial<UpdateDietMeal>) => onChange({ ...v, ...patch });
  return (
    <div className="space-y-4">
      <SectionLabel Icon={Pencil}>{tr("formsAdmin.dietEdit.editPlannedMeal")}</SectionLabel>
      <TargetLine parts={[[tr("formsAdmin.dietEdit.mealLabel"), v.meal_id]]} />
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label={tr("formsAdmin.dietEdit.slot")} optional>
          <Input
            value={v.slot ?? ""}
            disabled={disabled}
            placeholder={tr("formsAdmin.dietEdit.slotPlaceholder")}
            onChange={(e) => set({ slot: e.target.value || undefined })}
            className="h-9"
          />
        </Field>
        <Field
          label={tr("formsAdmin.dietEdit.time")}
          optional
          info={tr("formsAdmin.dietEdit.timeClearInfo")}
        >
          <TimeInput
            value={v.time ?? ""}
            disabled={disabled}
            onChange={(hhmm) => set({ time: hhmm ?? "" })}
          />
        </Field>
      </div>
    </div>
  );
}

// ── add_diet_portion ──────────────────────────────────────────────────────
type AddDietPortion = Portion & { meal_id?: number };

export function AddDietPortionForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const { db, foodNames } = useFoodDb();
  // Share the target meal across rows so "add chicken, rice and broccoli to
  // lunch" stays one call.
  const mealId = (value as AddDietPortion | null)?.meal_id;
  return (
    <BatchRepeater<AddDietPortion>
      value={value}
      onChange={onChange}
      disabled={disabled}
      Icon={Plus}
      title={tr("formsAdmin.dietEdit.addPortion")}
      addLabel={tr("formsAdmin.dietEdit.portion")}
      emptyItem={() => ({ meal_id: mealId, grams: 100 })}
      renderItem={(v, set) => (
        <>
          <TargetLine parts={[[tr("formsAdmin.dietEdit.mealLabel"), v.meal_id]]} />
          <PortionFields v={v} set={set} db={db} foodNames={foodNames} disabled={disabled} />
          <OverrideMacros v={v} set={set} disabled={disabled} />
        </>
      )}
    />
  );
}

// ── update_diet_portion ───────────────────────────────────────────────────
type UpdateDietPortion = Portion & {
  portion_id?: number;
  clear_override?: boolean;
};

export function UpdateDietPortionForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const { db, foodNames } = useFoodDb();
  return (
    <BatchRepeater<UpdateDietPortion>
      value={value}
      onChange={onChange}
      disabled={disabled}
      Icon={Pencil}
      title={tr("formsAdmin.dietEdit.editPortion")}
      renderItem={(v, set) => (
        <>
          <TargetLine parts={[[tr("formsAdmin.dietEdit.portionLabel"), v.portion_id]]} />
          <PortionFields v={v} set={set} db={db} foodNames={foodNames} disabled={disabled} />
          {!v.clear_override && <OverrideMacros v={v} set={set} disabled={disabled} />}
          <FlagToggle
            active={!!v.clear_override}
            label={
              v.clear_override
                ? tr("formsAdmin.dietEdit.willResolveFromPantry")
                : tr("formsAdmin.dietEdit.dropOverride")
            }
            disabled={disabled}
            onToggle={() =>
              set({
                clear_override: !v.clear_override,
                kcal: undefined,
                p: undefined,
                f: undefined,
                c: undefined,
                fiber: undefined,
              })
            }
          />
        </>
      )}
    />
  );
}

// ── log_planned_meal ──────────────────────────────────────────────────────
type LogPlanned = { date?: string; slot?: string; meal_id?: number };

export function LogPlannedMealForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const v = (value as LogPlanned) ?? {};
  const set = (patch: Partial<LogPlanned>) => onChange({ ...v, ...patch });

  // Default the date to today (matches the schema default).
  useEffect(() => {
    if (!v.date && !disabled) set({ date: toIso(today()) });
    // Mount-only default; re-running on v.date/set would fight user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <SectionLabel Icon={CalendarCheck} info={tr("formsAdmin.dietEdit.logAsPlannedInfo")}>
        {tr("formsAdmin.dietEdit.logAsPlanned")}
      </SectionLabel>
      <div className="grid grid-cols-2 gap-3">
        <Field label={tr("formsAdmin.dietEdit.date")}>
          <DatePicker
            value={v.date ?? ""}
            disabled={disabled}
            onChange={(iso) => set({ date: iso || undefined })}
          />
        </Field>
        <Field
          label={tr("formsAdmin.dietEdit.slot")}
          optional
          info={tr("formsAdmin.dietEdit.logSlotInfo")}
        >
          <Input
            value={v.slot ?? ""}
            disabled={disabled}
            placeholder={tr("formsAdmin.dietEdit.slotPlaceholder")}
            onChange={(e) => set({ slot: e.target.value || undefined })}
            className="h-9"
          />
        </Field>
      </div>
      <Field
        label={tr("formsAdmin.dietEdit.exactMealId")}
        optional
        info={tr("formsAdmin.dietEdit.exactMealIdInfo")}
      >
        <UnitInput
          value={v.meal_id ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.dietEdit.optional")}
          step={1}
          min={0}
          onChange={(n) => set({ meal_id: n })}
        />
      </Field>
    </div>
  );
}
