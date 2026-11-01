// Nutrition → Summary charts: daily kcal bars and the calendar heatmap.
import { useTranslation } from "react-i18next";

import { isoToDisplay } from "../lib/dateFormat";
import { cn } from "../lib/utils";
import type { Day } from "./shared";

type TFunc = ReturnType<typeof useTranslation>["t"];

// Tapping a bar/cell picks that day for the detail card below the chart;
// tapping it again clears the pick. While a day is picked the rest recede.
type DaySelectProps = {
  days: Day[];
  selectedDate: string | null;
  onSelectDate: (iso: string | null) => void;
};

export function KcalBars({ days, selectedDate, onSelectDate }: DaySelectProps) {
  const { t } = useTranslation();
  if (!days.length) return null;
  const maxKcal = Math.max(1, ...days.map((d) => Math.max(d.eaten.kcal, d.target?.kcal ?? 0)));
  return (
    <div className="space-y-2">
      {/* Few days (a week) fill/center the card; long ranges ("all"/custom can
          be up to a year) overflow into a horizontal scroll instead of spilling
          past the card edge. min-w-full centers when it fits, w-max lets the row
          grow past the card so overflow-x-auto gives it a scrollbar. */}
      <div className="overflow-x-auto overflow-y-hidden">
        <div className="flex h-32 w-max min-w-full items-end justify-center gap-1 sm:gap-2">
          {days.map((d) => {
            const eatenPct = (d.eaten.kcal / maxKcal) * 100;
            const targetPct = d.target ? (d.target.kcal / maxKcal) * 100 : null;
            // Match the heatmap's ±10% on-target band so the two views agree.
            const ratio = d.target?.kcal ? d.eaten.kcal / d.target.kcal : null;
            const fill =
              ratio == null
                ? "bg-primary"
                : ratio > 1.1
                  ? "bg-destructive"
                  : ratio >= 0.9
                    ? "bg-success"
                    : "bg-primary";
            return (
              <button
                key={d.date}
                type="button"
                onClick={() => onSelectDate(d.date === selectedDate ? null : d.date)}
                aria-pressed={d.date === selectedDate}
                className={cn(
                  "group flex h-full min-w-4 flex-1 flex-col items-center gap-1 rounded-sm transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  selectedDate != null && d.date !== selectedDate && "opacity-40",
                )}
                aria-label={t("nutrition.chart.viewDay", {
                  date: isoToDisplay(d.date),
                  kcal: d.eaten.kcal.toFixed(0),
                })}
              >
                <div
                  className={cn(
                    "relative w-full flex-1 overflow-hidden rounded-sm border bg-muted transition-colors group-hover:border-foreground/40",
                    d.date === selectedDate && "border-foreground/60",
                  )}
                >
                  {targetPct != null && (
                    <div
                      className="absolute inset-x-0 border-t border-dashed border-muted-foreground/60"
                      style={{ bottom: `${targetPct}%`, height: 0 }}
                    />
                  )}
                  <div
                    className={cn(
                      "absolute inset-x-0 bottom-0 transition-all group-hover:opacity-80",
                      fill,
                    )}
                    style={{ height: `${eatenPct}%` }}
                  />
                </div>
                <div className="flex flex-col items-center leading-tight">
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {weekdayInitial(d.date)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {isoToDisplay(d.date).slice(0, 2)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <LegendSwatch background="var(--primary)" label={t("nutrition.chart.underTarget")} />
        <LegendSwatch background="var(--success)" label={t("nutrition.chart.onTarget")} />
        <LegendSwatch background="var(--destructive)" label={t("nutrition.chart.overTarget")} />
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block w-3 border-t border-dashed border-muted-foreground/60"
          />
          {t("nutrition.chart.target")}
        </span>
      </div>
    </div>
  );
}

// Month-granularity calendar heatmap. A fixed 7-wide Mon→Sun grid (vs the
// 28–31 horizontally-scrolling columns KcalBars would produce) so the whole
// month fits in the card at a glance. Cells are colored by how eaten kcal
// compares to that day's target: blue = under, green = on-target, red = over.
// The exact numbers show in the picked day's card below the chart.
const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Mon→Sun single-letter weekday for a given ISO date (matches the heatmap's
// WEEKDAY_INITIALS header so the week bars read the same way).
function weekdayInitial(iso: string): string {
  return WEEKDAY_INITIALS[(parseIsoLocal(iso).getDay() + 6) % 7];
}

// Returns the cell fill (a color-mix toward transparent) and a human label.
// `ratio` is eaten/target; null when the day has no target set.
function heatCell(t: TFunc, d: Day): { background: string; label: string } {
  if (d.meal_count === 0) {
    return {
      background: "var(--muted)",
      label: t("nutrition.chart.nothingLoggedCell", { date: isoToDisplay(d.date) }),
    };
  }
  const base = `${isoToDisplay(d.date)}: ${d.eaten.kcal.toFixed(0)} kcal`;
  const targetKcal = d.target?.kcal ?? 0;
  if (!targetKcal) {
    // Logged but no target — neutral fill, no over/under signal to give.
    return {
      background: "color-mix(in oklab, var(--muted-foreground) 28%, var(--muted))",
      label: t("nutrition.chart.noTargetCell", { base }),
    };
  }
  const ratio = d.eaten.kcal / targetKcal;
  const pct = t("nutrition.chart.pctOfTarget", { pct: (ratio * 100).toFixed(0) });
  // On-target band: within ±10%.
  if (ratio >= 0.9 && ratio <= 1.1) {
    return {
      background: "color-mix(in oklab, var(--success) 75%, var(--muted))",
      label: t("nutrition.chart.cellOnTarget", { base, pct }),
    };
  }
  // Map distance from the band onto 45→100% saturation so further off-target
  // reads stronger. Half-the-target-off (ratio 0.5 or 1.5) saturates fully.
  const dev = ratio < 0.9 ? (0.9 - ratio) / 0.4 : (ratio - 1.1) / 0.4;
  const intensity = Math.round(45 + Math.min(1, Math.max(0, dev)) * 55);
  const tone = ratio < 0.9 ? "var(--primary)" : "var(--destructive)";
  return {
    background: `color-mix(in oklab, ${tone} ${intensity}%, var(--muted))`,
    label:
      ratio < 0.9
        ? t("nutrition.chart.cellUnder", { base, pct })
        : t("nutrition.chart.cellOver", { base, pct }),
  };
}

export function KcalHeatmap({ days, selectedDate, onSelectDate }: DaySelectProps) {
  const { t } = useTranslation();
  if (!days.length) return null;
  // Pad the first week so day-of-month lands under the right weekday column.
  const lead = (parseIsoLocal(days[0].date).getDay() + 6) % 7; // Mon=0
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAY_INITIALS.map((w, i) => (
          <div key={i} className="text-center text-[10px] font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {Array.from({ length: lead }).map((_, i) => (
          <div key={`pad-${i}`} aria-hidden />
        ))}
        {days.map((d) => {
          const { background, label } = heatCell(t, d);
          const dayNum = parseIsoLocal(d.date).getDate();
          return (
            <button
              key={d.date}
              type="button"
              onClick={() => onSelectDate(d.date === selectedDate ? null : d.date)}
              aria-pressed={d.date === selectedDate}
              aria-label={t("nutrition.chart.viewDaySuffix", { label })}
              style={{ background }}
              className={cn(
                "flex aspect-square items-center justify-center rounded-sm border text-[10px] text-foreground/70 tabular-nums transition-[border-color,opacity] hover:border-foreground/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                d.date === selectedDate &&
                  "border-2 border-foreground font-semibold text-foreground",
                selectedDate != null && d.date !== selectedDate && "opacity-50",
              )}
            >
              {dayNum}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <LegendSwatch
          background="color-mix(in oklab, var(--primary) 70%, var(--muted))"
          label={t("nutrition.chart.under")}
        />
        <LegendSwatch
          background="color-mix(in oklab, var(--success) 75%, var(--muted))"
          label={t("nutrition.chart.onTarget")}
        />
        <LegendSwatch
          background="color-mix(in oklab, var(--destructive) 70%, var(--muted))"
          label={t("nutrition.chart.over")}
        />
        <LegendSwatch background="var(--muted)" label={t("nutrition.chart.notLogged")} />
      </div>
    </div>
  );
}

function LegendSwatch({ background, label }: { background: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block size-3 rounded-sm border" style={{ background }} />
      {label}
    </span>
  );
}
