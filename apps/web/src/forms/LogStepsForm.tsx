import { Footprints, Target } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DatePicker } from "@/components/ui/date-picker";
import { DEFAULT_STEP_GOAL, StepProgress } from "../StepCounter";
import { Field, SectionLabel, UnitInput } from "./formKit";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate form for log_steps. Mirrors the Workout card's manual step
// editor (absolute count + daily goal) and adds a live StepProgress preview so
// the user sees the bar fill as they edit. Same flat contract the tool reads:
// { date, steps, goal }. `steps` is an absolute overwrite, so the input is the
// target total — exactly what the in-app editor writes.

type LogStepsInput = {
  date?: string;
  steps?: number;
  goal?: number;
};

export function LogStepsForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const data = (value as LogStepsInput) ?? {};
  const set = (patch: Partial<LogStepsInput>) => onChange({ ...data, ...patch });

  const steps = data.steps ?? 0;
  const goal = data.goal && data.goal > 0 ? data.goal : DEFAULT_STEP_GOAL;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SectionLabel Icon={Footprints}>{t("forms.steps.steps")}</SectionLabel>
        <StepProgress steps={steps} goal={goal} />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={
              <>
                {t("forms.steps.steps")}
                <span className="text-destructive"> *</span>
              </>
            }
          >
            <UnitInput
              icon={<Footprints className="size-3.5" />}
              suffix={t("forms.steps.stepsSuffix")}
              value={data.steps ?? ""}
              disabled={disabled}
              placeholder="0"
              min={0}
              step={1}
              onChange={(n) => set({ steps: n == null ? undefined : Math.max(0, Math.round(n)) })}
            />
          </Field>
          <Field label={t("forms.steps.dailyGoal")} optional>
            <UnitInput
              icon={<Target className="size-3.5" />}
              suffix={t("forms.steps.stepsSuffix")}
              value={data.goal ?? ""}
              disabled={disabled}
              placeholder={String(DEFAULT_STEP_GOAL)}
              min={0}
              step={1}
              onChange={(n) => set({ goal: n == null ? undefined : Math.max(0, Math.round(n)) })}
            />
          </Field>
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel Icon={Footprints}>{t("forms.steps.date")}</SectionLabel>
        <DatePicker
          value={data.date ?? ""}
          disabled={disabled}
          onChange={(iso) => set({ date: iso || undefined })}
        />
      </section>
    </div>
  );
}
