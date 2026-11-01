import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronDown, Flame, Plus, Target, Trash2, Utensils, X } from "lucide-react";
import type { Macros } from "@fa/shared";
import { Input } from "@/components/ui/input";
import { DatePicker, TimeInput } from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";
import { MacroBars } from "@/Dashboard";
import { useDailyTarget } from "@/lib/dailyTarget";
import { Field, SectionLabel, UnitInput } from "./formKit";
import { WeekdayPicker, weekdayAbbr, type Weekday } from "./workoutControls";
import { FoodPicker, macrosForItem, useFoodDb, type FoodDb, type Portion } from "./mealControls";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate form for save_diet_plan — create or replace the recurring
// rotation of days → meals → portions. Plan defaults up top (anchor date +
// fallback macro target), then collapsible day cards. Each day carries a
// weekday schedule, an optional per-day macro target, and its meals; each meal
// is a slot/time + portions reusing the shared FoodPicker + live macro math.

export type MacroTarget = {
  kcal?: number;
  p?: number;
  f?: number;
  c?: number;
  fiber?: number;
};

export function targetEmpty(t: MacroTarget | undefined): boolean {
  if (!t) return true;
  return t.kcal == null && t.p == null && t.f == null && t.c == null && t.fiber == null;
}

type Meal = {
  slot?: string;
  time?: string;
  items?: Portion[];
};

type Day = {
  name?: string;
  weekdays?: Weekday[];
  target?: MacroTarget;
  meals?: Meal[];
};

type PlanInput = {
  start_date?: string;
  default_target?: MacroTarget;
  days?: Day[];
};

type DayRow = { id: number; day: Day };

// Weekdays already claimed by every day EXCEPT `exceptId` — a weekday can run
// at most one diet day, so these are disabled in that day's WeekdayPicker.
function usedWeekdaysExcept(rows: DayRow[], exceptId: number): Set<Weekday> {
  const used = new Set<Weekday>();
  for (const r of rows) {
    if (r.id === exceptId) continue;
    for (const wd of r.day.weekdays ?? []) used.add(wd);
  }
  return used;
}

function cleanDay(day: Day): Day {
  const out: Day = { name: day.name ?? "", meals: day.meals ?? [] };
  if (day.weekdays?.length) out.weekdays = day.weekdays;
  if (!targetEmpty(day.target)) out.target = day.target;
  return out;
}

// Live macro total for a whole day — every portion across every meal, resolved
// against the pantry (or its override). Mirrors the meal-level math already
// shown per MealEditor, summed up so the day reads as one plate. Fiber only
// counts when at least one item carries it (unknown ≠ zero).
function sumDayMacros(meals: Meal[], db: FoodDb): Macros {
  let kcal = 0;
  let p = 0;
  let f = 0;
  let c = 0;
  let fiber = 0;
  let hasFiber = false;
  for (const meal of meals) {
    for (const it of meal.items ?? []) {
      const m = macrosForItem(it, db);
      kcal += m.kcal;
      p += m.p;
      f += m.f;
      c += m.c;
      if (m.fiber != null) {
        fiber += m.fiber;
        hasFiber = true;
      }
    }
  }
  return { kcal, p, f, c, ...(hasFiber ? { fiber } : {}) };
}

// The target the day's planned macros are measured against. "Based on current
// goals": the profile-derived daily target is the base, and any macro the user
// pins on this day's own target overrides it. Null only when there's neither a
// computable goal nor a per-day target (bars then just show the plate).
function dayReferenceTarget(target: MacroTarget | undefined, goal: Macros | null): Macros | null {
  const pick = (a: number | undefined, b: number | undefined) => (a != null ? a : b);
  const kcal = pick(target?.kcal, goal?.kcal);
  const p = pick(target?.p, goal?.p);
  const f = pick(target?.f, goal?.f);
  const c = pick(target?.c, goal?.c);
  const fiber = pick(target?.fiber, goal?.fiber);
  if (kcal == null && p == null && f == null && c == null && fiber == null) return null;
  return { kcal: kcal ?? 0, p: p ?? 0, f: f ?? 0, c: c ?? 0, ...(fiber != null ? { fiber } : {}) };
}

// Compact 5-up macro target grid (kcal/P/F/C/fiber). Unlike MacroFields it
// shows no Atwater "from macros" hint — a daily target need not balance.
export function TargetGrid({
  value,
  onChange,
  disabled,
}: {
  value: MacroTarget | undefined;
  onChange: (next: MacroTarget) => void;
  disabled?: boolean;
}) {
  const { t: tr } = useTranslation();
  const t = value ?? {};
  const set = (patch: Partial<MacroTarget>) => onChange({ ...t, ...patch });
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={tr("formsAdmin.macros.calories")}>
        <UnitInput
          icon={<Flame className="size-3.5" />}
          suffix="kcal"
          value={t.kcal ?? ""}
          disabled={disabled}
          placeholder="0"
          step="any"
          onChange={(n) => set({ kcal: n })}
        />
      </Field>
      <Field label={tr("formsAdmin.macros.protein")}>
        <UnitInput
          suffix="g"
          value={t.p ?? ""}
          disabled={disabled}
          placeholder="0"
          step="any"
          onChange={(n) => set({ p: n })}
        />
      </Field>
      <Field label={tr("formsAdmin.macros.fat")}>
        <UnitInput
          suffix="g"
          value={t.f ?? ""}
          disabled={disabled}
          placeholder="0"
          step="any"
          onChange={(n) => set({ f: n })}
        />
      </Field>
      <Field label={tr("formsAdmin.macros.carbs")}>
        <UnitInput
          suffix="g"
          value={t.c ?? ""}
          disabled={disabled}
          placeholder="0"
          step="any"
          onChange={(n) => set({ c: n })}
        />
      </Field>
      <Field label={tr("formsAdmin.macros.fiber")} optional>
        <UnitInput
          suffix="g"
          value={t.fiber ?? ""}
          disabled={disabled}
          placeholder="0"
          step="any"
          onChange={(n) => set({ fiber: n })}
        />
      </Field>
    </div>
  );
}

// One meal: slot/time + portion rows + live total. Reused inside each day card.
function MealEditor({
  meal,
  db,
  foodNames,
  disabled,
  onChange,
  onRemove,
}: {
  meal: Meal;
  db: FoodDb;
  foodNames: string[];
  disabled?: boolean;
  onChange: (next: Meal) => void;
  onRemove: () => void;
}) {
  const { t: tr } = useTranslation();
  const items = meal.items ?? [];
  const set = (patch: Partial<Meal>) => onChange({ ...meal, ...patch });

  const patchItem = (i: number, patch: Partial<Portion>) =>
    set({ items: items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) });
  const addItem = () => set({ items: [...items, { food: "", grams: 100 }] });
  const removeItem = (i: number) => set({ items: items.filter((_, idx) => idx !== i) });

  let kcal = 0;
  for (const it of items) kcal += macrosForItem(it, db).kcal;

  return (
    <div className="space-y-2 rounded-md border bg-background/60 p-2">
      <div className="flex items-center gap-1.5">
        <Input
          value={meal.slot ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.dietPlan.slotPlaceholder")}
          onChange={(e) => set({ slot: e.target.value || undefined })}
          className="h-8 flex-1"
        />
        <div className="w-24">
          <TimeInput
            value={meal.time ?? ""}
            disabled={disabled}
            onChange={(hhmm) => set({ time: hhmm || undefined })}
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
          aria-label={tr("formsAdmin.dietPlan.removeMeal")}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

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
                onChange={(canonical) => patchItem(i, { food: canonical })}
              />
              <div
                className={cn(
                  "mt-0.5 text-[10px] text-muted-foreground",
                  !known && it.food && "text-warning",
                )}
              >
                {it.food && !known && tr("formsAdmin.dietPlan.notInPantry")}
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
                onChange={(n) => patchItem(i, { grams: n })}
              />
            </div>
            <button
              type="button"
              onClick={() => removeItem(i)}
              disabled={disabled}
              className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
              aria-label={tr("formsAdmin.dietPlan.removePortion")}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={addItem}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          <Plus className="size-3" />
          {tr("formsAdmin.dietPlan.portion")}
        </button>
        {items.length > 0 && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {kcal.toFixed(0)} kcal
          </span>
        )}
      </div>
    </div>
  );
}

export function DietPlanForm({
  value,
  onChange,
  disabled,
  focusDayIndex,
}: ToolOverrideProps & { focusDayIndex?: number }) {
  const { t: tr } = useTranslation();
  const v = (value as PlanInput) ?? {};
  const { db, foodNames } = useFoodDb();
  // The user's current goal-adjusted daily target (profile + latest weigh-in),
  // so each day's planned plate is framed against what they're aiming for.
  const goalTarget = useDailyTarget();

  const nextId = useRef(0);
  const [rows, setRows] = useState<DayRow[]>(() =>
    (v.days ?? []).map((day) => ({ id: nextId.current++, day })),
  );
  const [open, setOpen] = useState<Set<number>>(() => {
    // Expand the day the user clicked "Edit" on (per-card edit), else the first.
    const initial = focusDayIndex != null && rows[focusDayIndex] ? rows[focusDayIndex] : rows[0];
    return new Set(initial ? [initial.id] : []);
  });

  const emit = (nextRows: DayRow[]) =>
    onChange({ ...v, days: nextRows.map((r) => cleanDay(r.day)) });
  const setTop = (patch: Partial<PlanInput>) => onChange({ ...v, ...patch });

  const patchDay = (id: number, patch: Partial<Day>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, day: { ...r.day, ...patch } } : r));
    setRows(next);
    emit(next);
  };
  const addDay = () => {
    const id = nextId.current++;
    const next = [...rows, { id, day: { name: "", meals: [] } as Day }];
    setRows(next);
    setOpen((s) => new Set(s).add(id));
    emit(next);
  };
  const removeDay = (id: number) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit(next);
  };
  const toggleOpen = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Meal helpers on a day.
  const setMeals = (id: number, meals: Meal[]) => patchDay(id, { meals });
  const addMeal = (id: number) => {
    const day = rows.find((r) => r.id === id)?.day;
    setMeals(id, [...(day?.meals ?? []), { slot: "", items: [] }]);
  };

  return (
    <div className="space-y-6">
      {/* ── Defaults ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Target} info={tr("formsAdmin.dietPlan.planDefaultsInfo")}>
          {tr("formsAdmin.dietPlan.planDefaults")}
        </SectionLabel>
        <Field label={tr("formsAdmin.dietPlan.anchorDate")} optional>
          <DatePicker
            value={v.start_date ?? ""}
            disabled={disabled}
            onChange={(iso) => setTop({ start_date: iso || undefined })}
          />
        </Field>
        <TargetGrid
          value={v.default_target}
          disabled={disabled}
          onChange={(t) => setTop({ default_target: targetEmpty(t) ? undefined : t })}
        />
      </section>

      {/* ── Days ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel
          Icon={CalendarDays}
          hint={tr("formsAdmin.dietPlan.dayCount", { count: rows.length })}
        >
          {tr("formsAdmin.dietPlan.days")}
        </SectionLabel>
        <div className="space-y-2">
          {rows.map((r) => {
            const isOpen = open.has(r.id);
            const day = r.day;
            const meals = day.meals ?? [];
            // Live plate total vs the reference target — computed only while the
            // day is open (the summary panel is the only consumer).
            const dayTotals = isOpen ? sumDayMacros(meals, db) : null;
            const refTarget = isOpen ? dayReferenceTarget(day.target, goalTarget) : null;
            const hasItems = meals.some((m) => (m.items?.length ?? 0) > 0);
            return (
              <div
                key={r.id}
                className="rounded-lg border border-edge bg-background/40 shadow-well"
              >
                <div className="flex items-center gap-1.5 p-1.5">
                  <button
                    type="button"
                    onClick={() => toggleOpen(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-60"
                    aria-label={
                      isOpen ? tr("formsAdmin.dietPlan.collapse") : tr("formsAdmin.dietPlan.expand")
                    }
                  >
                    <ChevronDown
                      className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                    />
                  </button>
                  <Input
                    value={day.name ?? ""}
                    disabled={disabled}
                    placeholder={tr("formsAdmin.dietPlan.dayNamePlaceholder")}
                    onChange={(e) => patchDay(r.id, { name: e.target.value })}
                    className="h-8 flex-1"
                  />
                  {!isOpen && (
                    <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
                      {tr("formsAdmin.dietPlan.mealCount", { count: meals.length })}
                      {day.weekdays?.length ? ` · ${day.weekdays.map(weekdayAbbr).join(" ")}` : ""}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeDay(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                    aria-label={tr("formsAdmin.dietPlan.removeDay")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>

                {isOpen && (
                  <div className="space-y-4 border-t p-3">
                    <Field label={tr("formsAdmin.dietPlan.runsOn")} optional>
                      <WeekdayPicker
                        value={day.weekdays}
                        disabled={disabled}
                        unavailable={usedWeekdaysExcept(rows, r.id)}
                        onChange={(wds) => patchDay(r.id, { weekdays: wds })}
                      />
                    </Field>

                    <div className="space-y-2">
                      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                        {tr("formsAdmin.dietPlan.dailyTarget")}{" "}
                        <span className="opacity-60">
                          {tr("formsAdmin.dietPlan.dailyTargetHint")}
                        </span>
                      </div>
                      <TargetGrid
                        value={day.target}
                        disabled={disabled}
                        onChange={(t) => patchDay(r.id, { target: targetEmpty(t) ? undefined : t })}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                        <Utensils className="size-3" />
                        {tr("formsAdmin.dietPlan.meals")}
                      </div>
                      {meals.map((meal, mi) => (
                        <MealEditor
                          key={mi}
                          meal={meal}
                          db={db}
                          foodNames={foodNames}
                          disabled={disabled}
                          onChange={(next) =>
                            setMeals(
                              r.id,
                              meals.map((m, idx) => (idx === mi ? next : m)),
                            )
                          }
                          onRemove={() =>
                            setMeals(
                              r.id,
                              meals.filter((_, idx) => idx !== mi),
                            )
                          }
                        />
                      ))}
                      <button
                        type="button"
                        onClick={() => addMeal(r.id)}
                        disabled={disabled}
                        className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
                      >
                        <Plus className="size-3.5" />
                        {tr("formsAdmin.dietPlan.addMeal")}
                      </button>
                    </div>

                    {/* ── Day total vs current goal ────────────────────── */}
                    {dayTotals && (hasItems || refTarget) && (
                      <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                        <div className="flex items-baseline justify-between text-xs">
                          <span className="font-medium">{tr("formsAdmin.dietPlan.dayTotal")}</span>
                          <span className="text-muted-foreground">
                            {refTarget
                              ? targetEmpty(day.target)
                                ? tr("formsAdmin.dietPlan.vsGoal")
                                : tr("formsAdmin.dietPlan.vsDayTarget")
                              : tr("formsAdmin.dietPlan.noGoal")}
                          </span>
                        </div>
                        <MacroBars eaten={dayTotals} target={refTarget} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <button
            type="button"
            onClick={addDay}
            disabled={disabled}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-60"
          >
            <Plus className="size-4" />
            {tr("formsAdmin.dietPlan.addDay")}
          </button>
        </div>
      </section>
    </div>
  );
}
