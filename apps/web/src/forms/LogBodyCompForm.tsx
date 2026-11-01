import { Percent, Ruler, Scale, Sparkles, StickyNote, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { estimateBodyFatNavy } from "@fa/shared";
import { Textarea } from "@/components/ui/textarea";
import { DateTimePicker } from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";
import { Field, SectionLabel, TogglePills, UnitInput } from "./formKit";
import { useFormContext } from "./formContext";
import {
  BODY_FAT_METHODS,
  bodyFatMethodLabel,
  bodyCompFieldVisibility,
  isNavyMethod,
  type BodyFatMethod,
} from "./bodyComp";
import type { ToolOverrideProps } from "./overrides";

// Bespoke gate form for log_body_comp. Weight is the only required input; body
// fat is METHOD-FIRST — pick how you measured, then only the relevant inputs
// render (a direct reading, or the circumferences the Navy estimate needs).
// When the circumferences are complete we preview the Navy BF% live with the
// same shared formula the server uses, so the number on screen matches what
// gets stored. Same flat contract: date, time, weight_kg, body_fat_method,
// body_fat_pct, waist_cm, neck_cm, hip_cm, notes.

type Sex = "male" | "female";

type BodyCompInput = {
  date?: string;
  time?: string;
  weight_kg?: number;
  body_fat_method?: BodyFatMethod;
  body_fat_pct?: number;
  waist_cm?: number;
  neck_cm?: number;
  hip_cm?: number;
  notes?: string;
};

export function LogBodyCompForm({ value, onChange, disabled }: ToolOverrideProps) {
  const { t } = useTranslation();
  const METHOD_OPTIONS = BODY_FAT_METHODS.map((m) => ({
    value: m,
    label: bodyFatMethodLabel(m),
  }));
  const b = (value as BodyCompInput) ?? {};
  const { ctx } = useFormContext();
  const sex = (ctx.profile?.sex ?? null) as Sex | null;
  const height = ctx.profile?.height_cm ?? null;
  const last = ctx.lastBodyComp;

  const set = (patch: Partial<BodyCompInput>) => onChange({ ...b, ...patch });

  // The `date` default (selected day) is seeded by the caller — ToolFormCard's
  // prefill in chat, the page dialog's initial draft on the Body screen.

  // Switching method clears inputs that no longer apply, so a body_fat_pct
  // typed before switching to Navy (or vice-versa) can't linger in the draft.
  const chooseMethod = (m: BodyFatMethod) => {
    const vis = bodyCompFieldVisibility(m, sex);
    set({
      body_fat_method: m,
      ...(vis.bodyFatPct ? {} : { body_fat_pct: undefined }),
      ...(vis.waist ? {} : { waist_cm: undefined }),
      ...(vis.neck ? {} : { neck_cm: undefined }),
      ...(vis.hip ? {} : { hip_cm: undefined }),
    });
  };

  const vis = bodyCompFieldVisibility(b.body_fat_method, sex);
  const navy = isNavyMethod(b.body_fat_method);

  const weightDelta =
    last?.weight_kg != null && b.weight_kg != null ? b.weight_kg - last.weight_kg : null;

  // Live Navy preview — only when every circumference the formula needs is in.
  let navyPreview: { bf: number; warning?: string } | null = null;
  if (
    navy &&
    height != null &&
    sex != null &&
    b.waist_cm != null &&
    b.neck_cm != null &&
    (sex === "male" || b.hip_cm != null)
  ) {
    try {
      const r = estimateBodyFatNavy({
        sex,
        height_cm: height,
        neck_cm: b.neck_cm,
        waist_cm: b.waist_cm,
        hip_cm: b.hip_cm ?? null,
      });
      navyPreview = { bf: r.body_fat_pct, warning: r.warnings[0] };
    } catch {
      navyPreview = null;
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Weigh-in ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Scale}>{t("forms.bodyComp.weighIn")}</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={
              <>
                {t("forms.bodyComp.weight")}
                <span className="text-destructive"> *</span>
              </>
            }
            hint={
              weightDelta != null
                ? t("forms.bodyComp.vsLast", {
                    delta: `${weightDelta > 0 ? "+" : ""}${weightDelta.toFixed(1)}`,
                  })
                : last?.weight_kg != null
                  ? t("forms.bodyComp.last", { value: last.weight_kg.toFixed(1) })
                  : undefined
            }
          >
            <UnitInput
              icon={<Scale className="size-3.5" />}
              suffix="kg"
              value={b.weight_kg ?? ""}
              disabled={disabled}
              placeholder="0.0"
              step="any"
              onChange={(n) => set({ weight_kg: n })}
            />
          </Field>
          {/* Full row on phones: "DD-MM-YYYY HH:MM" doesn't fit half width. */}
          <Field label={t("forms.bodyComp.dateTime")} className="col-span-2 sm:col-span-1">
            <DateTimePicker
              date={b.date ?? ""}
              time={b.time ?? ""}
              disabled={disabled}
              onChange={(date, time) => set({ date: date || undefined, time: time || undefined })}
            />
          </Field>
        </div>
      </section>

      {/* ── Body fat (optional, method-first) ──────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={Percent} hint={t("forms.bodyComp.optional")}>
          {t("forms.bodyComp.bodyFat")}
        </SectionLabel>
        <Field label={t("forms.bodyComp.howMeasured")} info={t("forms.bodyComp.howMeasuredInfo")}>
          <TogglePills<BodyFatMethod>
            options={METHOD_OPTIONS}
            value={b.body_fat_method}
            disabled={disabled}
            cols={2}
            onChange={chooseMethod}
          />
        </Field>

        {vis.bodyFatPct && (
          <Field label={t("forms.bodyComp.bodyFatReading")}>
            <UnitInput
              icon={<Percent className="size-3.5" />}
              suffix="%"
              value={b.body_fat_pct ?? ""}
              disabled={disabled}
              placeholder={t("forms.bodyComp.bodyFatReadingPlaceholder")}
              step="any"
              onChange={(n) => set({ body_fat_pct: n })}
            />
          </Field>
        )}

        {navy && (
          <div className="space-y-3 rounded-lg border border-edge bg-background/40 p-3 shadow-well">
            <p className="text-[11px] text-muted-foreground">
              {t("forms.bodyComp.tapeMeasurements")}
            </p>
            <div className={cn("grid gap-2", vis.hip ? "grid-cols-3" : "grid-cols-2")}>
              <Field label={t("forms.bodyComp.waist")}>
                <UnitInput
                  icon={<Ruler className="size-3.5" />}
                  suffix="cm"
                  value={b.waist_cm ?? ""}
                  disabled={disabled}
                  placeholder="0"
                  step="any"
                  onChange={(n) => set({ waist_cm: n })}
                />
              </Field>
              <Field label={t("forms.bodyComp.neck")} info={t("forms.bodyComp.neckInfo")}>
                <UnitInput
                  icon={<Ruler className="size-3.5" />}
                  suffix="cm"
                  value={b.neck_cm ?? ""}
                  disabled={disabled}
                  placeholder="0"
                  step="any"
                  onChange={(n) => set({ neck_cm: n })}
                />
              </Field>
              {vis.hip && (
                <Field label={t("forms.bodyComp.hip")} info={t("forms.bodyComp.hipInfo")}>
                  <UnitInput
                    icon={<Ruler className="size-3.5" />}
                    suffix="cm"
                    value={b.hip_cm ?? ""}
                    disabled={disabled}
                    placeholder="0"
                    step="any"
                    onChange={(n) => set({ hip_cm: n })}
                  />
                </Field>
              )}
            </div>

            {navyPreview ? (
              <div className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm">
                <Sparkles className="size-4 shrink-0 text-primary" />
                <span className="font-medium">
                  {t("forms.bodyComp.estimatedBodyFat", { value: navyPreview.bf.toFixed(1) })}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t("forms.bodyComp.estimated")}
                </span>
              </div>
            ) : (
              height == null && (
                <p className="flex items-center gap-1.5 text-[11px] text-warning">
                  <TriangleAlert className="size-3 shrink-0" />
                  {t("forms.bodyComp.setHeight")}
                </p>
              )
            )}
            {navyPreview?.warning && (
              <p className="flex items-start gap-1.5 text-[11px] text-warning">
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                {navyPreview.warning}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── Notes ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionLabel Icon={StickyNote}>{t("forms.bodyComp.notes")}</SectionLabel>
        <Textarea
          value={b.notes ?? ""}
          disabled={disabled}
          rows={2}
          placeholder={t("forms.bodyComp.notesPlaceholder")}
          onChange={(e) => set({ notes: e.target.value })}
          className="min-h-14 resize-y"
        />
      </section>
    </div>
  );
}
