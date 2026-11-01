import { useTranslation } from "react-i18next";
import { Dumbbell, Pencil, Repeat } from "lucide-react";
import { Input } from "@/components/ui/input";
import { BatchRepeater, Field, SectionLabel, UnitInput } from "./formKit";
import {
  ExerciseMetaDisclosure,
  ExercisePicker,
  Stepper,
  WeekdayPicker,
  type Weekday,
} from "./workoutControls";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate forms for the surgical workout-plan edits. Each targets an
// existing plan row by opaque ids (plan_day_id / exercise_row_id) that come
// from get_workout_plans and aren't user-editable — they're shown as read-only
// context and passed through untouched while the user edits the meaningful
// fields. All reuse the shared workoutControls (exercise picker, stepper,
// weekday picker) so they read like save_workout_plan.

// Read-only "what am I editing" line built from the ids the model resolved.
export function TargetLine({ parts }: { parts: Array<[string, unknown]> }) {
  const shown = parts.filter(([, v]) => v != null && v !== "");
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-edge bg-background/40 px-3 py-2 text-[11px] text-muted-foreground shadow-well">
      {shown.map(([label, v], i) => (
        <span key={label} className="inline-flex items-center gap-1">
          {i > 0 && <span className="opacity-50">·</span>}
          {label}
          <span className="font-mono text-foreground tabular-nums">#{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

// ── update_workout_plan_day ──────────────────────────────────────────────
type DayPatch = {
  plan_day_id?: number;
  name?: string;
  focus?: string;
  weekdays?: Weekday[];
};

export function UpdatePlanDayForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const v = (value as DayPatch) ?? {};
  const set = (patch: Partial<DayPatch>) => onChange({ ...v, ...patch });
  return (
    <div className="space-y-4">
      <TargetLine parts={[[tr("formsAdmin.planEdit.planDayLabel"), v.plan_day_id]]} />
      <Field label={tr("formsAdmin.planEdit.name")} optional>
        <Input
          value={v.name ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.planEdit.namePushPlaceholder")}
          onChange={(e) => set({ name: e.target.value || undefined })}
          className="h-9"
        />
      </Field>
      <Field
        label={tr("formsAdmin.planEdit.focus")}
        optional
        info={tr("formsAdmin.planEdit.focusInfo")}
      >
        <Input
          value={v.focus ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.planEdit.focusPlaceholder")}
          onChange={(e) => set({ focus: e.target.value })}
          className="h-9"
        />
      </Field>
      <Field
        label={tr("formsAdmin.planEdit.runsOn")}
        optional
        info={tr("formsAdmin.planEdit.runsOnInfo")}
      >
        <WeekdayPicker
          value={v.weekdays}
          disabled={disabled}
          onChange={(wds) => set({ weekdays: wds })}
        />
      </Field>
    </div>
  );
}

// ── shared prescription fields (sets / reps / weight / notes) ─────────────
type PrescriptionFields = {
  target_sets?: number;
  target_reps?: number;
  target_weight_kg?: number;
  notes?: string;
};

function Prescription({
  v,
  set,
  disabled,
}: {
  v: PrescriptionFields;
  set: (patch: Partial<PrescriptionFields>) => void;
  disabled?: boolean;
}) {
  const { t: tr } = useTranslation();
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <Field label={tr("formsAdmin.planEdit.sets")}>
          <Stepper
            value={v.target_sets}
            disabled={disabled}
            min={1}
            placeholder="3"
            onChange={(n) => set({ target_sets: n })}
          />
        </Field>
        <Field label={tr("formsAdmin.planEdit.reps")}>
          <Stepper
            value={v.target_reps}
            disabled={disabled}
            min={1}
            placeholder="10"
            onChange={(n) => set({ target_reps: n })}
          />
        </Field>
        <Field label={tr("formsAdmin.planEdit.weight")} optional>
          <UnitInput
            suffix="kg"
            value={v.target_weight_kg ?? ""}
            disabled={disabled}
            placeholder="—"
            step="any"
            onChange={(n) => set({ target_weight_kg: n })}
          />
        </Field>
      </div>
      <Field label={tr("formsAdmin.planEdit.notes")} optional>
        <Input
          value={v.notes ?? ""}
          disabled={disabled}
          placeholder={tr("formsAdmin.planEdit.notesPlaceholder")}
          onChange={(e) => set({ notes: e.target.value || undefined })}
          className="h-9"
        />
      </Field>
    </>
  );
}

// ── add_exercise_to_plan_day ─────────────────────────────────────────────
type AddExercise = PrescriptionFields & {
  plan_day_id?: number;
  exercise_id?: string;
  machine_id?: string;
};

export function AddPlanExerciseForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  // Carry the day id onto each new row so "add bench, incline and flyes to leg
  // day" stays a single call: the user fills the exercises, the shared day is
  // copied across.
  const dayId = (value as AddExercise | null)?.plan_day_id;
  return (
    <BatchRepeater<AddExercise>
      value={value}
      onChange={onChange}
      disabled={disabled}
      Icon={Dumbbell}
      title={tr("formsAdmin.planEdit.addExercise")}
      addLabel={tr("formsAdmin.planEdit.exercise")}
      emptyItem={() => ({ plan_day_id: dayId })}
      renderItem={(v, set) => (
        <>
          <TargetLine parts={[[tr("formsAdmin.planEdit.planDayLabel"), v.plan_day_id]]} />
          <Field label={tr("formsAdmin.planEdit.exerciseLabel")}>
            <ExercisePicker
              value={v.exercise_id}
              disabled={disabled}
              onPick={(id) => set({ exercise_id: id })}
            />
          </Field>
          <ExerciseMetaDisclosure exerciseId={v.exercise_id} />
          <Prescription v={v} set={set} disabled={disabled} />
        </>
      )}
    />
  );
}

// ── update_plan_exercise ─────────────────────────────────────────────────
type UpdateExercise = PrescriptionFields & {
  plan_day_id?: number;
  exercise_row_id?: number;
  exercise_id?: string;
  machine_id?: string;
};

export function UpdatePlanExerciseForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  return (
    <BatchRepeater<UpdateExercise>
      value={value}
      onChange={onChange}
      disabled={disabled}
      Icon={Pencil}
      title={tr("formsAdmin.planEdit.editPrescribedExercise")}
      renderItem={(v, set) => (
        <>
          <TargetLine
            parts={[
              [tr("formsAdmin.planEdit.planDayLabel"), v.plan_day_id],
              [tr("formsAdmin.planEdit.exerciseLabel"), v.exercise_row_id],
            ]}
          />
          <Field
            label={tr("formsAdmin.planEdit.exerciseLabel")}
            optional
            info={tr("formsAdmin.planEdit.swapExerciseInfo")}
          >
            <ExercisePicker
              value={v.exercise_id}
              disabled={disabled}
              onPick={(id) => set({ exercise_id: id })}
            />
          </Field>
          <ExerciseMetaDisclosure exerciseId={v.exercise_id} />
          <Prescription v={v} set={set} disabled={disabled} />
        </>
      )}
    />
  );
}

// ── replace_plan_exercise ────────────────────────────────────────────────
type ReplaceExercise = {
  plan_day_id?: number;
  exercise_row_id?: number;
  new_exercise_id?: string;
};

export function ReplacePlanExerciseForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t: tr } = useTranslation();
  const v = (value as ReplaceExercise) ?? {};
  return (
    <div className="space-y-4">
      <SectionLabel Icon={Repeat}>{tr("formsAdmin.planEdit.swapExercise")}</SectionLabel>
      <TargetLine
        parts={[
          [tr("formsAdmin.planEdit.planDayLabel"), v.plan_day_id],
          [tr("formsAdmin.planEdit.exerciseLabel"), v.exercise_row_id],
        ]}
      />
      <Field
        label={tr("formsAdmin.planEdit.replaceWith")}
        info={tr("formsAdmin.planEdit.replaceWithInfo")}
      >
        <ExercisePicker
          value={v.new_exercise_id}
          disabled={disabled}
          onPick={(id) => onChange({ ...v, new_exercise_id: id })}
        />
      </Field>
    </div>
  );
}
