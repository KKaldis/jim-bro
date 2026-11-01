/**
 * "Progress report" PDF: one printable summary of a chosen period across the
 * tracked areas (body composition, tape measurements, nutrition, training,
 * per-exercise strength, cardio fitness). Opened from the profile's Export section, which picks the
 * period and sections, fetches each section's progress endpoint, then prints.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown } from "lucide-react";
import {
  computeIdealProportions,
  type ExerciseId,
  getExercise,
  type IdealProportionsResult,
  type ProportionPart,
  type Macros,
  PROPORTION_PARTS,
  type WorkoutPR,
  type WorkoutSession,
} from "@fa/shared";
import {
  getProgressBody,
  getProgressCardio,
  getProgressMeasurements,
  getProgressNutrition,
  getWorkoutProgressPrs,
  getWorkoutSessions,
  useGetWorkoutProgressPrs,
} from "../api/endpoints/default/default";
import i18n, { intlLocale } from "../i18n";
import { toIso, today } from "../dateRange";
import { apiErr } from "../lib/apiErr";
import { isoToDisplay } from "../lib/dateFormat";
import { exerciseLabel } from "../forms/workoutControls";
import { bucketLabel, bucketsForExercise } from "../components/MuscleViewToggle";
import { useUiStore } from "../lib/uiStore";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { AVERAGE_OPTIONS, averageShortLabel } from "../components/SpacingToggle";
import { cn } from "../lib/utils";
import {
  EXERCISE_PART_LABEL,
  EXERCISE_PARTS,
  ExerciseProgressBody,
  type ChartView,
  chartViewNote,
  type ExerciseSeries,
  loadExerciseSeries,
} from "./exerciseProgressPdf";
import {
  MacroStats,
  PrintHeader,
  PrintLineChart,
  printDocument,
  signed,
  type Stat,
  StatGrid,
} from "./printDoc";
import {
  CalendarHeatmap,
  type HeatLegend,
  MacroSplit,
  MiniTrend,
  PrintBarChart,
  PrintMuscleIcon,
  PrintRadar,
  PrintThumb,
  ShareBar,
  TargetBars,
} from "./printViz";

export type ReportSection =
  "body" | "measurements" | "nutrition" | "training" | "exercises" | "cardio";
const SECTIONS: ReportSection[] = [
  "body",
  "measurements",
  "nutrition",
  "training",
  "exercises",
  "cardio",
];
const PERIODS = [30, 90, 180, 365] as const;

// The parts of each section the user can include or leave out, in print order.
const BLOCKS = {
  body: ["summary", "weight", "bodyFat", "waist"],
  measurements: ["proportions", "proportionsOverTime", "trends", "table"],
  nutrition: ["summary", "kcalHeatmap", "kcalChart"],
  training: ["summary", "setsHeatmap", "setsPerWeek", "muscleVolume", "prs"],
  exercises: EXERCISE_PARTS,
  cardio: ["summary", "restingHr", "vo2max"],
} as const satisfies Record<ReportSection, readonly string[]>;
type BlockOf<S extends ReportSection> = (typeof BLOCKS)[S][number];
type ReportBlock = BlockOf<ReportSection>;
// "section.block" — one entry per checked box.
type BlockKey = `${ReportSection}.${string}`;
type Show<S extends ReportSection> = (b: BlockOf<S>) => boolean;

const BLOCK_LABEL: Record<ReportBlock, string> = {
  summary: "export.report.blocks.summary",
  weight: "export.report.weight",
  bodyFat: "export.report.bodyFat",
  waist: "export.report.waist",
  proportions: "cards.proportions.title",
  proportionsOverTime: "export.report.proportionsOverTime",
  trends: "export.report.trends",
  table: "export.report.blocks.table",
  kcalHeatmap: "export.report.heat.kcalTitle",
  kcalChart: "export.report.kcalPerDay",
  setsHeatmap: "export.report.heat.setsTitle",
  setsPerWeek: "export.report.setsPerWeek",
  muscleVolume: "export.report.muscleVolume",
  prs: "export.report.prs",
  restingHr: "export.report.restingHr",
  vo2max: "export.report.vo2max",
  est1rm: EXERCISE_PART_LABEL.est1rm,
  topSet: EXERCISE_PART_LABEL.topSet,
  volume: EXERCISE_PART_LABEL.volume,
};

const blocksOf = (s: ReportSection): readonly ReportBlock[] => BLOCKS[s];
const ALL_BLOCKS: BlockKey[] = SECTIONS.flatMap((s) =>
  blocksOf(s).map((b): BlockKey => `${s}.${b}`),
);

function showFor<S extends ReportSection>(picked: Set<BlockKey>, s: S): Show<S> {
  return (b) => picked.has(`${s}.${b}`);
}

// Seven-number summary the progress endpoints return per metric (null = no data).
type MetricStats = {
  first: number;
  last: number;
  min: number;
  max: number;
  change: number;
  count: number;
} | null;

type BodyEntry = {
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  body_fat_pct_navy?: number | null;
  waist_cm: number | null;
  bmi?: number | null;
  ffmi?: number | null;
  fat_free_mass_kg?: number | null;
};
type BodyData = {
  entries: BodyEntry[];
  stats: Record<"weight_kg" | "body_fat_pct" | "waist_cm" | "bmi" | "ffmi", MetricStats>;
};
type MeasurementData = {
  from: string;
  entries: Array<Record<string, unknown> & { date: string }>;
  // Latest girth of every part as of the day before the period — the
  // starting point the over-time proportions replay from.
  baseline?: Partial<Record<ProportionPart, number>>;
  // Ideal proportions from the latest girths + wrist; null until the profile
  // has sex + wrist and enough parts are measured.
  proportions?: IdealProportionsResult | null;
  // Frame anchor for replaying proportions per date (ProportionsTrend).
  sex?: "male" | "female" | null;
  wrist_cm?: number | null;
};
type NutritionDay = {
  date: string;
  eaten: Macros;
  target: Macros | null;
  meal_count: number;
};
type NutritionData = {
  days: NutritionDay[];
  totals: { days_with_logs: number };
  averages: { eaten: Macros | null; target: Macros | null };
};
type CardioEntry = {
  date: string;
  resting_heart_rate: number | null;
  max_heart_rate?: number | null;
  vo2_max?: number | null;
  vo2_max_category?: string | null;
};
type CardioData = {
  entries: CardioEntry[];
  stats: { resting_heart_rate: MetricStats; vo2_max: MetricStats };
};
type TrainingData = { sessions: WorkoutSession[]; prs: WorkoutPR[] };

type ReportData = {
  from: string;
  to: string;
  blocks: Set<BlockKey>;
  body?: BodyData;
  measurements?: MeasurementData;
  nutrition?: NutritionData;
  training?: TrainingData;
  // Picked exercises that have sessions in the period.
  exercises?: ExerciseSeries[];
  // Average + spacing for the exercise charts, as picked in the options.
  exerciseView?: ChartView;
  cardio?: CardioData;
};

const MEASUREMENT_SITES = [
  "neck_cm",
  "shoulders_cm",
  "chest_cm",
  "arm_cm",
  "forearm_cm",
  "waist_cm",
  "hip_cm",
  "thigh_cm",
  "calf_cm",
] as const;

async function loadReport(
  days: number,
  blocks: Set<BlockKey>,
  exerciseIds: ExerciseId[],
): Promise<ReportData> {
  const end = today();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  const range = { from: toIso(start), to: toIso(end) };
  const out: ReportData = { ...range, blocks };
  // A section is fetched when any of its blocks is checked.
  const sections = new Set(
    SECTIONS.filter((s) => blocksOf(s).some((b) => blocks.has(`${s}.${b}`))),
  );
  const jobs: Promise<void>[] = [];
  if (sections.has("body"))
    jobs.push(getProgressBody(range).then((r) => void (out.body = r as unknown as BodyData)));
  if (sections.has("measurements"))
    jobs.push(
      Promise.all([
        getProgressMeasurements(range),
        // `latest` is "newest value of each part as of `to`", so a one-day
        // query on the eve of the period gives the girths you started with.
        getProgressMeasurements({ from: dayBefore(range.from), to: dayBefore(range.from) }),
      ]).then(
        ([r, before]) =>
          void (out.measurements = {
            ...(r as unknown as MeasurementData),
            baseline: before.latest as Partial<Record<ProportionPart, number>>,
          }),
      ),
    );
  if (sections.has("nutrition"))
    jobs.push(
      getProgressNutrition(range).then((r) => void (out.nutrition = r as unknown as NutritionData)),
    );
  if (sections.has("cardio"))
    jobs.push(getProgressCardio(range).then((r) => void (out.cardio = r as unknown as CardioData)));
  if (sections.has("exercises"))
    jobs.push(
      loadExerciseSeries(exerciseIds, range).then(
        (list) => void (out.exercises = list.filter((s) => s.points.length > 0)),
      ),
    );
  if (sections.has("training"))
    jobs.push(
      Promise.all([getWorkoutSessions(range), getWorkoutProgressPrs({ limit: 100 })]).then(
        ([s, p]) =>
          void (out.training = {
            sessions: s.sessions as unknown as WorkoutSession[],
            prs: (p.prs as unknown as WorkoutPR[]).filter(
              (pr) => pr.date >= range.from && pr.date <= range.to,
            ),
          }),
      ),
    );
  await Promise.all(jobs);
  return out;
}

// ---------- document ----------

// Labels carry the unit ("Weight (kg)"), so values are bare numbers.
// The note leads with the date the latest value was logged.
function metricStat(
  label: string,
  s: MetricStats,
  lastDate: string | null,
  digits = 1,
): Stat | null {
  if (!s) return null;
  const change =
    s.count > 1
      ? i18n.t("export.report.changeFrom", {
          change: signed(s.change, digits),
          first: s.first.toFixed(digits),
        })
      : null;
  return {
    label,
    value: s.last.toFixed(digits),
    note: [lastDate && isoToDisplay(lastDate), change].filter(Boolean).join(" · ") || undefined,
  };
}

// Date of the most recent entry that has a value for `pick`.
function latestDate<E extends { date: string }>(
  entries: E[],
  pick: (e: E) => number | null | undefined,
): string | null {
  return entries.reduce<string | null>(
    (best, e) => (pick(e) != null && (best == null || e.date > best) ? e.date : best),
    null,
  );
}

function dayBefore(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return toIso(d);
}

// Monday (ISO YYYY-MM-DD) of the week a date falls in.
function weekStart(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toIso(d);
}

// Up to ~9 weeks a bar per day reads fine; longer periods bucket by week.
const DAILY_BAR_LIMIT = 62;

// Training heatmap: one-hue ordinal blue ramp, light → dark = more sets
// (validated --ordinal). Nutrition heatmap: kcal as % of the day's target on
// a blue ↔ grey ↔ red diverging scale (under / on target / over) — two steps
// per arm, neutral grey midpoint, adjacent pairs validated for CVD and
// normal vision. Unlogged days are a dashed outline, never a colour.
const SETS_RAMP = ["#86b6ef", "#5598e7", "#256abf", "#104281"];
const KCAL_SCALE = [
  { max: 80, color: "#256abf", label: "< 80%" },
  { max: 95, color: "#86b6ef", label: "80–95%" },
  { max: 105, color: "#d6d5cf", label: "95–105%" },
  { max: 120, color: "#eb8a82", label: "105–120%" },
  { max: Infinity, color: "#c53030", label: "> 120%" },
];
const NO_TARGET = "#ececef";
const REST_DAY = "#f4f4f5";

function Empty() {
  const { t } = useTranslation();
  return <p className="muted small">{t("export.report.noData")}</p>;
}

function BodySection({ data, show }: { data: BodyData; show: Show<"body"> }) {
  const { t } = useTranslation();
  const entries = [...data.entries].sort((a, b) => a.date.localeCompare(b.date));
  const series = (pick: (e: BodyEntry) => number | null | undefined) =>
    entries.flatMap((e) => {
      const v = pick(e);
      return v == null ? [] : [{ date: e.date, value: v }];
    });
  const weight = series((e) => e.weight_kg);
  const bodyFat = series((e) => e.body_fat_pct ?? e.body_fat_pct_navy);
  const waist = series((e) => e.waist_cm);
  const stats = [
    metricStat(
      t("export.report.weight"),
      data.stats.weight_kg,
      latestDate(entries, (e) => e.weight_kg),
    ),
    metricStat(
      t("export.report.bodyFat"),
      data.stats.body_fat_pct,
      latestDate(entries, (e) => e.body_fat_pct),
    ),
    metricStat(
      t("export.report.waist"),
      data.stats.waist_cm,
      latestDate(entries, (e) => e.waist_cm),
    ),
    metricStat(
      t("export.report.bmi"),
      data.stats.bmi,
      latestDate(entries, (e) => e.bmi),
    ),
    metricStat(
      t("export.report.ffmi"),
      data.stats.ffmi,
      latestDate(entries, (e) => e.ffmi),
      2,
    ),
  ].filter((s): s is Stat => s != null);
  return (
    <section className="section">
      <h2>{t("export.report.sections.body")}</h2>
      {entries.length === 0 ? (
        <Empty />
      ) : (
        <>
          {show("summary") && <StatGrid stats={stats} />}
          {show("weight") && weight.length > 1 && (
            <>
              <h3>{t("export.report.weight")}</h3>
              <PrintLineChart points={weight} unit="kg" />
            </>
          )}
          {show("bodyFat") && bodyFat.length > 1 && (
            <>
              <h3>{t("export.report.bodyFat")}</h3>
              <PrintLineChart points={bodyFat} unit="%" />
            </>
          )}
          {show("waist") && waist.length > 1 && (
            <>
              <h3>{t("export.report.waist")}</h3>
              <PrintLineChart points={waist} unit="cm" />
            </>
          )}
        </>
      )}
    </section>
  );
}

// Ideal proportions from the latest measurements (the server's
// compute_ideal_proportions result, as on the Measurements screen): the radar
// against the 100% ideal ring, the score and key ratios beside it, then a
// row per part with its girth, ideal and a bar to the ideal marker.
export function ProportionsBlock({
  data,
  measuredOn,
}: {
  data: IdealProportionsResult;
  // When each part's latest girth was logged, ready to print.
  measuredOn: Partial<Record<ProportionPart, string>>;
}) {
  const { t } = useTranslation();
  const focus = new Set(data.priorities.filter((p) => p.action === "train").map((p) => p.part));
  const byPart = new Map(data.rows.map((r) => [r.part, r]));
  const measured = PROPORTION_PARTS.flatMap((part) => {
    const r = byPart.get(part);
    return r && r.actual_cm != null && r.pct_of_ideal != null
      ? [{ ...r, actual_cm: r.actual_cm, pct_of_ideal: r.pct_of_ideal }]
      : [];
  });
  if (measured.length === 0) return null;
  const label = (p: string) => t(`cards.proportions.parts.${p}`);
  const { shoulder_to_waist: adonis, waist_to_height: whtr } = data.ratios;
  const stats: Stat[] = [];
  if (data.proportion_score != null)
    stats.push({
      label: t("cards.proportions.score"),
      value: `${Math.round(data.proportion_score)}%`,
      note: t(`cards.proportions.method.${data.method}`),
    });
  if (adonis != null)
    stats.push({
      label: t("cards.proportions.adonis"),
      value: adonis.toFixed(2),
      note: t("export.report.idealRatio", { value: "1.62" }),
    });
  if (whtr != null)
    stats.push({
      label: t("cards.proportions.whtr"),
      value: whtr.toFixed(2),
      note: t("export.report.healthyBelow", { value: "0.50" }),
    });
  const barMax = Math.max(125, ...measured.map((r) => r.pct_of_ideal));
  return (
    <>
      <h3>{t("cards.proportions.title")}</h3>
      {measured.length >= 3 ? (
        <div className="props">
          <PrintRadar
            axes={measured.map((r) => ({
              key: r.part,
              label: label(r.part),
              value: r.pct_of_ideal,
              emphasis: focus.has(r.part),
            }))}
          />
          <div className="props-side">
            <StatGrid stats={stats} />
            {data.priorities.length > 0 && (
              <p className="small">
                <span className="muted">{t("cards.proportions.focus")} </span>
                {data.priorities
                  .map((p) =>
                    p.action === "reduce_waist"
                      ? t("cards.proportions.reduceWaist")
                      : label(p.part),
                  )
                  .join(", ")}
              </p>
            )}
            <p className="muted small">{t("export.report.radarHint")}</p>
          </div>
        </div>
      ) : (
        <>
          <StatGrid stats={stats} />
          <p className="muted small">{t("cards.proportions.needThree")}</p>
        </>
      )}
      <table className="keep">
        <thead>
          <tr>
            <th>{t("export.report.site")}</th>
            <th className="num">{t("cards.proportions.you")}</th>
            <th className="num">{t("cards.proportions.ideal")}</th>
            <th style={{ width: "34%" }}>{t("export.report.ofIdeal")}</th>
            <th className="num">%</th>
            <th>{t("export.report.status")}</th>
          </tr>
        </thead>
        <tbody>
          {measured.map((r) => (
            <tr key={r.part}>
              <td style={focus.has(r.part) ? { fontWeight: 700 } : undefined}>{label(r.part)}</td>
              <td className="num">
                {r.actual_cm.toFixed(1)} cm
                {measuredOn[r.part] && <span className="muted small"> {measuredOn[r.part]}</span>}
              </td>
              <td className="num">{r.ideal_cm.toFixed(1)} cm</td>
              <td>
                <span className="ideal-bar" style={{ marginTop: 4 }}>
                  <span
                    style={{ width: `${(Math.min(r.pct_of_ideal, barMax) / barMax) * 100}%` }}
                  />
                  <i style={{ left: `${(100 / barMax) * 100}%` }} />
                </span>
              </td>
              <td className="num">{Math.round(r.pct_of_ideal)}%</td>
              <td className="small">{r.status ? t(`cards.proportions.status.${r.status}`) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// Measurement-entry key → proportion part.
const SITE_PART: Record<(typeof MEASUREMENT_SITES)[number], ProportionPart> = {
  neck_cm: "neck",
  shoulders_cm: "shoulders",
  chest_cm: "chest",
  arm_cm: "arm",
  forearm_cm: "forearm",
  waist_cm: "waist",
  hip_cm: "hips",
  thigh_cm: "thigh",
  calf_cm: "calf",
};

type ProportionSnapshot = {
  date: string;
  // Parts actually measured on this date (the rest are carried forward).
  measured: Set<ProportionPart>;
  result: IdealProportionsResult;
};

// Proportions over time. The server only returns today's result, so this
// replays computeIdealProportions (the same shared function) through the
// period: it starts from the girths you had before the period (baseline,
// shown at the period's first day) and, at every measurement date, carries
// each part's most recent girth forward — so a day that only re-measured the
// waist still scores the full set. Wrist + sex anchor the frame throughout.
function proportionSnapshots(data: MeasurementData): ProportionSnapshot[] {
  if (!data.sex || !data.wrist_cm) return [];
  const { sex, wrist_cm } = data;
  const current: Partial<Record<ProportionPart, number>> = { ...data.baseline };
  const compute = () => computeIdealProportions({ sex, wrist_cm, measurements: { ...current } });
  const entries = [...data.entries].sort((a, b) => a.date.localeCompare(b.date));
  const snaps: ProportionSnapshot[] = [];
  if (Object.keys(current).length > 0 && (entries[0]?.date ?? "") > data.from)
    snaps.push({ date: data.from, measured: new Set(), result: compute() });
  for (const e of entries) {
    const measured = new Set<ProportionPart>();
    for (const site of MEASUREMENT_SITES) {
      const v = e[site];
      if (typeof v === "number") {
        current[SITE_PART[site]] = v;
        measured.add(SITE_PART[site]);
      }
    }
    snaps.push({ date: e.date, measured, result: compute() });
  }
  return snaps;
}

function ProportionsTrend({ snaps }: { snaps: ProportionSnapshot[] }) {
  const { t } = useTranslation();
  const series = (pick: (r: IdealProportionsResult) => number | null | undefined) =>
    snaps.flatMap((s) => {
      const v = pick(s.result);
      return v == null ? [] : [{ date: s.date, value: v }];
    });
  const score = series((r) => r.proportion_score);
  const adonis = series((r) => r.ratios.shoulder_to_waist);
  if (score.length < 2 && adonis.length < 2) return null;
  return (
    <>
      <h3 style={{ marginTop: 16 }}>{t("export.report.proportionsOverTime")}</h3>
      <div className="two-up">
        {score.length > 1 && (
          <div>
            <p className="small muted" style={{ margin: "0 0 2px" }}>
              {t("cards.proportions.score")} (%)
            </p>
            <PrintLineChart points={score} unit="%" digits={0} half />
          </div>
        )}
        {adonis.length > 1 && (
          <div>
            <p className="small muted" style={{ margin: "0 0 2px" }}>
              {t("cards.proportions.adonis")} · {t("export.report.idealRatio", { value: "1.62" })}
            </p>
            <PrintLineChart points={adonis} unit="" digits={2} half />
          </div>
        )}
      </div>
    </>
  );
}

function MeasurementsSection({
  data,
  show,
}: {
  data: MeasurementData;
  show: Show<"measurements">;
}) {
  const { t } = useTranslation();
  const entries = [...data.entries].sort((a, b) => a.date.localeCompare(b.date));
  const rows = MEASUREMENT_SITES.flatMap((site) => {
    const vals = entries.flatMap((e) => {
      const v = e[site];
      return typeof v === "number" ? [{ date: e.date, v }] : [];
    });
    if (vals.length === 0) return [];
    const first = vals[0];
    const last = vals[vals.length - 1];
    return [{ site, first, last, count: vals.length, vals }];
  });
  // One small chart per site that has a trend (2+ measurements in the period).
  const trends = rows.filter((r) => r.count > 1);
  // Parts last measured before the period (their girth comes from the
  // baseline) read "before <period start>" — the exact day isn't in this
  // response, but the value is never undated.
  const measuredOn: Partial<Record<ProportionPart, string>> = {};
  for (const part of Object.keys(data.baseline ?? {}) as ProportionPart[])
    measuredOn[part] = t("export.report.before", { date: isoToDisplay(data.from) });
  for (const r of rows) measuredOn[SITE_PART[r.site]] = isoToDisplay(r.last.date);
  const snaps = proportionSnapshots(data);
  // A part's % of ideal on the dates it was measured, for its tile's note.
  const idealNote = (part: ProportionPart): string | undefined => {
    const pcts = snaps.flatMap((s) => {
      if (!s.measured.has(part)) return [];
      const v = s.result.rows.find((row) => row.part === part)?.pct_of_ideal;
      return v == null ? [] : [v];
    });
    if (pcts.length === 0) return undefined;
    const last = pcts[pcts.length - 1];
    return pcts.length > 1
      ? t("export.report.ofIdealChange", {
          pct: Math.round(last),
          change: signed(last - pcts[0], 0),
        })
      : t("export.report.ofIdealNote", { pct: Math.round(last) });
  };
  return (
    <section className="section">
      <h2>{t("export.report.sections.measurements")}</h2>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <>
          {show("proportions") && data.proportions && (
            <ProportionsBlock data={data.proportions} measuredOn={measuredOn} />
          )}
          {show("proportionsOverTime") && <ProportionsTrend snaps={snaps} />}
          {show("trends") && trends.length > 0 && (
            <h3 style={{ marginTop: 16 }}>{t("export.report.trends")}</h3>
          )}
          {show("trends") && trends.length > 0 && (
            <div className="trends">
              {trends.map((r) => (
                <MiniTrend
                  key={r.site}
                  label={t(`export.report.sites.${r.site}`)}
                  points={r.vals.map((x) => ({ date: x.date, value: x.v }))}
                  unit="cm"
                  note={idealNote(SITE_PART[r.site])}
                />
              ))}
            </div>
          )}
          {show("table") && (
            <table>
              <thead>
                <tr>
                  <th>{t("export.report.site")}</th>
                  <th className="num">{t("export.report.latest")}</th>
                  <th className="num">{t("export.report.first")}</th>
                  <th className="num">{t("export.report.change")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.site}>
                    <td>{t(`export.report.sites.${r.site}`)}</td>
                    <td className="num">
                      {r.last.v.toFixed(1)} cm{" "}
                      <span className="muted small">{isoToDisplay(r.last.date)}</span>
                    </td>
                    <td className="num">
                      {r.count > 1 ? (
                        <>
                          {r.first.v.toFixed(1)} cm{" "}
                          <span className="muted small">{isoToDisplay(r.first.date)}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">
                      {r.count > 1 ? `${signed(r.last.v - r.first.v)} cm` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function NutritionSection({
  data,
  from,
  to,
  show,
}: {
  data: NutritionData;
  from: string;
  to: string;
  show: Show<"nutrition">;
}) {
  const { t } = useTranslation();
  const logged = data.days
    .filter((d) => d.meal_count > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
  const avg = data.averages.eaten;
  const target = data.averages.target;
  // Every day of the period in order. An unlogged day is an empty slot, not a
  // zero-kcal day, so weekly figures average the logged days only. Past
  // DAILY_BAR_LIMIT days both the chart and the table switch to weeks.
  const chrono = [...data.days].sort((a, b) => a.date.localeCompare(b.date));
  const daily = chrono.length <= DAILY_BAR_LIMIT;
  type Row = {
    key: string;
    label: string;
    eaten: Macros;
    target: Macros | null;
    days?: number;
    total?: number;
  };
  let rows: Row[];
  if (daily) {
    rows = chrono.map((d) => ({
      key: d.date,
      label: isoToDisplay(d.date),
      eaten: d.eaten,
      target: d.target,
      days: d.meal_count > 0 ? 1 : 0,
    }));
  } else {
    const weeks = new Map<string, NutritionDay[]>();
    for (const d of chrono) {
      const wk = weekStart(d.date);
      weeks.set(wk, [...(weeks.get(wk) ?? []), d]);
    }
    const mean = (ms: Macros[]): Macros => {
      const n = ms.length || 1;
      const sum = (k: "kcal" | "p" | "f" | "c") => ms.reduce((a, m) => a + m[k], 0) / n;
      return { kcal: sum("kcal"), p: sum("p"), f: sum("f"), c: sum("c") };
    };
    rows = [...weeks].map(([wk, ds]) => {
      const on = ds.filter((d) => d.meal_count > 0);
      const targets = on.flatMap((d) => (d.target ? [d.target] : []));
      return {
        key: wk,
        label: isoToDisplay(wk),
        eaten: mean(on.map((d) => d.eaten)),
        target: targets.length ? mean(targets) : null,
        days: on.length,
        total: ds.length,
      };
    });
  }
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  let anyNoTarget = false;
  const kcalCell = (iso: string) => {
    const d = byDate.get(iso);
    if (!d || d.meal_count === 0) return { color: null, dashed: true };
    if (!d.target || d.target.kcal <= 0) {
      anyNoTarget = true;
      return { color: NO_TARGET };
    }
    const pct = (d.eaten.kcal / d.target.kcal) * 100;
    return { color: KCAL_SCALE.find((b) => pct < b.max)!.color };
  };
  // Run once up front so the legend knows whether "no target" occurs.
  for (const d of data.days) kcalCell(d.date);
  const kcalLegend: HeatLegend[] = [
    ...KCAL_SCALE.map((b) => ({ color: b.color, label: b.label })),
    ...(anyNoTarget ? [{ color: NO_TARGET, label: t("export.report.heat.noTarget") }] : []),
    { color: null, dashed: true, label: t("export.report.heat.notLogged") },
  ];
  const kcalBars = rows.map((r) => ({ label: r.label, value: r.days ? r.eaten.kcal : 0 }));
  return (
    <section className="section">
      <h2>{t("export.report.sections.nutrition")}</h2>
      {!avg || logged.length === 0 ? (
        <Empty />
      ) : (
        <>
          {show("summary") && (
            <div className="keep">
              <p className="muted small">
                {t("export.report.daysLogged", {
                  count: data.totals.days_with_logs,
                  total: data.days.length,
                })}
              </p>
              {target ? (
                <TargetBars value={avg} target={target} />
              ) : (
                <MacroStats macros={avg} label={t("export.report.avgPerDay")} />
              )}
              <MacroSplit macros={avg} />
            </div>
          )}
          {show("kcalHeatmap") && (
            <div className="keep">
              <h3>{t("export.report.heat.kcalTitle")}</h3>
              <CalendarHeatmap from={from} to={to} cell={kcalCell} legend={kcalLegend} />
            </div>
          )}
          {show("kcalChart") && (
            <>
              <h3>{t(daily ? "export.report.kcalPerDay" : "export.report.kcalPerWeek")}</h3>
              <PrintBarChart
                bars={kcalBars}
                reference={target?.kcal}
                referenceLabel={t("export.report.target")}
                unit="kcal"
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

function TrainingSection({
  data,
  from,
  to,
  show,
}: {
  data: TrainingData;
  from: string;
  to: string;
  show: Show<"training">;
}) {
  const { t } = useTranslation();
  const sessions = [...data.sessions]
    .filter((s) => s.sets.length > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
  const totalSets = sessions.reduce((n, s) => n + s.sets.length, 0);
  const volume = sessions.reduce(
    (n, s) => n + s.sets.reduce((m, set) => m + set.reps * (set.weight_kg ?? 0), 0),
    0,
  );
  const minutes = sessions.reduce((n, s) => n + (s.duration_min ?? 0), 0);
  const kcal = sessions.reduce((n, s) => n + (s.kcal_burned ?? 0), 0);
  const stats: Stat[] = [
    { label: t("export.report.sessions"), value: String(sessions.length) },
    { label: t("export.report.sets"), value: String(totalSets) },
    {
      label: t("export.report.volume"),
      // Tonnes past 100 t so a year's total fits its tile.
      value:
        volume >= 100_000
          ? `${(volume / 1000).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })} t`
          : `${Math.round(volume).toLocaleString(intlLocale())} kg`,
    },
  ];
  if (minutes > 0)
    stats.push({ label: t("export.report.duration"), value: `${Math.round(minutes)} min` });
  if (kcal > 0) stats.push({ label: t("export.report.burned"), value: `${Math.round(kcal)} kcal` });

  // Best PR per exercise in the period (highest estimated 1RM).
  const best = new Map<string, WorkoutPR>();
  for (const pr of data.prs) {
    const cur = best.get(pr.exercise_id);
    if (!cur || pr.est_1rm_kg > cur.est_1rm_kg) best.set(pr.exercise_id, pr);
  }
  const prs = [...best.values()].sort((a, b) => b.est_1rm_kg - a.est_1rm_kg);

  // Sets per week, oldest first, keeping empty weeks between sessions.
  const perWeek = new Map<string, number>();
  if (sessions.length) {
    const last = weekStart(sessions[0].date);
    const d = new Date(weekStart(sessions[sessions.length - 1].date) + "T00:00:00");
    for (; toIso(d) <= last; d.setDate(d.getDate() + 7)) perWeek.set(toIso(d), 0);
  }
  for (const s of sessions) {
    const wk = weekStart(s.date);
    perWeek.set(wk, (perWeek.get(wk) ?? 0) + s.sets.length);
  }
  const weekBars = [...perWeek].map(([wk, n]) => ({ label: isoToDisplay(wk), value: n }));

  // Sets per muscle over the period, counted like the plan totals: each set
  // in full toward its exercise's primary muscles, cardio left out.
  const view = useUiStore.getState().muscleView;
  const muscleSets = new Map<string, number>();
  for (const s of sessions)
    for (const set of s.sets) {
      if (getExercise(set.exercise_id)?.type === "cardio") continue;
      for (const b of bucketsForExercise(set.exercise_id, view))
        muscleSets.set(b, (muscleSets.get(b) ?? 0) + 1);
    }
  // Sets per calendar day, binned into quarters of the busiest day.
  const setsByDay = new Map<string, number>();
  for (const s of sessions) setsByDay.set(s.date, (setsByDay.get(s.date) ?? 0) + s.sets.length);
  const busiest = Math.max(0, ...setsByDay.values());
  const cuts = [1, 2, 3].map((k) => Math.max(1, Math.ceil((busiest * k) / 4)));
  const binOf = (n: number) => cuts.filter((c) => n > c).length;
  const setsCell = (iso: string) => {
    const n = setsByDay.get(iso) ?? 0;
    return { color: n > 0 ? SETS_RAMP[binOf(n)] : REST_DAY };
  };
  const bounds = [0, ...cuts, busiest];
  const setsLegend: HeatLegend[] = [
    { color: REST_DAY, label: t("export.report.heat.rest") },
    ...SETS_RAMP.flatMap((color, i) => {
      const lo = bounds[i] + 1;
      const hi = bounds[i + 1];
      if (hi < lo) return [];
      return [
        {
          color,
          label: t("export.report.heat.setsRange", { range: lo === hi ? `${lo}` : `${lo}–${hi}` }),
        },
      ];
    }),
  ];
  const muscles = [...muscleSets].sort((a, b) => b[1] - a[1]);
  const muscleMax = muscles[0]?.[1] ?? 0;

  return (
    <section className="section">
      <h2>{t("export.report.sections.training")}</h2>
      {sessions.length === 0 ? (
        <Empty />
      ) : (
        <>
          {show("summary") && <StatGrid stats={stats} />}
          {show("setsHeatmap") && (
            <div className="keep">
              <h3>{t("export.report.heat.setsTitle")}</h3>
              <CalendarHeatmap from={from} to={to} cell={setsCell} legend={setsLegend} />
            </div>
          )}
          {show("setsPerWeek") && weekBars.length > 1 && (
            <>
              <h3>{t("export.report.setsPerWeek")}</h3>
              <PrintBarChart bars={weekBars} unit={t("export.report.sets")} />
            </>
          )}
          {show("muscleVolume") && muscles.length > 0 && (
            <div className="keep">
              <h3>{t("export.report.muscleVolume")}</h3>
              <table>
                <thead>
                  <tr>
                    <th colSpan={2}>{t("export.workout.muscle")}</th>
                    <th style={{ width: "40%" }} />
                    <th className="num">{t("export.report.sets")}</th>
                  </tr>
                </thead>
                <tbody>
                  {muscles.map(([id, n]) => (
                    <tr key={id}>
                      <td className="icon">
                        <PrintMuscleIcon id={id} view={view} />
                      </td>
                      <td>{bucketLabel(id, view)}</td>
                      <td>
                        <ShareBar value={n} max={muscleMax} />
                      </td>
                      <td className="num">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {show("prs") && prs.length > 0 && (
            <>
              <h3>{t("export.report.prs")}</h3>
              <table>
                <thead>
                  <tr>
                    <th colSpan={2}>{t("export.workout.exercise")}</th>
                    <th>{t("export.report.date")}</th>
                    <th className="num">{t("export.report.best")}</th>
                    <th className="num">{t("export.report.est1rm")}</th>
                  </tr>
                </thead>
                <tbody>
                  {prs.map((pr) => (
                    <tr key={pr.exercise_id}>
                      <td className="icon">
                        <PrintThumb exerciseId={pr.exercise_id} />
                      </td>
                      <td>{exerciseLabel(pr.exercise_id)}</td>
                      <td>{isoToDisplay(pr.date)}</td>
                      <td className="num">
                        {pr.weight_kg} kg × {pr.reps}
                      </td>
                      <td className="num">{pr.est_1rm_kg.toFixed(1)} kg</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </section>
  );
}

function CardioSection({ data, show }: { data: CardioData; show: Show<"cardio"> }) {
  const { t } = useTranslation();
  const entries = [...data.entries].sort((a, b) => a.date.localeCompare(b.date));
  const rhr = entries.flatMap((e) =>
    e.resting_heart_rate == null ? [] : [{ date: e.date, value: e.resting_heart_rate }],
  );
  const vo2 = entries.flatMap((e) =>
    e.vo2_max == null ? [] : [{ date: e.date, value: e.vo2_max }],
  );
  const stats = [
    metricStat(
      t("export.report.restingHr"),
      data.stats.resting_heart_rate,
      latestDate(entries, (e) => e.resting_heart_rate),
      0,
    ),
    metricStat(
      t("export.report.vo2max"),
      data.stats.vo2_max,
      latestDate(entries, (e) => e.vo2_max),
    ),
  ].filter((s): s is Stat => s != null);
  return (
    <section className="section">
      <h2>{t("export.report.sections.cardio")}</h2>
      {entries.length === 0 ? (
        <Empty />
      ) : (
        <>
          {show("summary") && <StatGrid stats={stats} />}
          {show("restingHr") && rhr.length > 1 && (
            <>
              <h3>{t("export.report.restingHr")}</h3>
              <PrintLineChart points={rhr} unit="bpm" digits={0} />
            </>
          )}
          {show("vo2max") && vo2.length > 1 && (
            <>
              <h3>{t("export.report.vo2max")}</h3>
              <PrintLineChart points={vo2} unit="" />
            </>
          )}
        </>
      )}
    </section>
  );
}

function ProgressReportDoc({ data }: { data: ReportData }) {
  const { t } = useTranslation();
  return (
    <>
      <PrintHeader
        kind={t("export.kinds.progressReport")}
        title={t("export.report.title")}
        subtitle={`${isoToDisplay(data.from)} – ${isoToDisplay(data.to)}`}
      />
      {data.body && <BodySection data={data.body} show={showFor(data.blocks, "body")} />}
      {data.measurements && (
        <MeasurementsSection data={data.measurements} show={showFor(data.blocks, "measurements")} />
      )}
      {data.nutrition && (
        <NutritionSection
          data={data.nutrition}
          from={data.from}
          to={data.to}
          show={showFor(data.blocks, "nutrition")}
        />
      )}
      {data.training && (
        <TrainingSection
          data={data.training}
          from={data.from}
          to={data.to}
          show={showFor(data.blocks, "training")}
        />
      )}
      {data.exercises && (
        <section className="section">
          <h2>{t("export.report.sections.exercises")}</h2>
          {data.exerciseView && data.exercises.length > 0 && (
            <p className="muted small">{chartViewNote(data.exerciseView)}</p>
          )}
          {data.exercises.length === 0 ? (
            <Empty />
          ) : (
            <ExerciseProgressBody
              list={data.exercises}
              show={showFor(data.blocks, "exercises")}
              view={data.exerciseView}
              nested
            />
          )}
        </section>
      )}
      {data.cardio && <CardioSection data={data.cardio} show={showFor(data.blocks, "cardio")} />}
    </>
  );
}

// ---------- dialog ----------

// Which exercises the Exercises section prints: an "All" toggle over a
// scrolling list. Exercises with no sessions in the period drop out of the PDF.
function ExerciseChecklist({
  options,
  skipped,
  onChange,
  loading,
  view,
  onView,
}: {
  options: ExerciseId[];
  skipped: Set<ExerciseId>;
  onChange: (next: Set<ExerciseId>) => void;
  loading: boolean;
  view: ChartView;
  onView: (next: ChartView) => void;
}) {
  const { t } = useTranslation();
  // The chart menu's average + spacing choices, as chips.
  const chip = (active: boolean, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground soft:border-transparent soft:shadow-pressed"
          : "text-muted-foreground hover:bg-accent soft:border-transparent soft:shadow-control",
      )}
    >
      {label}
    </button>
  );
  const viewControls = (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 ps-6 text-xs">
      <span className="flex items-center gap-1 whitespace-nowrap">
        <span className="text-muted-foreground">{t("body.averageLabel")}</span>
        {AVERAGE_OPTIONS.map((o) =>
          chip(view.average === o.value, averageShortLabel(o.value, t), () =>
            onView({ ...view, average: o.value }),
          ),
        )}
      </span>
      <span className="flex items-center gap-1 whitespace-nowrap">
        <span className="text-muted-foreground">{t("body.spacingLabel")}</span>
        {(["even", "date"] as const).map((s) =>
          chip(
            view.spacing === s,
            t(s === "date" ? "body.spacingByDate" : "body.spacingEven"),
            () => onView({ ...view, spacing: s }),
          ),
        )}
      </span>
    </div>
  );
  if (loading) return <Skeleton className="ms-6 mt-2 h-16" />;
  if (options.length === 0)
    return (
      <p className="mt-2 ps-6 text-xs text-muted-foreground">{t("export.exercise.noneTrained")}</p>
    );
  const on = options.length - options.filter((id) => skipped.has(id)).length;
  const toggle = (id: ExerciseId, checked: boolean) => {
    const next = new Set(skipped);
    if (checked) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <>
      {viewControls}
      <div className="mt-2 space-y-1 ps-6">
        <label className="flex items-center gap-1.5 text-xs font-medium soft:cursor-pointer">
          <input
            type="checkbox"
            className="nm-check size-3.5"
            checked={on === options.length}
            ref={(el) => {
              if (el) el.indeterminate = on > 0 && on < options.length;
            }}
            onChange={(e) => onChange(new Set(e.target.checked ? [] : options))}
          />
          {t("export.exercise.exercises")}
          <span className="font-normal text-muted-foreground">
            {on}/{options.length}
          </span>
        </label>
        <ul className="max-h-48 space-y-1 overflow-y-auto ps-5">
          {options.map((id) => (
            <li key={id}>
              <label
                className={cn(
                  "flex items-center gap-1.5 text-xs soft:cursor-pointer",
                  skipped.has(id) && "text-muted-foreground",
                )}
              >
                <input
                  type="checkbox"
                  className="nm-check size-3.5"
                  checked={!skipped.has(id)}
                  onChange={(e) => toggle(id, e.target.checked)}
                />
                <span className="truncate">{exerciseLabel(id)}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// The export options (period, sections) and the Export button, shown inline in
// the profile's expandable Export section. `onCancel` adds a Cancel button;
// `onExported` runs once the print dialog has been handed the report.
export function ProgressReportOptions({
  onExported,
  onCancel,
}: {
  onExported?: () => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(90);
  const [blocks, setBlocks] = useState<Set<BlockKey>>(() => new Set(ALL_BLOCKS));
  // Exercises section: every lift with a PR, most recent first (cardio has no
  // 1RM). Tracked as the unchecked ones, so all start checked once loaded.
  const prsQ = useGetWorkoutProgressPrs({ limit: 100 });
  const exerciseOptions = useMemo(() => {
    const ids = new Set<ExerciseId>();
    for (const pr of (prsQ.data?.prs as unknown as WorkoutPR[] | undefined) ?? [])
      if (getExercise(pr.exercise_id)?.type !== "cardio") ids.add(pr.exercise_id);
    return [...ids];
  }, [prsQ.data]);
  const [skipped, setSkipped] = useState<Set<ExerciseId>>(() => new Set());
  // Starts from the Workout → Progress chart settings.
  const [exerciseView, setExerciseView] = useState<ChartView>(() => {
    const s = useUiStore.getState();
    return { average: s.workoutChartAverage, spacing: s.workoutChartSpacing };
  });
  const pickedExercises = exerciseOptions.filter((id) => !skipped.has(id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Checking/unchecking a set of boxes at once (one block, or a whole section).
  const setMany = (keys: BlockKey[], on: boolean) => {
    const next = new Set(blocks);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    setBlocks(next);
  };

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const data = { ...(await loadReport(days, blocks, pickedExercises)), exerciseView };
      await printDocument(
        `${t("export.report.title")} ${data.from} – ${data.to}`,
        <ProgressReportDoc data={data} />,
      );
      onExported?.();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("export.report.period")}</p>
        <div className="grid grid-cols-4 gap-1.5 soft:gap-2.5">
          {PERIODS.map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={days === p ? "default" : "outline"}
              className={
                days === p
                  ? "soft:bg-background soft:text-primary soft:shadow-pressed soft:hover:bg-background"
                  : "soft:hover:bg-background soft:hover:text-primary"
              }
              aria-pressed={days === p}
              onClick={() => setDays(p)}
              disabled={busy}
            >
              {t(`export.report.periods.${p}`)}
            </Button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t("export.report.include")}</p>
        <div className="space-y-2 soft:space-y-3">
          {SECTIONS.map((s) => {
            const keys = blocksOf(s).map((b): BlockKey => `${s}.${b}`);
            const on = keys.filter((k) => blocks.has(k)).length;
            return (
              // Soft: an included section is a raised tile, a fully left-out
              // one sinks into a well.
              <fieldset
                key={s}
                className={cn(
                  "rounded-md border border-edge px-3 py-2 transition-shadow soft:px-3.5 soft:py-2.5",
                  on > 0 ? "soft:shadow-tile" : "soft:shadow-well",
                )}
                disabled={busy}
              >
                <label
                  className={cn(
                    "flex items-center gap-2 text-sm font-medium soft:cursor-pointer",
                    on === 0 && "soft:text-muted-foreground",
                  )}
                >
                  <input
                    type="checkbox"
                    className="nm-check size-4"
                    checked={on === keys.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && on < keys.length;
                    }}
                    onChange={(e) => setMany(keys, e.target.checked)}
                  />
                  {t(`export.report.sections.${s}`)}
                </label>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 ps-6">
                  {blocksOf(s).map((b) => {
                    const key: BlockKey = `${s}.${b}`;
                    return (
                      <label
                        key={b}
                        className={cn(
                          "flex items-center gap-1.5 text-xs soft:cursor-pointer",
                          !blocks.has(key) && "text-muted-foreground",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="nm-check size-3.5"
                          checked={blocks.has(key)}
                          onChange={(e) => setMany([key], e.target.checked)}
                        />
                        {t(BLOCK_LABEL[b])}
                      </label>
                    );
                  })}
                </div>
                {s === "exercises" && on > 0 && (
                  <ExerciseChecklist
                    options={exerciseOptions}
                    skipped={skipped}
                    onChange={setSkipped}
                    loading={prsQ.isPending}
                    view={exerciseView}
                    onView={setExerciseView}
                  />
                )}
              </fieldset>
            );
          })}
        </div>
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
        )}
        <Button
          type="button"
          className="gap-1"
          onClick={() => void run()}
          disabled={busy || blocks.size === 0}
        >
          <FileDown className="size-4" />
          {busy ? t("export.preparing") : t("export.exportPdf")}
        </Button>
      </div>
    </div>
  );
}
