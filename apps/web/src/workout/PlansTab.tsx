// Workout → Plans: plan list, the plan editor and the exercise picker.
import { EmptyState } from "@/components/EmptyState";
import {
  type Equipment,
  type Exercise,
  exerciseFields,
  type ExerciseId,
  getExercise,
  type MachineId,
  muscleGroupsForExercise,
  type Weekday,
  type WorkoutCatalog,
  type WorkoutPlan,
} from "@fa/shared";
import { WorkoutPlanWriteRequest } from "@fa/shared/schemas";
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Info,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  deleteWorkoutPlansId,
  postWorkoutPlans,
  postWorkoutPlansIdActivate,
  putWorkoutPlansId,
} from "../api/endpoints/default/default";
import { ExerciseTypeBadge } from "../components/ExerciseTypeBadge";
import { MuscleMap } from "../components/MuscleMap";
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
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { SearchInput } from "../components/ui/search-input";
import { ExportPdfMenuItem, runExport } from "../export/printDoc";
import { exportWorkoutPlanPdf } from "../export/workoutPlanPdf";
import { MuscleGroupTotals, SaveWorkoutPlanForm } from "../forms/SaveWorkoutPlanForm";
import type { JsonSchema } from "../forms/ToolForm";
import {
  EquipmentSelect,
  exerciseAtGym,
  ExerciseMetaPanel,
  ExerciseTypeToggle,
  exerciseTypeMatches,
  MuscleSelect,
  type ExerciseTypeFilter,
  useExerciseMuscleNames,
  useGymMachineIds,
  useMuscleFilter,
} from "../forms/workoutControls";
import { apiErr } from "../lib/apiErr";
import { exerciseMatches, exerciseName, machineName } from "../lib/catalogLabels";
import { ExerciseThumb } from "../lib/exerciseIcon";
import { cn } from "../lib/utils";
import type { EditPlan } from "./shared";

// ---------- Plans list ----------

// Per-plan "active" toggle. Exactly one workout plan is active at a time, so
// this behaves radio-style: clicking an inactive plan activates it; the active
// plan's switch is "on" and non-interactive (you switch the active plan by
// turning another one on). Mirrors Diet's ActivePlanToggle.
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
  const label = checked ? t("workout.activePlan") : t("workout.makeActivePlan");
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
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

export function PlansList({
  plans,
  activePlanId,
  catalog,
  onEdit,
  onNew,
  onChanged,
}: {
  plans: WorkoutPlan[];
  // The user's active plan (profile.active_workout_plan_id), or null. Exactly
  // one plan is active at a time — the toggle behaves radio-style.
  activePlanId: number | null;
  catalog: WorkoutCatalog;
  onEdit: (p: WorkoutPlan) => void;
  onNew: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const exerciseById = useMemo(() => new Map(catalog.exercises.map((e) => [e.id, e])), [catalog]);

  // Confirmation + per-row state for the destructive delete. Pending holds
  // the plan being confirmed (or null if no dialog is open); deleteErr is the
  // inline failure message rendered above the list.
  const [pendingDelete, setPendingDelete] = useState<WorkoutPlan | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The plan whose activate request is in flight (disables every toggle while
  // pending, so a double-tap can't race two activations).
  const [activatingId, setActivatingId] = useState<number | null>(null);
  const activate = async (planId: number) => {
    setActivatingId(planId);
    setDeleteErr(null);
    try {
      await postWorkoutPlansIdActivate(planId);
      await onChanged();
    } catch (e) {
      setDeleteErr(apiErr(e));
    } finally {
      setActivatingId(null);
    }
  };

  // Cards collapse to a one-line summary by default (mirrors the Diets
  // list); the day breakdown and edit/delete controls only appear on expand.
  // `expandedIds === null` means "not yet touched" → default to the active
  // plan expanded; after the first toggle it's an explicit set, so the active
  // plan can still be collapsed by hand.
  const [expandedIds, setExpandedIds] = useState<Set<number> | null>(null);
  const expanded = expandedIds ?? new Set<number>(activePlanId != null ? [activePlanId] : []);
  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };
  // Plan days whose muscle breakdown is open (the chevron by their weekdays).
  const [openDays, setOpenDays] = useState<ReadonlySet<number>>(() => new Set());
  const toggleDay = (id: number) =>
    setOpenDays((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteWorkoutPlansId(pendingDelete.id);
      setPendingDelete(null);
      await onChanged();
    } catch (e) {
      setDeleteErr(apiErr(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      <Button onClick={onNew} className="w-full gap-1">
        <Plus className="size-4" /> {t("workout.newPlan")}
      </Button>
      {deleteErr && <p className="text-sm text-destructive">{deleteErr}</p>}
      {plans.length === 0 ? (
        <EmptyState icon={ClipboardList}>{t("workout.noPlansYet")}</EmptyState>
      ) : (
        plans.map((p) => {
          const isExpanded = expanded.has(p.id);
          const isActive = p.id === activePlanId;
          return (
            <Card key={p.id} className={cn(isActive && "border-primary")}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 text-start"
                    onClick={() => toggle(p.id)}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <CardTitle className="truncate text-base">{p.name}</CardTitle>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("workout.daysCount", { count: p.days.length })}
                    </span>
                  </button>
                  {/* Active toggle stays pinned far right; the actions menu
                      sits to its left, shown whether expanded or not. */}
                  <div className="flex shrink-0 items-center gap-1.5">
                    <RowActions
                      onEdit={() => onEdit(p)}
                      onDelete={() => {
                        setDeleteErr(null);
                        setPendingDelete(p);
                      }}
                      editLabel={t("workout.editPlan")}
                      deleteLabel={t("workout.deletePlan")}
                      ariaLabel={t("workout.actionsForPlan", { name: p.name })}
                      triggerClassName="h-7 w-7"
                      middle={
                        <ExportPdfMenuItem
                          onSelect={() => void runExport(() => exportWorkoutPlanPdf(p))}
                        />
                      }
                    />
                    <ActivePlanToggle
                      checked={isActive}
                      disabled={activatingId != null}
                      onActivate={() => void activate(p.id)}
                    />
                  </div>
                </div>
              </CardHeader>
              {isExpanded && (
                <CardContent>
                  {p.notes && <CardDescription className="mb-3">{p.notes}</CardDescription>}
                  {p.days.length === 0 ? (
                    <EmptyState icon={CalendarDays} compact>
                      {t("workout.noDaysConfigured")}
                    </EmptyState>
                  ) : (
                    <ul className="space-y-2">
                      {p.days.map((d) => (
                        <li
                          key={d.id}
                          className="rounded-md border border-edge bg-card p-2 shadow-tile"
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="text-sm font-medium">
                              {d.name}
                              {d.focus && (
                                <span className="text-muted-foreground"> · {d.focus}</span>
                              )}
                            </span>
                            {(d.weekdays.length > 0 || d.exercises.length > 0) && (
                              <div className="flex flex-wrap items-center gap-1">
                                {d.weekdays.map((w) => (
                                  <Badge key={w} variant="secondary" className="capitalize">
                                    {t(`workout.weekdays.${w}`).slice(0, 3)}
                                  </Badge>
                                ))}
                                {/* Opens the day's muscle breakdown below. */}
                                {d.exercises.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => toggleDay(d.id)}
                                    aria-expanded={openDays.has(d.id)}
                                    aria-label={t("export.workout.daySummary")}
                                    className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                  >
                                    <ChevronDown
                                      className={cn(
                                        "size-4 transition-transform",
                                        openDays.has(d.id) && "rotate-180",
                                      )}
                                    />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                            {d.exercises.length === 0
                              ? t("workout.noExercises")
                              : d.exercises.map((e) => (
                                  <span key={e.id} className="rounded-sm bg-muted px-1.5 py-0.5">
                                    {exerciseName(exerciseById.get(e.exercise_id) ?? e.exercise_id)}{" "}
                                    <span className="opacity-60">
                                      {e.target_sets}×
                                      {exerciseFields(exerciseById.get(e.exercise_id)).reps
                                        ? (e.target_reps ?? "—")
                                        : e.target_duration_sec != null
                                          ? // Cardio is planned in minutes; holds in seconds.
                                            exerciseFields(exerciseById.get(e.exercise_id)).distance
                                            ? t("workout.minutesShort", {
                                                n: +(e.target_duration_sec / 60).toFixed(1),
                                              })
                                            : `${e.target_duration_sec}s`
                                          : "—"}
                                    </span>
                                  </span>
                                ))}
                          </div>
                          {/* One pass of the day — no weekday multiplier, unlike
                              the plan's weekly totals below. */}
                          {d.exercises.length > 0 && openDays.has(d.id) && (
                            <div className="mt-2">
                              <MuscleGroupTotals days={[{ exercises: d.exercises }]} bare />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-4">
                    <MuscleGroupTotals days={p.days} defaultOpen={false} />
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(v) => {
          if (!v) {
            setPendingDelete(null);
            setDeleteErr(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workout.deletePlanTitle", { name: pendingDelete?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("workout.deletePlanBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open until the request resolves so an error
                // can be surfaced inline above the list. AlertDialogAction's
                // default behaviour is to close immediately on click — prevent
                // that and close manually on success in handleDelete.
                e.preventDefault();
                void handleDelete();
              }}
              disabled={deleting}
              className={buttonVariants({ variant: "destructive" })}
            >
              {deleting ? t("workout.deleting") : t("workout.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// The plan editor drives the shared <SaveWorkoutPlanForm> (the same bespoke
// form the save_workout_plan chat gate uses) with a local draft, then maps it
// back to the REST plan body. SaveWorkoutPlanForm picks exercises from the
// bundled @fa/shared catalog, so no catalog prop is needed here.
type FormPlanExercise = {
  exercise_id?: ExerciseId;
  machine_id?: MachineId;
  target_sets?: number;
  target_reps?: number;
  target_weight_kg?: number;
  target_duration_sec?: number;
  notes?: string;
};
type FormPlanDay = {
  weekdays?: Weekday[];
  name?: string;
  focus?: string;
  exercises?: FormPlanExercise[];
};
type FormPlan = {
  plan_id?: number;
  name?: string;
  notes?: string;
  days?: FormPlanDay[];
};

const PLAN_EMPTY_SCHEMA = { type: "object", properties: {} } as JsonSchema;

function editPlanToForm(p: EditPlan): FormPlan {
  return {
    plan_id: p.id,
    name: p.name,
    notes: p.notes || undefined,
    days: p.days.map((d) => ({
      weekdays: d.weekdays,
      name: d.name,
      focus: d.focus || undefined,
      exercises: d.exercises.map((e) => ({
        exercise_id: e.exercise_id,
        machine_id: e.machine_id ?? undefined,
        target_sets: e.target_sets,
        target_reps: e.target_reps ?? undefined,
        target_weight_kg: e.target_weight_kg ?? undefined,
        target_duration_sec: e.target_duration_sec ?? undefined,
        notes: e.notes || undefined,
      })),
    })),
  };
}

function formToPlanBody(draft: FormPlan) {
  return {
    name: (draft.name ?? "").trim(),
    notes: draft.notes || undefined,
    days: (draft.days ?? []).map((d) => ({
      weekdays: d.weekdays ?? [],
      name: (d.name ?? "").trim() || "Day",
      focus: d.focus || undefined,
      exercises: (d.exercises ?? [])
        .filter((e) => e.exercise_id)
        .map((e, i) => ({
          exercise_id: e.exercise_id!,
          machine_id: e.machine_id ?? null,
          order: i,
          target_sets: e.target_sets ?? 3,
          target_reps: e.target_reps ?? null,
          target_weight_kg: e.target_weight_kg ?? null,
          target_duration_sec: e.target_duration_sec ?? null,
          notes: e.notes || undefined,
        })),
    })),
  };
}

export function PlanEditorDialog({
  open,
  onClose,
  plan,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  plan: EditPlan;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<FormPlan>(() => editPlanToForm(plan));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset when a different plan opens.
  useEffect(() => {
    setDraft(editPlanToForm(plan));
    setErr(null);
  }, [plan]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      // Validate against the same Zod schema the server enforces
      // (@fa/shared/schemas → WorkoutPlanWriteRequest) before the write.
      const body = WorkoutPlanWriteRequest.parse(formToPlanBody(draft));
      if (plan.id == null) {
        await postWorkoutPlans(body);
      } else {
        await putWorkoutPlansId(body, plan.id);
      }
      await onSaved();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="modal-cap flex w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>
            {plan.id == null ? t("workout.newWorkoutPlan") : t("workout.editWorkoutPlan")}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <SaveWorkoutPlanForm
            schema={PLAN_EMPTY_SCHEMA}
            value={draft}
            onChange={(next) => setDraft(next as FormPlan)}
            disabled={saving}
          />
          {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !(draft.name ?? "").trim()}>
            {saving ? t("common.saving") : plan.id == null ? t("workout.create") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Exercise picker (modal-in-modal) ----------

export function ExercisePicker({
  catalog,
  onPick,
  onClose,
  prioritizeIds,
  gymFilterDefault = true,
}: {
  catalog: WorkoutCatalog;
  onPick: (ex: Exercise) => void;
  onClose: () => void;
  // When set, exercises whose id is in this list float to the top of the
  // results (preserving the input order), with a divider before the rest.
  // Used by the Progress tab to surface the user's trained lifts first.
  prioritizeIds?: ExerciseId[];
  // When the user has saved gym machines, start with the "only my gym" filter
  // on (default). Pass false where hiding equipment is unhelpful (e.g. picking
  // a lift to view its progress history).
  gymFilterDefault?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const muscle = useMuscleFilter();
  const muscleMatches = muscle.matches;
  const [equipmentFilter, setEquipmentFilter] = useState<Equipment | "all">("all");
  const [typeFilter, setTypeFilter] = useState<ExerciseTypeFilter>("all");

  const gym = useGymMachineIds();
  const hasGym = gym.size > 0;
  const [onlyGym, setOnlyGym] = useState(gymFilterDefault);
  // Exercise whose how-to dialog is open.
  const [howToId, setHowToId] = useState<ExerciseId | null>(null);

  const priorityRank = useMemo(() => {
    const m = new Map<ExerciseId, number>();
    if (prioritizeIds) prioritizeIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [prioritizeIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = catalog.exercises.filter((e) => {
      if (equipmentFilter !== "all" && e.equipment !== equipmentFilter) {
        return false;
      }
      if (onlyGym && hasGym && !exerciseAtGym(e.machine_id, gym)) {
        return false;
      }
      if (!muscleMatches(e)) return false;
      if (!exerciseTypeMatches(e, typeFilter)) return false;
      if (q && !exerciseMatches(e, q)) {
        return false;
      }
      return true;
    });
    if (priorityRank.size === 0) return matches;
    return matches.slice().sort((a, b) => {
      const ra = priorityRank.get(a.id);
      const rb = priorityRank.get(b.id);
      if (ra != null && rb != null) return ra - rb;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [
    catalog,
    query,
    muscleMatches,
    typeFilter,
    equipmentFilter,
    priorityRank,
    onlyGym,
    hasGym,
    gym,
  ]);

  const firstUnprioritized = useMemo(() => {
    if (priorityRank.size === 0) return -1;
    return filtered.findIndex((e) => !priorityRank.has(e.id));
  }, [filtered, priorityRank]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="modal-cap w-full max-w-xl overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{t("workout.addExercise")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-4 py-3">
          <SearchInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t("workout.searchExercises")}
          />
          <div className="flex gap-2">
            <MuscleSelect
              value={muscle.value}
              onChange={muscle.onChange}
              view={muscle.view}
              onViewChange={muscle.onViewChange}
            />
            <EquipmentSelect
              value={equipmentFilter}
              onChange={setEquipmentFilter}
              gym={{ on: onlyGym, onChange: setOnlyGym, available: hasGym }}
            />
          </div>
          <ExerciseTypeToggle value={typeFilter} onChange={setTypeFilter} />
        </div>
        <div className="max-h-[50vh] overflow-y-auto border-t">
          {filtered.length === 0 ? (
            <EmptyState icon={Search} compact className="m-3">
              {t("workout.noMatches")}
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {filtered.map((ex, i) => (
                <li
                  key={ex.id}
                  className={cn(
                    i === firstUnprioritized && "border-t-2 border-t-muted-foreground/20",
                  )}
                >
                  {/* The row lights up as one while either pick target is
                      hovered; the how-to toggle between them hovers alone. */}
                  <div
                    className={cn(
                      "flex items-stretch transition-[color,background-color,box-shadow]",
                      "has-[[data-pick]:hover]:bg-accent",
                      "soft:has-[[data-pick]:hover]:bg-background soft:has-[[data-pick]:hover]:text-primary soft:has-[[data-pick]:hover]:shadow-pressed",
                    )}
                  >
                    <button
                      type="button"
                      data-pick
                      onClick={() => onPick(ex)}
                      className="flex flex-1 items-center gap-2.5 px-4 py-2 text-start text-sm"
                    >
                      <ExerciseThumb exerciseId={ex.id} className="size-12" placeholder />
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                        <span className="font-medium">{exerciseName(ex)}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <ExerciseTypeBadge type={ex.type} />
                          {ex.equipment}
                          {ex.machine_id ? ` · ${machineName(ex.machine_id)}` : ""}
                        </span>
                        <ExerciseMuscleNames exerciseId={ex.id} />
                      </span>
                    </button>
                    {ex.metadata && (
                      <button
                        type="button"
                        onClick={() => setHowToId(ex.id)}
                        aria-haspopup="dialog"
                        aria-label={t("workout.howToFor", { name: exerciseName(ex) })}
                        className={cn(
                          "flex shrink-0 flex-col items-center justify-center gap-0.5 px-2 text-[10px] font-medium text-muted-foreground transition-[color,background-color,box-shadow] hover:bg-accent hover:text-foreground soft:hover:bg-background soft:hover:text-primary soft:hover:shadow-pressed",
                        )}
                      >
                        <Info className="size-4" />
                        {t("workout.howTo")}
                      </button>
                    )}
                    {/* Part of the pick target; the how-to toggle sits between. */}
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      data-pick
                      onClick={() => onPick(ex)}
                      className="flex shrink-0 items-center ps-1 pe-4"
                    >
                      <MuscleMap
                        groups={muscleGroupsForExercise(ex.id)}
                        muscles={ex.primary_muscles}
                        className="h-12"
                      />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
      {howToId && (
        <ExerciseHowToDialog
          exerciseId={howToId}
          open
          onOpenChange={(o) => !o && setHowToId(null)}
        />
      )}
    </Dialog>
  );
}

// Modal with an exercise's how-to: who it's for (thumb, type, muscles) on top,
// then the reference media/description panel.
export function ExerciseHowToDialog({
  exerciseId,
  open,
  onOpenChange,
}: {
  exerciseId: ExerciseId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const muscleNames = useExerciseMuscleNames();
  const ex = getExercise(exerciseId);
  if (!ex?.metadata) return null;
  const groups = muscleGroupsForExercise(ex);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ExerciseThumb exerciseId={ex.id} className="size-12" />
            <div className="min-w-0 flex-1 space-y-1 text-start">
              <DialogTitle className="flex items-center gap-2">
                <span className="truncate">{exerciseName(ex)}</span>
                <ExerciseTypeBadge type={ex.type} />
              </DialogTitle>
              {groups.length > 0 && (
                <p className="text-xs text-muted-foreground">{muscleNames(ex)}</p>
              )}
            </div>
            {groups.length > 0 && (
              <MuscleMap groups={groups} muscles={ex.primary_muscles} className="h-12" />
            )}
          </div>
        </DialogHeader>
        <ExerciseMetaPanel meta={ex.metadata} embed />
      </DialogContent>
    </Dialog>
  );
}

export function ExerciseMuscleNames({ exerciseId }: { exerciseId: string }) {
  const muscleNames = useExerciseMuscleNames();
  const ex = getExercise(exerciseId);
  const names = ex ? muscleNames(ex) : "";
  return names ? <span className="text-[11px] text-muted-foreground/80">{names}</span> : null;
}
