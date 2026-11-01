import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarDays, type LucideIcon, Pencil, Plus, Ruler, Trash2, Scale } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { SectionSubNav } from "@/components/SectionSubNav";
import { averageCap, ChartControls, fitAverage } from "@/components/SpacingToggle";
import { MeasurementsSection } from "./BodyMeasurements.tsx";
import {
  deleteBodyEntryId,
  patchBodyDate,
  postBody,
  useGetProgressBody,
} from "./api/endpoints/default/default";
import { BodyLogRequest } from "@fa/shared/schemas";
import i18n from "./i18n";
import { apiErr } from "./lib/apiErr";
import { PageTitle } from "./lib/pageChrome";
import { RangeNav } from "./RangeNav.tsx";
import { clipToData, fromIso, type Granularity } from "./dateRange.ts";
import { exportChartsPdf, trendStat } from "./export/chartsPdf";
import { runExport } from "./export/printDoc";
import { useDateRange } from "./lib/useDateRange.ts";
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
import { type ChartPoint, pointKey, remapColorScale } from "./components/chart";
import { type ChartSelection, SeriesCard } from "./components/SeriesCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { formatTime24, isoToDisplay } from "./lib/dateFormat";
import { Skeleton } from "./components/ui/skeleton";
import { useDayContext } from "./lib/dayContext";
import { useMinLoading } from "./lib/useMinLoading";
import { type BodySection, useUiStore } from "./lib/uiStore";
import { gaugeColorScale, MetricGauge } from "./lib/metricGauge";
import { cn } from "./lib/utils";
import { LogBodyCompForm } from "./forms/LogBodyCompForm";
import { invalidateFormContext } from "./forms/formContext";

type BodyEntry = {
  id?: number;
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  body_fat_pct_navy?: number | null;
  body_fat_method?: string | null;
  waist_cm: number | null;
  neck_cm?: number | null;
  hip_cm?: number | null;
  bmi: number | null;
  ffmi: number | null;
  ffmi_normalized: number | null;
  fat_free_mass_kg: number | null;
  fat_mass_kg?: number | null;
  logged_at?: string;
  notes?: string;
  time?: string | null;
};

type Sex = "male" | "female";

type Stats = {
  first: number;
  last: number;
  min: number;
  max: number;
  change: number;
  count: number;
} | null;

type BodyResp = {
  from: string;
  to: string;
  entries: BodyEntry[];
  stats: {
    weight_kg: Stats;
    body_fat_pct: Stats;
    waist_cm: Stats;
    bmi: Stats;
    ffmi: Stats;
  };
  sex: Sex | null;
};

// Walk entries from newest to oldest to find the most recent normalized FFMI.
function latestNormFfmi(entries: BodyEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const v = entries[i].ffmi_normalized;
    if (v != null) return v;
  }
  return null;
}

// Most recent recorded weight — used as a starting value for a new entry so a
// quick weigh-in is a one-field tweak.
function latestWeight(entries: BodyEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const v = entries[i].weight_kg;
    if (v != null) return v;
  }
  return null;
}

type PointDetail = { label: string; value: string };

// Identity of one weigh-in across the charts. A date can hold more than one
// entry (delete targets a row id, not a day), so the row id is what ties a
// point in the weight chart to the same point in the BMI chart; the index is
// only a fallback for rows the API returned without one.
function entryKey(e: BodyEntry, i: number): string {
  return e.id != null ? `id:${e.id}` : `${e.date}#${i}`;
}

// Key of a chart point that averages a day's entries — no single row behind it.
const DAY_KEY_PREFIX = "day:";

// A chart series over the entries that recorded this metric, one point per day.
// A lone entry keeps its own key (and its edit / delete); a day with several is
// drawn at their average, keyed by the day, so its tooltip can only send you to
// that day's table. The key is shared across charts, so they stay in step even
// though each one skips a different set of days.
function series(
  entries: BodyEntry[],
  value: (e: BodyEntry) => number | null | undefined,
  detail?: (e: BodyEntry) => PointDetail[],
): ChartPoint[] {
  const byDay = new Map<string, Array<{ e: BodyEntry; i: number }>>();
  entries.forEach((e, i) => {
    const arr = byDay.get(e.date) ?? [];
    arr.push({ e, i });
    byDay.set(e.date, arr);
  });
  const out: ChartPoint[] = [];
  for (const [date, rows] of byDay) {
    if (rows.length === 1) {
      const { e, i } = rows[0];
      const v = value(e);
      if (v != null) out.push({ key: entryKey(e, i), date, value: v, detail: detail?.(e) });
      continue;
    }
    const vs = rows.map((r) => value(r.e)).filter((v): v is number => v != null);
    if (vs.length === 0) continue;
    out.push({
      key: `${DAY_KEY_PREFIX}${date}`,
      date,
      value: vs.reduce((a, b) => a + b, 0) / vs.length,
      detail: [{ label: i18n.t("body.detailEntriesAvg"), value: String(rows.length) }],
    });
  }
  return out;
}

// Navy BF% is estimated from circumferences, so surface those raw inputs when a
// chart point is tapped — it keeps the estimate auditable. Hip only feeds the
// female Navy formula, so it's shown for women only.
function bfSecondary(e: BodyEntry, sex: Sex | null): PointDetail[] {
  const out: PointDetail[] = [];
  if (e.weight_kg != null)
    out.push({ label: i18n.t("body.detailWeight"), value: `${e.weight_kg.toFixed(1)} kg` });
  if (e.waist_cm != null)
    out.push({ label: i18n.t("body.detailWaist"), value: `${e.waist_cm.toFixed(1)} cm` });
  if (e.neck_cm != null)
    out.push({ label: i18n.t("body.detailNeck"), value: `${e.neck_cm.toFixed(1)} cm` });
  if (sex === "female" && e.hip_cm != null)
    out.push({ label: i18n.t("body.detailHip"), value: `${e.hip_cm.toFixed(1)} cm` });
  if (e.fat_free_mass_kg != null)
    out.push({
      label: i18n.t("body.detailLeanMass"),
      value: `${e.fat_free_mass_kg.toFixed(1)} kg`,
    });
  if (e.fat_mass_kg != null)
    out.push({ label: i18n.t("body.detailFatMass"), value: `${e.fat_mass_kg.toFixed(1)} kg` });
  return out;
}

// BMI = weight / height²; height is a profile constant, so weight is the only
// per-entry input worth surfacing behind the number.
function bmiSecondary(e: BodyEntry): PointDetail[] {
  return e.weight_kg != null
    ? [{ label: i18n.t("body.detailWeight"), value: `${e.weight_kg.toFixed(1)} kg` }]
    : [];
}

// FFMI = fat-free mass / height², where fat-free mass = weight × (1 − BF%).
// Surface both inputs plus the resulting lean mass.
function ffmiSecondary(e: BodyEntry): PointDetail[] {
  const out: PointDetail[] = [];
  if (e.weight_kg != null)
    out.push({ label: i18n.t("body.detailWeight"), value: `${e.weight_kg.toFixed(1)} kg` });
  const bf = e.body_fat_pct ?? e.body_fat_pct_navy;
  if (bf != null) out.push({ label: i18n.t("body.detailBodyFat"), value: `${bf.toFixed(1)}%` });
  if (e.fat_free_mass_kg != null)
    out.push({
      label: i18n.t("body.detailLeanMass"),
      value: `${e.fat_free_mass_kg.toFixed(1)} kg`,
    });
  return out;
}

const BODY_SECTIONS: Array<{ id: BodySection; Icon: LucideIcon }> = [
  { id: "composition", Icon: Scale },
  { id: "measurements", Icon: Ruler },
];

export function Body({
  navTab = null,
}: {
  // Agent-driven sub-tab navigation (show_screen tab arg); see Nutrition.
  navTab?: { tab: string; key: number } | null;
}) {
  const { t } = useTranslation();
  // Persisted, so reopening Body lands on the sub-section last viewed.
  const section = useUiStore((s) => s.bodySection);
  const setSection = useUiStore((s) => s.setBodySection);
  useEffect(() => {
    if (navTab && BODY_SECTIONS.some((s) => s.id === navTab.tab)) {
      setSection(navTab.tab as BodySection);
    }
    // Trigger only on navTab.key (bumps per show_screen request).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTab?.key]);
  const SectionIcon = BODY_SECTIONS.find((s) => s.id === section)?.Icon ?? Scale;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 md:pb-0">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-5 sm:py-6">
          <PageTitle Icon={SectionIcon} help={section}>
            {t(`body.tabs.${section}`)}
          </PageTitle>
          {section === "composition" ? <CompositionSection /> : <MeasurementsSection />}
        </div>
      </div>
      <SectionSubNav
        sections={BODY_SECTIONS}
        section={section}
        onSection={setSection}
        label={(id) => t(`body.tabs.${id}`)}
        ariaLabel={t("body.sectionsAria")}
        tourPrefix="body"
      />
    </div>
  );
}

// Weigh-ins: weight, body fat and the metrics derived from them.
function CompositionSection() {
  const { t } = useTranslation();
  const granularity = useUiStore((s) => s.bodyGranularity);
  const setGranularity = useUiStore((s) => s.setBodyGranularity);
  const { selectedDate, selectedDateIso, todayIso, setSelectedDate } = useDayContext();
  // Body entries are logged for the active day; a future day can't have one.
  const isFutureDay = selectedDateIso > todayIso;
  const { range, customRange, setCustomRange } = useDateRange(granularity, selectedDate);

  const queryClient = useQueryClient();
  const bodyQ = useGetProgressBody({ from: range.from, to: range.to });
  const data = (bodyQ.data as unknown as BodyResp | undefined) ?? null;
  const err = bodyQ.error ? apiErr(bodyQ.error) : null;
  // Under "all" the range label starts at the first entry (see clipToData).
  const firstEntry = data?.entries.reduce<string | null>(
    (min, e) => (min == null || e.date < min ? e.date : min),
    null,
  );
  const showLoader = useMinLoading(bodyQ.isPending);
  const [logOpen, setLogOpen] = useState(false);

  return (
    <>
      <RangeNav
        granularity={granularity}
        anchor={selectedDate}
        onGranularity={setGranularity}
        onAnchor={setSelectedDate}
        customRange={customRange}
        onCustomRange={setCustomRange}
        dataFrom={firstEntry}
      />
      {granularity === "day" && (
        <Button
          onClick={() => setLogOpen(true)}
          disabled={isFutureDay}
          title={isFutureDay ? t("body.cantLogFuture") : undefined}
          className="w-full gap-1"
        >
          <Plus className="size-4" /> {t("body.logEntry")}
        </Button>
      )}
      {showLoader && (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {data && !showLoader && (
        <BodyContent
          data={data}
          granularity={granularity}
          onChanged={() => {
            invalidateFormContext();
            void queryClient.invalidateQueries();
          }}
        />
      )}
      {logOpen && (
        <LogEntryDialog
          dateIso={selectedDateIso}
          lastWeightKg={data ? latestWeight(data.entries) : null}
          onClose={() => setLogOpen(false)}
          onSaved={() => {
            setLogOpen(false);
            // Shared gate-form context caches the latest weigh-in for prefill;
            // drop it so a chat log_body_comp picks up what we just wrote.
            invalidateFormContext();
            void queryClient.invalidateQueries();
          }}
        />
      )}
    </>
  );
}

// Flatten an existing entry into the form's draft shape (the tool's flat input
// = the POST/PATCH /body payload). Only the raw, user-entered fields are kept;
// derived metrics (BMI/FFMI/Navy) are recomputed server-side on save. Null
// fields are dropped so the method-first form shows only what was recorded.
function entryToDraft(e: BodyEntry): Record<string, unknown> {
  const draft: Record<string, unknown> = { date: e.date };
  if (e.weight_kg != null) draft.weight_kg = e.weight_kg;
  if (e.body_fat_method) draft.body_fat_method = e.body_fat_method;
  if (e.body_fat_pct != null) draft.body_fat_pct = e.body_fat_pct;
  if (e.waist_cm != null) draft.waist_cm = e.waist_cm;
  if (e.neck_cm != null) draft.neck_cm = e.neck_cm;
  if (e.hip_cm != null) draft.hip_cm = e.hip_cm;
  if (e.notes) draft.notes = e.notes;
  const time = entryTime(e);
  if (time) draft.time = time;
  return draft;
}

// The entry's HH:MM: the user-picked time, else when it was logged (older
// entries predate the time field).
function entryTime(e: BodyEntry): string {
  return e.time ?? formatTime24(e.logged_at);
}

// Create a new body_comp_entry (POST /body) or edit an existing one
// (PATCH /body/{date}). The server computes BMI/FFMI/Navy BF% and stores them
// alongside the raw inputs either way. Method-first: the user picks how they
// measured body fat, then only the relevant inputs render — a direct reading
// (DEXA/BIA/caliper/visual) shows a single BF% field, while Navy shows
// circumferences and the server estimates BF% from them. Field visibility is
// shared with the chat gate form via bodyCompFieldVisibility.
function LogEntryDialog({
  dateIso,
  lastWeightKg,
  editEntry,
  onClose,
  onSaved,
}: {
  dateIso: string;
  lastWeightKg: number | null;
  editEntry?: BodyEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  // Manual body-comp entry reuses the chat gate's LogBodyCompForm, so both
  // surfaces look identical and share the method-first BF% logic.
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    editEntry
      ? entryToDraft(editEntry)
      : {
          date: dateIso,
          // New entries default to now; the date to the day in view.
          time: formatTime24(new Date()),
          ...(lastWeightKg != null ? { weight_kg: lastWeightKg } : {}),
        },
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Edits locate the row by its ORIGINAL date even when the draft moves it.
  const originalDate = editEntry?.date ?? dateIso;

  const onSubmit = async () => {
    if (draft.weight_kg == null || draft.weight_kg === "") {
      setErr(t("body.weightRequired"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Validate the free-form draft against the SAME Zod schema the server
      // enforces (@fa/shared/schemas → BodyLogRequest), so bad input fails here
      // with a precise field message instead of a round-trip 400. parse() also
      // strips draft-only/computed keys, leaving exactly the request body.
      const body = BodyLogRequest.parse({
        ...draft,
        date: (draft.date as string) || originalDate,
      });
      if (editEntry) {
        await patchBodyDate(originalDate, {
          ...body,
          // entry_id pins the exact row (the PATCH route locates by date
          // otherwise). Not a BodyLogRequest field, so re-attach it after
          // parse drops unknown keys.
          ...(editEntry.id != null ? { entry_id: editEntry.id } : {}),
        });
      } else {
        await postBody(body);
      }
      onSaved();
    } catch (ex) {
      setErr(apiErr(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="modal-cap overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editEntry
              ? t("body.editBodyEntry", { date: isoToDisplay(originalDate) })
              : t("body.logBodyEntry", { date: isoToDisplay(originalDate) })}
          </DialogTitle>
          <DialogDescription>{t("body.logDialogDescription")}</DialogDescription>
        </DialogHeader>
        <LogBodyCompForm
          schema={{ type: "object" }}
          value={draft}
          onChange={(next) => setDraft(next as Record<string, unknown>)}
          disabled={busy}
        />
        {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
        <DialogFooter className="mt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => void onSubmit()} disabled={busy}>
            {busy ? t("common.saving") : editEntry ? t("body.saveChanges") : t("body.saveEntry")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BodyContent({
  data,
  granularity,
  onChanged,
}: {
  data: BodyResp;
  granularity: Granularity;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  // Delete targets a single entry by its row id (DELETE /body/entry/{id}), so
  // removing one weigh-in leaves any other entries on the same day intact.
  // Pending holds the entry being confirmed; deleteErr renders inline above
  // the charts, which is the one spot both the tooltip and the day-view table
  // can report into.
  const [pendingDelete, setPendingDelete] = useState<BodyEntry | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The entry currently open in the edit dialog (null = closed).
  const [editEntry, setEditEntry] = useState<BodyEntry | null>(null);
  // How the charts space their points — persisted, so it survives a reload.
  const spacing = useUiStore((s) => s.bodyChartSpacing);
  const setSpacing = useUiStore((s) => s.setBodyChartSpacing);
  const averageDays = useUiStore((s) => s.bodyChartAverage);
  const setAverageDays = useUiStore((s) => s.setBodyChartAverage);
  const chartColor = useUiStore((s) => s.bodyChartColor);
  const setChartColor = useUiStore((s) => s.setBodyChartColor);
  // The point tapped on any chart, shared by all of them so one tap opens the
  // same entry's tooltip on every series. Keyed by entryKey rather than by
  // date, since a day can hold more than one entry.
  const [selection, setSelection] = useState<ChartSelection | null>(null);
  const setGranularity = useUiStore((s) => s.setBodyGranularity);
  const { setSelectedDate } = useDayContext();
  // A day averaged from several entries: open it in the day view, whose table
  // lists each entry with its own edit / delete.
  const goToDay = (iso: string) => {
    setSelection(null);
    setSelectedDate(fromIso(iso));
    setGranularity("day");
  };

  // Edit / delete for the entry behind a tapped point, rendered inside that
  // point's tooltip — or, for a day's average, a jump to that day. Looked up
  // fresh on every render, so a deleted entry's actions can't outlive it.
  const pointActions = (p: ChartPoint) => {
    const key = pointKey(p);
    if (key.startsWith(DAY_KEY_PREFIX)) {
      return (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 [&_svg]:size-3.5"
          aria-label={t("body.goToDay")}
          title={t("body.goToDay")}
          onClick={() => goToDay(p.date)}
        >
          <CalendarDays />
        </Button>
      );
    }
    const entry = data.entries.find((e, i) => entryKey(e, i) === key);
    if (!entry) return null;
    return (
      <>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 [&_svg]:size-3.5"
          aria-label={t("body.editEntry")}
          title={t("body.editEntry")}
          onClick={() => setEditEntry(entry)}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-destructive hover:text-destructive [&_svg]:size-3.5"
          aria-label={t("body.deleteEntry")}
          title={t("body.deleteEntry")}
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

  const handleDelete = async () => {
    if (pendingDelete?.id == null) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      await deleteBodyEntryId(pendingDelete.id);
      setPendingDelete(null);
      onChanged();
    } catch (e) {
      setDeleteErr(apiErr(e));
    } finally {
      setDeleting(false);
    }
  };

  if (data.entries.length === 0) {
    return <EmptyState icon={Scale}>{t("body.noEntriesInRange")}</EmptyState>;
  }

  const showCharts = granularity !== "day";
  // The charts span the whole selected window, not just first-entry to
  // last-entry, so each point sits at its real date — two readings ten months
  // apart have to look ten months apart. "All" is clipped to the first entry,
  // the same rule the range label follows, so a young account doesn't get a
  // year of empty leading space. Taken from the response rather than the live
  // range so the axis always matches the entries drawn under it.
  const chartWindow = clipToData(
    { from: data.from, to: data.to, label: "" },
    granularity,
    data.entries[0]?.date ?? null,
  );
  // "even" withholds the window, which drops LineChart back to one slot per
  // point — denser and easier to read when the logging is sparse, at the cost
  // of the real spacing between readings.
  const axis = spacing === "date" ? chartWindow : null;
  const avgCap = averageCap({
    granularity,
    from: chartWindow.from,
    to: chartWindow.to,
  });
  const average = fitAverage(averageDays, avgCap);
  // No profile height in this response; recover it from the latest BMI
  // (BMI = weight / height²).
  const heightCm =
    data.stats.bmi?.last && data.stats.weight_kg?.last
      ? Math.sqrt(data.stats.weight_kg.last / data.stats.bmi.last) * 100
      : null;
  // Each chart's series, shared by its card and the PDF export.
  const weightPts = series(data.entries, (e) => e.weight_kg);
  const bodyFatPts = series(
    data.entries,
    (e) => e.body_fat_pct ?? e.body_fat_pct_navy,
    (e) => bfSecondary(e, data.sex),
  );
  const bmiPts = series(data.entries, (e) => e.bmi, bmiSecondary);
  const ffmiPts = series(data.entries, (e) => e.ffmi, ffmiSecondary);
  // Lines tinted by the same bands as the gauges above them.
  const tint = chartColor === "scale";
  const weightColors = tint ? gaugeColorScale("weight", null, heightCm) : null;
  const bodyFatColors = tint ? gaugeColorScale("bodyFat", data.sex) : null;
  const bmiColors = tint ? gaugeColorScale("bmi") : null;
  // The FFMI chart plots raw FFMI but the bands are for the normalized value
  // (raw + 6.1 × (1.8 − height_m)), so shift them into raw terms. Without a
  // height there's nothing to shift by, and the line stays solid.
  const ffmiShift = heightCm ? 6.1 * (1.8 - heightCm / 100) : null;
  const ffmiBands = tint && ffmiShift != null ? gaugeColorScale("ffmi", data.sex) : null;
  const ffmiColors =
    ffmiBands && ffmiShift != null
      ? remapColorScale(
          ffmiBands,
          (v) => v + ffmiShift,
          (s) => s - ffmiShift,
        )
      : null;

  return (
    <>
      {/* Range views summarize the window; the day view shows each entry as its
          own card instead (below), like Measurements' day card. */}
      {showCharts && (
        <Card>
          <CardHeader>
            <CardTitle>{t("body.summary")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <SummaryStat
                label={t("body.weight")}
                stats={data.stats.weight_kg}
                unit="kg"
                digits={1}
                gauge={
                  <MetricGauge
                    kind="weight"
                    value={data.stats.weight_kg?.last}
                    heightCm={heightCm}
                  />
                }
              />
              <SummaryStat
                label={t("body.bodyFat")}
                stats={data.stats.body_fat_pct}
                unit="%"
                digits={1}
                gauge={
                  <MetricGauge
                    kind="bodyFat"
                    value={data.stats.body_fat_pct?.last}
                    sex={data.sex}
                  />
                }
              />
              <SummaryStat
                label={t("body.bmi")}
                stats={data.stats.bmi}
                unit=""
                digits={1}
                gauge={<MetricGauge kind="bmi" value={data.stats.bmi?.last} />}
              />
              <SummaryStat
                label={t("body.ffmi")}
                stats={data.stats.ffmi}
                unit=""
                digits={1}
                gauge={
                  <MetricGauge
                    kind="ffmi"
                    value={latestNormFfmi(data.entries) ?? data.stats.ffmi?.last}
                    sex={data.sex}
                  />
                }
              />
            </div>
          </CardContent>
        </Card>
      )}

      {deleteErr && <p className="text-sm text-destructive">{deleteErr}</p>}

      {showCharts && (
        <>
          <ChartControls
            average={average}
            cap={avgCap}
            onAverage={setAverageDays}
            spacing={spacing}
            onSpacing={setSpacing}
            color={chartColor}
            onColor={setChartColor}
            // PDF of these charts as shown: same window, average and spacing.
            onExport={() =>
              void runExport(() =>
                exportChartsPdf({
                  title: t("export.report.sections.body"),
                  period: chartWindow,
                  view: { average, spacing },
                  stats: [
                    trendStat(t("body.seriesWeight"), weightPts, 1, "kg"),
                    trendStat(t("body.seriesBodyFat"), bodyFatPts, 1, "%"),
                    trendStat(t("body.seriesBmi"), bmiPts),
                    trendStat(t("body.seriesFfmi"), ffmiPts),
                  ],
                  charts: [
                    { title: t("body.seriesWeight"), points: weightPts, unit: "kg" },
                    { title: t("body.seriesBodyFat"), points: bodyFatPts, unit: "%" },
                    { title: t("body.seriesBmi"), points: bmiPts, unit: "" },
                    { title: t("body.seriesFfmi"), points: ffmiPts, unit: "" },
                  ],
                }),
              )
            }
          />
          <SeriesCard
            id="weight"
            title={t("body.seriesWeight")}
            points={weightPts}
            unit="kg"
            from={axis?.from}
            to={axis?.to}
            selection={selection}
            onSelect={setSelection}
            actions={pointActions}
            average={average}
            colorScale={weightColors}
          />
          <SeriesCard
            id="bodyFat"
            title={t("body.seriesBodyFat")}
            points={bodyFatPts}
            unit="%"
            from={axis?.from}
            to={axis?.to}
            selection={selection}
            onSelect={setSelection}
            actions={pointActions}
            average={average}
            colorScale={bodyFatColors}
          />
          <SeriesCard
            id="bmi"
            title={t("body.seriesBmi")}
            points={bmiPts}
            unit=""
            from={axis?.from}
            to={axis?.to}
            selection={selection}
            onSelect={setSelection}
            actions={pointActions}
            average={average}
            colorScale={bmiColors}
          />
          <SeriesCard
            id="ffmi"
            title={t("body.seriesFfmi")}
            points={ffmiPts}
            unit=""
            from={axis?.from}
            to={axis?.to}
            selection={selection}
            onSelect={setSelection}
            actions={pointActions}
            average={average}
            colorScale={ffmiColors}
          />
        </>
      )}

      {/* Charts replace the entry cards: with a chart on screen a weigh-in is
          read by tapping its point. Day granularity draws no charts, so the
          cards are the only way to see — and edit — that day's entries. */}
      {!showCharts &&
        data.entries.map((e, i) => (
          <EntryCard
            key={entryKey(e, i)}
            entry={e}
            sex={data.sex}
            onEdit={() => setEditEntry(e)}
            onDelete={() => {
              setDeleteErr(null);
              setPendingDelete(e);
            }}
          />
        ))}

      <AlertDialog open={pendingDelete != null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("body.deleteWeighInTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? t("body.deleteWeighInBody", { date: isoToDisplay(pendingDelete.date) })
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

      {editEntry && (
        <LogEntryDialog
          dateIso={editEntry.date}
          lastWeightKg={null}
          editEntry={editEntry}
          onClose={() => setEditEntry(null)}
          onSaved={() => {
            setEditEntry(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

// One weigh-in, laid out like Measurements' day card: date + edit / delete in
// the header, a tile per metric with its gauge, notes underneath.
function EntryCard({
  entry: e,
  sex,
  onEdit,
  onDelete,
}: {
  entry: BodyEntry;
  sex: Sex | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  // Effective BF% prefers the user-entered reading, falls back to the Navy
  // estimate; legacy rows with only a Navy estimate have no method stored.
  const bf = e.body_fat_pct ?? e.body_fat_pct_navy ?? null;
  const methodLabel =
    e.body_fat_method ?? (e.body_fat_pct == null && e.body_fat_pct_navy != null ? "navy" : null);
  // No profile height in this response; recover it from BMI (weight / height²).
  const heightCm = e.bmi && e.weight_kg ? Math.sqrt(e.weight_kg / e.bmi) * 100 : null;
  const circumferences = [
    e.waist_cm != null ? `${t("body.detailWaist")} ${e.waist_cm.toFixed(1)} cm` : null,
    e.neck_cm != null ? `${t("body.detailNeck")} ${e.neck_cm.toFixed(1)} cm` : null,
    sex === "female" && e.hip_cm != null
      ? `${t("body.detailHip")} ${e.hip_cm.toFixed(1)} cm`
      : null,
  ].filter((v): v is string => v != null);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>
          {entryTime(e) ? t("body.entryTitleAt", { time: entryTime(e) }) : t("body.entryTitle")}
        </CardTitle>
        <div className="flex items-center">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 [&_svg]:size-3.5"
            aria-label={t("body.editEntry")}
            title={t("body.editEntry")}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          {e.id != null && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 text-destructive hover:text-destructive [&_svg]:size-3.5"
              aria-label={t("body.deleteEntry")}
              title={t("body.deleteEntry")}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <EntryStat
            label={t("body.weight")}
            value={e.weight_kg != null ? `${e.weight_kg.toFixed(1)} kg` : null}
            gauge={<MetricGauge kind="weight" value={e.weight_kg} heightCm={heightCm} />}
          />
          <EntryStat
            label={t("body.bodyFat")}
            value={bf != null ? `${bf.toFixed(1)}%` : null}
            tag={bf != null && methodLabel ? `(${methodLabel})` : undefined}
            sub={
              e.fat_mass_kg != null
                ? `${t("body.detailFatMass")} ${e.fat_mass_kg.toFixed(1)} kg`
                : undefined
            }
            gauge={<MetricGauge kind="bodyFat" value={bf} sex={sex} />}
          />
          <EntryStat
            label={t("body.bmi")}
            value={e.bmi != null ? e.bmi.toFixed(1) : null}
            gauge={<MetricGauge kind="bmi" value={e.bmi} />}
          />
          <EntryStat
            label={t("body.ffmi")}
            value={e.ffmi != null ? e.ffmi.toFixed(1) : null}
            sub={
              e.fat_free_mass_kg != null
                ? `${t("body.detailLeanMass")} ${e.fat_free_mass_kg.toFixed(1)} kg`
                : undefined
            }
            gauge={<MetricGauge kind="ffmi" value={e.ffmi_normalized ?? e.ffmi} sex={sex} />}
          />
        </div>
        {circumferences.length > 0 && (
          <p className="text-xs text-muted-foreground tabular-nums">{circumferences.join(" · ")}</p>
        )}
        {e.notes && <p className="text-xs text-muted-foreground">{e.notes}</p>}
      </CardContent>
    </Card>
  );
}

// A single entry's metric tile: SummaryStat's look without the range lines.
function EntryStat({
  label,
  value,
  tag,
  sub,
  gauge,
}: {
  label: string;
  value: string | null;
  tag?: string;
  sub?: string;
  gauge?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-edge bg-card p-3 shadow-tile">
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums">
        {value ?? "—"}
        {value != null && tag && <span className="font-normal text-muted-foreground"> {tag}</span>}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground tabular-nums">{sub}</div>}
      {value != null && gauge}
    </div>
  );
}

function SummaryStat({
  label,
  stats,
  unit,
  digits,
  sub,
  gauge,
}: {
  label: string;
  stats: Stats;
  unit: string;
  digits: number;
  sub?: string;
  // Optional MetricGauge bar rendered under the latest value.
  gauge?: React.ReactNode;
}) {
  const { t } = useTranslation();
  if (!stats) {
    return (
      <div className="flex flex-col gap-0.5 rounded-lg border border-edge bg-card p-3 shadow-tile">
        <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        <div className="text-sm font-medium">—</div>
      </div>
    );
  }
  const sign = stats.change > 0 ? "+" : "";
  const deltaCls =
    stats.change > 0
      ? "text-destructive"
      : stats.change < 0
        ? "text-[color:var(--success)]"
        : "text-muted-foreground";
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-edge bg-card p-3 shadow-tile">
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="text-sm font-medium">
        {stats.last.toFixed(digits)}
        {unit}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      <div className={cn("text-[11px]", deltaCls)}>
        {t("body.changeFrom", {
          sign,
          change: stats.change.toFixed(digits),
          first: stats.first.toFixed(digits),
          unit,
        })}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t("body.range", {
          min: stats.min.toFixed(digits),
          max: stats.max.toFixed(digits),
          unit,
        })}
      </div>
      {gauge}
    </div>
  );
}

// LineChart, tooltip and axis rendering are shared with the Workout progress
// charts — see components/chart.tsx. Body points carry a `detail` array
// (PointDetail) that the tooltip surfaces when a point is tapped, plus the
// entry's edit / delete controls, which is why the page no longer lists the
// entries in a table alongside the charts.
