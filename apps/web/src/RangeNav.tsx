import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  clipToData,
  type CustomRange,
  defaultCustomRange,
  fromIso,
  type Granularity,
  rangeFor,
  shift,
  toIso,
  today,
} from "./dateRange.ts";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { CalendarPopover, DatePicker, MonthPopover } from "./components/ui/date-picker";
import { cn } from "./lib/utils";

type Props = {
  granularity: Granularity;
  anchor: Date;
  granularities?: Granularity[];
  onGranularity: (g: Granularity) => void;
  onAnchor: (d: Date) => void;
  // Explicit range for the "custom" granularity. A screen that offers "custom"
  // in `granularities` must pass both; screens that don't simply omit them.
  customRange?: CustomRange;
  onCustomRange?: (r: CustomRange) => void;
  // Allow the Next arrow to step past today. Off by default — most tabs show
  // retrospective data so future dates are meaningless. Workout opts in so the
  // user can plan future sessions on weekdays the plan doesn't already cover.
  allowFuture?: boolean;
  // Earliest date the screen has data for. Under "all" the label starts there
  // instead of a full year back (see clipToData).
  dataFrom?: string | null;
};

export function RangeNav({
  granularity,
  anchor,
  granularities = ["day", "week", "month", "all", "custom"],
  onGranularity,
  onAnchor,
  customRange,
  onCustomRange,
  allowFuture = false,
  dataFrom,
}: Props) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close the day / week / month picker popover when clicking outside it.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  const range = clipToData(rangeFor(granularity, anchor, customRange), granularity, dataFrom);
  // day/week/month advance in fixed steps; all/custom are absolute ranges, so
  // the prev/next arrows don't apply to them.
  const steppable = granularity === "day" || granularity === "week" || granularity === "month";
  const isFuture = anchor > today();
  // Editing either end of the custom range keeps from <= to so the span (and
  // the API query) stays valid without a separate validation pass.
  const custom = customRange ?? defaultCustomRange();
  const setFrom = (iso: string) => {
    if (iso && onCustomRange) onCustomRange({ from: iso, to: iso > custom.to ? iso : custom.to });
  };
  const setTo = (iso: string) => {
    if (iso && onCustomRange)
      onCustomRange({ from: iso < custom.from ? iso : custom.from, to: iso });
  };
  // On the day view, surface the relative day as a badge: Today solid, the
  // adjacent days with an outlined border.
  const dayDiff =
    granularity === "day" ? Math.round((anchor.getTime() - today().getTime()) / 86_400_000) : null;
  const dayBadge =
    dayDiff === 0
      ? { text: t("widgets.todayBadge"), variant: "default" as const }
      : dayDiff === -1
        ? { text: t("widgets.yesterday"), variant: "outline" as const }
        : dayDiff === 1
          ? { text: t("widgets.tomorrow"), variant: "outline" as const }
          : null;
  return (
    // A Fragment (not a wrapping div) so the sticky date nav below becomes a
    // direct child of the tall page-content column — position:sticky only sticks
    // within its parent's box, so a short wrapper here would scroll straight off.
    // The granularity toggle scrolls away; the date nav sticks to the top of the
    // scroll container so the selected day/range stays in view.
    <>
      {granularities.length > 1 && (
        <div className="flex w-full justify-center rounded-md bg-muted p-1 text-muted-foreground sm:mx-auto sm:w-fit soft:gap-2 soft:bg-transparent">
          {granularities.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => onGranularity(g)}
              className={cn(
                "flex-1 rounded-sm px-1.5 py-1 text-xs font-medium transition-colors sm:flex-none sm:px-3",
                granularity === g
                  ? "bg-background text-foreground shadow-sm ring-1 ring-primary soft:text-primary soft:shadow-pressed soft:ring-0"
                  : "hover:text-foreground soft:shadow-control soft:hover:text-primary",
              )}
            >
              {t(`widgets.${g}`)}
            </button>
          ))}
        </div>
      )}
      {/* Symmetric mx-10 keeps equal gutters on both sides while still pulling
          the bar's right edge clear of the mobile data drawer's floating close
          (X) button (its footprint ends ~3.25rem in from the panel's right).
          h-13 pins the bar at a constant 52px regardless of which granularity's
          controls are inside, so it doesn't shrink for label-only views. */}
      <div className="sticky top-2 z-20 mx-10 flex h-13 items-center justify-center gap-1 rounded-lg border border-edge bg-card px-2 text-card-foreground shadow-[0_0_1rem_0rem_var(--card)] soft:shadow-surface">
        {steppable && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onAnchor(shift(granularity, anchor, -1))}
            aria-label={t("widgets.previous")}
          >
            <ChevronLeft className="size-4" />
          </Button>
        )}
        {steppable ? (
          // The period label opens a picker centred under it: the day calendar,
          // the same calendar highlighting whole weeks, or a month grid with
          // year navigation. Any date inside the period is a valid anchor.
          <div ref={pickerRef} className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              aria-label={t(
                granularity === "day"
                  ? "widgets.pickADay"
                  : granularity === "week"
                    ? "widgets.pickAWeek"
                    : "widgets.pickAMonth",
              )}
              className="flex min-w-28 items-center justify-center gap-2 rounded-md px-2 py-1 text-center text-sm font-medium transition-colors hover:bg-accent sm:min-w-50"
            >
              {dayBadge ? (
                <>
                  <Badge variant={dayBadge.variant}>{dayBadge.text}</Badge>
                  {range.label.replace(/^(Today|Yesterday|Tomorrow) · /, "")}
                </>
              ) : (
                range.label
              )}
            </button>
            {pickerOpen &&
              (granularity === "month" ? (
                <MonthPopover
                  value={toIso(anchor)}
                  align="center"
                  onPick={(iso) => {
                    onAnchor(fromIso(iso));
                    setPickerOpen(false);
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              ) : (
                <CalendarPopover
                  value={toIso(anchor)}
                  align="center"
                  selectWeek={granularity === "week"}
                  onPick={(iso) => {
                    onAnchor(fromIso(iso));
                    setPickerOpen(false);
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              ))}
          </div>
        ) : granularity === "custom" ? (
          <div className="flex min-w-0 items-center gap-1">
            <DatePicker
              value={custom.from}
              onChange={setFrom}
              ariaLabel={t("widgets.from")}
              align="left"
              className="w-28 sm:w-32"
            />
            <span className="text-muted-foreground">–</span>
            <DatePicker
              value={custom.to}
              onChange={setTo}
              ariaLabel={t("widgets.to")}
              align="right"
              className="w-28 sm:w-32"
            />
          </div>
        ) : (
          <div className="flex min-w-28 items-center justify-center gap-2 text-center text-sm font-medium sm:min-w-50">
            {range.label}
          </div>
        )}
        {steppable && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onAnchor(shift(granularity, anchor, 1))}
            disabled={!allowFuture && isFuture}
            aria-label={t("widgets.next")}
          >
            <ChevronRight className="size-4" />
          </Button>
        )}
      </div>
    </>
  );
}
