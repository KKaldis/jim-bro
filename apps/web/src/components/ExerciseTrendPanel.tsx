// "How has this lift been going?" — toggled open inside the exercise's log card
// by the graph button on its log row. One chart of the last N sets (10–100, the
// user's pick): each set's estimated 1RM (Epley) and weight as lines on the left
// kg axis, with the set's volume (reps × kg) as faint bars behind them on their
// own right-hand axis — volume runs an order of magnitude above the load, so it
// can't share. "Per day" folds each day's sets into one point: its top set, best
// 1RM and total volume. Points sit at their date or evenly spaced, and the lines
// can carry a trailing average (the Workout chart preferences, shared with
// Progress); per set, a faint divider marks where one session ends and the next
// begins. Legend entries toggle their series.
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { epley1RM, type ExerciseId, type LastExerciseSet } from "@fa/shared";
import { isoToDisplay } from "@/lib/dateFormat";
import { apiErr } from "@/lib/apiErr";
import { cn } from "@/lib/utils";
import { useGetWorkoutExercisesIdLastSets } from "@/api/endpoints/default/default";
import { fromIso, today, toIso } from "@/dateRange";
import {
  type ChartSpacing,
  type TrendGrouping,
  type TrendSetCount,
  useUiStore,
} from "@/lib/uiStore";
import { averageCap, ChartControls, fitAverage } from "./SpacingToggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  CHART_W,
  ChartGrid,
  ChartXAxis,
  ChartYAxis,
  axisTicks,
  compactNumber,
  fullValue,
  rollingAverage,
} from "./chart";
import { Skeleton } from "./ui/skeleton";

const SET_COUNTS: TrendSetCount[] = [10, 20, 50, 100];

// One plotted point: a single set, or (per day) a day's sets folded together —
// weight × reps and RPE from its top set, the best 1RM, the summed volume.
type TrendSet = Omit<LastExerciseSet, "set_id" | "completed_at" | "duration_sec"> & {
  oneRm: number;
  volume: number;
  sets: number;
};

type Series = "oneRm" | "weight" | "volume";

// Heaviest set first, more reps breaking a tie.
function topSet(a: TrendSet, b: TrendSet): TrendSet {
  return b.weight_kg > a.weight_kg || (b.weight_kg === a.weight_kg && b.reps > a.reps) ? b : a;
}

// Calendar days from `iso` through today, both included.
function daysBack(iso: string): number {
  return Math.round((fromIso(toIso(today())).getTime() - fromIso(iso).getTime()) / 86_400_000) + 1;
}

function groupByDay(sets: TrendSet[]): TrendSet[] {
  const days: TrendSet[] = [];
  for (const s of sets) {
    const last = days[days.length - 1];
    if (last?.date !== s.date) {
      days.push(s);
      continue;
    }
    const top = topSet(last, s);
    days[days.length - 1] = {
      ...top,
      oneRm: Math.max(last.oneRm, s.oneRm),
      volume: last.volume + s.volume,
      sets: last.sets + 1,
    };
  }
  return days;
}

export function ExerciseTrendPanel({
  exerciseId,
  bleed,
}: {
  exerciseId: ExerciseId;
  // Negative margins letting the chart's axis columns run into the host card's
  // padding (which differs per card), so the plot keeps that width.
  bleed?: string;
}) {
  const { t } = useTranslation();
  const setCount = useUiStore((s) => s.workoutTrendSets);
  const setSetCount = useUiStore((s) => s.setWorkoutTrendSets);
  const grouping = useUiStore((s) => s.workoutTrendGrouping);
  const setGrouping = useUiStore((s) => s.setWorkoutTrendGrouping);
  // Mounted only while open, so this fetches on demand. The previous count's
  // chart stays up while a new one loads.
  const q = useGetWorkoutExercisesIdLastSets(
    exerciseId,
    { limit: setCount },
    { query: { placeholderData: keepPreviousData } },
  );
  // Server returns newest first; chart oldest → newest. Bodyweight / cardio sets
  // (no load) have no 1RM to plot.
  const raw = useMemo<TrendSet[] | null>(() => {
    if (!q.data) return null;
    return (q.data.sets as unknown as LastExerciseSet[])
      .filter((s) => s.reps > 0 && s.weight_kg > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.set_id - b.set_id)
      .map((s) => ({
        session_id: s.session_id,
        date: s.date,
        reps: s.reps,
        weight_kg: s.weight_kg,
        rpe: s.rpe,
        oneRm: epley1RM(s.reps, s.weight_kg),
        volume: s.reps * s.weight_kg,
        sets: 1,
      }));
  }, [q.data]);
  const grouped = grouping === "day";
  const sets = useMemo(() => (raw && grouped ? groupByDay(raw) : raw), [raw, grouped]);
  const spacing = useUiStore((s) => s.workoutChartSpacing);
  const setSpacing = useUiStore((s) => s.setWorkoutChartSpacing);
  const averageDays = useUiStore((s) => s.workoutChartAverage);
  const setAverageDays = useUiStore((s) => s.setWorkoutChartAverage);
  // The last N sets have no fixed period, so the average is capped by the days
  // they span.
  const avgCap =
    sets && sets.length > 0
      ? averageCap({
          granularity: "all",
          from: sets[0].date,
          to: sets[sets.length - 1].date,
        })
      : 0;
  const average = fitAverage(averageDays, avgCap);

  return (
    // No box of its own: it always opens inside an exercise's card.
    <div className="space-y-3 pt-1">
      <div className="flex min-h-6 flex-wrap items-center justify-end gap-2">
        <TrendViewControls
          count={setCount}
          onCount={setSetCount}
          grouping={grouping}
          onGrouping={setGrouping}
        />
        {!q.error && sets && sets.length > 0 && (
          <ChartControls
            average={average}
            cap={avgCap}
            onAverage={setAverageDays}
            spacing={spacing}
            onSpacing={setSpacing}
          />
        )}
      </div>
      {q.error ? (
        <p className="text-xs text-destructive">{apiErr(q.error)}</p>
      ) : sets == null ? (
        <Skeleton className="h-56 w-full" />
      ) : sets.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t("workout.trendEmpty")}</p>
      ) : (
        <>
          <div className={bleed}>
            <TrendChart sets={sets} grouped={grouped} spacing={spacing} averageDays={average} />
          </div>
          {/* How far back the sets reach; their count is in the picker above. */}
          <div className="text-center text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("workout.trendBackDays", { count: daysBack(sets[0].date) })}
          </div>
        </>
      )}
    </div>
  );
}

// How much history the chart covers and whether it plots sets or days, in one
// dropdown styled like ChartControls beside it.
function TrendViewControls({
  count,
  onCount,
  grouping,
  onGrouping,
}: {
  count: TrendSetCount;
  onCount: (n: TrendSetCount) => void;
  grouping: TrendGrouping;
  onGrouping: (g: TrendGrouping) => void;
}) {
  const { t } = useTranslation();
  const groupingLabel = (g: TrendGrouping) =>
    t(g === "day" ? "workout.trendPerDay" : "workout.trendPerSet");
  // As in ChartControls, picking leaves the menu open so both can change in one go.
  const keepOpen = (e: Event) => e.preventDefault();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground transition-[color,box-shadow] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none soft:bg-background soft:shadow-control soft:data-[state=open]:text-foreground soft:data-[state=open]:shadow-pressed">
        <span>
          {t("workout.trendSetsLabel")} <span className="font-medium text-foreground">{count}</span>
        </span>
        <span aria-hidden>·</span>
        <span className="font-medium text-foreground">{groupingLabel(grouping)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuLabel>{t("workout.trendSetsLabel")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(count)}
          onValueChange={(v) => onCount(Number(v) as TrendSetCount)}
        >
          {SET_COUNTS.map((n) => (
            <DropdownMenuRadioItem
              key={n}
              value={String(n)}
              className="text-xs"
              onSelect={keepOpen}
            >
              {t("workout.trendLastSets", { count: n })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("workout.trendGroupLabel")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={grouping}
          onValueChange={(v) => onGrouping(v as TrendGrouping)}
        >
          {(["set", "day"] as const).map((g) => (
            <DropdownMenuRadioItem key={g} value={g} className="text-xs" onSelect={keepOpen}>
              {groupingLabel(g)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function signed(v: number): string {
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r)}`;
}

function TrendChart({
  sets,
  grouped,
  spacing,
  averageDays,
}: {
  sets: TrendSet[];
  // One point per day rather than per set.
  grouped: boolean;
  spacing: ChartSpacing;
  // Trailing-average window in days, 0 for none (see rollingAverage).
  averageDays: number;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);
  // Series toggled from the legend. The last visible one can't be hidden, so
  // the chart is never empty.
  const [hidden, setHidden] = useState<ReadonlySet<Series>>(() => new Set());
  const shown = (k: Series) => !hidden.has(k);
  const toggle = (k: Series) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else if (next.size < 2) next.add(k);
      return next;
    });
  const showKg = shown("oneRm") || shown("weight");
  const h = 190;
  const pad = 12;
  const plotW = CHART_W - 2 * pad;
  const n = sets.length;

  // x: evenly spaced by set, or by date — each day a slot of equal width, its
  // sets spread across it so a session's sets don't pile onto one x.
  const DAY = 86_400_000;
  const dayOf = (s: TrendSet) =>
    Math.round((fromIso(s.date).getTime() - fromIso(sets[0].date).getTime()) / DAY);
  const days = dayOf(sets[n - 1]) + 1;
  const dateFrac = sets.map((s, i) => {
    const d = dayOf(s);
    const first = sets.findIndex((x) => x.date === s.date);
    const count = sets.filter((x) => x.date === s.date).length;
    return (d + (i - first + 0.5) / count) / days;
  });
  const byDate = spacing === "date" && days > 1;
  const xAt = (i: number) =>
    pad + (byDate ? dateFrac[i] * plotW : n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const pctAt = (i: number) => (xAt(i) / CHART_W) * 100;

  // y (kg): spans the visible line series, so hiding one rescales to the other.
  const kgs = sets.flatMap((s) => [
    ...(shown("oneRm") || !showKg ? [s.oneRm] : []),
    ...(shown("weight") || !showKg ? [s.weight_kg] : []),
  ]);
  const minY = Math.min(...kgs);
  const maxY = Math.max(...kgs);
  const spanY = maxY - minY || 1;
  const yAt = (v: number) =>
    maxY === minY ? h / 2 : h - pad - ((v - minY) / spanY) * (h - 2 * pad);
  const ticks = axisTicks(minY, maxY);

  // Volume bars: own zero-based scale on the right axis. Its ticks sit at the
  // same heights as the kg gridlines so one set of lines serves both axes.
  const maxVol = Math.max(...sets.map((s) => s.volume)) || 1;
  const volAt = (v: number) => h - pad - (v / maxVol) * (h - 2 * pad);
  const volTicks = axisTicks(0, maxVol, Math.max(ticks.length - 1, 1));
  const barW = Math.min(18, Math.max(6, (plotW / Math.max(n, 1)) * 0.55));

  const linePath = (values: number[]) =>
    values
      .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
      .join(" ");
  // Averages sit inside the raw values' range, so they share the kg scale. A
  // single set has nothing to average.
  const trend = averageDays > 0 && n > 1;
  const avgOf = (pick: (s: TrendSet) => number) =>
    trend
      ? rollingAverage(
          sets.map((s) => ({ date: s.date, value: pick(s) })),
          averageDays,
        )
      : [];
  const weightAvg = avgOf((s) => s.weight_kg);
  const oneRmAvg = avgOf((s) => s.oneRm);
  const avgLabel = t("body.averageDays", { count: averageDays });

  // Session boundaries: midway between the last set of one session and the
  // first of the next. Per day every point is its own session, so none.
  const dividers = grouped
    ? []
    : sets.flatMap((s, i) =>
        i > 0 && s.session_id !== sets[i - 1].session_id ? [(xAt(i - 1) + xAt(i)) / 2] : [],
      );

  const sel = active != null ? sets[active] : null;
  const prev = active != null && active > 0 ? sets[active - 1] : null;
  const selPct = active != null ? pctAt(active) : 0;

  return (
    <div dir="ltr" className="space-y-2">
      <div className="flex gap-1">
        {/* Hidden axes keep their width so the plot doesn't jump on toggle. */}
        <div className={cn(!showKg && "invisible")}>
          <ChartYAxis ticks={ticks} unit="kg" yAt={yAt} height={h} stackUnit />
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: h }}>
            <svg viewBox={`0 0 ${CHART_W} ${h}`} preserveAspectRatio="none" width="100%" height={h}>
              {showKg ? (
                <ChartGrid ticks={ticks} yAt={yAt} />
              ) : (
                <ChartGrid ticks={volTicks} yAt={volAt} />
              )}
              {dividers.map((x, i) => (
                <line
                  key={`s${i}`}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={h}
                  className="stroke-border"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {shown("volume") &&
                sets.map((s, i) => {
                  const bh = Math.max(2, h - pad - volAt(s.volume));
                  return (
                    <rect
                      key={`v${i}`}
                      x={xAt(i) - barW / 2}
                      y={h - pad - bh}
                      width={barW}
                      height={bh}
                      rx={2}
                      className={cn(
                        "fill-muted-foreground",
                        active === i ? "opacity-40" : "opacity-20",
                      )}
                    />
                  );
                })}
              {active != null && (
                <line
                  x1={xAt(active)}
                  x2={xAt(active)}
                  y1={0}
                  y2={h}
                  className="stroke-muted-foreground/50"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {/* With an average on, the raw lines fade (weight to dashes) behind
                  the thicker average lines, as on the other charts. */}
              {shown("weight") && (
                <path
                  d={linePath(sets.map((s) => s.weight_kg))}
                  fill="none"
                  className="stroke-primary"
                  strokeWidth={trend ? 1.5 : 2}
                  strokeOpacity={trend ? 0.35 : 1}
                  strokeDasharray={trend ? "4 3" : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {shown("oneRm") && (
                <path
                  d={linePath(sets.map((s) => s.oneRm))}
                  fill="none"
                  className="stroke-muted-foreground"
                  strokeWidth={2}
                  strokeOpacity={trend ? 0.35 : 1}
                  strokeDasharray="0.1 4"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {trend && shown("weight") && (
                <path
                  d={linePath(weightAvg)}
                  fill="none"
                  className="stroke-primary"
                  strokeWidth={3}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {trend && shown("oneRm") && (
                <path
                  d={linePath(oneRmAvg)}
                  fill="none"
                  className="stroke-muted-foreground"
                  strokeWidth={3}
                  strokeDasharray="0.1 5"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {/* Dots in HTML so they stay round despite the stretched SVG. */}
            {sets.map((s, i) => (
              <span key={`d${i}`}>
                {shown("weight") && (
                  <Dot
                    leftPct={pctAt(i)}
                    top={yAt(s.weight_kg)}
                    big={active === i}
                    className="bg-primary"
                  />
                )}
                {shown("oneRm") && (
                  <Dot
                    leftPct={pctAt(i)}
                    top={yAt(s.oneRm)}
                    big={active === i}
                    className="bg-muted-foreground"
                  />
                )}
              </span>
            ))}
            {/* Full-height tap columns: easier to hit than the dots themselves. */}
            {sets.map((s, i) => (
              <button
                key={`h${i}`}
                type="button"
                aria-label={`${isoToDisplay(s.date)} ${t("workout.trendSetValue", { weight: s.weight_kg, reps: s.reps })}`}
                onClick={() => setActive(active === i ? null : i)}
                className="absolute top-0 h-full -translate-x-1/2 cursor-pointer"
                style={{ left: `${pctAt(i)}%`, width: `${Math.max(100 / n, 4)}%` }}
              />
            ))}
            {sel && (
              <div
                className={cn(
                  "pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2 py-1 text-[11px] whitespace-nowrap shadow-overlay",
                  selPct < 30
                    ? "ms-3"
                    : selPct > 70
                      ? "-ms-3 -translate-x-full"
                      : "-translate-x-1/2",
                )}
                style={{ left: `${selPct}%` }}
              >
                <div className="font-medium">
                  {isoToDisplay(sel.date)}
                  {grouped && (
                    <span className="ms-1.5 font-normal text-muted-foreground">
                      {t("workout.trendSetCount", { count: sel.sets })}
                    </span>
                  )}
                  {sel.rpe != null && (
                    <span className="ms-1.5 font-normal text-muted-foreground">
                      {t("workout.rpe", { value: sel.rpe })}
                    </span>
                  )}
                </div>
                {/* Weight × reps always: it's the set itself; the rest derive from it. */}
                <TipRow
                  swatch="bg-primary"
                  label={t(grouped ? "workout.trendTopSet" : "workout.trendWeight")}
                >
                  {t("workout.trendSetValue", { weight: sel.weight_kg, reps: sel.reps })}
                </TipRow>
                {trend && shown("weight") && active != null && (
                  <TipRow swatch="bg-primary" label={avgLabel}>
                    {fullValue(weightAvg[active], " kg")}
                  </TipRow>
                )}
                {shown("oneRm") && (
                  <TipRow swatch="bg-muted-foreground" label={t("workout.chartEst1rm")}>
                    {fullValue(sel.oneRm, " kg")}
                    {prev && (
                      <span className="ms-1 text-muted-foreground">
                        ({signed(sel.oneRm - prev.oneRm)})
                      </span>
                    )}
                  </TipRow>
                )}
                {trend && shown("oneRm") && active != null && (
                  <TipRow swatch="bg-muted-foreground" label={avgLabel}>
                    {fullValue(oneRmAvg[active], " kg")}
                  </TipRow>
                )}
                {shown("volume") && (
                  <TipRow
                    swatch="bg-muted-foreground/40"
                    label={t(grouped ? "workout.chartTotalVolume" : "workout.trendVolume")}
                  >
                    {fullValue(sel.volume, " kg")}
                  </TipRow>
                )}
              </div>
            )}
          </div>
          <ChartXAxis points={sets.map((s) => ({ date: s.date, value: s.oneRm }))} />
        </div>
        <div className={cn(!shown("volume") && "invisible")}>
          <VolumeAxis ticks={volTicks} yAt={volAt} height={h} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <LegendItem
          on={shown("weight")}
          onToggle={() => toggle("weight")}
          swatch={<span className="h-0.5 w-4 rounded-sm bg-primary" />}
        >
          {t("workout.trendWeight")}
        </LegendItem>
        <LegendItem
          on={shown("oneRm")}
          onToggle={() => toggle("oneRm")}
          swatch={<span className="w-4 border-t-2 border-dotted border-muted-foreground" />}
        >
          {t("workout.chartEst1rm")}
        </LegendItem>
        <LegendItem
          on={shown("volume")}
          onToggle={() => toggle("volume")}
          swatch={<span className="size-2.5 rounded-sm bg-muted-foreground/25" />}
        >
          {t("workout.trendVolume")}
        </LegendItem>
      </div>
    </div>
  );
}

// Right-hand volume axis: ChartYAxis mirrored (left-aligned labels), with the
// unit under the top tick since "kg" is shared with the left axis.
function VolumeAxis({
  ticks,
  yAt,
  height,
}: {
  ticks: number[];
  yAt: (v: number) => number;
  height: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="relative w-8 shrink-0 text-start text-[10px] text-muted-foreground tabular-nums"
      style={{ height }}
    >
      {ticks.map((v, i) => (
        <span
          key={i}
          className="absolute inset-s-0 -translate-y-1/2 whitespace-nowrap"
          style={{ top: yAt(v) }}
        >
          {compactNumber(v)}
        </span>
      ))}
      <span
        className="absolute inset-s-0 text-[9px] leading-none whitespace-nowrap"
        style={{ top: yAt(ticks[ticks.length - 1]) + 7 }}
      >
        {t("workout.trendVolumeAxis")}
      </span>
    </div>
  );
}

function Dot({
  leftPct,
  top,
  big,
  className,
}: {
  leftPct: number;
  top: number;
  big: boolean;
  className: string;
}) {
  return (
    <span
      className={cn(
        // Same dots as LineChart: 5px, 8px when selected.
        "pointer-events-none absolute -translate-1/2 rounded-full",
        big ? "size-2" : "size-1.25",
        className,
      )}
      style={{ left: `${leftPct}%`, top }}
    />
  );
}

function LegendItem({
  on,
  onToggle,
  swatch,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  swatch: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 transition-opacity hover:bg-accent",
        !on && "line-through opacity-40",
      )}
    >
      {swatch}
      {children}
    </button>
  );
}

function TipRow({
  swatch,
  label,
  children,
}: {
  swatch: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("size-2 shrink-0 rounded-full", swatch)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ms-auto ps-3 font-medium tabular-nums">{children}</span>
    </div>
  );
}
