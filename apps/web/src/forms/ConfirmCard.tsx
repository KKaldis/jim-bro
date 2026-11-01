import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import type { ToolOverrideProps } from "./overrides";

// Shared confirmation card for the destructive, no-data-entry tools
// (delete_meal, delete_body_comp_entry, delete_workout_plan,
// delete_workout_session, remove_diet_meal, remove_diet_portion,
// remove_exercise_from_plan_day). There's nothing to edit — the gate IS the
// confirmation — so the card just restates *what* is about to be removed
// (resolved from the tool's flat input) and leans on the parent's Save button
// to commit. Mirrors the page-level AlertDialogs used for the same deletes.

type Row = { label: string; value: string };

// Translator function shape (i18next's t). Passed into config so nouns/labels
// resolve at render time.
type TFn = (key: string) => string;

type ConfirmConfig = {
  // i18n key for the thing being removed, lower-case ("logged meal", "weigh-in")
  // — slotted into "Delete this {noun}?".
  nounKey: string;
  // Extract the identifying fields to show as a read-only summary. Empty values
  // are dropped, so optional inputs (a defaulted date, an absent time) just
  // don't render a row. `tr` localizes the row labels + any fallback text.
  describe: (input: Record<string, unknown>, tr: TFn) => Row[];
};

function id(v: unknown): string {
  return v == null || v === "" ? "" : `#${v}`;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function titleCase(v: unknown): string {
  const s = str(v);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

// Per-tool identity extractors. Pure-id tools show "#<id>"; meal/weigh-in tools
// show the human-meaningful slot/date the model resolved.
const CONFIRM_CONFIGS: Record<string, ConfirmConfig> = {
  delete_meal: {
    nounKey: "loggedMeal",
    describe: (i, tr) => [
      { label: tr("formsAdmin.confirm.slot"), value: titleCase(i.slot) },
      {
        label: tr("formsAdmin.confirm.date"),
        value: i.date ? str(i.date) : tr("formsAdmin.confirm.today"),
      },
      { label: tr("formsAdmin.confirm.time"), value: str(i.time) },
    ],
  },
  delete_body_comp_entry: {
    nounKey: "weighIn",
    describe: (i, tr) => [{ label: tr("formsAdmin.confirm.date"), value: str(i.date) }],
  },
  delete_workout_plan: {
    nounKey: "workoutPlan",
    describe: (i, tr) => [{ label: tr("formsAdmin.confirm.plan"), value: id(i.plan_id) }],
  },
  delete_diet_plan: {
    nounKey: "entireDietPlan",
    describe: () => [],
  },
  delete_workout_session: {
    nounKey: "workoutSession",
    describe: (i, tr) => [{ label: tr("formsAdmin.confirm.session"), value: id(i.session_id) }],
  },
  remove_diet_meal: {
    nounKey: "plannedMeal",
    describe: (i, tr) => [{ label: tr("formsAdmin.confirm.meal"), value: id(i.meal_id) }],
  },
  remove_diet_portion: {
    nounKey: "plannedPortion",
    describe: (i, tr) => [{ label: tr("formsAdmin.confirm.portion"), value: id(i.portion_id) }],
  },
  remove_exercise_from_plan_day: {
    nounKey: "exerciseFromPlanDay",
    describe: (i, tr) => [
      { label: tr("formsAdmin.confirm.planDay"), value: id(i.plan_day_id) },
      { label: tr("formsAdmin.confirm.exercise"), value: id(i.exercise_row_id) },
    ],
  },
};

function makeConfirmCard(config: ConfirmConfig): ComponentType<ToolOverrideProps> {
  function ConfirmCard({ value }: ToolOverrideProps) {
    const { t: tr } = useTranslation();
    const input = (value as Record<string, unknown>) ?? {};
    const rows = config.describe(input, tr).filter((r) => r.value !== "");
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              {tr("formsAdmin.confirm.deleteQuestion", {
                noun: tr(`formsAdmin.confirm.${config.nounKey}`),
              })}
            </p>
            <p className="text-[11px] text-muted-foreground">{tr("formsAdmin.confirm.noUndo")}</p>
          </div>
        </div>
        {rows.length > 0 && (
          <dl className="divide-y overflow-hidden rounded-lg border border-edge bg-background/40 shadow-well">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {r.label}
                </dt>
                <dd className="text-sm tabular-nums">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  }
  ConfirmCard.displayName = "ConfirmCard";
  return ConfirmCard;
}

// Pre-built components keyed by tool name, ready to spread into the OVERRIDES
// registry. Each is the same ConfirmCard skin bound to that tool's identity
// fields.
export const CONFIRM_CARDS: Record<string, ComponentType<ToolOverrideProps>> = Object.fromEntries(
  Object.entries(CONFIRM_CONFIGS).map(([tool, config]) => [tool, makeConfirmCard(config)]),
);
