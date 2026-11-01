// Workout → Progress: exercise trends, training burn, and muscle-group volume.
import { EmptyState } from "@/components/EmptyState";
import {
  averageCap,
  averageTrend,
  CHART_MENU_TRIGGER,
  ChartControls,
  fitAverage,
} from "@/components/SpacingToggle";
import {
  type Exercise,
  type ExerciseId,
  type ExerciseProgressPoint,
  getExercise,
  type MuscleGroupId,
  muscleGroupsForExercise,
  type MuscleGroupVolumePoint,
  setVolume,
  type WorkoutCatalog,
  type WorkoutPR,
  type WorkoutSession,
} from "@fa/shared";
import type { TFunction } from "i18next";
import {
  BicepsFlexed,
  ChartColumn,
  ChevronDown,
  FileDown,
  Flame,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Stat } from "../Dashboard";
import {
  useGetWorkoutProgressExerciseId,
  useGetWorkoutProgressMuscleGroups,
  useGetWorkoutProgressPrs,
} from "../api/endpoints/default/default";
import { ExerciseTypeBadge } from "../components/ExerciseTypeBadge";
import { HelpPopover } from "../components/HelpPopover";
import { MuscleMap } from "../components/MuscleMap";
import { bucketLabel, BucketMap, bucketsForExercise } from "../components/MuscleViewToggle";
import {
  axisTicks,
  CHART_W,
  ChartGrid,
  type ChartPoint,
  ChartTooltip,
  ChartYAxis,
  LineChart,
} from "../components/chart";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import { fromIso, type Granularity, type Range, toIso } from "../dateRange";
import { type ChartView, exportExerciseProgressPdf } from "../export/exerciseProgressPdf";
import { exportMuscleVolumePdf } from "../export/muscleVolumePdf";
import { runExport } from "../export/printDoc";
import { exerciseLabel } from "../forms/workoutControls";
import { apiErr } from "../lib/apiErr";
import { exerciseName, machineName } from "../lib/catalogLabels";
import { isoToDisplay } from "../lib/dateFormat";
import { ExerciseThumb } from "../lib/exerciseIcon";
import { BurnMetricToggle, totalBurnKcal, totalDurationMin } from "../lib/trainingBurn";
import { type BurnMetric, type MuscleView, useUiStore } from "../lib/uiStore";
import { cn } from "../lib/utils";
import { CardioFitnessSection } from "./CardioSection";
import { ExerciseMuscleNames, ExercisePicker } from "./PlansTab";
import { BurnHelp } from "./SessionsTab";

// ---------- Progress tab ----------

// Number of days the per-exercise chart looks back on the single-day view
// (one day isn't a trend, so "day" keeps the server's rolling windows). 180
// covers ~6 months of training history — enough to see programmed progression
// on most lifts without overwhelming the chart with noise. Every other
// granularity charts exactly the selected period.
const EXERCISE_PROGRESS_DAYS = 180;

// Query window for the Progress charts: the selected period, or undefined on
// the day view so the server falls back to its rolling look-back.
function progressWindow(granularity: Granularity, range: Range) {
  return granularity === "day" ? undefined : { from: range.from, to: range.to };
}

export function ProgressTab({
  catalog,
  granularity,
  range,
  sessions,
}: {
  catalog: WorkoutCatalog;
  granularity: Granularity;
  range: Range;
  // The period's sessions (already loaded by the page) — the day view breaks
  // the selected day's volume down from these instead of weekly buckets.
  sessions: WorkoutSession[];
}) {
  const exerciseById = useMemo(() => new Map(catalog.exercises.map((e) => [e.id, e])), [catalog]);

  // PRs derive the dropdown of exercises the user has actually trained.
  // First set of any exercise always counts as a PR, so this naturally
  // includes every trained lift (server caps at 100).
  const prsQ = useGetWorkoutProgressPrs({ limit: 100 });
  const prs = (prsQ.data?.prs as unknown as WorkoutPR[] | undefined) ?? null;

  // Trained-exercise list, sorted by most-recent PR first so the user's
  // active lifts surface to the top of the dropdown.
  const trainedExercises = useMemo<ExerciseId[]>(() => {
    if (!prs) return [];
    const seen = new Set<ExerciseId>();
    const out: ExerciseId[] = [];
    for (const pr of prs) {
      if (seen.has(pr.exercise_id)) continue;
      seen.add(pr.exercise_id);
      out.push(pr.exercise_id);
    }
    return out;
  }, [prs]);

  const [selectedExercise, setSelectedExercise] = useState<ExerciseId | null>(null);
  // Once PRs load, auto-select the most recently PR'd exercise so the chart
  // has something interesting to show without the user clicking anything.
  useEffect(() => {
    if (selectedExercise == null && trainedExercises.length > 0) {
      setSelectedExercise(trainedExercises[0]);
    }
  }, [trainedExercises, selectedExercise]);

  return (
    <div className="space-y-4">
      <ExerciseProgressSection
        catalog={catalog}
        trainedExercises={trainedExercises}
        selected={selectedExercise}
        onSelect={setSelectedExercise}
        exerciseById={exerciseById}
        loading={prs == null}
        granularity={granularity}
        range={range}
      />
      {granularity === "day" ? (
        <DayMuscleGroupVolumeSection sessions={sessions} />
      ) : (
        <MuscleGroupVolumeSection granularity={granularity} range={range} sessions={sessions} />
      )}
      <CardioFitnessSection granularity={granularity} range={range} />
    </div>
  );
}

function ExerciseProgressSection({
  catalog,
  trainedExercises,
  selected,
  onSelect,
  exerciseById,
  loading,
  granularity,
  range,
}: {
  catalog: WorkoutCatalog;
  trainedExercises: ExerciseId[];
  selected: ExerciseId | null;
  onSelect: (id: ExerciseId) => void;
  exerciseById: Map<ExerciseId, Exercise>;
  loading: boolean;
  granularity: Granularity;
  range: Range;
}) {
  const { t } = useTranslation();
  const period = progressWindow(granularity, range);
  const progressQ = useGetWorkoutProgressExerciseId(selected ?? "", period, {
    // Only fetch once an exercise is picked.
    query: { enabled: !!selected },
  });
  const points = selected
    ? ((progressQ.data?.points as unknown as ExerciseProgressPoint[] | undefined) ?? null)
    : null;
  const fetching = !!selected && progressQ.isPending;
  const err = progressQ.error ? apiErr(progressQ.error) : null;

  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedEx = selected ? exerciseById.get(selected) : undefined;
  const selectedName = selected ? exerciseName(selectedEx ?? selected) : null;
  const selectedGroups = selected ? muscleGroupsForExercise(selected) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {t("workout.perExerciseProgress")}
          <HelpPopover
            label={t("workout.perExerciseHelpAria")}
            heading={t("workout.perExerciseProgress")}
            align="start"
          >
            <p>{t("workout.perExerciseDescription")}</p>
          </HelpPopover>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && trainedExercises.length === 0 ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          // Same row layout as the picker modal, so the pick reads as that row.
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md border border-input bg-background text-start text-sm shadow-xs",
              "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              // Soft: a raised tile rather than an outlined field.
              "transition-[color,background-color,box-shadow] soft:border-transparent soft:shadow-tile soft:hover:bg-background soft:hover:text-primary soft:active:shadow-pressed",
              selectedEx ? "px-3 py-2" : "h-9 px-3",
            )}
          >
            {selectedEx ? (
              <>
                <ExerciseThumb exerciseId={selectedEx.id} className="size-12" placeholder />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="font-medium">{exerciseName(selectedEx)}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ExerciseTypeBadge type={selectedEx.type} />
                    {selectedEx.equipment}
                    {selectedEx.machine_id ? ` · ${machineName(selectedEx.machine_id)}` : ""}
                  </span>
                  <ExerciseMuscleNames exerciseId={selectedEx.id} />
                </span>
                {selectedGroups.length > 0 && (
                  <MuscleMap
                    groups={selectedGroups}
                    muscles={selectedEx.primary_muscles}
                    className="h-12"
                  />
                )}
              </>
            ) : (
              <span className="flex-1 truncate text-muted-foreground">
                {selectedName ?? t("workout.pickAnExercise")}
              </span>
            )}
            <ChevronDown className="size-4 shrink-0 opacity-50" />
          </button>
        )}

        {pickerOpen && (
          <ExercisePicker
            catalog={catalog}
            prioritizeIds={trainedExercises}
            gymFilterDefault={false}
            onPick={(ex) => {
              onSelect(ex.id);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {err && <p className="text-sm text-destructive">{err}</p>}

        {fetching && <Skeleton className="h-32 w-full" />}

        {!fetching && selected && points != null && (
          <ExerciseProgressCharts
            points={points}
            granularity={granularity}
            period={period}
            // PDF of the exercise in view, over the same window as the charts.
            onExport={(view) =>
              void runExport(() => exportExerciseProgressPdf(selected, period, view))
            }
          />
        )}

        {!fetching && !selected && (
          <EmptyState icon={TrendingUp}>{t("workout.pickExerciseToChart")}</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function ExerciseProgressCharts({
  points,
  granularity,
  period,
  onExport,
}: {
  points: ExerciseProgressPoint[];
  granularity: Granularity;
  // The queried period, or undefined on the day view's rolling look-back.
  period: { from: string; to: string } | undefined;
  // Called with the charts' current average + spacing, so the PDF matches.
  onExport: (view: ChartView) => void;
}) {
  const { t } = useTranslation();
  const spacing = useUiStore((s) => s.workoutChartSpacing);
  const setSpacing = useUiStore((s) => s.setWorkoutChartSpacing);
  const averageDays = useUiStore((s) => s.workoutChartAverage);
  const setAverageDays = useUiStore((s) => s.setWorkoutChartAverage);
  // The tapped date, shared by all three charts (like the Body charts): one tap
  // opens the same session's tooltip on every series.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  if (points.length === 0) {
    return (
      <EmptyState icon={TrendingUp}>
        {period
          ? t("workout.noSetsInRange")
          : t("workout.noSetsInDays", { days: EXERCISE_PROGRESS_DAYS })}
      </EmptyState>
    );
  }
  const oneRm = points.map((p) => ({ date: p.date, value: p.est_1rm_kg }));
  const topW = points.map((p) => ({ date: p.date, value: p.top_weight_kg }));
  const vol = points.map((p) => ({ date: p.date, value: p.total_volume_kg }));
  // The day view's look-back has no fixed period, so it spans the sessions.
  const window = period ?? { from: points[0].date, to: points[points.length - 1].date };
  const axis = spacing === "date" ? window : null;
  const avgCap = averageCap({
    granularity: period ? granularity : "all",
    from: window.from,
    to: window.to,
  });
  const average = fitAverage(averageDays, avgCap);
  return (
    <div className="space-y-4">
      <ChartControls
        average={average}
        cap={avgCap}
        onAverage={setAverageDays}
        spacing={spacing}
        onSpacing={setSpacing}
        onExport={() => onExport({ average, spacing })}
      />
      {(
        [
          ["chartEst1rm", oneRm],
          ["chartTopSetWeight", topW],
          ["chartTotalVolume", vol],
        ] as const
      ).map(([title, pts]) => (
        <ChartBlock
          key={title}
          title={t(`workout.${title}`)}
          unit={t("workout.unitKg")}
          points={pts}
          from={axis?.from}
          to={axis?.to}
          selectedKey={selectedKey}
          onSelectKey={setSelectedKey}
          average={average}
        />
      ))}
    </div>
  );
}

export function ChartBlock({
  title,
  unit,
  points,
  from,
  to,
  selectedKey,
  onSelectKey,
  tooltipActions,
  average,
}: {
  title: string;
  unit: string;
  points: ChartPoint[];
  // The period window: points sit at their date within it (gaps read as
  // gaps). Omitted → evenly spaced.
  from?: string;
  to?: string;
  // Shared selection across sibling charts; omitted → each chart keeps its own.
  selectedKey?: string | null;
  onSelectKey?: (key: string | null) => void;
  tooltipActions?: (point: ChartPoint) => React.ReactNode;
  // Trailing-average window in days (0 / omitted = none), see rollingAverage.
  average?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {points.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {t("workout.latest")}{" "}
            <span className="font-medium text-foreground">
              {points[points.length - 1].value.toFixed(1)}
              {unit}
            </span>
          </span>
        )}
      </div>
      <ProgressLineChart
        points={points}
        unit={unit}
        from={from}
        to={to}
        selectedKey={selectedKey}
        onSelectKey={onSelectKey}
        tooltipActions={tooltipActions}
        average={average}
      />
    </div>
  );
}

// SVG line chart with a value axis, gridlines and tap-to-inspect points — the
// shared LineChart (components/chart.tsx). The "latest" badge above covers the
// current number; the axis + tooltip cover everything in between.
function ProgressLineChart({
  points,
  unit,
  from,
  to,
  selectedKey,
  onSelectKey,
  tooltipActions,
  average = 0,
}: {
  points: ChartPoint[];
  unit: string;
  // The period window: points sit at their date within it (gaps read as
  // gaps). Omitted → evenly spaced.
  from?: string;
  to?: string;
  // Shared selection across sibling charts; omitted → each chart keeps its own.
  selectedKey?: string | null;
  onSelectKey?: (key: string | null) => void;
  tooltipActions?: (point: ChartPoint) => React.ReactNode;
  // Trailing-average window in days (0 / omitted = none), see rollingAverage.
  average?: number;
}) {
  const { t } = useTranslation();
  if (points.length === 0) {
    return (
      <EmptyState icon={ChartColumn} compact>
        {t("workout.noData")}
      </EmptyState>
    );
  }
  return (
    <LineChart
      points={points}
      unit={unit}
      from={from}
      to={to}
      height={120}
      selectedKey={selectedKey}
      onSelectKey={onSelectKey}
      tooltipActions={tooltipActions}
      trend={averageTrend(points, average, t)}
    />
  );
}

// Inclusive list of YYYY-MM-DD dates from `from` to `to`, for zero-filling the
// burn chart so rest days read as gaps rather than missing bars.
function eachDayIso(from: string, to: string): string[] {
  const out: string[] = [];
  const d = fromIso(from);
  const end = fromIso(to);
  while (d <= end) {
    out.push(toIso(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Training-burn roll-up for the Workout page. The single-day card is owned by
// the Dashboard, so here we render only the week/month picture: a per-day bar
// chart of estimated burn plus the period total and average per training day.
// Burn is each session's logged `kcal_burned`, or a MET estimate from its
// duration when none was logged (see lib/trainingBurn). The kcal/time toggle
// swaps every figure for logged training minutes.
export function TrainingBurnCard({
  sessions,
  granularity,
  range,
  bodyweightKg,
  selectedDate,
  onSelectDate,
}: {
  sessions: WorkoutSession[];
  granularity: Granularity;
  range: { from: string; to: string };
  bodyweightKg: number | null;
  // Tapped day on the chart, shared with the list below it.
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
}) {
  const { t } = useTranslation();
  const metric = useUiStore((s) => s.burnMetric);
  // Per-calendar-day burn across the range, zero-filled. Days holding an
  // unfinished session are flagged so they stay tappable even with no burn yet.
  const points = useMemo<BurnPoint[]>(() => {
    const byDate = new Map<string, WorkoutSession[]>();
    for (const s of sessions) {
      const arr = byDate.get(s.date) ?? [];
      arr.push(s);
      byDate.set(s.date, arr);
    }
    return eachDayIso(range.from, range.to).map((date) => {
      const day = byDate.get(date) ?? [];
      const unfinished = day.filter((s) => s.duration_min == null).length;
      return {
        date,
        value:
          metric === "duration" ? totalDurationMin(day) : totalBurnKcal(day, bodyweightKg).kcal,
        hasSessions: day.length > 0,
        unfinished: unfinished > 0,
        detail:
          unfinished > 0
            ? [{ label: t("workout.unfinishedCount", { count: unfinished }), value: "" }]
            : undefined,
      };
    });
  }, [sessions, range.from, range.to, bodyweightKg, metric, t]);

  // The single-day view nests the burn total + per-session rows inside the
  // sessions list (TrainingBurnDayCard, rendered by SessionsTab); here we only
  // draw the week/month chart.
  if (granularity === "day") return null;

  const overall =
    metric === "duration" ? totalDurationMin(sessions) : totalBurnKcal(sessions, bodyweightKg).kcal;
  const trainingDays = points.filter((p) => p.value > 0).length;
  if (sessions.length === 0) return null;
  const avgPerDay = trainingDays > 0 ? overall / trainingDays : 0;
  const unit = metric === "duration" ? t("workout.min") : t("workout.unitKcal");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Flame className="size-4 text-primary" />
          {t("workout.trainingBurn")}
          <BurnHelp description={t("workout.burnRangeDescription")} />
          <BurnMetricToggle className="ms-auto" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label={t("workout.totalStat")}
            value={`${Math.round(overall).toLocaleString()} ${unit}`}
          />
          <Stat
            label={t("workout.avgPerTrainingDay")}
            value={`${Math.round(avgPerDay).toLocaleString()} ${unit}`}
          />
          <Stat label={t("workout.trainingDaysStat")} value={String(trainingDays)} />
        </div>
        <BurnBarChart
          points={points}
          metric={metric}
          average={avgPerDay}
          selectedDate={selectedDate}
          onSelectDate={onSelectDate}
        />
      </CardContent>
    </Card>
  );
}

// Per-day bar chart of training burn (kcal, or minutes in the time view). Bars scale to the period's peak; a
// dashed line marks the average across training days. Shares the value axis,
// gridlines and tap-to-inspect tooltip with the line charts (components/chart).
type BurnPoint = ChartPoint & { hasSessions?: boolean; unfinished?: boolean };

function BurnBarChart({
  points,
  metric,
  average,
  selectedDate,
  onSelectDate,
}: {
  points: BurnPoint[];
  metric: BurnMetric;
  average?: number | null;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
}) {
  const { t } = useTranslation();
  if (points.length === 0) {
    return (
      <EmptyState icon={ChartColumn} compact>
        {t("workout.noData")}
      </EmptyState>
    );
  }
  const w = CHART_W;
  const h = 120;
  const pad = 18;
  const innerH = h - 2 * pad;
  const innerW = w - 2 * pad;
  const max = Math.max(...points.map((p) => p.value), 1);
  const slot = innerW / points.length;
  const barW = Math.max(1, slot - 2);
  const yAt = (v: number) => h - pad - (v / max) * innerH;
  const ticks = axisTicks(0, max);
  // A day is tappable when it burned something or holds any session (e.g. an
  // unfinished one with no sets yet).
  const tappable = (p: BurnPoint) => p.value > 0 || !!p.hasSessions;
  const selectedIdx = points.findIndex((p) => p.date === selectedDate);
  const selected = selectedIdx >= 0 ? selectedIdx : null;
  const active =
    selected != null && points[selected] && tappable(points[selected]) ? selected : null;
  return (
    <div dir="ltr" className="flex gap-2">
      <ChartYAxis ticks={ticks} yAt={yAt} height={h} />
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height: h }}>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            width="100%"
            height={h}
            className="text-primary"
          >
            <ChartGrid ticks={ticks} yAt={yAt} width={w} />
            {average != null && average > 0 && (
              <line
                x1={pad}
                x2={w - pad}
                y1={yAt(average)}
                y2={yAt(average)}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                opacity={0.5}
              />
            )}
            {points.map((p, i) => {
              if (!tappable(p)) return null;
              // No burn yet (unfinished, no sets): a short stub marks the day.
              const barH = p.value > 0 ? Math.max(1, (p.value / max) * innerH) : 4;
              const isSelected = selected === i;
              // Unfinished days render faded so they read as "not done yet".
              // While a day is selected the rest recede so it stands out.
              const opacity = isSelected
                ? 1
                : (p.unfinished ? 0.4 : 0.85) * (selected != null ? 0.4 : 1);
              return (
                <g key={p.date}>
                  {/* Selected day: a soft full-height column behind the bar. */}
                  {isSelected && (
                    <rect
                      x={pad + i * slot}
                      y={pad}
                      width={slot}
                      height={innerH}
                      fill="currentColor"
                      opacity={0.15}
                    />
                  )}
                  <rect
                    x={pad + i * slot + (slot - barW) / 2}
                    y={h - pad - barH}
                    width={barW}
                    height={barH}
                    fill="currentColor"
                    opacity={opacity}
                  />
                  {/* Full-height, invisible hit target so the bar is easy to tap. */}
                  <rect
                    x={pad + i * slot}
                    y={pad}
                    width={slot}
                    height={innerH}
                    fill="transparent"
                    className="cursor-pointer"
                    onClick={() => onSelectDate(isSelected ? null : p.date)}
                  />
                </g>
              );
            })}
          </svg>
          {active != null && (
            <ChartTooltip
              point={points[active]}
              unit={` ${t(metric === "duration" ? "workout.min" : "workout.unitKcal")}`}
              leftPct={((pad + active * slot + slot / 2) / w) * 100}
              top={yAt(points[active].value)}
            />
          )}
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{isoToDisplay(points[0].date)}</span>
          <span>
            {t(metric === "duration" ? "workout.peakMin" : "workout.peak", {
              value: Math.round(max).toLocaleString(),
            })}
          </span>
          <span>{isoToDisplay(points[points.length - 1].date)}</span>
        </div>
      </div>
    </div>
  );
}

type VolumeMetric = "volume" | "sets";

// A week's value on the chosen metric; null = nothing trained that week.
type WeekSlot = { week: string; point: MuscleGroupVolumePoint | null };

function metricValue(p: MuscleGroupVolumePoint | null, metric: VolumeMetric): number {
  if (!p) return 0;
  return metric === "volume" ? p.total_volume_kg : p.set_count;
}

function formatMetric(value: number, metric: VolumeMetric, t: TFunction): string {
  return metric === "volume"
    ? `${Math.round(value).toLocaleString()} kg`
    : t("workout.setsShort", { count: Math.round(value) });
}

// Every Monday from the week holding `from` through the week holding `to` —
// the shared x-axis, so a week with no training is an empty slot on every row
// instead of shifting that row's bars out of line with the others.
function weekStarts(from: string, to: string): string[] {
  const d = fromIso(from);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const end = fromIso(to);
  const out: string[] = [];
  while (d <= end) {
    out.push(toIso(d));
    d.setDate(d.getDate() + 7);
  }
  return out;
}

function MuscleGroupVolumeSection({
  granularity,
  range,
  sessions,
}: {
  granularity: Granularity;
  range: Range;
  sessions: WorkoutSession[];
}) {
  const { t } = useTranslation();
  // Groups or finer targets; the server buckets by either, the id in group_id.
  const view = useUiStore((s) => s.muscleView);
  const [metric, setMetric] = useState<VolumeMetric>("volume");
  const [expanded, setExpanded] = useState<MuscleGroupId | null>(null);
  const period = progressWindow(granularity, range);
  const volumeQ = useGetWorkoutProgressMuscleGroups({ ...period, by: view });
  const points = (volumeQ.data?.points as unknown as MuscleGroupVolumePoint[] | undefined) ?? null;
  const err = volumeQ.error ? apiErr(volumeQ.error) : null;
  const from = volumeQ.data?.from;
  const to = volumeQ.data?.to;

  // Bucket the flat (week, group) rows by group onto the period's full week
  // axis and total each over the whole period (the server only returns sets
  // inside it), biggest group on the chosen metric first.
  const perGroup = useMemo(() => {
    if (!points || !from || !to) return null;
    const weeks = weekStarts(from, to);
    const byGroup = new Map<MuscleGroupId, Map<string, MuscleGroupVolumePoint>>();
    for (const p of points) {
      const m = byGroup.get(p.group_id) ?? new Map();
      m.set(p.week_start, p);
      byGroup.set(p.group_id, m);
    }
    const rows = Array.from(byGroup.entries()).map(([groupId, byWeek]) => {
      const series: WeekSlot[] = weeks.map((week) => ({ week, point: byWeek.get(week) ?? null }));
      const totalVolume = series.reduce((sum, s) => sum + metricValue(s.point, "volume"), 0);
      const totalSets = series.reduce((sum, s) => sum + metricValue(s.point, "sets"), 0);
      return { groupId, series, totalVolume, totalSets };
    });
    rows.sort((a, b) =>
      metric === "volume"
        ? b.totalVolume - a.totalVolume || b.totalSets - a.totalSets
        : b.totalSets - a.totalSets || b.totalVolume - a.totalVolume,
    );
    return rows;
  }, [points, from, to, metric]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t("workout.volumeByGroup")}
          <HelpPopover
            label={t("workout.volumeHelpAria")}
            heading={t("workout.volumeByGroup")}
            align="start"
          >
            <p>{t("workout.weeklyVolumeDescription")}</p>
          </HelpPopover>
          <VolumeViewControls
            className="ms-auto"
            metric={metric}
            onMetric={setMetric}
            // PDF of the card as shown: same period, metric and grouping.
            onExport={
              perGroup && perGroup.length > 0 && from && to
                ? () =>
                    void runExport(() =>
                      exportMuscleVolumePdf({
                        rows: perGroup.map((r) => ({
                          groupId: r.groupId,
                          totalVolume: r.totalVolume,
                          totalSets: r.totalSets,
                          weeks: r.series.map((s) => ({
                            week: s.week,
                            volume: metricValue(s.point, "volume"),
                            sets: metricValue(s.point, "sets"),
                          })),
                        })),
                        metric,
                        view,
                        period: { from, to },
                        sessions,
                      }),
                    )
                : undefined
            }
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {err && <p className="text-sm text-destructive">{err}</p>}
        {!err && points == null && <Skeleton className="h-24 w-full" />}
        {!err && perGroup != null && perGroup.length === 0 && (
          <EmptyState icon={BicepsFlexed}>{t("workout.noVolumeYet")}</EmptyState>
        )}
        {!err && perGroup != null && perGroup.length > 0 && (
          <ul className="space-y-2">
            {perGroup.map(({ groupId, series, totalVolume, totalSets }) => {
              const open = expanded === groupId;
              return (
                <li
                  key={groupId}
                  className={cn(
                    // Soft: raised while collapsed, pressed in while expanded.
                    "rounded-lg border border-edge bg-background/40 px-3 py-2 shadow-well transition-shadow soft:bg-background",
                    !open && "soft:shadow-tile",
                  )}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : groupId)}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md text-start text-sm transition-colors hover:bg-muted/50 soft:hover:bg-transparent soft:hover:text-primary"
                  >
                    <BucketMap id={groupId} view={view} className="h-9" />
                    {/* The sparkline wraps to its own line under the name so the
                        name gets the width; while open the detail chart below
                        replaces it. */}
                    <span className="min-w-0 flex-1 truncate font-medium capitalize">
                      {bucketLabel(groupId, view)}
                    </span>
                    {!open && (
                      <span className="order-last basis-full px-9 pt-1.5">
                        <VolumeSparkline series={series} metric={metric} />
                      </span>
                    )}
                    <span className="w-20 shrink-0 text-end text-xs text-muted-foreground sm:w-24">
                      <span
                        className={cn(
                          "block tabular-nums",
                          metric === "volume" && "font-medium text-foreground",
                        )}
                      >
                        {Math.round(totalVolume).toLocaleString()} kg
                      </span>
                      <span className={cn(metric === "sets" && "font-medium text-foreground")}>
                        {t("workout.setsShort", { count: totalSets })}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>
                  {open && (
                    <BucketVolumeDetail
                      bucketId={groupId}
                      series={series}
                      metric={metric}
                      sessions={sessions}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// The volume cards' view settings in one dropdown, styled like the charts'
// ChartControls: the metric (when the card offers one) and the shared
// groups / muscles breakdown.
function VolumeViewControls({
  metric,
  onMetric,
  onExport,
  className,
}: {
  metric?: VolumeMetric;
  onMetric?: (v: VolumeMetric) => void;
  // Adds "Export PDF" as the menu's last entry.
  onExport?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const view = useUiStore((s) => s.muscleView);
  const setView = useUiStore((s) => s.setMuscleView);
  const metricLabel = (v: VolumeMetric) =>
    t(v === "volume" ? "workout.metricVolume" : "workout.metricSets");
  const viewLabel = (v: MuscleView) =>
    t(v === "group" ? "workout.muscleViewGroups" : "workout.muscleViewMuscles");
  // As in ChartControls, picking leaves the menu open so both can change in one go.
  const keepOpen = (e: Event) => e.preventDefault();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(CHART_MENU_TRIGGER, "shrink-0", className)}>
        <SlidersHorizontal className="size-3" aria-hidden />
        {metric && (
          <>
            <span className="font-medium text-foreground">{metricLabel(metric)}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span className="font-medium text-foreground">{viewLabel(view)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {metric && onMetric && (
          <>
            <DropdownMenuLabel>{t("workout.metricLabel")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={metric}
              onValueChange={(v) => onMetric(v as VolumeMetric)}
            >
              {(["volume", "sets"] as const).map((v) => (
                <DropdownMenuRadioItem key={v} value={v} className="text-xs" onSelect={keepOpen}>
                  {metricLabel(v)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>{t("workout.muscleViewLabel")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={view} onValueChange={(v) => setView(v as MuscleView)}>
          {(["group", "target"] as const).map((v) => (
            <DropdownMenuRadioItem key={v} value={v} className="text-xs" onSelect={keepOpen}>
              {viewLabel(v)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onExport && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onSelect={onExport}>
              <FileDown className="size-3.5" />
              {t("export.exportPdf")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Theme series colours for the biggest exercises; the long tail shares grey.
const EXERCISE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const OTHER_EXERCISE_COLOR = "var(--muted-foreground)";

// Drill-down for one muscle/group: a week-by-week bar stacked by exercise, a
// few period stats, and the exercises that fed it (from the period's
// sessions, same primary-muscle attribution as the server). Clicking an
// exercise — in the list or on the chart — highlights its share of each week.
function BucketVolumeDetail({
  bucketId,
  series,
  metric,
  sessions,
}: {
  bucketId: MuscleGroupId;
  series: WeekSlot[];
  metric: VolumeMetric;
  sessions: WorkoutSession[];
}) {
  const { t } = useTranslation();
  const view = useUiStore((s) => s.muscleView);
  const values = series.map((s) => metricValue(s.point, metric));
  const trained = series.filter((s) => s.point).length;
  const total = values.reduce((a, b) => a + b, 0);
  const best = Math.max(...values, 0);

  const [selected, setSelected] = useState<ExerciseId | null>(null);
  const toggle = (id: ExerciseId) => setSelected((cur) => (cur === id ? null : id));

  // Per exercise: period totals plus a per-week tally keyed by Monday.
  const exercises = useMemo(() => {
    type Tally = { volume: number; sets: number };
    const byEx = new Map<ExerciseId, Tally & { weeks: Map<string, Tally> }>();
    for (const s of sessions) {
      const d = fromIso(s.date);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const week = toIso(d);
      for (const set of s.sets) {
        if (!bucketsForExercise(set.exercise_id, view).includes(bucketId)) continue;
        const vol = setVolume(set);
        const ex = byEx.get(set.exercise_id) ?? { volume: 0, sets: 0, weeks: new Map() };
        ex.volume += vol;
        ex.sets += 1;
        const wk = ex.weeks.get(week) ?? { volume: 0, sets: 0 };
        wk.volume += vol;
        wk.sets += 1;
        ex.weeks.set(week, wk);
        byEx.set(set.exercise_id, ex);
      }
    }
    return Array.from(byEx.entries())
      .sort((a, b) => (metric === "volume" ? b[1].volume - a[1].volume : b[1].sets - a[1].sets))
      .map(([id, ex], i) => ({
        id,
        ...ex,
        color: EXERCISE_COLORS[i] ?? OTHER_EXERCISE_COLOR,
      }));
  }, [sessions, bucketId, view, metric]);

  const stat = (label: string, value: string) => (
    <div className="rounded-md bg-muted/50 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <StackedWeekBars
          weeks={series.map((s) => s.week)}
          exercises={exercises}
          metric={metric}
          selected={selected}
          onSelect={toggle}
        />
        {/* px-9 matches the plot's inset (axis w-8 + gap-1 each side) so the
            dates sit under the bars. */}
        <div className="mt-1 flex justify-between px-9 text-[10px] text-muted-foreground">
          <span>{isoToDisplay(series[0]?.week)}</span>
          <span>{isoToDisplay(series[series.length - 1]?.week)}</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {stat(t("workout.avgPerWeek"), formatMetric(total / Math.max(series.length, 1), metric, t))}
        {stat(t("workout.bestWeek"), formatMetric(best, metric, t))}
        {stat(t("workout.weeksTrainedLabel"), `${trained} / ${series.length}`)}
      </div>
      <TypeVolumeSplit exercises={exercises} />
      {exercises.length > 0 && (
        // A table: swatch · name · type (centered) · kg · sets. Rows are
        // subgrids of the list so every column lines up across exercises.
        <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] gap-y-0.5">
          {exercises.map((ex) => {
            const type = getExercise(ex.id)?.type;
            return (
              <li key={ex.id} className="col-span-5 grid grid-cols-subgrid">
                <button
                  type="button"
                  aria-pressed={selected === ex.id}
                  onClick={() => toggle(ex.id)}
                  className={cn(
                    "col-span-5 grid grid-cols-subgrid items-center gap-x-2 rounded-sm px-1 py-0.5 text-start text-xs transition-opacity hover:bg-muted/50",
                    selected != null && selected !== ex.id && "opacity-40",
                    selected === ex.id && "bg-muted",
                  )}
                >
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-sm"
                    style={{ background: ex.color }}
                  />
                  <span className="min-w-0 truncate">{exerciseLabel(ex.id)}</span>
                  <span className="flex justify-center">
                    {type && <ExerciseTypeBadge type={type} />}
                  </span>
                  <span className="text-end text-muted-foreground tabular-nums">
                    {ex.volume > 0 ? `${Math.round(ex.volume).toLocaleString()} kg` : "—"}
                  </span>
                  <span className="text-end text-muted-foreground tabular-nums">
                    {t("workout.setsShort", { count: ex.sets })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// One bar per week on the shared axis, stacked bottom-up from the biggest
// exercise. With an exercise selected, every other segment fades so its
// share of each week stands out; an untrained week is a faint stub.
function StackedWeekBars({
  weeks,
  exercises,
  metric,
  selected,
  onSelect,
}: {
  weeks: string[];
  exercises: {
    id: ExerciseId;
    color: string;
    weeks: Map<string, { volume: number; sets: number }>;
  }[];
  metric: VolumeMetric;
  selected: ExerciseId | null;
  onSelect: (id: ExerciseId) => void;
}) {
  const { t } = useTranslation();
  // Week under the pointer; its tooltip breaks the bar down by exercise.
  // Mouse: hover shows it, clicking a segment selects that exercise. Touch:
  // a tap toggles the week's tooltip only (pick exercises from the list), and
  // a tap anywhere else closes it — there's no mouseleave to do that.
  const [active, setActive] = useState<number | null>(null);
  const touchRef = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active == null) return;
    const close = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [active]);
  if (weeks.length === 0) {
    return <span className="text-xs text-muted-foreground">{t("workout.noData")}</span>;
  }
  const w = 200;
  const h = 140;
  const pick = (v: { volume: number; sets: number } | undefined) =>
    v ? (metric === "volume" ? v.volume : v.sets) : 0;
  const totals = weeks.map((wk) => exercises.reduce((sum, ex) => sum + pick(ex.weeks.get(wk)), 0));
  const max = Math.max(...totals, 1);
  const barWidth = w / weeks.length;
  // Zero-based value axis in the chosen metric; the top pad keeps the max
  // tick's label inside the box.
  const pad = 16;
  const yAt = (v: number) => h - (v / max) * (h - pad);
  const ticks = axisTicks(0, max, 2);

  let tooltip: ReactNode = null;
  if (active != null) {
    const wk = weeks[active];
    const total = totals[active];
    const leftPct = ((active + 0.5) / weeks.length) * 100;
    const rows = exercises
      .map((ex) => ({ ex, value: pick(ex.weeks.get(wk)) }))
      .filter((r) => r.value > 0);
    // Shifting by the same percentage of its own width as the anchor's
    // position keeps the box inside the chart at every week, even on a phone.
    tooltip = (
      <div
        className="pointer-events-none absolute z-10 max-w-full rounded-md border bg-popover px-2 py-1 text-[11px] whitespace-nowrap shadow-overlay"
        style={{
          left: `${leftPct}%`,
          top: yAt(total) - 6,
          transform: `translate(-${leftPct}%, -100%)`,
        }}
      >
        <div className="font-medium">
          {t("workout.weekOf", { date: isoToDisplay(wk) })} ·{" "}
          {total > 0 ? formatMetric(total, metric, t) : t("workout.noTrainingWeek")}
        </div>
        {rows.map(({ ex, value }) => (
          <div
            key={ex.id}
            className={cn(
              "flex items-center gap-1.5 text-muted-foreground",
              selected === ex.id && "font-medium text-foreground",
              selected != null && selected !== ex.id && "opacity-60",
            )}
          >
            <span aria-hidden className="size-2 rounded-sm" style={{ background: ex.color }} />
            <span className="min-w-0 truncate">{exerciseLabel(ex.id)}</span>
            <span className="ms-auto ps-2 tabular-nums">
              {formatMetric(value, metric, t)} · {Math.round((value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    // pe-9 mirrors the axis column on the right so the plot sits centred, in
    // line with the collapsed rows' sparklines.
    <div className="flex gap-1 pe-9">
      <ChartYAxis
        ticks={ticks}
        unit={metric === "volume" ? "kg" : t("workout.metricSets").toLowerCase()}
        yAt={yAt}
        height={h}
        stackUnit
      />
      <div
        ref={boxRef}
        className="relative min-w-0 flex-1"
        onPointerDown={(e) => (touchRef.current = e.pointerType !== "mouse")}
        onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
      >
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={h}>
          <ChartGrid ticks={ticks} yAt={yAt} width={w} />
          {weeks.map((wk, i) => {
            const x = i * barWidth + 0.5;
            const width = Math.max(1, barWidth - 1);
            let y = h;
            return (
              <g
                key={wk}
                onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
                onClick={() => touchRef.current && setActive((cur) => (cur === i ? null : i))}
              >
                {/* Full-height, invisible hit target so short and empty weeks still hover. */}
                <rect x={i * barWidth} y={0} width={barWidth} height={h} fill="transparent" />
                {active === i && (
                  <rect
                    x={i * barWidth}
                    y={0}
                    width={barWidth}
                    height={h}
                    fill="currentColor"
                    opacity={0.06}
                  />
                )}
                {totals[i] === 0 ? (
                  <rect
                    x={x}
                    y={h - 1}
                    width={width}
                    height={1}
                    fill={OTHER_EXERCISE_COLOR}
                    opacity={0.3}
                  />
                ) : (
                  exercises.map((ex) => {
                    const value = pick(ex.weeks.get(wk));
                    if (value === 0) return null;
                    const segH = (value / max) * (h - pad);
                    y -= segH;
                    return (
                      <rect
                        key={ex.id}
                        x={x}
                        y={y}
                        width={width}
                        height={segH}
                        fill={ex.color}
                        opacity={selected == null || selected === ex.id ? 0.9 : 0.15}
                        className="cursor-pointer transition-opacity"
                        onClick={() => !touchRef.current && onSelect(ex.id)}
                      />
                    );
                  })
                )}
              </g>
            );
          })}
        </svg>
        {tooltip}
      </div>
    </div>
  );
}

// Day view of volume by muscle group: the selected day's groups, each with the
// exercises that hit it. Same attribution as the weekly endpoint — a set counts
// in full for every primary group its exercise targets.
function DayMuscleGroupVolumeSection({ sessions }: { sessions: WorkoutSession[] }) {
  const { t } = useTranslation();
  const view = useUiStore((s) => s.muscleView);
  const perGroup = useMemo(() => {
    type Tally = { volume: number; sets: number };
    const byGroup = new Map<MuscleGroupId, Tally & { exercises: Map<ExerciseId, Tally> }>();
    for (const s of sessions) {
      for (const set of s.sets) {
        const vol = setVolume(set);
        for (const g of bucketsForExercise(set.exercise_id, view)) {
          const row = byGroup.get(g) ?? { volume: 0, sets: 0, exercises: new Map() };
          row.volume += vol;
          row.sets += 1;
          const ex = row.exercises.get(set.exercise_id) ?? { volume: 0, sets: 0 };
          ex.volume += vol;
          ex.sets += 1;
          row.exercises.set(set.exercise_id, ex);
          byGroup.set(g, row);
        }
      }
    }
    return Array.from(byGroup.entries())
      .map(([groupId, r]) => ({
        groupId,
        volume: r.volume,
        sets: r.sets,
        exercises: Array.from(r.exercises.entries()).sort((a, b) => b[1].volume - a[1].volume),
      }))
      .sort((a, b) => b.volume - a.volume || b.sets - a.sets);
  }, [sessions, view]);
  // Bars scale to the day's biggest group (groups) or to their own group
  // (exercises). Volume when there is any; a bodyweight-only day falls back to sets.
  const top = {
    volume: Math.max(0, ...perGroup.map((g) => g.volume)),
    sets: Math.max(0, ...perGroup.map((g) => g.sets)),
  };
  const share = (volume: number, sets: number, maxVolume: number, maxSets: number) =>
    maxVolume > 0 ? volume / maxVolume : maxSets > 0 ? sets / maxSets : 0;

  const total = (volume: number, sets: number, strong = false) => (
    <span className="w-24 shrink-0 text-end text-xs text-muted-foreground">
      <span className={cn("block tabular-nums", strong && "font-medium text-foreground")}>
        {volume > 0 ? `${Math.round(volume).toLocaleString()} kg` : "—"}
      </span>
      {t("workout.setsShort", { count: sets })}
    </span>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {t("workout.volumeByGroup")}
          <HelpPopover
            label={t("workout.volumeHelpAria")}
            heading={t("workout.volumeByGroup")}
            align="start"
          >
            <p>{t("workout.weeklyVolumeDescription")}</p>
          </HelpPopover>
          <VolumeViewControls className="ms-auto" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {perGroup.length === 0 ? (
          <EmptyState icon={BicepsFlexed}>{t("workout.noVolumeDay")}</EmptyState>
        ) : (
          <>
            <ul className="divide-y">
              {perGroup.map(({ groupId, volume, sets, exercises }) => (
                <li key={groupId} className="space-y-1.5 py-2.5">
                  <div className="flex items-center gap-3 text-sm">
                    <BucketMap id={groupId} view={view} className="h-9" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate font-medium capitalize">
                          {bucketLabel(groupId, view)}
                        </span>
                        {total(volume, sets, true)}
                      </div>
                      <ShareBar value={share(volume, sets, top.volume, top.sets)} />
                    </div>
                  </div>
                  <ul className="space-y-1.5 ps-12">
                    {exercises.map(([exId, ex]) => (
                      <li key={exId} className="space-y-1 text-xs">
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate">{exerciseLabel(exId)}</span>
                          {total(ex.volume, ex.sets)}
                        </div>
                        <ShareBar value={share(ex.volume, ex.sets, volume, sets)} thin />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// An expanded bucket's period work split by exercise type: per type, the
// exercises (as a counted badge), their volume and sets. Cardio is left out.
function TypeVolumeSplit({
  exercises,
}: {
  exercises: { id: ExerciseId; volume: number; sets: number }[];
}) {
  const { t } = useTranslation();
  const split = (["compound", "isolation"] as const)
    .map((type) => {
      const of = exercises.filter((e) => getExercise(e.id)?.type === type);
      return {
        type,
        count: of.length,
        volume: of.reduce((n, e) => n + e.volume, 0),
        sets: of.reduce((n, e) => n + e.sets, 0),
      };
    })
    .filter((s) => s.count > 0);
  if (split.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {split.map((s) => (
        <div key={s.type} className="space-y-1 rounded-md bg-muted/50 px-2 py-1.5">
          <ExerciseTypeBadge type={s.type} count={s.count} />
          <div className="text-xs text-muted-foreground tabular-nums">
            {s.volume > 0 && (
              <span className="font-medium text-foreground">
                {Math.round(s.volume).toLocaleString()} kg ·{" "}
              </span>
            )}
            {t("workout.setsShort", { count: s.sets })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Horizontal fill bar for a row's share (0–1) of its comparison total.
function ShareBar({ value, thin = false }: { value: number; thin?: boolean }) {
  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-muted", thin ? "h-1" : "h-1.5")}>
      <div
        className={cn("h-full rounded-full", thin ? "bg-primary/60" : "bg-primary")}
        style={{ width: `${Math.min(100, Math.max(value > 0 ? 2 : 0, value * 100))}%` }}
      />
    </div>
  );
}

// Per-row bar chart: one slot per week of the period, so every row shares the
// same x-axis; an untrained week is a faint baseline stub. Each bar's height
// is the group's value that week relative to that group's own max.
// Cross-row comparisons happen via the period total on the right — not bar
// height — because a chest day dwarfs a biceps day and would flatten smaller
// groups if normalised globally.
function VolumeSparkline({
  series,
  metric,
  height = 28,
}: {
  series: WeekSlot[];
  metric: VolumeMetric;
  height?: number;
}) {
  const { t } = useTranslation();
  if (series.length === 0) {
    return <span className="text-xs text-muted-foreground">{t("workout.noData")}</span>;
  }
  const w = 200;
  const h = height;
  const max = Math.max(...series.map((s) => metricValue(s.point, metric)), 1);
  const barWidth = w / series.length;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      width="100%"
      height={h}
      className="text-primary"
    >
      {series.map((s, i) => {
        const value = metricValue(s.point, metric);
        const barH = s.point ? Math.max(1, (value / max) * h) : 1;
        return (
          <rect
            key={s.week}
            x={i * barWidth + 0.5}
            y={h - barH}
            width={Math.max(1, barWidth - 1)}
            height={barH}
            fill="currentColor"
            opacity={s.point ? 0.85 : 0.2}
          >
            <title>
              {t("workout.weekOf", { date: isoToDisplay(s.week) })}:{" "}
              {s.point ? formatMetric(value, metric, t) : t("workout.noTrainingWeek")}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
