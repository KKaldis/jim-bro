// Body → Measurements: tape girths over time and how they compare to the
// ideal proportions for the user's frame (wrist).
//
// Muscle girths (shoulders, chest, arm, forearm, thigh, calf) live on a
// per-day measuring session. Waist / neck / hip are shared with Composition:
// they're stored on the day's weigh-in, where they also drive the Navy BF%
// estimate, and the server's log_measurements path writes them there. This
// view reads both through /progress/measurements, already merged per day.
import { Suspense, lazy, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Ruler, Scale, ScanLine, Trash2, UserRound } from "lucide-react";
import { type IdealProportionsResult, PROPORTION_PARTS, type ProportionPart } from "@fa/shared";
import { EmptyState } from "@/components/EmptyState";
import { averageCap, ChartColorMenu, ChartControls, fitAverage } from "@/components/SpacingToggle";
import {
  deleteMeasurementsDate,
  putMeasurementsDate,
  useGetProgressBody,
  useGetProgressMeasurements,
} from "./api/endpoints/default/default";
import type { MeasurementDay, ProgressMeasurementsResponse } from "./api/model";
import { ProportionsBody, ProportionsFocus, ProportionsStats } from "./cards/bodyCards";
import { gaugeColorScale, gaugeRange, MetricGauge, proportionKind } from "./lib/metricGauge";
import { FeatureLock, useFeature } from "./lib/features";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Button, buttonVariants } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { type ChartPoint, type ColorScale, remapColorScale } from "./components/chart";
import { type ChartSelection, SeriesCard } from "./components/SeriesCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { DateTimePicker } from "./components/ui/date-picker";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import { FlexLoader } from "./components/FlexLoader";
import { clipToData } from "./dateRange.ts";
import { exportChartsPdf, trendStat } from "./export/chartsPdf";
import { runExport } from "./export/printDoc";
import { ProportionsBlock } from "./export/progressReport";
import { Field, SectionLabel, UnitInput } from "./forms/formKit";
import { invalidateFormContext, useFormContext } from "./forms/formContext";
import { apiErr } from "./lib/apiErr";
import { formatTime24, isoToDisplay } from "./lib/dateFormat";
import { useDayContext } from "./lib/dayContext";
import { useDateRange } from "./lib/useDateRange.ts";
import { useMinLoading } from "./lib/useMinLoading";
import { useUiStore } from "./lib/uiStore";
import { cn } from "./lib/utils";
import { RangeNav } from "./RangeNav.tsx";

// Parts stored on the weigh-in rather than the measuring session.
const WEIGH_IN_PARTS: ReadonlySet<ProportionPart> = new Set(["waist", "neck", "hips"]);
const MUSCLE_PARTS = PROPORTION_PARTS.filter((p) => !WEIGH_IN_PARTS.has(p));
const WEIGH_IN_ORDER: ProportionPart[] = ["waist", "neck", "hips"];

// The API's field for a part: hips is `hip_cm`, the weigh-in's column name.
type GirthKey = Exclude<
  keyof MeasurementDay,
  "date" | "notes" | "has_session" | "weigh_in_id" | "logged_at" | "time"
>;
function girthKey(p: ProportionPart): GirthKey {
  return (p === "hips" ? "hip_cm" : `${p}_cm`) as GirthKey;
}

// Measuring instructions, reused from the calculators' girth fields.
const HINT_KEY: Record<ProportionPart, string> = {
  shoulders: "shoulders",
  chest: "chest",
  arm: "armFlexed",
  forearm: "forearm",
  neck: "neck",
  waist: "waistNavy",
  hips: "hip",
  thigh: "thigh",
  calf: "calf",
};

function usePartLabel() {
  const { t } = useTranslation();
  return (p: ProportionPart) =>
    p === "arm" ? t("calculators.fields.armFlexed") : t(`cards.proportions.parts.${p}`);
}

function fmtCm(v: number): string {
  return `${v.toFixed(1)} cm`;
}

// The body scanner pulls in MediaPipe (~150 KB of JS, plus ~34 MB of models
// it caches on first use), so its chunk only loads when the scanner opens.
const PhysiqueScanner = lazy(() =>
  import("./physique/PhysiqueScanner.tsx").then((m) => ({ default: m.PhysiqueScanner })),
);

function ScannerChunkFallback() {
  const { t } = useTranslation();
  return createPortal(
    <div className="fixed inset-0 z-100 flex flex-col items-center justify-center gap-3 bg-black text-white">
      <FlexLoader className="size-12 text-white" />
      <p className="text-sm text-white/80">{t("physique.loading.chunk")}</p>
    </div>,
    document.body,
  );
}

export function MeasurementsSection() {
  const { t } = useTranslation();
  const granularity = useUiStore((s) => s.bodyGranularity);
  const setGranularity = useUiStore((s) => s.setBodyGranularity);
  const { selectedDate, selectedDateIso, todayIso, setSelectedDate } = useDayContext();
  const isFutureDay = selectedDateIso > todayIso;
  const { range, customRange, setCustomRange } = useDateRange(granularity, selectedDate);

  const queryClient = useQueryClient();
  const q = useGetProgressMeasurements({ from: range.from, to: range.to });
  const data = (q.data as unknown as ProgressMeasurementsResponse | undefined) ?? null;
  const err = q.error ? apiErr(q.error) : null;
  const showLoader = useMinLoading(q.isPending);
  // The day whose session is open in the editor (null = closed).
  const [editDate, setEditDate] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // The scan scales every centimetre from the profile height; wrist/ankle and
  // the last weigh-in refine body fat and the frame-potential ranking.
  const { ctx: formCtx } = useFormContext();
  const canScan = useFeature("silhouette_scan");

  const onChanged = () => {
    // The weigh-in may have changed too (waist / neck / hip), so drop the
    // gate-form prefill cache along with every query.
    invalidateFormContext();
    void queryClient.invalidateQueries();
  };

  return (
    <>
      <RangeNav
        granularity={granularity}
        anchor={selectedDate}
        onGranularity={setGranularity}
        onAnchor={setSelectedDate}
        customRange={customRange}
        onCustomRange={setCustomRange}
        dataFrom={data?.entries[0]?.date ?? null}
      />
      {/* Two ways in: tape by hand, or the photo silhouette scanner (both
          always on; the FeatureLock stays in case an extension locks it). */}
      <div className={cn("grid gap-2", granularity === "day" && "grid-cols-2")}>
        {granularity === "day" && (
          <Button
            onClick={() => setEditDate(selectedDateIso)}
            disabled={isFutureDay}
            title={isFutureDay ? t("body.measurements.cantLogFuture") : undefined}
            className="w-full gap-1"
          >
            <Plus className="size-4" /> {t("body.measurements.log")}
          </Button>
        )}
        <FeatureLock name="silhouette_scan" badgeClassName="-top-2 -end-1">
          <Button
            variant="outline"
            // Re-checked here: FeatureLock renders unlocked while entitlements
            // load, and a free user mustn't slip in during that window.
            onClick={() => canScan && setScanning(true)}
            className="w-full gap-1"
          >
            <ScanLine className="size-4" /> {t("physique.entry")}
            <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
              {t("physique.beta")}
            </span>
          </Button>
        </FeatureLock>
      </div>
      {scanning && (
        <Suspense fallback={<ScannerChunkFallback />}>
          <PhysiqueScanner
            onClose={() => setScanning(false)}
            subject={{
              sex: formCtx.profile?.sex ?? null,
              heightCm: formCtx.profile?.height_cm ?? null,
              weightKg: formCtx.lastBodyComp?.weight_kg ?? null,
              bodyFatPct: formCtx.lastBodyComp?.body_fat_pct ?? null,
              wristCm: formCtx.profile?.wrist_cm ?? null,
              ankleCm: formCtx.profile?.ankle_cm ?? null,
            }}
          />
        </Suspense>
      )}
      {showLoader && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {data && !showLoader && (
        <MeasurementsContent data={data} onEdit={setEditDate} onChanged={onChanged} />
      )}
      {editDate && data && (
        <MeasurementsDialog
          date={editDate}
          day={data.entries.find((e) => e.date === editDate)}
          latest={data.latest}
          onClose={() => setEditDate(null)}
          onSaved={() => {
            setEditDate(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function MeasurementsContent({
  data,
  onEdit,
  onChanged,
}: {
  data: ProgressMeasurementsResponse;
  onEdit: (date: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const granularity = useUiStore((s) => s.bodyGranularity);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteMeasurementsDate(pendingDelete);
      setPendingDelete(null);
      onChanged();
    } catch (e) {
      setDeleteErr(apiErr(e));
    } finally {
      setDeleting(false);
    }
  };

  const hasAny = Object.keys(data.latest).length > 0;
  if (!hasAny) {
    return <EmptyState icon={Ruler}>{t("body.measurements.empty")}</EmptyState>;
  }

  const day = granularity === "day" ? data.entries[0] : undefined;
  const actions = (date: string, hasSession: boolean) => (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 [&_svg]:size-3.5"
        aria-label={t("body.measurements.edit")}
        title={t("body.measurements.edit")}
        onClick={() => onEdit(date)}
      >
        <Pencil />
      </Button>
      {hasSession && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-destructive hover:text-destructive [&_svg]:size-3.5"
          aria-label={t("body.measurements.delete")}
          title={t("body.measurements.delete")}
          onClick={() => {
            setDeleteErr(null);
            setPendingDelete(date);
          }}
        >
          <Trash2 />
        </Button>
      )}
    </>
  );

  return (
    <>
      <ProportionsPanel data={data} />
      {deleteErr && <p className="text-sm text-destructive">{deleteErr}</p>}
      {granularity === "day" ? (
        <DayCard day={day} proportions={data.proportions} actions={actions} />
      ) : (
        <>
          <CurrentCard data={data} />
          <SeriesCharts data={data} actions={actions} />
        </>
      )}

      <AlertDialog open={pendingDelete != null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("body.measurements.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? t("body.measurements.deleteBody", { date: isoToDisplay(pendingDelete) })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(ev) => {
                ev.preventDefault();
                void handleDelete();
              }}
              disabled={deleting}
              className={buttonVariants({ variant: "destructive" })}
            >
              {deleting ? t("body.deleting") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Without sex + wrist on the profile there are no ideals to compare against,
// so the radar is replaced by a nudge to fill them in.
function ProportionsPanel({ data }: { data: ProgressMeasurementsResponse }) {
  const { t } = useTranslation();
  const requestProfile = useUiStore((s) => s.requestProfile);
  if (data.proportions) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
      <span className="flex-1">
        {data.sex ? t("body.measurements.needWrist") : t("body.measurements.needSexWrist")}
      </span>
      <Button type="button" size="sm" variant="outline" className="gap-1" onClick={requestProfile}>
        <UserRound className="size-3.5" /> {t("body.measurements.openProfile")}
      </Button>
    </div>
  );
}

type Proportions = ProgressMeasurementsResponse["proportions"];

// A part's % of its ideal and its ideal girth, from the proportions result.
function proportionRow(proportions: Proportions, p: ProportionPart) {
  const rows = proportions?.rows;
  const r = Array.isArray(rows)
    ? (rows as Array<Record<string, unknown>>).find((x) => x?.part === p)
    : undefined;
  return {
    pct: typeof r?.pct_of_ideal === "number" ? r.pct_of_ideal : null,
    ideal: typeof r?.ideal_cm === "number" ? r.ideal_cm : null,
  };
}

// Where each tile sits in the U around the radar (md and up): upper body
// down the left and right sides, legs along the bottom. Literal class names
// so Tailwind keeps them.
const U_SLOT: Record<ProportionPart, string> = {
  shoulders: "md:col-start-1 md:row-start-1",
  chest: "md:col-start-1 md:row-start-2",
  arm: "md:col-start-1 md:row-start-3",
  forearm: "md:col-start-3 md:row-start-1",
  neck: "md:col-start-3 md:row-start-2",
  waist: "md:col-start-3 md:row-start-3",
  hips: "md:col-start-1 md:row-start-4",
  thigh: "md:col-start-2 md:row-start-4",
  calf: "md:col-start-3 md:row-start-4",
};
const U_ORDER: ProportionPart[] = [
  "shoulders",
  "chest",
  "arm",
  "forearm",
  "neck",
  "waist",
  "hips",
  "thigh",
  "calf",
];

// The part tiles in a U with the proportions radar (the compute_ideal_proportions
// card's body, without its part table and source note) in the middle, and the
// focus chips underneath. On phones the radar comes first and the tiles follow
// two per row; without proportions it's a plain tile grid.
function PartsLayout({
  proportions,
  tile,
  footer,
}: {
  proportions: Proportions;
  tile: (p: ProportionPart) => React.ReactNode;
  footer?: React.ReactNode;
}) {
  const tint = useUiStore((s) => s.bodyChartColor) === "scale";
  if (!proportions) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{U_ORDER.map(tile)}</div>
        {footer}
      </div>
    );
  }
  const priorities = proportions.priorities;
  const hasFocus = Array.isArray(priorities) && priorities.length > 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[1fr_minmax(0,1.6fr)_1fr]">
        <div className="col-span-2 min-w-0 md:col-span-1 md:col-start-2 md:row-span-3 md:row-start-1 md:self-center">
          <ProportionsStats data={proportions} className="mb-1" />
          <ProportionsBody
            data={proportions}
            focusChips={false}
            notes={false}
            radarLabelsInside
            stats={false}
            tint={tint}
          />
        </div>
        {U_ORDER.map((p) => (
          <div key={p} className={cn("min-w-0", U_SLOT[p])}>
            {tile(p)}
          </div>
        ))}
        {/* Phones: nine tiles two-up leave a gap, so the focus chips sit in
            that slot (unboxed). Wider screens show them under the U instead. */}
        {hasFocus && (
          <div className="flex min-w-0 items-start md:hidden">
            <ProportionsFocus data={proportions} />
          </div>
        )}
      </div>
      <ProportionsFocus data={proportions} className="hidden md:flex" />
      {footer}
    </div>
  );
}

// A girth in cm ↔ its % of ideal (computeIdealProportions' pct_of_ideal). The
// waist's % is inverted (ideal / actual, capped at 100), so it runs downward.
function cmToPct(p: ProportionPart, ideal: number, cm: number): number {
  return p === "waist" ? Math.min(100, (ideal / cm) * 100) : (cm / ideal) * 100;
}
function pctToCm(p: ProportionPart, ideal: number, pct: number): number {
  return p === "waist" ? (ideal * 100) / pct : (pct * ideal) / 100;
}

// One part, styled like the Composition summary stats: value, change across
// the range, and a gauge of how close it is to its ideal (the exact ideal girth
// is in the radar's tooltip), labelled in cm at both ends.
function PartTile({
  part,
  value,
  change,
  proportions,
}: {
  part: ProportionPart;
  value: number | null | undefined;
  change: number | null;
  proportions: Proportions;
}) {
  const { t } = useTranslation();
  const partLabel = usePartLabel();
  const { pct, ideal } = proportionRow(proportions, part);
  const range = gaugeRange(proportionKind(part));
  const ends: [string, string] | null =
    range && ideal != null
      ? [pctToCm(part, ideal, range.min).toFixed(0), pctToCm(part, ideal, range.max).toFixed(0)]
      : null;
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-edge bg-card p-3 shadow-tile">
      <div className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {partLabel(part)}
        {WEIGH_IN_PARTS.has(part) && (
          <Scale className="size-3" aria-label={t("body.measurements.fromWeighIn")} />
        )}
      </div>
      <div className="text-sm font-medium tabular-nums">{value != null ? fmtCm(value) : "—"}</div>
      {/* No change line on waist / neck. Growth reads as progress on the
          muscle girths only. */}
      {change != null && change !== 0 && part !== "waist" && part !== "neck" && (
        <div
          className={cn(
            "text-[11px] tabular-nums",
            change > 0 ? "text-success" : "text-muted-foreground",
          )}
        >
          {change > 0 ? "+" : ""}
          {change.toFixed(1)} cm
        </div>
      )}
      {value != null && <MetricGauge kind={proportionKind(part)} value={pct} ends={ends} />}
    </div>
  );
}

// First and last value of a part within the range, for the change line.
function partSpan(entries: MeasurementDay[], p: ProportionPart) {
  const vs = entries.map((e) => e[girthKey(p)]).filter((v): v is number => v != null);
  return vs.length >= 2 ? { first: vs[0], last: vs[vs.length - 1] } : null;
}

// Newest value of every part (as of the range end) and its change across the
// range. Waist / neck / hip are marked as coming from the weigh-ins.
function CurrentCard({ data }: { data: ProgressMeasurementsResponse }) {
  const { t } = useTranslation();
  const chartColor = useUiStore((s) => s.bodyChartColor);
  const setChartColor = useUiStore((s) => s.setBodyChartColor);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{t("body.measurements.current")}</CardTitle>
        {/* Only the radar changes color; without proportions there's none. */}
        {data.proportions && <ChartColorMenu color={chartColor} onColor={setChartColor} />}
      </CardHeader>
      <CardContent>
        <PartsLayout
          proportions={data.proportions}
          tile={(p) => {
            const span = partSpan(data.entries, p);
            return (
              <PartTile
                key={p}
                part={p}
                value={data.latest[p]}
                change={span ? span.last - span.first : null}
                proportions={data.proportions}
              />
            );
          }}
        />
      </CardContent>
    </Card>
  );
}

// Chart order: the V-taper trio first, then the rest top to bottom.
const CHART_ORDER: ProportionPart[] = [
  "shoulders",
  "chest",
  "waist",
  "arm",
  "forearm",
  "neck",
  "hips",
  "thigh",
  "calf",
];

// One chart per part that has data in the range. They share one selection, so
// tapping a reading opens that day's tooltip on every chart; only the tapped
// chart carries the edit / delete controls.
function SeriesCharts({
  data,
  actions,
}: {
  data: ProgressMeasurementsResponse;
  actions: (date: string, hasSession: boolean) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const partLabel = usePartLabel();
  const granularity = useUiStore((s) => s.bodyGranularity);
  const spacing = useUiStore((s) => s.bodyChartSpacing);
  const setSpacing = useUiStore((s) => s.setBodyChartSpacing);
  const averageDays = useUiStore((s) => s.bodyChartAverage);
  const setAverageDays = useUiStore((s) => s.setBodyChartAverage);
  const chartColor = useUiStore((s) => s.bodyChartColor);
  const setChartColor = useUiStore((s) => s.setBodyChartColor);
  const [selection, setSelection] = useState<ChartSelection | null>(null);
  const withData = CHART_ORDER.filter((p) => data.entries.some((e) => e[girthKey(p)] != null));
  if (withData.length === 0) return null;

  // Same axis rule as the Composition charts (see Body.tsx).
  const window = clipToData(
    { from: data.from, to: data.to, label: "" },
    granularity,
    data.entries[0]?.date ?? null,
  );
  const axis = spacing === "date" ? window : null;
  const avgCap = averageCap({
    granularity,
    from: window.from,
    to: window.to,
  });
  const average = fitAverage(averageDays, avgCap);
  // Each part's ideal girth as a dashed baseline (none without proportions).
  const idealLine = (p: ProportionPart) => {
    const { ideal } = proportionRow(data.proportions, p);
    return ideal == null
      ? null
      : { value: ideal, label: t("body.measurements.idealLine", { value: ideal.toFixed(1) }) };
  };
  // The tile gauges' bands, converted from % of ideal into cm.
  const girthColors = (p: ProportionPart): ColorScale | null => {
    const { ideal } = proportionRow(data.proportions, p);
    if (chartColor !== "scale" || ideal == null) return null;
    return remapColorScale(
      gaugeColorScale(proportionKind(p))!,
      (v) => cmToPct(p, ideal, v),
      (pct) => pctToCm(p, ideal, pct),
    );
  };
  const pointsFor = (p: ProportionPart) =>
    data.entries.flatMap((e) => {
      const v = e[girthKey(p)];
      return v == null ? [] : [{ date: e.date, value: v }];
    });
  // One measuring day per date, so the date is the shared point key.
  const pointActions = (pt: ChartPoint) => {
    const e = data.entries.find((x) => x.date === pt.date);
    return e ? actions(e.date, e.has_session) : null;
  };

  return (
    <>
      <ChartControls
        average={average}
        cap={avgCap}
        onAverage={setAverageDays}
        spacing={spacing}
        onSpacing={setSpacing}
        color={chartColor}
        onColor={setChartColor}
        // PDF of these charts as shown: same window, average, spacing and
        // ideal-girth lines.
        onExport={() =>
          void runExport(() =>
            exportChartsPdf({
              title: t("export.report.sections.measurements"),
              period: window,
              view: { average, spacing },
              // The ideal-proportions radar, score and table, as in the report.
              top: data.proportions && (
                <ProportionsBlock
                  data={data.proportions as unknown as IdealProportionsResult}
                  measuredOn={Object.fromEntries(
                    withData.flatMap((p) => {
                      const pts = pointsFor(p);
                      return pts.length ? [[p, isoToDisplay(pts[pts.length - 1].date)]] : [];
                    }),
                  )}
                />
              ),
              stats: withData.map((p) => trendStat(partLabel(p), pointsFor(p), 1, "cm")),
              charts: withData.map((p) => ({
                title: partLabel(p),
                points: pointsFor(p),
                unit: "cm",
                reference: idealLine(p),
              })),
            }),
          )
        }
      />
      {withData.map((p) => (
        <SeriesCard
          key={p}
          id={p}
          title={partLabel(p)}
          points={pointsFor(p)}
          unit="cm"
          from={axis?.from}
          to={axis?.to}
          selection={selection}
          onSelect={setSelection}
          actions={pointActions}
          reference={idealLine(p)}
          average={average}
          colorScale={girthColors(p)}
        />
      ))}
    </>
  );
}

// Day view: every part on that day, muscle girths first, then the weigh-in's.
function DayCard({
  day,
  proportions,
  actions,
}: {
  day: MeasurementDay | undefined;
  proportions: Proportions;
  actions: (date: string, hasSession: boolean) => React.ReactNode;
}) {
  const { t } = useTranslation();
  if (!day) {
    return <EmptyState icon={Ruler}>{t("body.measurements.noneThisDay")}</EmptyState>;
  }
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>
          {dayTime(day)
            ? t("body.measurements.dayTitleAt", { time: dayTime(day) })
            : t("body.measurements.dayTitle")}
        </CardTitle>
        <div className="flex items-center">{actions(day.date, day.has_session)}</div>
      </CardHeader>
      <CardContent>
        <PartsLayout
          proportions={proportions}
          tile={(p) => (
            <PartTile
              key={p}
              part={p}
              value={day[girthKey(p)]}
              change={null}
              proportions={proportions}
            />
          )}
          footer={day.notes && <p className="text-xs text-muted-foreground">{day.notes}</p>}
        />
      </CardContent>
    </Card>
  );
}

// The day's HH:MM: the user-picked time, else when it was logged (older
// rows predate the time field).
function dayTime(day: MeasurementDay): string {
  return day.time ?? formatTime24(day.logged_at);
}

type Draft = Partial<Record<ProportionPart, number>>;

// Create or edit the day's session. Waist / neck / hip are sent only when
// changed, so saving arm girths never rewrites (or recomputes) the weigh-in.
// With no weigh-in that day, entering one of them asks for a weight, since
// they're stored on the weigh-in.
function MeasurementsDialog({
  date,
  day,
  latest,
  onClose,
  onSaved,
}: {
  date: string;
  day: MeasurementDay | undefined;
  latest: Record<string, number>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const partLabel = usePartLabel();
  const initial: Draft = {};
  for (const p of PROPORTION_PARTS) {
    const v = day?.[girthKey(p)];
    if (v != null) initial[p] = v;
  }
  const [draft, setDraft] = useState<Draft>(initial);
  const [notes, setNotes] = useState(day?.notes ?? "");
  // Date defaults to the day in view, time to the day's own (or now for a new
  // session). Moving the date re-saves the session there; see onSubmit.
  const [logDate, setLogDate] = useState(date);
  const [time, setTime] = useState(() => (day ? dayTime(day) : "") || formatTime24(new Date()));
  const moved = logDate !== date;
  const [weight, setWeight] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Whether the day already has a weigh-in to carry waist / neck / hip — it
  // may have one without any girths, which the measurements data wouldn't show.
  const weighInQ = useGetProgressBody({ from: logDate, to: logDate });
  const weighInCount = (weighInQ.data as unknown as { entries?: unknown[] } | undefined)?.entries
    ?.length;
  const hasWeighIn = (!moved && day?.weigh_in_id != null) || (weighInCount ?? 0) > 0;
  // A moved session carries every filled waist / neck / hip to the new day's
  // weigh-in; otherwise only the changed ones are sent.
  const changedShared = WEIGH_IN_ORDER.filter((p) =>
    moved ? draft[p] != null : draft[p] !== initial[p],
  );
  const needsWeight =
    !hasWeighIn && weighInQ.isSuccess && WEIGH_IN_ORDER.some((p) => draft[p] != null);

  const onSubmit = async () => {
    if (needsWeight && weight == null) {
      setErr(t("body.measurements.weightRequired"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, number | string | null> = { notes, time: time || null };
      for (const p of MUSCLE_PARTS) body[girthKey(p)] = draft[p] ?? null;
      for (const p of changedShared) body[girthKey(p)] = draft[p] ?? null;
      if (needsWeight && weight != null) body.weight_kg = weight;
      await putMeasurementsDate(logDate, body);
      // Moving the date: drop the old day's session. Its weigh-in (and the
      // waist / neck / hip on it) belongs to Composition and stays.
      if (moved && day?.has_session) await deleteMeasurementsDate(date);
      onSaved();
    } catch (ex) {
      setErr(apiErr(ex));
    } finally {
      setBusy(false);
    }
  };

  const field = (p: ProportionPart) => (
    <Field
      key={p}
      label={partLabel(p)}
      optional
      info={t(`calculators.info.${HINT_KEY[p]}`)}
      hint={
        draft[p] == null && latest[p] != null
          ? t("body.measurements.last", { value: latest[p].toFixed(1) })
          : undefined
      }
    >
      <UnitInput
        suffix="cm"
        value={draft[p] ?? ""}
        disabled={busy}
        min={5}
        max={300}
        step="any"
        onChange={(n) =>
          setDraft((d) => {
            const next = { ...d };
            if (n == null) delete next[p];
            else next[p] = n;
            return next;
          })
        }
      />
    </Field>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="modal-cap overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("body.measurements.dialogTitle", { date: isoToDisplay(date) })}
          </DialogTitle>
          <DialogDescription>{t("body.measurements.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <Field label={t("body.measurements.dateTime")} className="sm:max-w-60">
            <DateTimePicker
              date={logDate}
              time={time}
              disabled={busy}
              onChange={(d, tm) => {
                if (d) setLogDate(d);
                setTime(tm);
              }}
            />
          </Field>
          <section className="space-y-3">
            <SectionLabel Icon={Ruler}>{t("body.measurements.muscleSection")}</SectionLabel>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{MUSCLE_PARTS.map(field)}</div>
          </section>
          <section className="space-y-3">
            <SectionLabel Icon={Scale} info={t("body.measurements.sharedInfo")}>
              {t("body.measurements.sharedSection")}
            </SectionLabel>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {WEIGH_IN_ORDER.map(field)}
              {needsWeight && (
                <Field
                  label={
                    <>
                      {t("calculators.fields.weight")}
                      <span className="text-destructive"> *</span>
                    </>
                  }
                  info={t("body.measurements.weightInfo")}
                >
                  <UnitInput
                    suffix="kg"
                    value={weight ?? ""}
                    disabled={busy}
                    min={20}
                    max={400}
                    step="any"
                    onChange={setWeight}
                  />
                </Field>
              )}
            </div>
          </section>
          <Field label={t("body.measurements.notes")} optional>
            <Input value={notes} disabled={busy} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void onSubmit()} disabled={busy}>
            {busy ? t("common.saving") : t("body.measurements.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
