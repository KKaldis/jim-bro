/**
 * Diet tab on the Nutrition screen: the user's recurring meal template
 * (plan → days → meals → portions), rendered with macros LIVE-resolved from
 * the pantry by the server (GET /diet/plan). Mirrors the workout plan
 * editor: read-only cards + a full-plan editor dialog that PUTs the tree.
 *
 * Today's template day is highlighted and gets a one-tap "Ate this" per
 * meal (POST /diet/log-planned — resolve now, freeze into the meal log).
 * Portions that can't resolve (food missing from pantry / no macros) render
 * as "needs enrichment" and block the one-tap log instead of counting as 0.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  ClipboardList,
  CalendarDays,
  Utensils,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  deleteDietPlansId,
  getDietPlansId,
  postDietLogPlanned,
  postDietPlans,
  postDietPlansIdActivate,
  putDietPlansId,
  useGetDietPlans,
  useGetDietPlansId,
} from "./api/endpoints/default/default";
import { DietPlanWriteRequest } from "@fa/shared/schemas";
import { apiErr } from "./lib/apiErr";
import {
  humanizeFoodName,
  type Macros,
  type ResolvedDietDay,
  type ResolvedDietMeal,
  type ResolvedDietPlan,
  type Weekday,
} from "@fa/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Badge } from "./components/ui/badge";
import { Button, buttonVariants } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import { RowActions } from "./components/RowActions";
import { exportDietPlanPdf } from "./export/dietPlanPdf";
import { ExportPdfMenuItem, runExport } from "./export/printDoc";
import { MacroBars } from "./Dashboard";
import { DietPlanForm } from "./forms/DietPlanForm";
import type { JsonSchema } from "./forms/ToolForm";
import { useDailyTarget } from "./lib/dailyTarget";
import { formatTime24 } from "./lib/dateFormat";
import { PageTitle } from "./lib/pageChrome";
import { useMinLoading } from "./lib/useMinLoading";
import { cn } from "./lib/utils";

type DietPlanResp = {
  plan: ResolvedDietPlan | null;
  today_day_id: number | null;
};

type TFunc = ReturnType<typeof useTranslation>["t"];

function macroLine(t: TFunc, m: Macros): string {
  const args = {
    kcal: Math.round(m.kcal),
    p: Math.round(m.p),
    f: Math.round(m.f),
    c: Math.round(m.c),
    fiber: m.fiber != null ? Math.round(m.fiber) : 0,
  };
  return m.fiber != null ? t("diet.macroLineFiber", args) : t("diet.macroLine", args);
}

// Per-plan "active" toggle. Exactly one plan is active at a time, so this
// behaves radio-style: clicking an inactive plan activates it; the active
// plan's switch is "on" and non-interactive (there's intentionally no
// "deactivate" — you switch the active plan by turning another one on).
function ActivePlanToggle({
  checked,
  disabled,
  onActivate,
}: {
  checked: boolean;
  disabled?: boolean;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? t("diet.activePlan") : t("diet.makeActivePlan")}
      title={checked ? t("diet.activePlan") : t("diet.makeActivePlan")}
      disabled={disabled || checked}
      onClick={onActivate}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-input",
        checked || disabled ? "cursor-default" : "cursor-pointer",
        "disabled:opacity-100",
        !checked && disabled && "opacity-50",
      )}
    >
      <span
        className={cn(
          "inline-block size-4 transform rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4 rtl:-translate-x-4" : "translate-x-0.5 rtl:-translate-x-0.5",
        )}
      />
    </button>
  );
}

type PlanSummary = {
  id: number;
  name: string;
  active: boolean;
  day_count: number;
};

export function DietSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  // Many plans, one active. Each card expands independently — several can be
  // open at once. `expandedIds === null` means "not yet touched" → default to
  // the active plan expanded; after the first toggle it's an explicit set, so
  // the active plan can still be collapsed by hand.
  const plansQ = useGetDietPlans();
  const plans = (plansQ.data?.plans ?? []) as PlanSummary[];
  const activeId = plansQ.data?.active_plan_id ?? null;
  const [expandedIds, setExpandedIds] = useState<Set<number> | null>(null);
  const expanded = expandedIds ?? new Set<number>(activeId != null ? [activeId] : []);

  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  const err = plansQ.error ? apiErr(plansQ.error) : null;
  const showLoader = useMinLoading(plansQ.isPending);
  const invalidate = () => void queryClient.invalidateQueries();

  return (
    <div className="space-y-4">
      <PageTitle Icon={CalendarRange} help="diet">
        {t("diet.title")}
      </PageTitle>
      {showLoader && (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {!showLoader && plansQ.data && (
        <>
          <Button className="w-full gap-1" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> {t("diet.newPlan")}
          </Button>
          {plans.length === 0 ? (
            <EmptyState icon={ClipboardList}>{t("diet.empty")}</EmptyState>
          ) : (
            plans.map((p) => (
              <PlanCard
                key={p.id}
                summary={p}
                activeId={activeId}
                expanded={expanded.has(p.id)}
                onToggle={() => toggle(p.id)}
                onChanged={invalidate}
              />
            ))
          )}
          {creating && (
            <DietEditorDialog
              plan={null}
              planId={null}
              onClose={() => setCreating(false)}
              onSaved={(savedId) => {
                setCreating(false);
                if (savedId != null) {
                  const next = new Set(expanded);
                  next.add(savedId);
                  setExpandedIds(next);
                }
                invalidate();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

// One plan in the list. Self-contained: fetches its own resolved tree only
// while expanded, and owns its edit / delete / activate controls — so any
// number of cards can be open at once without a shared single-plan query.
function PlanCard({
  summary,
  activeId,
  expanded,
  onToggle,
  onChanged,
}: {
  summary: PlanSummary;
  activeId: number | null;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // The resolved tree is fetched while the card is expanded — and also while
  // the editor is open, so editing a collapsed plan loads its days first
  // (otherwise the editor would start from an empty draft and overwrite it).
  const planQ = useGetDietPlansId(summary.id, {
    query: { enabled: expanded || editing },
  });
  const data = (planQ.data as unknown as DietPlanResp | undefined) ?? null;
  const plan = data?.plan ?? null;
  const isActive = summary.id === activeId;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const activate = async () => {
    setBusy(true);
    setErr(null);
    try {
      await postDietPlansIdActivate(summary.id);
      onChanged();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await deleteDietPlansId(summary.id);
      setConfirmDelete(false);
      onChanged();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setBusy(false);
    }
  };

  // Works collapsed too: reuse the loaded tree, else fetch it on demand.
  const exportPdf = async () => {
    const tree = plan ?? ((await getDietPlansId(summary.id)) as unknown as DietPlanResp).plan;
    if (tree) await exportDietPlanPdf(tree);
  };

  return (
    <Card className={cn(summary.active && "border-primary")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-start"
            onClick={onToggle}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )}
            <CardTitle className="truncate text-base">{summary.name}</CardTitle>
            <span className="text-xs text-muted-foreground">
              {t("diet.dayCount", { count: summary.day_count })}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Actions menu shows whether or not the card is expanded; editing
                fetches the plan tree on demand. */}
            <RowActions
              onEdit={() => setEditing(true)}
              onDelete={() => setConfirmDelete(true)}
              editLabel={t("diet.editPlan")}
              deleteLabel={t("diet.deletePlan")}
              ariaLabel={t("diet.rowActions", { name: summary.name })}
              triggerClassName="h-7 w-7"
              middle={<ExportPdfMenuItem onSelect={() => void runExport(exportPdf)} />}
            />
            <ActivePlanToggle
              checked={summary.active}
              disabled={busy}
              onActivate={() => void activate()}
            />
          </div>
        </div>
        {err && <p className="mt-1 text-sm text-destructive">{err}</p>}
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-3">
          {planQ.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : !plan || plan.rotation.length === 0 ? (
            <EmptyState icon={CalendarDays}>{t("diet.noDays")}</EmptyState>
          ) : (
            <>
              {plan.default_target && (
                <p className="text-sm text-muted-foreground">
                  {t("diet.defaultTarget", { macros: macroLine(t, plan.default_target) })}
                </p>
              )}
              {plan.rotation.map((day) => (
                <DayCard
                  key={day.id}
                  day={day}
                  isToday={isActive && day.id === data?.today_day_id}
                />
              ))}
            </>
          )}
        </CardContent>
      )}
      {/* Wait for the plan tree before opening the editor so a collapsed plan
          isn't edited from an empty draft (which would overwrite its days). */}
      {editing &&
        (planQ.isPending ? (
          <Dialog open onOpenChange={(o) => !o && setEditing(false)}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t("diet.editDietPlan")}</DialogTitle>
              </DialogHeader>
              <Skeleton className="h-40 w-full" />
            </DialogContent>
          </Dialog>
        ) : (
          <DietEditorDialog
            plan={plan}
            planId={summary.id}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ))}
      <AlertDialog open={confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("diet.deleteTitle", { name: summary.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("diet.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(ev) => {
                ev.preventDefault();
                void del();
              }}
              disabled={busy}
              className={buttonVariants({ variant: "destructive" })}
            >
              {busy ? t("diet.deleting") : t("diet.deletePlan")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function DayCard({ day, isToday }: { day: ResolvedDietDay; isToday: boolean }) {
  const { t } = useTranslation();
  // Frame the day's planned plate against what the user's actually aiming for:
  // their profile-derived daily goal, unless the day pins its own target.
  const goalTarget = useDailyTarget();
  const refTarget = day.target ?? goalTarget;
  return (
    <Card className={cn(isToday && "border-primary/60")}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {day.name}
            {isToday && <Badge>{t("diet.today")}</Badge>}
          </CardTitle>
          {/* Read-only here — add / edit / delete days inside the plan editor. */}
          {day.weekdays.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {day.weekdays.map((w) => (
                <Badge key={w} variant="secondary" className="capitalize">
                  {w.slice(0, 3)}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {day.target
            ? t("diet.dayTarget", { macros: macroLine(t, day.target) })
            : t("diet.noDayTarget")}
          {" · "}
          {t("diet.planned", { macros: macroLine(t, day.totals) })}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {day.meals.length === 0 ? (
          <EmptyState icon={Utensils}>{t("diet.noMealsPlanned")}</EmptyState>
        ) : (
          day.meals.map((meal) => <MealBlock key={meal.id} meal={meal} canLog={isToday} />)
        )}
        {(day.meals.length > 0 || refTarget) && (
          <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium">{t("diet.plannedTotal")}</span>
              <span className="text-muted-foreground">
                {refTarget
                  ? day.target
                    ? t("diet.vsDayTarget")
                    : t("diet.vsGoal")
                  : t("diet.noGoal")}
              </span>
            </div>
            <MacroBars eaten={day.totals} target={refTarget} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MealBlock({ meal, canLog }: { meal: ResolvedDietMeal; canLog: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [logging, setLogging] = useState(false);
  const [logged, setLogged] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function logAsEaten() {
    setLogging(true);
    setErr(null);
    try {
      await postDietLogPlanned({ meal_id: meal.id });
      setLogged(true);
      // The new meal log affects the dashboard + nutrition views.
      void queryClient.invalidateQueries();
    } catch (e) {
      // 409 carries needs_enrichment[] — surface the unresolved foods by name.
      const needs = (e as { response?: { data?: { needs_enrichment?: string[] } } })?.response?.data
        ?.needs_enrichment;
      setErr(
        needs?.length
          ? t("diet.missingMacrosFor", { foods: needs.map(humanizeFoodName).join(", ") })
          : apiErr(e),
      );
    } finally {
      setLogging(false);
    }
  }

  return (
    <div className="rounded-md border border-edge bg-card p-2 shadow-tile">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium capitalize">
          {meal.slot}
          {meal.time && (
            <span className="ms-1.5 text-xs font-normal text-muted-foreground tabular-nums">
              {formatTime24(meal.time)}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {macroLine(t, meal.totals)}
          </span>
          {canLog && (
            <Button
              size="sm"
              variant={logged ? "secondary" : "outline"}
              className="h-7 gap-1 px-2 text-xs"
              disabled={logging || logged || meal.unresolved > 0}
              title={meal.unresolved > 0 ? t("diet.needsMacrosBeforeLog") : t("diet.logMealToday")}
              onClick={() => void logAsEaten()}
            >
              <Check className="size-3.5" />
              {logged ? t("diet.logged") : logging ? t("diet.logging") : t("diet.ateThis")}
            </Button>
          )}
        </div>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {meal.items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              {humanizeFoodName(item.food)}
              {item.resolved == null && (
                <span
                  className="ms-1.5 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
                  title={t("diet.notInPantryTitle")}
                >
                  <AlertTriangle className="size-3" /> {t("diet.needsMacros")}
                </span>
              )}
              {item.override && (
                <span
                  className="ms-1.5 text-[10px] tracking-wide text-muted-foreground uppercase"
                  title={t("diet.fixedTitle")}
                >
                  {t("diet.fixed")}
                </span>
              )}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {Math.round(item.grams)}g
              {item.resolved ? ` · ${Math.round(item.resolved.kcal)} kcal` : " · —"}
            </span>
          </li>
        ))}
      </ul>
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
    </div>
  );
}

// ---------- editor ----------

// The editor drives the shared <DietPlanForm> (the same bespoke form the
// save_diet_plan chat gate uses) with a local draft. The draft speaks the flat
// save_diet_plan input shape; the only wrinkle vs the tool is that the REST PUT
// /diet/plan keeps a per-portion `macros{}` override + `source`. The form only
// edits food + grams, so those ride along untouched on each portion and are
// mapped back on save.

type DraftPortion = {
  food?: string;
  grams?: number;
  macros?: Macros;
  source?: "db" | "estimated" | "manual";
};
type DraftMeal = { slot?: string; time?: string; items?: DraftPortion[] };
type DraftDay = {
  name?: string;
  weekdays?: Weekday[];
  target?: Macros;
  meals?: DraftMeal[];
};
type DraftPlan = {
  name?: string;
  start_date?: string;
  default_target?: Macros;
  days?: DraftDay[];
};

// <DietPlanForm> requires a JsonSchema prop but doesn't read it, so an empty
// object schema is fine for the manual surface.
const EMPTY_SCHEMA = { type: "object", properties: {} } as JsonSchema;

function planToDraft(plan: ResolvedDietPlan | null): DraftPlan {
  if (!plan || plan.rotation.length === 0) {
    return {
      name: plan?.name,
      start_date: plan?.start_date ?? undefined,
      default_target: plan?.default_target ?? undefined,
      days: [{ name: "Day 1", meals: [] }],
    };
  }
  return {
    name: plan.name,
    start_date: plan.start_date ?? undefined,
    default_target: plan.default_target ?? undefined,
    days: plan.rotation.map((d) => ({
      name: d.name,
      weekdays: [...d.weekdays],
      target: d.target ?? undefined,
      meals: d.meals.map((m) => ({
        slot: m.slot,
        time: m.time ?? undefined,
        items: m.items.map((p) => ({
          food: p.food,
          grams: p.grams,
          ...(p.macros ? { macros: p.macros } : {}),
          ...(p.source ? { source: p.source } : {}),
        })),
      })),
    })),
  };
}

function draftToBody(draft: DraftPlan) {
  return {
    name: (draft.name ?? "").trim() || null,
    start_date: draft.start_date ?? null,
    default_target: draft.default_target ?? null,
    days: (draft.days ?? []).map((d) => ({
      name: (d.name ?? "").trim() || "Day",
      weekdays: d.weekdays ?? [],
      target: d.target ?? null,
      meals: (d.meals ?? [])
        .filter((m) => (m.slot ?? "").trim())
        .map((m) => ({
          slot: (m.slot ?? "").trim(),
          time: (m.time ?? "").trim() || null,
          items: (m.items ?? [])
            .filter((p) => (p.food ?? "").trim() && (p.grams ?? 0) > 0)
            .map((p) => ({
              food: (p.food ?? "").trim(),
              grams: p.grams!,
              ...(p.macros ? { macros: p.macros } : {}),
              ...(p.source ? { source: p.source } : {}),
            })),
        })),
    })),
  };
}

function DietEditorDialog({
  plan,
  planId,
  focusDayIndex,
  onClose,
  onSaved,
}: {
  plan: ResolvedDietPlan | null;
  // null = create a new plan (POST); a number = replace that plan (PUT).
  planId: number | null;
  focusDayIndex?: number;
  onClose: () => void;
  onSaved: (savedId: number | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DraftPlan>(() => planToDraft(plan));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      // Validate against the same Zod schema the server enforces
      // (@fa/shared/schemas → DietPlanWriteRequest) before the write. The cast
      // bridges an Orval type-gen quirk: it renders nullable Macros refs
      // (default_target / day target) without `null`, so its generated type is
      // narrower than the schema — `body` is already validated, so this is safe.
      const body = DietPlanWriteRequest.parse(draftToBody(draft)) as Parameters<
        typeof postDietPlans
      >[0];
      const resp = planId == null ? await postDietPlans(body) : await putDietPlansId(body, planId);
      const saved = resp as unknown as DietPlanResp;
      onSaved(saved?.plan?.id ?? planId);
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setSaving(false);
    }
  };

  const dayCount = draft.days?.length ?? 0;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="modal-cap flex max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>
            {planId == null ? t("diet.newDietPlan") : t("diet.editDietPlan")}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="space-y-1.5">
            <label htmlFor="diet-plan-name" className="text-sm font-medium">
              {t("diet.planName")}
            </label>
            <Input
              id="diet-plan-name"
              value={draft.name ?? ""}
              placeholder={t("diet.planNamePlaceholder")}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <DietPlanForm
            schema={EMPTY_SCHEMA}
            value={draft}
            onChange={(next) => setDraft(next as DraftPlan)}
            disabled={saving}
            focusDayIndex={focusDayIndex}
          />
          {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving || dayCount === 0}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
