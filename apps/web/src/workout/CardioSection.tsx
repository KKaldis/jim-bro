// Workout → Progress → cardio fitness: VO₂max log, edit dialog and result view.
import { EmptyState } from "@/components/EmptyState";
import { averageCap, ChartControls, fitAverage } from "@/components/SpacingToggle";
import {
  ageFromBirthYear,
  type CardioEntry,
  computeVo2Max,
  type Profile,
  type Sex,
  type Vo2MaxCategory,
  vo2MaxReference,
  type Vo2MaxResult,
} from "@fa/shared";
import { CardioLogRequest } from "@fa/shared/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, HeartPulse, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  deleteCardioEntryId,
  postCardio,
  useGetProgressCardio,
} from "../api/endpoints/default/default";
import { HelpPopover } from "../components/HelpPopover";
import { type ChartPoint, pointKey } from "../components/chart";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DatePicker } from "../components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { fromIso, type Granularity } from "../dateRange";
import { exportChartsPdf, trendStat } from "../export/chartsPdf";
import { runExport } from "../export/printDoc";
import { apiErr } from "../lib/apiErr";
import { isoToDisplay } from "../lib/dateFormat";
import { useDayContext, useDaySnapshot } from "../lib/dayContext";
import { runTool } from "../lib/runTool";
import { useUiStore } from "../lib/uiStore";
import { cn } from "../lib/utils";
import { ChartBlock } from "./ProgressTab";

// Per-category chrome for the VO₂max fitness label + reference scale.
const VO2_CATEGORY_META: Record<Vo2MaxCategory, { label: string; badge: string; bar: string }> = {
  poor: {
    label: "Poor",
    badge:
      "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
    bar: "bg-rose-400 dark:bg-rose-600",
  },
  fair: {
    label: "Fair",
    badge:
      "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
    bar: "bg-amber-400 dark:bg-amber-600",
  },
  good: {
    label: "Good",
    badge:
      "border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
    bar: "bg-sky-400 dark:bg-sky-600",
  },
  excellent: {
    label: "Excellent",
    badge:
      "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    bar: "bg-emerald-400 dark:bg-emerald-600",
  },
  superior: {
    label: "Superior",
    badge:
      "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
    bar: "bg-violet-400 dark:bg-violet-600",
  },
};

function vo2CategoryMeta(category: Vo2MaxCategory | null | undefined) {
  return category ? VO2_CATEGORY_META[category] : null;
}

// VO₂max — aerobic / cardio fitness — derived from a resting (and optional max)
// heart rate plus the profile's age + sex. Readings are PERSISTED (cardio_entry
// table) via POST /cardio so the estimate can be tracked over time; the form
// also shows a live client-side preview using the same @fa/shared formula the
// server and chat agent use.
//
// Honours the Progress tab's day/week/month toggle: a single-day view shows
// just the reading(s), while week/month views add the VO₂max + resting-HR
// trend charts (a one-point chart on a single day isn't worth drawing).
export function CardioFitnessSection({
  granularity,
  range,
}: {
  granularity: Granularity;
  range: { from: string; to: string };
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const dateIso = useUiStore((s) => s.selectedDateIso);
  const { data } = useDaySnapshot(dateIso);
  const profile = (data?.profile as Profile | undefined) ?? null;

  const sex: Sex | null = profile?.sex === "male" || profile?.sex === "female" ? profile.sex : null;
  const age = profile?.birth_year != null ? ageFromBirthYear(profile.birth_year) : null;
  const profileReady = sex != null && age != null;

  // Charts only make sense across a multi-day window.
  const showCharts = granularity !== "day";
  const cardioQ = useGetProgressCardio({ from: range.from, to: range.to });
  const entries = (cardioQ.data?.entries as unknown as CardioEntry[] | undefined) ?? null;
  const fetchErr = cardioQ.error ? apiErr(cardioQ.error) : null;
  const spacing = useUiStore((s) => s.workoutChartSpacing);
  const setSpacing = useUiStore((s) => s.setWorkoutChartSpacing);
  const averageDays = useUiStore((s) => s.workoutChartAverage);
  const setAverageDays = useUiStore((s) => s.setWorkoutChartAverage);
  const axis = spacing === "date" ? range : null;
  const avgCap = averageCap({
    granularity,
    from: range.from,
    to: range.to,
  });
  const average = fitAverage(averageDays, avgCap);

  const [restingText, setRestingText] = useState("");
  const [maxText, setMaxText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const parseField = (t: string): number | null => {
    const trimmed = t.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };
  const resting = parseField(restingText);
  const max = parseField(maxText);

  // Live preview of what would be saved — same formula the server applies.
  let preview: Vo2MaxResult | null = null;
  let previewErr: string | null = null;
  if (profileReady && resting != null) {
    try {
      preview = computeVo2Max({
        sex: sex as Sex,
        age: age as number,
        resting_heart_rate: resting,
        max_heart_rate: max,
      });
    } catch (e) {
      previewErr = e instanceof Error ? e.message : String(e);
    }
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/progress/cardio"] });

  async function onSave() {
    if (resting == null || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await postCardio(
        CardioLogRequest.parse({
          // The form only shows in the day view, where the range is that one
          // day. Without it the server stamps its own "today", so a reading
          // logged while viewing another day landed on the wrong date.
          date: range.from,
          resting_heart_rate: resting,
          ...(max != null ? { max_heart_rate: max } : {}),
        }),
      );
      setRestingText("");
      setMaxText("");
      await refresh();
    } catch (e) {
      setSaveErr(apiErr(e));
    } finally {
      setSaving(false);
    }
  }

  // The tapped reading, shared by both charts so one tap opens its tooltip on
  // each; only the chart that was tapped offers edit / delete — same flow as a
  // weigh-in on the Body charts. Keyed by row id since a day can hold more than
  // one reading.
  const [selection, setSelection] = useState<{ chart: string; key: string } | null>(null);
  const setGranularity = useUiStore((s) => s.setWorkoutGranularity);
  const { setSelectedDate } = useDayContext();
  // A day averaged from several readings: open it in the day view, whose list
  // has each reading's own edit / delete.
  const goToDay = (iso: string) => {
    setSelection(null);
    setSelectedDate(fromIso(iso));
    setGranularity("day");
  };
  const [editEntry, setEditEntry] = useState<CardioEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CardioEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  async function onDelete() {
    if (pendingDelete?.id == null) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteCardioEntryId(pendingDelete.id);
      setPendingDelete(null);
      setSelection(null);
      await refresh();
    } catch (e) {
      setDeleteErr(apiErr(e));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  // One reading as-is; several (same day) are averaged — VO2max and both heart
  // rates — with the category re-read from where the average falls in the
  // age/sex reference bands. Drives the day view's summary and the one point
  // per day on the trend charts, so the two always agree.
  const summarize = (list: CardioEntry[]) => {
    if (list.length === 1) {
      const e = list[0];
      return {
        vo2Max: e.vo2_max ?? null,
        category: (e.vo2_max_category ?? null) as Vo2MaxCategory | null,
        restingHr: e.resting_heart_rate,
        maxHr: e.max_heart_rate ?? null,
        maxHrEstimated: e.max_heart_rate_estimated ?? null,
        date: e.date,
        count: 1,
      };
    }
    const mean = (xs: Array<number | null | undefined>) => {
      const ns = xs.filter((v): v is number => v != null);
      return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
    };
    const vo2Max = mean(list.map((e) => e.vo2_max));
    const resting = mean(list.map((e) => e.resting_heart_rate));
    const maxHr = mean(list.map((e) => e.max_heart_rate));
    const band =
      vo2Max != null && sex != null && age != null
        ? vo2MaxReference(sex, age).find(
            (b) => vo2Max >= b.min && (b.max == null || vo2Max < b.max),
          )
        : undefined;
    return {
      vo2Max: vo2Max != null ? Math.round(vo2Max * 10) / 10 : null,
      category: band?.category ?? null,
      restingHr: resting != null ? Math.round(resting) : null,
      maxHr: maxHr != null ? Math.round(maxHr) : null,
      maxHrEstimated: list.every((e) => e.max_heart_rate_estimated),
      date: list[0].date,
      count: list.length,
    };
  };

  // Day view: the readings that carry a VO2max, summarized.
  const dayVo2 = (() => {
    const withVo2 = (entries ?? []).filter((e) => e.vo2_max != null);
    if (withVo2.length === 0) return null;
    const sum = summarize(withVo2);
    return sum.vo2Max != null ? { ...sum, vo2Max: sum.vo2Max } : null;
  })();

  const keyOf = (e: CardioEntry, i: number) => (e.id != null ? `id-${e.id}` : `${e.date}-${i}`);
  // Trend charts: one point per day. A single reading keeps its own key, so
  // its tooltip offers edit / delete; a day with several shows their average
  // (keyed by the day, no row to act on — edit them from that day's list).
  const vo2Series: ChartPoint[] = [];
  const restingSeries: ChartPoint[] = [];
  const byDay = new Map<string, Array<{ e: CardioEntry; i: number }>>();
  entries?.forEach((e, i) => {
    const arr = byDay.get(e.date) ?? [];
    arr.push({ e, i });
    byDay.set(e.date, arr);
  });
  for (const [date, rows] of byDay) {
    const sum = summarize(rows.map((r) => r.e));
    const key = rows.length === 1 ? keyOf(rows[0].e, rows[0].i) : `day-${date}`;
    const countDetail =
      rows.length > 1 ? [{ label: t("workout.readingsLabel"), value: String(rows.length) }] : [];
    if (sum.vo2Max != null) {
      vo2Series.push({
        date,
        value: sum.vo2Max,
        key,
        detail: [
          ...countDetail,
          ...(sum.category
            ? [
                {
                  label: t("workout.categoryLabel"),
                  value: t(`workout.category.${sum.category}`),
                },
              ]
            : []),
        ],
      });
    }
    if (sum.restingHr != null) {
      restingSeries.push({
        date,
        value: sum.restingHr,
        key,
        detail: [
          ...countDetail,
          ...(sum.maxHr != null
            ? [
                {
                  label: t("workout.maxHrLabel"),
                  value: t("workout.bpmValue", { value: sum.maxHr }),
                },
              ]
            : []),
        ],
      });
    }
  }
  const chartSelect = (chart: string) => (key: string | null) => {
    // Re-tapping a point a sibling chart owns hands the controls to this chart
    // rather than dismissing it (as Body's MetricChart does).
    if (key == null && selection != null && selection.chart !== chart) {
      setSelection({ chart, key: selection.key });
      return;
    }
    setSelection(key == null ? null : { chart, key });
  };
  const pointActions = (p: ChartPoint) => {
    if (pointKey(p).startsWith("day-")) {
      return (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 [&_svg]:size-3.5"
          aria-label={t("workout.goToDay")}
          title={t("workout.goToDay")}
          onClick={() => goToDay(p.date)}
        >
          <CalendarDays />
        </Button>
      );
    }
    const entry = entries?.find((e, i) => keyOf(e, i) === pointKey(p));
    if (entry?.id == null) return null;
    return (
      <>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 [&_svg]:size-3.5"
          aria-label={t("workout.editReading")}
          title={t("workout.editReading")}
          onClick={() => setEditEntry(entry)}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-destructive hover:text-destructive [&_svg]:size-3.5"
          aria-label={t("workout.deleteReading")}
          title={t("workout.deleteReading")}
          onClick={() => {
            setDeleteErr(null);
            setPendingDelete(entry);
          }}
        >
          <Trash2 />
        </Button>
      </>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HeartPulse className="size-4 text-rose-500" />
          {t("workout.cardioFitness")}
          <HelpPopover
            label={t("workout.cardioFitnessHelpAria")}
            heading={t("workout.cardioFitness")}
            align="start"
          >
            <p>{t("workout.cardioFitnessDescription")}</p>
          </HelpPopover>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!profileReady && (
          <p className="text-sm text-muted-foreground">{t("workout.addSexBirthYear")}</p>
        )}

        {/* Latest persisted reading (headline + reference scale) — day view
            only; week/month show the trend charts instead. */}
        {!showCharts && dayVo2 && sex != null && age != null && (
          <Vo2MaxResultView
            vo2Max={dayVo2.vo2Max}
            category={dayVo2.category}
            sex={sex}
            age={age}
            restingHr={dayVo2.restingHr}
            maxHr={dayVo2.maxHr}
            maxHrEstimated={dayVo2.maxHrEstimated}
            asOf={dayVo2.date}
            averageOf={dayVo2.count > 1 ? dayVo2.count : undefined}
          />
        )}

        {/* Log a new reading — day view only; week/month are read-only trend
            views. */}
        {!showCharts && (
          <div className="space-y-2 rounded-lg border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="vo2-resting">{t("workout.restingHr")}</Label>
                <Input
                  id="vo2-resting"
                  type="number"
                  inputMode="numeric"
                  placeholder={t("workout.restingHrPlaceholder")}
                  value={restingText}
                  onChange={(e) => setRestingText(e.target.value)}
                  disabled={!profileReady || saving}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vo2-max-hr">{t("workout.maxHrOptional")}</Label>
                <Input
                  id="vo2-max-hr"
                  type="number"
                  inputMode="numeric"
                  placeholder={t("workout.maxHrPlaceholder")}
                  value={maxText}
                  onChange={(e) => setMaxText(e.target.value)}
                  disabled={!profileReady || saving}
                />
              </div>
            </div>

            {previewErr && <p className="text-sm text-destructive">{previewErr}</p>}
            {preview && (
              <p className="text-xs text-muted-foreground">
                {t("workout.estimateLabel")}{" "}
                <span className="font-medium text-foreground">
                  {t("workout.estimateValue", { value: preview.vo2_max.toFixed(1) })}
                </span>{" "}
                · {preview.category ? t(`workout.category.${preview.category}`) : preview.category}{" "}
                · {t("workout.maxHrValue", { value: preview.max_heart_rate })}
                {preview.max_heart_rate_estimated ? t("workout.fromAge") : ""}
              </p>
            )}
            {saveErr && <p className="text-sm text-destructive">{saveErr}</p>}

            <Button
              type="button"
              className="w-full"
              disabled={!profileReady || resting == null || !!previewErr || saving}
              onClick={onSave}
            >
              {saving ? t("common.saving") : t("workout.logReading")}
            </Button>
          </div>
        )}

        {fetchErr && <p className="text-sm text-destructive">{fetchErr}</p>}

        {entries != null && entries.length === 0 && (
          <EmptyState icon={HeartPulse}>
            {granularity === "day" ? t("workout.noReadingForDay") : t("workout.noReadingsInRange")}
          </EmptyState>
        )}

        {deleteErr && <p className="text-sm text-destructive">{deleteErr}</p>}
        {/* A single day has no trend to chart: list its readings instead, each
            with the same edit / delete the chart tooltips offer. */}
        {!showCharts && entries != null && entries.length > 0 && (
          <ul className="divide-y border-t">
            {entries.map((e, i) => {
              const meta = vo2CategoryMeta(e.vo2_max_category as Vo2MaxCategory | null);
              return (
                <li key={keyOf(e, i)} className="flex items-center gap-3 py-2 text-sm">
                  {/* Line 1: VO2max + resting HR. Line 2: category badge + max HR. */}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-baseline gap-3">
                      <span>
                        <span className="font-medium tabular-nums">
                          {e.vo2_max != null ? e.vo2_max.toFixed(1) : "—"}
                        </span>{" "}
                        <span className="text-xs text-muted-foreground">ml/kg/min</span>
                      </span>
                      {e.resting_heart_rate != null && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {t("workout.bpmValue", { value: e.resting_heart_rate })}
                        </span>
                      )}
                    </span>
                    {((meta && e.vo2_max_category) || e.max_heart_rate != null) && (
                      <span className="flex items-center gap-2">
                        {meta && e.vo2_max_category && (
                          <Badge variant="outline" className={cn("capitalize", meta.badge)}>
                            {t(`workout.category.${e.vo2_max_category}`)}
                          </Badge>
                        )}
                        {e.max_heart_rate != null && (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {t("workout.maxHrValue", { value: e.max_heart_rate })}
                            {e.max_heart_rate_estimated ? t("workout.fromAge") : ""}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  {e.id != null && (
                    <span className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-7 text-muted-foreground [&_svg]:size-4"
                        aria-label={t("workout.editReading")}
                        title={t("workout.editReading")}
                        onClick={() => setEditEntry(e)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-7 text-muted-foreground hover:text-destructive [&_svg]:size-4"
                        aria-label={t("workout.deleteReading")}
                        title={t("workout.deleteReading")}
                        onClick={() => {
                          setDeleteErr(null);
                          setPendingDelete(e);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {/* Tap a point for the reading's details + edit / delete — the tooltips
            replace a separate records list, as on the Body charts. */}
        {showCharts && vo2Series.length > 0 && (
          <div className="space-y-4">
            <ChartControls
              average={average}
              cap={avgCap}
              onAverage={setAverageDays}
              spacing={spacing}
              onSpacing={setSpacing}
              // PDF of these charts as shown: same window, average and spacing.
              onExport={() =>
                void runExport(() =>
                  exportChartsPdf({
                    title: t("export.report.sections.cardio"),
                    period: range,
                    view: { average, spacing },
                    stats: [
                      trendStat(t("export.report.vo2max"), vo2Series, 1),
                      trendStat(t("export.report.restingHr"), restingSeries, 0),
                    ],
                    charts: [
                      { title: t("workout.chartVo2Max"), points: vo2Series, unit: "" },
                      {
                        title: t("workout.chartRestingHr"),
                        points: restingSeries,
                        unit: "bpm",
                        digits: 0,
                      },
                    ],
                  }),
                )
              }
            />
            <ChartBlock
              title={t("workout.chartVo2Max")}
              unit={t("workout.unitVo2")}
              points={vo2Series}
              from={axis?.from}
              to={axis?.to}
              selectedKey={selection?.key ?? null}
              onSelectKey={chartSelect("vo2")}
              tooltipActions={selection?.chart === "vo2" ? pointActions : undefined}
              average={average}
            />
            {restingSeries.length > 0 && (
              <ChartBlock
                title={t("workout.chartRestingHr")}
                unit={t("workout.unitBpm")}
                points={restingSeries}
                from={axis?.from}
                to={axis?.to}
                selectedKey={selection?.key ?? null}
                onSelectKey={chartSelect("resting")}
                tooltipActions={selection?.chart === "resting" ? pointActions : undefined}
                average={average}
              />
            )}
          </div>
        )}
      </CardContent>

      {editEntry && (
        <CardioEditDialog
          entry={editEntry}
          onClose={() => setEditEntry(null)}
          onSaved={async () => {
            setEditEntry(null);
            setSelection(null);
            await refresh();
          }}
        />
      )}

      <AlertDialog open={pendingDelete != null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workout.deleteReadingTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? t("workout.deleteReadingBody", { date: isoToDisplay(pendingDelete.date) })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(ev) => {
                ev.preventDefault();
                void onDelete();
              }}
              disabled={deleting}
              className={buttonVariants({ variant: "destructive" })}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// Edit one cardio reading in place: date + resting / max heart rate. The
// server recomputes VO2max from the new heart rates.
function CardioEditDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: CardioEntry;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState(entry.date);
  const [restingText, setRestingText] = useState(
    entry.resting_heart_rate != null ? String(entry.resting_heart_rate) : "",
  );
  const [maxText, setMaxText] = useState(
    entry.max_heart_rate != null && !entry.max_heart_rate_estimated
      ? String(entry.max_heart_rate)
      : "",
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const resting = restingText.trim() === "" ? NaN : Number(restingText);
    const max = maxText.trim() === "" ? null : Number(maxText);
    if (!Number.isFinite(resting) || (max != null && !Number.isFinite(max))) {
      setErr(t("workout.readingInvalid"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // In place via update_cardio_entry: keeps the row id, recomputes
      // VO2max. An empty max HR sends 0, which clears it back to the
      // age-based estimate.
      const error = await runTool("update_cardio_entry", {
        id: entry.id,
        ...(date !== entry.date ? { date } : {}),
        resting_heart_rate: resting,
        max_heart_rate: max ?? 0,
      });
      if (error) {
        setErr(error);
        return;
      }
      await onSaved();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("workout.editReadingTitle")}</DialogTitle>
          <DialogDescription>{t("workout.editReadingDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cardio-edit-date">{t("workout.date")}</Label>
            <DatePicker
              id="cardio-edit-date"
              value={date}
              onChange={(v) => v && setDate(v)}
              disabled={busy}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cardio-edit-resting">{t("workout.restingHr")}</Label>
              <Input
                id="cardio-edit-resting"
                type="number"
                inputMode="numeric"
                value={restingText}
                onChange={(e) => setRestingText(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cardio-edit-max">{t("workout.maxHrOptional")}</Label>
              <Input
                id="cardio-edit-max"
                type="number"
                inputMode="numeric"
                placeholder={t("workout.maxHrPlaceholder")}
                value={maxText}
                onChange={(e) => setMaxText(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Exported so the chat result card for estimate_vo2_max (cards/resultCards.tsx)
// renders the identical headline + reference scale instead of a second
// hand-rolled VO₂max widget — one component, two surfaces.
export function Vo2MaxResultView({
  vo2Max,
  category,
  sex,
  age,
  restingHr,
  maxHr,
  maxHrEstimated,
  asOf,
  averageOf,
}: {
  vo2Max: number;
  category: Vo2MaxCategory | null;
  sex: Sex;
  age: number;
  restingHr: number | null;
  maxHr: number | null;
  maxHrEstimated: boolean | null;
  asOf?: string;
  // Set when the numbers are a mean over this many readings (a day with
  // several logs), so the caption says so.
  averageOf?: number;
}) {
  const { t } = useTranslation();
  const meta = vo2CategoryMeta(category);
  const bands = vo2MaxReference(sex, age);
  // Scale the reference bar to a sensible window: from the poor/fair boundary
  // down a touch, up past the superior threshold, so the marker has room.
  const lo = Math.max(0, bands[1].min - 8);
  const hi = bands[bands.length - 1].min + 12;
  const span = hi - lo;
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / span) * 100))}%`;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">{vo2Max.toFixed(1)}</span>
          <span className="text-xs text-muted-foreground">ml/kg/min</span>
        </div>
        {meta && category && (
          <Badge variant="outline" className={cn("capitalize", meta.badge)}>
            {t(`workout.category.${category}`)}
          </Badge>
        )}
      </div>

      {/* Reference scale: colored segments per category + a marker for the user. */}
      <div className="space-y-1">
        <div dir="ltr" className="relative h-2.5 w-full overflow-hidden rounded-full">
          <div className="flex size-full">
            {bands.map((b) => {
              const segHi = b.max ?? hi;
              const segLo = Math.max(b.min, lo);
              const widthPct = ((segHi - segLo) / span) * 100;
              if (widthPct <= 0) return null;
              return (
                <div
                  key={b.category}
                  className={VO2_CATEGORY_META[b.category].bar}
                  style={{ width: `${widthPct}%` }}
                />
              );
            })}
          </div>
          <div
            className="absolute top-1/2 h-4 w-1 -translate-1/2 rounded-full bg-foreground ring-2 ring-background"
            style={{ left: pct(vo2Max) }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>{t("workout.category.poor")}</span>
          <span>{t("workout.category.superior")}</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {maxHr != null && (
          <>
            {t("workout.maxHrLine", { value: maxHr })}
            {maxHrEstimated ? t("workout.estimatedFromAge") : ""}
            {restingHr != null ? " · " : ""}
          </>
        )}
        {restingHr != null && <>{t("workout.restingLine", { value: restingHr })}</>}
        {asOf ? t("workout.asOf", { date: isoToDisplay(asOf) }) : ""}
        {averageOf ? t("workout.averageOfReadings", { count: averageOf }) : ""}
      </p>
    </div>
  );
}
