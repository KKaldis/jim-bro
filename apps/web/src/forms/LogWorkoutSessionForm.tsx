import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Dumbbell, Flame, Plus, StickyNote, Tag, Trash2, X } from "lucide-react";
import { getExercise, isTimedExercise, trackedMetricsFor } from "@fa/shared";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { today, toIso } from "../dateRange";
import { Field, SectionLabel, UnitInput } from "./formKit";
import { ExerciseMetaDisclosure, ExercisePicker, Stepper } from "./workoutControls";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate form for log_workout_session — create a session and log every
// set in one shot. Session-level fields up top (date / name / duration / kcal /
// notes), then one card per exercise with an editable reps × weight × RPE set
// grid. Flat contract preserved; unknown keys (plan_day_id, started_at) pass
// through untouched.

type SetRow = {
  reps?: number;
  weight_kg?: number;
  rpe?: number;
  // Cardio work (seconds / metres) — set instead of reps/weight for cardio
  // exercises. Kept on the row so an agent-proposed cardio set round-trips.
  duration_sec?: number;
  distance_m?: number;
  completed_at?: string;
};

type ExerciseRow = {
  exercise_id?: string;
  machine_id?: string;
  sets?: SetRow[];
};

type SessionInput = {
  date?: string;
  name?: string;
  duration_min?: number;
  kcal_burned?: number;
  notes?: string;
  exercises?: ExerciseRow[];
  [key: string]: unknown;
};

export function LogWorkoutSessionForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const s = (value as SessionInput) ?? {};
  const exercises = s.exercises ?? [];
  const set = (patch: Partial<SessionInput>) => onChange({ ...s, ...patch });

  // Default date to today + ensure at least one exercise row so the form is
  // never empty (the tool requires ≥1 exercise with ≥1 set).
  useEffect(() => {
    if (disabled) return;
    const patch: Partial<SessionInput> = {};
    if (!s.date) patch.date = toIso(today());
    if (exercises.length === 0) patch.exercises = [{ sets: [{}] }];
    if (Object.keys(patch).length) set(patch);
    // Mount-only seed; re-running would fight user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setExercises = (next: ExerciseRow[]) => set({ exercises: next });

  const patchExercise = (i: number, patch: Partial<ExerciseRow>) =>
    setExercises(exercises.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  const addExercise = () => setExercises([...exercises, { sets: [{}] }]);

  const removeExercise = (i: number) => setExercises(exercises.filter((_, idx) => idx !== i));

  const patchSet = (ei: number, si: number, patch: Partial<SetRow>) => {
    const ex = exercises[ei];
    const sets = (ex.sets ?? []).map((st, idx) => (idx === si ? { ...st, ...patch } : st));
    patchExercise(ei, { sets });
  };

  const addSet = (ei: number) => {
    const sets = exercises[ei].sets ?? [];
    // Clone the last set's load so adding "another set of the same" is one tap.
    const last = sets[sets.length - 1];
    patchExercise(ei, { sets: [...sets, last ? { ...last } : {}] });
  };

  const removeSet = (ei: number, si: number) => {
    const sets = (exercises[ei].sets ?? []).filter((_, idx) => idx !== si);
    patchExercise(ei, { sets });
  };

  return (
    <div className="space-y-6">
      {/* ── Session ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Tag}>{t("forms.workout.session")}</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("forms.workout.date")}>
            <DatePicker
              value={s.date ?? ""}
              disabled={disabled}
              onChange={(iso) => set({ date: iso || undefined })}
            />
          </Field>
          <Field label={t("forms.workout.name")} optional>
            <Input
              value={s.name ?? ""}
              disabled={disabled}
              placeholder={t("forms.workout.namePlaceholder")}
              onChange={(e) => set({ name: e.target.value || undefined })}
              className="h-9"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("forms.workout.duration")} optional>
            <UnitInput
              icon={<Clock className="size-3.5" />}
              suffix="min"
              value={s.duration_min ?? ""}
              disabled={disabled}
              placeholder="0"
              step="any"
              onChange={(n) => set({ duration_min: n })}
            />
          </Field>
          <Field label={t("forms.workout.energy")} optional>
            <UnitInput
              icon={<Flame className="size-3.5" />}
              suffix="kcal"
              value={s.kcal_burned ?? ""}
              disabled={disabled}
              placeholder="0"
              step="any"
              onChange={(n) => set({ kcal_burned: n })}
            />
          </Field>
        </div>
      </section>

      {/* ── Exercises ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel
          Icon={Dumbbell}
          hint={t("forms.workout.exercises", { count: exercises.length })}
        >
          {t("forms.workout.exercisesTitle")}
        </SectionLabel>
        <div className="space-y-3">
          {exercises.map((ex, ei) => {
            const sets = ex.sets ?? [];
            const exCatalog = ex.exercise_id ? getExercise(ex.exercise_id) : null;
            const isCardio = exCatalog
              ? trackedMetricsFor(exCatalog).includes("duration_distance")
              : false;
            // A timed hold (plank): seconds (duration_sec) instead of reps.
            const isTimed = !isCardio && isTimedExercise(exCatalog);
            return (
              <div
                key={ei}
                className="space-y-3 rounded-lg border border-edge bg-background/40 p-3 shadow-well"
              >
                <div className="flex items-center gap-1.5">
                  <div className="flex-1">
                    <ExercisePicker
                      value={ex.exercise_id}
                      disabled={disabled}
                      onPick={(id) => patchExercise(ei, { exercise_id: id })}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeExercise(ei)}
                    disabled={disabled}
                    className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
                    aria-label={t("forms.workout.removeExercise")}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>

                <ExerciseMetaDisclosure exerciseId={ex.exercise_id} />

                {/* Set grid */}
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[1.5rem_1fr_1fr_3.5rem_1.75rem] items-center gap-2 px-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    <span>#</span>
                    {isCardio ? (
                      <>
                        <span>{t("forms.workout.durationCol")}</span>
                        <span>{t("forms.workout.distanceCol")}</span>
                        <span />
                      </>
                    ) : (
                      <>
                        <span>{t(isTimed ? "forms.workout.seconds" : "forms.workout.reps")}</span>
                        <span>{t("forms.workout.weight")}</span>
                        <span>{t("forms.workout.rpe")}</span>
                      </>
                    )}
                    <span />
                  </div>
                  {sets.map((st, si) => (
                    <div
                      key={si}
                      className="grid grid-cols-[1.5rem_1fr_1fr_3.5rem_1.75rem] items-center gap-2"
                    >
                      <span className="text-center text-xs text-muted-foreground tabular-nums">
                        {si + 1}
                      </span>
                      {isCardio ? (
                        <>
                          <UnitInput
                            suffix="min"
                            value={st.duration_sec != null ? st.duration_sec / 60 : ""}
                            disabled={disabled}
                            placeholder="0"
                            step="any"
                            min={0}
                            // Cardio sets carry no load; zero reps/weight so the
                            // burn comes from duration × MET.
                            onChange={(n) =>
                              patchSet(ei, si, {
                                duration_sec: n != null && n > 0 ? Math.round(n * 60) : undefined,
                                reps: 0,
                                weight_kg: 0,
                              })
                            }
                          />
                          <UnitInput
                            suffix="km"
                            value={st.distance_m != null ? st.distance_m / 1000 : ""}
                            disabled={disabled}
                            placeholder="0"
                            step="any"
                            min={0}
                            onChange={(n) =>
                              patchSet(ei, si, {
                                distance_m: n != null && n > 0 ? Math.round(n * 1000) : undefined,
                              })
                            }
                          />
                          <span />
                        </>
                      ) : (
                        <>
                          {isTimed ? (
                            // A timed hold: seconds in duration_sec, reps 0.
                            <Stepper
                              value={st.duration_sec ?? undefined}
                              disabled={disabled}
                              min={0}
                              placeholder="0"
                              onChange={(n) =>
                                patchSet(ei, si, {
                                  duration_sec: n != null && n > 0 ? n : undefined,
                                  reps: 0,
                                })
                              }
                            />
                          ) : (
                            <Stepper
                              value={st.reps}
                              disabled={disabled}
                              min={0}
                              placeholder="0"
                              onChange={(n) => patchSet(ei, si, { reps: n })}
                            />
                          )}
                          <UnitInput
                            suffix="kg"
                            value={st.weight_kg ?? ""}
                            disabled={disabled}
                            placeholder="0"
                            step="any"
                            onChange={(n) => patchSet(ei, si, { weight_kg: n })}
                          />
                          <Input
                            type="number"
                            inputMode="decimal"
                            value={st.rpe ?? ""}
                            disabled={disabled}
                            placeholder="–"
                            min={1}
                            max={10}
                            step="any"
                            onChange={(e) => {
                              const v = e.target.value;
                              patchSet(ei, si, {
                                rpe: v === "" ? undefined : Number(v),
                              });
                            }}
                            className="h-9 px-1 text-center text-sm tabular-nums"
                          />
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => removeSet(ei, si)}
                        disabled={disabled || sets.length <= 1}
                        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                        aria-label={t("forms.workout.removeSet")}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => addSet(ei)}
                    disabled={disabled}
                    className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
                  >
                    <Plus className="size-3.5" />
                    {t("forms.workout.addSet")}
                  </button>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={addExercise}
            disabled={disabled}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
          >
            <Plus className="size-4" />
            {t("forms.workout.addExercise")}
          </button>
        </div>
      </section>

      {/* ── Notes ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={StickyNote}>{t("forms.workout.notes")}</SectionLabel>
        <Textarea
          value={s.notes ?? ""}
          disabled={disabled}
          rows={2}
          placeholder={t("forms.workout.notesPlaceholder")}
          onChange={(e) => set({ notes: e.target.value || undefined })}
          className="min-h-14 resize-y"
        />
      </section>
    </div>
  );
}
