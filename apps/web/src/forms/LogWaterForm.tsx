import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Droplets, GlassWater, Milk, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { BOTTLE_ML, DEFAULT_GOAL_ML, formatLiters, GLASS_ML, WaterRing } from "../HydrationCard";
import { useGetWater } from "../api/endpoints/default/default";
import { useDayContext } from "../lib/dayContext";
import { Field, SectionLabel, UnitInput } from "./formKit";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate form for log_water. Reuses the Hydration card's editable layout
// (water ring + quick-add chips + intake/goal inputs). The tool accepts add_ml
// OR set_ml; like the card's manual editor we operate on a single ABSOLUTE
// target and submit `set_ml`, so the ring and quick-adds share one number. A
// model-proposed add_ml is folded into the current day's total once it loads.

type LogWaterInput = {
  date?: string;
  add_ml?: number;
  set_ml?: number;
  goal_ml?: number;
};

export function LogWaterForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const data = (value as LogWaterInput) ?? {};
  const { selectedDateIso } = useDayContext();
  const dateIso = typeof data.date === "string" && data.date ? data.date : selectedDateIso;

  // Read the day's running total so a proposed add_ml ("I drank 500ml") can be
  // resolved to an absolute target, and the ring shows progress vs goal.
  const q = useGetWater({ date: dateIso });
  const currentMl = q.data?.ml ?? 0;

  const set = (patch: Partial<LogWaterInput>) => onChange({ ...data, ...patch });

  // Normalize the model's proposal to an absolute set_ml once the current total
  // is known (matching the card editor, which always writes absolute). Runs
  // once; skipped on a read-only (saved) card whose value is already absolute.
  const normalized = useRef(false);
  useEffect(() => {
    if (normalized.current || disabled || q.isPending) return;
    normalized.current = true;
    if (data.set_ml == null) {
      const target = data.add_ml != null ? currentMl + data.add_ml : currentMl;
      const { add_ml: _drop, ...rest } = data;
      onChange({ ...rest, set_ml: Math.max(0, Math.round(target)) });
    } else if (data.add_ml != null) {
      // Both supplied — set_ml wins; drop the now-ambiguous add_ml.
      const { add_ml: _drop, ...rest } = data;
      onChange(rest);
    }
    // Runs once when the water query settles (normalized ref guards re-entry);
    // reads currentMl/data fresh at that point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.isPending, disabled]);

  const target = data.set_ml ?? currentMl;
  const goalMl = data.goal_ml && data.goal_ml > 0 ? data.goal_ml : DEFAULT_GOAL_ML;

  const bump = (delta: number) => set({ set_ml: Math.max(0, Math.round(target + delta)) });

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SectionLabel Icon={Droplets}>{t("forms.water.intake")}</SectionLabel>
        <div className="flex items-center gap-4">
          <WaterRing ml={target} goalMl={goalMl} />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                disabled={disabled}
                onClick={() => bump(GLASS_ML)}
              >
                <GlassWater className="size-4" /> +{GLASS_ML} ml
              </Button>
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                disabled={disabled}
                onClick={() => bump(BOTTLE_ML)}
              >
                <Milk className="size-4" /> +{BOTTLE_ML} ml
              </Button>
            </div>
            <Field label={t("forms.water.totalIntake")} hint={formatLiters(target)}>
              <UnitInput
                icon={<Droplets className="size-3.5" />}
                suffix="ml"
                value={data.set_ml ?? ""}
                disabled={disabled}
                placeholder="0"
                min={0}
                step={1}
                onChange={(n) =>
                  set({
                    set_ml: n == null ? undefined : Math.max(0, Math.round(n)),
                  })
                }
              />
            </Field>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Field label={t("forms.water.dailyGoal")} optional>
          <UnitInput
            icon={<Target className="size-3.5" />}
            suffix="ml"
            value={data.goal_ml ?? ""}
            disabled={disabled}
            placeholder={String(DEFAULT_GOAL_ML)}
            min={0}
            step={1}
            onChange={(n) =>
              set({
                goal_ml: n == null ? undefined : Math.max(0, Math.round(n)),
              })
            }
          />
        </Field>
        <Field label={t("forms.water.date")}>
          <DatePicker
            value={data.date ?? ""}
            disabled={disabled}
            onChange={(iso) => set({ date: iso || undefined })}
          />
        </Field>
      </section>
    </div>
  );
}
