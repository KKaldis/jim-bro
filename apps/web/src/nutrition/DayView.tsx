// Nutrition → Summary: the selected day's targets, macros and logged meals.
import { EmptyState } from "@/components/EmptyState";
import { computeTargets, type Goal, latestBodyMetrics, type Profile } from "@fa/shared";
import { ChefHat, ChevronRight, Flame, Utensils } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { CalorieRing, MacroBars } from "../Dashboard";
import { RowActions } from "../components/RowActions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "../components/ui/table";
import { formatTime24, isoToDisplay } from "../lib/dateFormat";
import { useDaySnapshot } from "../lib/dayContext";
import { compareTime, slotRank } from "../lib/mealSlots";
import { runTool } from "../lib/runTool";
import { cn } from "../lib/utils";
import { EditMealDialog } from "./EditMealDialog";
import { type Day, dayTargets, type Macros, type Meal, type MealItem, sumItems } from "./shared";

const CATEGORY_ICONS: Record<string, string> = {
  protein: "🥩",
  dairy: "🥛",
  legume: "🫘",
  grain: "🌾",
  starch: "🥔",
  fruit: "🍎",
  vegetable: "🥦",
  fat: "🥑",
  nut: "🥜",
  condiment: "🧂",
  beverage: "🥤",
  supplement: "💊",
  sweet: "🍬",
  other: "•",
};
function categoryIcon(cat?: string): string {
  if (!cat) return "•";
  return CATEGORY_ICONS[cat] ?? "•";
}

// Range view: the day picked on the breakdown chart — its macros against the
// day's target and the meals logged, with a jump into the full day view.
export function SelectedDayCard({
  day,
  onGoToDay,
  onChanged,
}: {
  day: Day;
  onGoToDay: (iso: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>
            {isoToDisplay(day.date)}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {t("nutrition.summary.mealCount", { count: day.meal_count })}
            </span>
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => onGoToDay(day.date)}>
            {t("nutrition.chart.goToDay")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {day.meal_count > 0 && <MacroBars eaten={day.eaten} target={day.target} />}
        <DayMeals day={day} onChanged={onChanged} />
      </CardContent>
    </Card>
  );
}

// Maintenance (TDEE), the goal-adjusted daily target, and goal for a day,
// derived from the profile + latest weigh-in via the (cached) day snapshot,
// since the nutrition response doesn't carry them. `goalTarget` is the macros
// the profile's goal implies (recomp/cut/lean-bulk applied to TDEE) — the
// primary kcal/macro target the day is measured against. All null when
// weight/height is unknown.
export function useDayEnergy(dateIso: string): {
  maintenance: number | null;
  goalTarget: Macros | null;
  goal: Goal | undefined;
} {
  const snap = useDaySnapshot(dateIso);
  const profile = snap.data?.profile ?? null;
  // Newest weight + the most recent body fat (carried forward over weight-only
  // weigh-ins) — see latestBodyMetrics.
  const metrics = latestBodyMetrics(snap.data?.bodyComp ?? []);
  const targets =
    profile && metrics && profile.height_cm
      ? computeTargets(profile as unknown as Profile, metrics)
      : null;
  return {
    maintenance: targets?.tdee ?? null,
    goalTarget: targets?.daily_target ?? null,
    goal: profile?.goal as Goal | undefined,
  };
}

// The selected day's macro bars. Mirrors the dashboard: passing maintenance +
// goal turns the kcal row into the calorie-budget bar (maintenance reference
// line + deficit/surplus band) rather than the plain target-vs-eaten bar.
// Macro bars for the selected day. Rendered without its own <Card> wrapper so
// it sits inside the shared day card beneath the ring + hydration grid; the
// top border keeps it visually separated like the divided columns above.
export function DayMacrosSection({ day }: { day: Day }) {
  const { t } = useTranslation();
  const { maintenance, goalTarget, goal } = useDayEnergy(day.date);
  const { target, dietKcal } = dayTargets(day, goalTarget);
  return (
    <div className="border-t">
      <CardHeader>
        <CardTitle>{t("nutrition.summary.macros")}</CardTitle>
      </CardHeader>
      <CardContent>
        <MacroBars
          eaten={day.eaten}
          target={target}
          maintenanceKcal={maintenance}
          goal={goal}
          dietKcal={dietKcal}
          hideKcal
        />
        {!target && (
          <p className="mt-2 text-sm text-muted-foreground">{t("nutrition.summary.noTargetDay")}</p>
        )}
      </CardContent>
    </div>
  );
}

// Primary at-a-glance outline for the selected day: the headline calories
// eaten vs target ring. Sits above the macro bars so the day reads as a
// summary first, detail second.
export function DayOutline({ day }: { day: Day }) {
  const { t } = useTranslation();
  const { eaten } = day;

  // Maintenance (TDEE), goal-based target + goal for the ring's reference
  // ticks / band; the diet plan's kcal (when active) rides along as a marker.
  const { maintenance, goalTarget, goal } = useDayEnergy(day.date);
  const { target, dietKcal } = dayTargets(day, goalTarget);

  return (
    <>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Flame className="size-4 text-primary" />
          {t("nutrition.summary.energy")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <CalorieRing
          eaten={eaten.kcal}
          target={target?.kcal ?? null}
          maintenance={maintenance}
          goal={goal}
          dietKcal={dietKcal}
        />
      </CardContent>
    </>
  );
}

type FoodFlatRow = {
  kind: "food";
  time?: string;
  slot: string;
  item: MealItem;
  // Only set in multi-meal slots, on the first row of each meal — opens that
  // meal in the editor (update_meal matches by slot + time).
  onEdit?: () => void;
  // Only set in multi-meal slots, on the first row of each meal — deletes just
  // that meal (delete_meal matches by meal_index), not the whole slot.
  onDelete?: () => void;
};

type SlotGroup = {
  slot: string;
  rows: FoodFlatRow[];
  total: Macros;
  grams: number;
  earliestTime?: string;
  // The raw meals collapsed into this slot. A single-meal slot carries Edit on
  // its header; a multi-meal slot carries a per-meal Edit on each meal's first
  // row (update_meal matches by slot + time). Delete removes every meal in the
  // slot.
  meals: Meal[];
};

// What a pending delete confirmation targets: the whole slot (header kebab) or a
// single meal within a multi-meal slot (row kebab), pinned by meal_index.
type DeleteTarget =
  { kind: "slot"; slot: string } | { kind: "meal"; slot: string; mealIndex: number; time?: string };

// Group a day's meals into one entry per slot, summing items + macros within
// each slot. Multiple meals logged under the same slot (e.g. two "snack"s)
// collapse into a single slot section rather than repeating the slot header.
function groupMealsBySlot(meals: Meal[]): SlotGroup[] {
  const bySlot = new Map<string, SlotGroup>();
  const order: string[] = [];
  for (const meal of meals) {
    let g = bySlot.get(meal.slot);
    if (!g) {
      g = {
        slot: meal.slot,
        rows: [],
        total: { kcal: 0, p: 0, f: 0, c: 0 },
        grams: 0,
        meals: [],
      };
      bySlot.set(meal.slot, g);
      order.push(meal.slot);
    }
    g.meals.push(meal);
    for (const item of meal.items) {
      g.rows.push({ kind: "food", time: meal.time, slot: meal.slot, item });
    }
    if (meal.time && (!g.earliestTime || meal.time < g.earliestTime)) {
      g.earliestTime = meal.time;
    }
  }
  const groups = order.map((slot) => {
    const g = bySlot.get(slot)!;
    g.rows.sort((a, b) => compareTime(a.time, b.time));
    const { total, grams } = sumItems(g.rows.map((r) => r.item));
    return { ...g, total, grams };
  });
  groups.sort(
    (a, b) =>
      slotRank(a.slot) - slotRank(b.slot) ||
      compareTime(a.earliestTime, b.earliestTime) ||
      a.slot.localeCompare(b.slot),
  );
  return groups;
}

// The day's logged meals, grouped by slot. The slot header is a plain label;
// every meal carries its own kebab on its first row. Edit opens the meal in
// EditMealDialog (update_meal matches by slot + time). Delete removes it — a
// lone meal deletes at the slot level, a meal sharing its slot deletes by
// meal_index so its siblings survive.
export function DayMeals({ day, onChanged }: { day: Day; onChanged: () => void }) {
  const { t } = useTranslation();
  // Delete either a whole slot (its header kebab) or a single meal within a
  // multi-meal slot (that meal's row kebab, targeted by meal_index).
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState<{ slot: string; meal: Meal; index: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (day.meals.length === 0) {
    return <EmptyState icon={Utensils}>{t("nutrition.meals.nothingLogged")}</EmptyState>;
  }

  const groups = groupMealsBySlot(day.meals);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setErr(null);
    const error = await runTool("delete_meal", {
      date: day.date,
      slot: pendingDelete.slot,
      ...(pendingDelete.kind === "meal" ? { meal_index: pendingDelete.mealIndex } : {}),
    });
    setDeleting(false);
    if (error) {
      setErr(error);
      return;
    }
    setPendingDelete(null);
    onChanged();
  }

  return (
    <>
      {err && <p className="mb-2 text-sm text-destructive">{err}</p>}
      <Table>
        <TableBody>
          {groups.map((g) => {
            const single = g.meals.length === 1 ? g.meals[0] : null;
            // Identify the meal by its stable position in the day's meal list
            // (storage order), so update_meal/delete_meal target exactly this
            // meal even when several share a slot with no time logged.
            const editMeal = (slot: string, meal: Meal) => {
              setErr(null);
              setEditing({ slot, meal, index: day.meals.indexOf(meal) });
            };
            const deleteMeal = (slot: string, meal: Meal) => {
              setErr(null);
              // A lone meal in a slot deletes at the slot level (clearer "removes
              // everything under {slot}" wording); a meal sharing its slot deletes
              // by meal_index so its siblings survive.
              setPendingDelete(
                single
                  ? { kind: "slot", slot }
                  : { kind: "meal", slot, mealIndex: day.meals.indexOf(meal), time: meal.time },
              );
            };
            // Actions live on each meal's own row, never on the slot-title header:
            // the first row of every meal carries Edit (update_meal matches by
            // slot + time) and Delete (delete_meal by meal_index). Single- and
            // multi-meal slots render the same way.
            const slotMeals = [...g.meals].sort((a, b) => compareTime(a.time, b.time));
            return (
              <Fragment key={g.slot}>
                <SectionHeader label={g.slot} />
                {slotMeals.map((meal, mi) => (
                  <MealItemRows
                    key={`${g.slot}-${mi}`}
                    rows={meal.items.map((item, ii) => ({
                      kind: "food",
                      time: meal.time,
                      slot: g.slot,
                      item,
                      onEdit: ii === 0 ? () => editMeal(g.slot, meal) : undefined,
                      onDelete: ii === 0 ? () => deleteMeal(g.slot, meal) : undefined,
                    }))}
                  />
                ))}
                <SlotTotalRow grams={g.grams} total={g.total} />
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingDelete(null);
            setErr(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="capitalize">
              {t("nutrition.meals.deleteTitle", { slot: pendingDelete?.slot })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "meal"
                ? pendingDelete.time
                  ? t("nutrition.meals.deleteMealBody", {
                      slot: pendingDelete.slot,
                      time: formatTime24(pendingDelete.time),
                      date: isoToDisplay(day.date),
                    })
                  : t("nutrition.meals.deleteMealBodyNoTime", {
                      slot: pendingDelete.slot,
                      date: isoToDisplay(day.date),
                    })
                : t("nutrition.meals.deleteBody", {
                    slot: pendingDelete?.slot,
                    date: isoToDisplay(day.date),
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className={buttonVariants({ variant: "destructive" })}
            >
              {deleting ? t("nutrition.meals.deleting") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editing && (
        <EditMealDialog
          day={day}
          date={day.date}
          slot={editing.slot}
          meal={editing.meal}
          mealIndex={editing.index}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function SlotTotalRow({ grams, total }: { grams: number; total: Macros }) {
  const { t } = useTranslation();
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={2} className="py-1.5 text-end text-xs font-medium text-muted-foreground">
        {t("nutrition.meals.slotTotal")}
      </TableCell>
      <TableCell className="text-end text-xs font-semibold tabular-nums">
        {grams.toFixed(0)}
      </TableCell>
      <TableCell className="text-end text-xs font-semibold tabular-nums">
        {total.kcal.toFixed(0)}
      </TableCell>
      <TableCell className="text-end text-xs font-semibold tabular-nums">
        {total.p.toFixed(0)}
      </TableCell>
      <TableCell className="text-end text-xs font-semibold tabular-nums">
        {total.f.toFixed(0)}
      </TableCell>
      <TableCell className="text-end text-xs font-semibold tabular-nums">
        {total.c.toFixed(0)}
      </TableCell>
      <TableCell className="text-end text-xs font-semibold text-muted-foreground tabular-nums">
        {total.fiber != null ? total.fiber.toFixed(1) : "—"}
      </TableCell>
      {/* Spacer for the slot-header actions column. */}
      <TableCell className="w-8" />
    </TableRow>
  );
}

// The slot label + column headings row. Carries no actions — Edit/Delete live
// on each meal's own row (see DayMeals), so the slot title stays a plain label.
function SectionHeader({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell colSpan={2} className="py-1.5 text-xs font-semibold capitalize">
        {label}
      </TableCell>
      <TableCell className="w-16 py-1.5 text-end text-xs font-normal text-muted-foreground">
        g
      </TableCell>
      <TableCell className="w-16 py-1.5 text-end text-xs font-normal text-muted-foreground">
        kcal
      </TableCell>
      <TableCell className="w-12 py-1.5 text-end text-xs font-normal text-muted-foreground">
        P
      </TableCell>
      <TableCell className="w-12 py-1.5 text-end text-xs font-normal text-muted-foreground">
        F
      </TableCell>
      <TableCell className="w-12 py-1.5 text-end text-xs font-normal text-muted-foreground">
        C
      </TableCell>
      <TableCell className="w-16 py-1.5 text-end text-xs font-normal text-muted-foreground">
        {t("nutrition.meals.colFiber")}
      </TableCell>
      {/* Spacer to align with the per-row actions column below. */}
      <TableCell className="w-8 py-1.5" />
    </TableRow>
  );
}

// A meal's rows, with recipe-tagged ingredients folded into collapsible groups.
// Items logged from a recipe (log_recipe) carry a `recipe` tag; contiguous items
// sharing one tag render under a single recipe header that expands to the
// ingredient breakdown. Untagged items render as plain food rows. The per-meal
// `onEdit` (multi-meal slots) rides on the first row and is surfaced on whichever
// block leads — a recipe header or a standalone row.
function MealItemRows({ rows }: { rows: FoodFlatRow[] }) {
  const blocks: Array<
    | { kind: "food"; row: FoodFlatRow }
    | { kind: "recipe"; slug: string; name: string; rows: FoodFlatRow[] }
  > = [];
  for (const row of rows) {
    const rec = row.item.recipe;
    const last = blocks[blocks.length - 1];
    if (rec && last?.kind === "recipe" && last.slug === rec.slug) {
      last.rows.push(row);
    } else if (rec) {
      blocks.push({ kind: "recipe", slug: rec.slug, name: rec.name, rows: [row] });
    } else {
      blocks.push({ kind: "food", row });
    }
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === "food" ? (
          <FoodRow key={i} row={b.row} onEdit={b.row.onEdit} onDelete={b.row.onDelete} />
        ) : (
          <RecipeGroup key={i} name={b.name} rows={b.rows} />
        ),
      )}
    </>
  );
}

// One recipe logged into the day: a header row (chef hat + name + summed macros)
// that toggles the ingredient breakdown. Collapsed by default so a recipe reads
// as a single line; the edit affordance (from the first ingredient) rides on the
// header so editing the recipe still opens its meal.
function RecipeGroup({ name, rows }: { name: string; rows: FoodFlatRow[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { total, grams } = sumItems(rows.map((r) => r.item));
  const time = rows[0]?.time;
  const onEdit = rows[0]?.onEdit;
  const onDelete = rows[0]?.onDelete;
  return (
    <>
      <TableRow className="bg-muted/40">
        <TableCell className="text-xs text-muted-foreground tabular-nums">
          {time ? formatTime24(time) : "—"}
        </TableCell>
        <TableCell className="text-xs">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex items-center gap-1 font-medium hover:text-foreground/80"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            />
            <ChefHat aria-hidden className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">{name}</span>
          </button>
        </TableCell>
        <TableCell className="text-end text-xs tabular-nums">{grams.toFixed(0)}</TableCell>
        <TableCell className="text-end text-xs tabular-nums">{total.kcal.toFixed(0)}</TableCell>
        <TableCell className="text-end text-xs tabular-nums">{total.p.toFixed(0)}</TableCell>
        <TableCell className="text-end text-xs tabular-nums">{total.f.toFixed(0)}</TableCell>
        <TableCell className="text-end text-xs tabular-nums">{total.c.toFixed(0)}</TableCell>
        <TableCell className="text-end text-xs text-muted-foreground tabular-nums">
          {total.fiber != null ? total.fiber.toFixed(1) : "—"}
        </TableCell>
        <TableCell className="w-8 py-0 text-end">
          {(onEdit || onDelete) && (
            <RowActions
              onEdit={onEdit}
              onDelete={onDelete}
              editLabel={t("nutrition.meals.editMeal")}
              deleteLabel={t("nutrition.meals.deleteMeal")}
              ariaLabel={t("nutrition.meals.editRecipe", { name })}
              triggerClassName="-me-1.5 h-6 w-6"
            />
          )}
        </TableCell>
      </TableRow>
      {open && rows.map((r, i) => <FoodRow key={i} row={r} indented />)}
    </>
  );
}

function FoodRow({
  row,
  onEdit,
  onDelete,
  indented,
}: {
  row: FoodFlatRow;
  onEdit?: () => void;
  onDelete?: () => void;
  // True for ingredient rows nested under an expanded recipe group — the name
  // is inset (and time hidden) so the breakdown reads as belonging to the group.
  indented?: boolean;
}) {
  const { t } = useTranslation();
  const it = row.item;
  return (
    <TableRow className={indented ? "bg-muted/20" : undefined}>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        {indented ? "" : row.time ? formatTime24(row.time) : "—"}
      </TableCell>
      <TableCell className="text-xs">
        <span
          className={indented ? "ps-5 text-muted-foreground" : undefined}
          title={it.category ?? t("nutrition.meals.uncategorized")}
        >
          <span aria-hidden className="me-1.5 inline-block w-4 text-center">
            {categoryIcon(it.category)}
          </span>
          {it.display_name ?? it.food}
        </span>
      </TableCell>
      <TableCell className="text-end text-xs tabular-nums">{it.grams.toFixed(0)}</TableCell>
      <TableCell className="text-end text-xs tabular-nums">{it.kcal.toFixed(0)}</TableCell>
      <TableCell className="text-end text-xs tabular-nums">{it.p.toFixed(0)}</TableCell>
      <TableCell className="text-end text-xs tabular-nums">{it.f.toFixed(0)}</TableCell>
      <TableCell className="text-end text-xs tabular-nums">{it.c.toFixed(0)}</TableCell>
      <TableCell className="text-end text-xs text-muted-foreground tabular-nums">
        {it.fiber != null ? it.fiber.toFixed(1) : "—"}
      </TableCell>
      {/* Actions column. The first row of each meal carries its Edit (update_meal
          matches it by slot + time) and Delete (delete_meal by meal_index);
          other rows leave a spacer so the column stays aligned. */}
      <TableCell className="w-8 py-0 text-end">
        {(onEdit || onDelete) && (
          <RowActions
            onEdit={onEdit}
            onDelete={onDelete}
            editLabel={t("nutrition.meals.editMeal")}
            deleteLabel={t("nutrition.meals.deleteMeal")}
            ariaLabel={
              row.time
                ? t("nutrition.meals.editSlotAt", {
                    slot: row.slot,
                    time: formatTime24(row.time),
                  })
                : t("nutrition.meals.editSlot", { slot: row.slot })
            }
            triggerClassName="-me-1.5 h-6 w-6"
          />
        )}
      </TableCell>
    </TableRow>
  );
}
