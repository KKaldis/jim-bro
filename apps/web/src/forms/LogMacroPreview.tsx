import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Macros } from "@fa/shared";
import { MacroBars } from "@/Dashboard";
import { useDailyTarget } from "@/lib/dailyTarget";
import { useDaySnapshot } from "@/lib/dayContext";
import { useUiStore, type LogPreviewMode } from "@/lib/uiStore";
import { cn } from "@/lib/utils";

const add = (a: Macros, b: Macros): Macros => ({
  kcal: a.kcal + b.kcal,
  p: a.p + b.p,
  f: a.f + b.f,
  c: a.c + b.c,
  fiber: a.fiber != null || b.fiber != null ? (a.fiber ?? 0) + (b.fiber ?? 0) : undefined,
});

// Live macro preview for the food-log forms (add-food dialog, log_recipe,
// log_meal). A persisted toggle flips between the item alone vs the day's
// target ("Item") and the day it lands on with the item ghosted on top of
// what's already eaten ("Day"). Falls back to the item view while that day's
// snapshot loads.
export function LogMacroPreview({
  item,
  dateIso,
  extra,
}: {
  item: Macros;
  dateIso: string;
  // Optional muted text next to the header (e.g. "= 1.5 servings").
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const mode = useUiStore((s) => s.logPreviewMode);
  const setMode = useUiStore((s) => s.setLogPreviewMode);
  const dayTarget = useDailyTarget();
  const day = useDaySnapshot(dateIso);
  const eaten = day.data?.today.eaten ?? null;
  const showDay = mode === "day" && eaten != null;

  const options: Array<{ value: LogPreviewMode; label: string }> = [
    { value: "item", label: t("forms.logRecipe.previewItem") },
    { value: "day", label: t("forms.logRecipe.previewDay") },
  ];

  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {mode === "day" ? t("forms.logRecipe.dayAfterLog") : t("forms.logRecipe.logsAs")}
        </span>
        <div className="flex items-center gap-2">
          {extra && <span className="text-muted-foreground tabular-nums">{extra}</span>}
          <div className="flex rounded-md border bg-background/60 p-0.5" role="group">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={mode === o.value}
                onClick={() => setMode(o.value)}
                className={cn(
                  "rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors",
                  mode === o.value
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {showDay ? (
        <MacroBars eaten={eaten} target={dayTarget} projected={add(eaten, item)} showPct />
      ) : (
        <MacroBars eaten={item} target={dayTarget} showPct />
      )}
    </div>
  );
}
