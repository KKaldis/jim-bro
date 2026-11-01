import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  BicepsFlexed,
  CalendarDays,
  ChevronDown,
  Dumbbell,
  Plus,
  Trash2,
} from "lucide-react";
import { exerciseFields, getExercise, planMuscleTotals, type PlanTotalsDay } from "@fa/shared";
import {
  BucketMap,
  bucketLabel,
  bucketsForExercise,
  MuscleViewToggle,
} from "@/components/MuscleViewToggle";
import { ExerciseTypeBadge } from "@/components/ExerciseTypeBadge";
import { useUiStore } from "@/lib/uiStore";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Field, SectionLabel, UnitInput } from "./formKit";
import {
  ExerciseMetaDisclosure,
  ExercisePicker,
  Stepper,
  WeekdayPicker,
  weekdayAbbr,
  type Weekday,
} from "./workoutControls";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate form for save_workout_plan (create, or wholesale-replace an
// existing plan when plan_id is set). Plan name/notes up top, then collapsible
// day cards — each with a weekday selector, focus, and a list of prescribed
// exercises (exercise picker + target sets/reps/weight). Days carry stable
// local ids so collapse/rename never jumps rows; everything serializes back to
// the flat day/exercise arrays the tool expects.

type PlanExercise = {
  exercise_id?: string;
  machine_id?: string;
  target_sets?: number;
  target_reps?: number;
  target_weight_kg?: number;
  target_duration_sec?: number;
  notes?: string;
};

type PlanDay = {
  weekdays?: Weekday[];
  name?: string;
  focus?: string;
  exercises?: PlanExercise[];
};

type PlanInput = {
  plan_id?: number;
  name?: string;
  notes?: string;
  days?: PlanDay[];
};

type DayRow = { id: number; day: PlanDay };

// Weekdays already claimed by every day EXCEPT `exceptId` — a weekday runs at
// most one day, so these are disabled in that day's WeekdayPicker (mirrors the
// diet-plan form).
function usedWeekdaysExcept(rows: DayRow[], exceptId: number): Set<Weekday> {
  const used = new Set<Weekday>();
  for (const r of rows) {
    if (r.id === exceptId) continue;
    for (const wd of r.day.weekdays ?? []) used.add(wd);
  }
  return used;
}

// Targets for a row whose exercise was just (re)picked: keep what still applies
// and fill what the new exercise needs, so the fields and the weekly totals
// never disagree (a plank swapped in for a lift would otherwise show "60"
// as a placeholder but count 0 s, and a run would inherit the lift's 3 sets).
function retarget(ex: PlanExercise, exerciseId: string): PlanExercise {
  const fields = exerciseFields(getExercise(exerciseId));
  const cardio = fields.distance;
  return {
    ...ex,
    exercise_id: exerciseId,
    target_sets: cardio ? 1 : (ex.target_sets ?? 3),
    target_reps: fields.reps ? (ex.target_reps ?? 10) : undefined,
    target_duration_sec: fields.duration
      ? (ex.target_duration_sec ?? (cardio ? 1800 : 60))
      : undefined,
    target_weight_kg: fields.weight ? ex.target_weight_kg : undefined,
  };
}

function cleanDay(day: PlanDay): PlanDay {
  const out: PlanDay = { name: day.name ?? "", exercises: day.exercises ?? [] };
  if (day.weekdays?.length) out.weekdays = day.weekdays;
  if (day.focus) out.focus = day.focus;
  return out;
}

export function SaveWorkoutPlanForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const v = (value as PlanInput) ?? {};

  const nextId = useRef(0);
  const [rows, setRows] = useState<DayRow[]>(() =>
    (v.days ?? []).map((day) => ({ id: nextId.current++, day })),
  );
  // Existing days start collapsed; a day added here opens (see addDay).
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  const emit = (nextRows: DayRow[]) =>
    onChange({ ...v, days: nextRows.map((r) => cleanDay(r.day)) });

  const setTop = (patch: Partial<PlanInput>) => onChange({ ...v, ...patch });

  const patchDay = (id: number, patch: Partial<PlanDay>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, day: { ...r.day, ...patch } } : r));
    setRows(next);
    emit(next);
  };

  const addDay = () => {
    const id = nextId.current++;
    const next = [...rows, { id, day: { name: "", exercises: [] } as PlanDay }];
    setRows(next);
    setOpen((sset) => new Set(sset).add(id));
    emit(next);
  };

  const removeDay = (id: number) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit(next);
  };

  const toggleOpen = (id: number) =>
    setOpen((sset) => {
      const n = new Set(sset);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Exercise helpers operate on a day's exercises[].
  const patchExercise = (id: number, ei: number, patch: Partial<PlanExercise>) => {
    const day = rows.find((r) => r.id === id)?.day;
    if (!day) return;
    const exercises = (day.exercises ?? []).map((e, idx) => (idx === ei ? { ...e, ...patch } : e));
    patchDay(id, { exercises });
  };
  const addExercise = (id: number) => {
    const day = rows.find((r) => r.id === id)?.day;
    if (!day) return;
    patchDay(id, {
      exercises: [...(day.exercises ?? []), { target_sets: 3, target_reps: 10 }],
    });
  };
  const removeExercise = (id: number, ei: number) => {
    const day = rows.find((r) => r.id === id)?.day;
    if (!day) return;
    patchDay(id, { exercises: (day.exercises ?? []).filter((_, idx) => idx !== ei) });
  };
  // Swap exercise ei with its neighbour (dir -1 = up, +1 = down). The saved
  // order is the array position, so this is all reordering needs.
  const moveExercise = (id: number, ei: number, dir: -1 | 1) => {
    const day = rows.find((r) => r.id === id)?.day;
    if (!day) return;
    const exercises = [...(day.exercises ?? [])];
    const to = ei + dir;
    if (to < 0 || to >= exercises.length) return;
    [exercises[ei], exercises[to]] = [exercises[to], exercises[ei]];
    patchDay(id, { exercises });
  };

  return (
    <div className="space-y-6">
      {/* ── Plan ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel
          Icon={Dumbbell}
          hint={
            v.plan_id != null
              ? tr("formsAdmin.workoutPlan.replacingExisting")
              : tr("formsAdmin.workoutPlan.newPlan")
          }
        >
          {tr("formsAdmin.workoutPlan.plan")}
        </SectionLabel>
        <Field label={tr("formsAdmin.workoutPlan.name")}>
          <Input
            value={v.name ?? ""}
            disabled={disabled}
            placeholder={tr("formsAdmin.workoutPlan.namePlaceholder")}
            onChange={(e) => setTop({ name: e.target.value || undefined })}
            className="h-9"
          />
        </Field>
        <Field label={tr("formsAdmin.workoutPlan.notes")} optional>
          <Textarea
            value={v.notes ?? ""}
            disabled={disabled}
            rows={2}
            placeholder={tr("formsAdmin.workoutPlan.notesPlaceholder")}
            onChange={(e) => setTop({ notes: e.target.value || undefined })}
            className="min-h-14 resize-y"
          />
        </Field>
      </section>

      {/* ── Days ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel
          Icon={CalendarDays}
          hint={tr("formsAdmin.workoutPlan.dayCount", { count: rows.length })}
        >
          {tr("formsAdmin.workoutPlan.days")}
        </SectionLabel>
        <div className="space-y-2">
          {rows.map((r) => {
            const isOpen = open.has(r.id);
            const day = r.day;
            const exercises = day.exercises ?? [];
            return (
              <div key={r.id} className="rounded-lg border border-primary/40 bg-background/40">
                <div className="flex items-center gap-1.5 p-1.5">
                  <button
                    type="button"
                    onClick={() => toggleOpen(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-60"
                    aria-label={
                      isOpen
                        ? tr("formsAdmin.workoutPlan.collapse")
                        : tr("formsAdmin.workoutPlan.expand")
                    }
                  >
                    <ChevronDown
                      className={cn("size-4 transition-transform", isOpen && "rotate-180")}
                    />
                  </button>
                  <Input
                    value={day.name ?? ""}
                    disabled={disabled}
                    placeholder={tr("formsAdmin.workoutPlan.dayNamePlaceholder")}
                    onChange={(e) => patchDay(r.id, { name: e.target.value })}
                    className="h-8 flex-1"
                  />
                  {!isOpen && (
                    <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
                      {tr("formsAdmin.workoutPlan.exCount", { count: exercises.length })}
                      {day.weekdays?.length ? ` · ${day.weekdays.map(weekdayAbbr).join(" ")}` : ""}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeDay(r.id)}
                    disabled={disabled}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                    aria-label={tr("formsAdmin.workoutPlan.removeDay")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>

                {isOpen && (
                  <div className="space-y-4 border-t p-3">
                    <Field label={tr("formsAdmin.workoutPlan.runsOn")} optional>
                      <WeekdayPicker
                        value={day.weekdays}
                        disabled={disabled}
                        unavailable={usedWeekdaysExcept(rows, r.id)}
                        onChange={(wds) => patchDay(r.id, { weekdays: wds })}
                      />
                    </Field>

                    <Field label={tr("formsAdmin.workoutPlan.focus")} optional>
                      <Input
                        value={day.focus ?? ""}
                        disabled={disabled}
                        placeholder={tr("formsAdmin.workoutPlan.focusPlaceholder")}
                        onChange={(e) => patchDay(r.id, { focus: e.target.value || undefined })}
                        className="h-9"
                      />
                    </Field>

                    {/* Prescribed exercises */}
                    <div className="space-y-2">
                      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                        {tr("formsAdmin.workoutPlan.exercises")}
                      </div>
                      {exercises.map((ex, ei) => (
                        <div key={ei} className="space-y-2 rounded-md border bg-background/60 p-2">
                          <ExercisePicker
                            value={ex.exercise_id}
                            disabled={disabled}
                            onPick={(eid) =>
                              eid !== ex.exercise_id && patchExercise(r.id, ei, retarget(ex, eid))
                            }
                          />
                          <ExerciseMetaDisclosure exerciseId={ex.exercise_id} />
                          <div className="grid grid-cols-3 gap-2">
                            <Field label={tr("formsAdmin.workoutPlan.sets")}>
                              <Stepper
                                value={ex.target_sets}
                                disabled={disabled}
                                min={1}
                                placeholder="3"
                                onChange={(n) => patchExercise(r.id, ei, { target_sets: n })}
                              />
                            </Field>
                            {/* Only the targets this exercise uses (exerciseFields):
                                reps for lifts, duration for timed holds (seconds) and
                                cardio (entered in minutes), weight where it applies. */}
                            {(() => {
                              const fields = exerciseFields(getExercise(ex.exercise_id ?? ""));
                              const cardio = fields.distance;
                              return (
                                <>
                                  {fields.reps && (
                                    <Field label={tr("formsAdmin.workoutPlan.reps")}>
                                      <Stepper
                                        value={ex.target_reps}
                                        disabled={disabled}
                                        min={1}
                                        placeholder="10"
                                        onChange={(n) =>
                                          patchExercise(r.id, ei, { target_reps: n })
                                        }
                                      />
                                    </Field>
                                  )}
                                  {fields.duration && !cardio && (
                                    <Field label={tr("formsAdmin.workoutPlan.seconds")}>
                                      <Stepper
                                        value={ex.target_duration_sec}
                                        disabled={disabled}
                                        min={1}
                                        placeholder="60"
                                        onChange={(n) =>
                                          patchExercise(r.id, ei, { target_duration_sec: n })
                                        }
                                      />
                                    </Field>
                                  )}
                                  {cardio && (
                                    <Field label={tr("formsAdmin.workoutPlan.minutes")}>
                                      <UnitInput
                                        suffix="min"
                                        value={
                                          ex.target_duration_sec != null
                                            ? ex.target_duration_sec / 60
                                            : ""
                                        }
                                        disabled={disabled}
                                        placeholder="30"
                                        step="any"
                                        onChange={(n) =>
                                          patchExercise(r.id, ei, {
                                            target_duration_sec:
                                              n != null ? Math.round(n * 60) : undefined,
                                          })
                                        }
                                      />
                                    </Field>
                                  )}
                                  {fields.weight && (
                                    <Field label={tr("formsAdmin.workoutPlan.weight")} optional>
                                      <UnitInput
                                        suffix="kg"
                                        value={ex.target_weight_kg ?? ""}
                                        disabled={disabled}
                                        placeholder="—"
                                        step="any"
                                        onChange={(n) =>
                                          patchExercise(r.id, ei, { target_weight_kg: n })
                                        }
                                      />
                                    </Field>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                          <Input
                            value={ex.notes ?? ""}
                            disabled={disabled}
                            placeholder={tr("formsAdmin.workoutPlan.notesPlaceholder")}
                            onChange={(e) =>
                              patchExercise(r.id, ei, { notes: e.target.value || undefined })
                            }
                            className="h-8 text-[13px]"
                          />
                          <div className="grid grid-cols-3 gap-1">
                            <button
                              type="button"
                              onClick={() => moveExercise(r.id, ei, 1)}
                              disabled={disabled || ei === exercises.length - 1}
                              className="flex h-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                              aria-label={tr("formsAdmin.workoutPlan.moveExerciseDown")}
                              title={tr("formsAdmin.workoutPlan.moveExerciseDown")}
                            >
                              <ArrowDown className="size-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeExercise(r.id, ei)}
                              disabled={disabled}
                              className="flex h-8 items-center justify-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                            >
                              <Trash2 className="size-3.5" />
                              {tr("formsAdmin.workoutPlan.removeExercise")}
                            </button>
                            <button
                              type="button"
                              onClick={() => moveExercise(r.id, ei, -1)}
                              disabled={disabled || ei === 0}
                              className="flex h-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                              aria-label={tr("formsAdmin.workoutPlan.moveExerciseUp")}
                              title={tr("formsAdmin.workoutPlan.moveExerciseUp")}
                            >
                              <ArrowUp className="size-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => addExercise(r.id)}
                        disabled={disabled}
                        className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
                      >
                        <Plus className="size-3.5" />
                        {tr("formsAdmin.workoutPlan.addExercise")}
                      </button>
                    </div>
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
            {tr("formsAdmin.workoutPlan.addDay")}
          </button>
        </div>
      </section>

      <MuscleGroupTotals days={rows.map((r) => r.day)} />
    </div>
  );
}

// Weekly sets/reps per muscle group for a plan's days (planMuscleTotals in
// @fa/shared — the same numbers the agent's review_training_plan reports).
// Shared by the plan builder (live, as you edit) and the read-only plan card on
// the Workout page.
// The header toggles the list; `defaultOpen` sets its initial state. `bare`
// renders just the list, no header — for a day card, which shows or hides it
// from its own toggle.
export function MuscleGroupTotals({
  days,
  defaultOpen = true,
  bare = false,
}: {
  days: readonly PlanTotalsDay[];
  defaultOpen?: boolean;
  bare?: boolean;
}) {
  const { t: tr } = useTranslation();
  const view = useUiStore((s) => s.muscleView);
  const totals = useMemo(
    () => planMuscleTotals(days, (id) => bucketsForExercise(id, view)),
    [days, view],
  );
  const [headerOpen, setOpen] = useState(defaultOpen);
  const open = bare || headerOpen;
  if (totals.length === 0) return null;
  return (
    <section className="space-y-3">
      {!bare && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
          >
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
            <div className="flex-1">
              <SectionLabel Icon={BicepsFlexed}>
                {tr("formsAdmin.workoutPlan.muscleTotals")}
              </SectionLabel>
            </div>
          </button>
          {open && <MuscleViewToggle />}
        </div>
      )}
      {open && (
        <ul className="divide-y rounded-lg border border-edge bg-background/40 shadow-well">
          {totals.map(({ group, sets, reps, seconds, compound, isolation }) => (
            <li key={group} className="flex items-center gap-3 px-3 py-1.5 text-sm">
              <BucketMap id={group} view={view} className="h-8 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="block truncate font-medium capitalize">
                  {bucketLabel(group, view)}
                </span>
                {(compound > 0 || isolation > 0) && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {compound > 0 && <ExerciseTypeBadge type="compound" count={compound} />}
                    {isolation > 0 && <ExerciseTypeBadge type="isolation" count={isolation} />}
                  </div>
                )}
              </div>
              <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {tr("formsAdmin.workoutPlan.setCount", { count: sets })}
              </span>
              <span className="min-w-20 text-end font-semibold whitespace-nowrap tabular-nums">
                {[
                  reps > 0 && tr("formsAdmin.workoutPlan.repCount", { count: reps }),
                  seconds > 0 &&
                    (seconds >= 60
                      ? tr("formsAdmin.workoutPlan.holdMinutes", {
                          value: Math.round((seconds / 60) * 10) / 10,
                        })
                      : tr("formsAdmin.workoutPlan.holdSeconds", { value: seconds })),
                ]
                  .filter(Boolean)
                  .join(" + ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
