/**
 * Per-exercise strength trends (est. 1RM, top set, volume) for print. Used two
 * ways: a one-exercise PDF from the Workout → Progress chart menu, and the
 * Exercises section of the profile's progress report (exercises picked there).
 */
import { useTranslation } from "react-i18next";
import { type ExerciseId, type ExerciseProgressPoint } from "@fa/shared";
import { getWorkoutProgressExerciseId } from "../api/endpoints/default/default";
import { averageTrend } from "../components/SpacingToggle";
import type { ChartSpacing } from "../lib/uiStore";
import { exerciseLabel } from "../forms/workoutControls";
import i18n from "../i18n";
import { isoToDisplay } from "../lib/dateFormat";
import {
  PrintHeader,
  PrintLineChart,
  printDocument,
  signed,
  type Stat,
  StatGrid,
} from "./printDoc";
import { PrintThumb, PrintTypeTag } from "./printViz";

type Period = { from: string; to: string };
export type ExerciseSeries = { id: ExerciseId; points: ExerciseProgressPoint[] };

// The parts of the document the user can leave out, in print order.
export const EXERCISE_PARTS = ["summary", "est1rm", "topSet", "volume"] as const;
export type ExercisePart = (typeof EXERCISE_PARTS)[number];
type Part = ExercisePart;
type ShowPart = (p: Part) => boolean;
// The on-screen chart settings to print with: average window in days (0 =
// none) and point spacing.
export type ChartView = { average: number; spacing: ChartSpacing };
const DATE_VIEW: ChartView = { average: 0, spacing: "date" };

// "7-day average · Points spaced by date" — printed with the charts so the
// reader knows how they were drawn.
export function chartViewNote(view: ChartView): string {
  return [
    view.average > 0
      ? i18n.t("body.averageDays", { count: view.average })
      : i18n.t("export.exercise.averageNone"),
    i18n.t(view.spacing === "even" ? "export.exercise.spacingEven" : "export.exercise.spacingDate"),
  ].join(" · ");
}
export const EXERCISE_PART_LABEL: Record<Part, string> = {
  summary: "export.exercise.summary",
  est1rm: "workout.chartEst1rm",
  topSet: "workout.chartTopSetWeight",
  volume: "workout.chartTotalVolume",
};

const kg = (n: number) => `${n.toFixed(1)} kg`;

// Latest value with its change since the first session of the period.
function trendStat(label: string, values: number[]): Stat | null {
  if (values.length === 0 || values.every((v) => v === 0)) return null;
  const first = values[0];
  const last = values[values.length - 1];
  return {
    label,
    value: kg(last),
    note:
      values.length > 1
        ? i18n.t("export.report.changeFrom", {
            change: signed(last - first),
            first: first.toFixed(1),
          })
        : undefined,
  };
}

// `nested` = inside the progress report's Exercises section: one heading level
// down, so each exercise sits under that section's h2.
function ExerciseBlock({
  series,
  show,
  nested,
  view,
}: {
  series: ExerciseSeries;
  show: ShowPart;
  nested: boolean;
  view: ChartView;
}) {
  const { t } = useTranslation();
  const { id, points } = series;
  const line = (pick: (p: ExerciseProgressPoint) => number) =>
    points.map((p) => ({ date: p.date, value: pick(p) }));
  const charts = (
    [
      ["est1rm", "workout.chartEst1rm", line((p) => p.est_1rm_kg)],
      ["topSet", "workout.chartTopSetWeight", line((p) => p.top_weight_kg)],
      ["volume", "workout.chartTotalVolume", line((p) => p.total_volume_kg)],
    ] as const
  ).filter(([part, , pts]) => show(part) && pts.some((p) => p.value > 0));
  const Title = nested ? "h3" : "h2";
  const best = points.reduce<ExerciseProgressPoint | null>(
    (b, p) => (!b || p.top_weight_kg > b.top_weight_kg ? p : b),
    null,
  );
  const stats = [
    { label: t("export.report.sessions"), value: String(points.length) },
    trendStat(
      t("export.report.est1rm"),
      points.map((p) => p.est_1rm_kg),
    ),
    best && best.top_weight_kg > 0
      ? {
          label: t("export.report.best"),
          value: `${best.top_weight_kg} kg × ${best.top_reps_at_top_weight}`,
          note: isoToDisplay(best.date),
        }
      : null,
  ].filter((s): s is Stat => s != null);
  return (
    <section
      className={nested ? undefined : "section"}
      style={nested ? { marginTop: 16 } : undefined}
    >
      <Title style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PrintThumb exerciseId={id} />
        {exerciseLabel(id)}
        <PrintTypeTag exerciseId={id} />
      </Title>
      {points.length === 0 ? (
        <p className="muted small">{t("export.report.noData")}</p>
      ) : (
        <>
          <StatGrid stats={stats} />
          {charts.map(([part, title, pts]) => (
            <div key={part}>
              {nested ? (
                <p className="small muted" style={{ margin: "0 0 2px" }}>
                  {t(title)}
                </p>
              ) : (
                <h3>{t(title)}</h3>
              )}
              <PrintLineChart
                points={pts}
                unit="kg"
                even={view.spacing === "even"}
                trend={averageTrend(pts, view.average, t)}
              />
            </div>
          ))}
        </>
      )}
    </section>
  );
}

// One row per exercise: sessions, est. 1RM first → latest, best top set.
function SummaryTable({ list, nested }: { list: ExerciseSeries[]; nested: boolean }) {
  const { t } = useTranslation();
  return (
    <section className={nested ? "keep" : "section"}>
      {nested ? <h3>{t("export.exercise.summary")}</h3> : <h2>{t("export.exercise.summary")}</h2>}
      <table>
        <thead>
          <tr>
            <th colSpan={2}>{t("export.workout.exercise")}</th>
            <th className="num">{t("export.report.sessions")}</th>
            <th className="num">{t("export.report.first")}</th>
            <th className="num">{t("export.report.latest")}</th>
            <th className="num">{t("export.report.change")}</th>
            <th className="num">{t("export.report.best")}</th>
          </tr>
        </thead>
        <tbody>
          {list.map(({ id, points }) => {
            const first = points[0];
            const last = points[points.length - 1];
            const best = Math.max(0, ...points.map((p) => p.top_weight_kg));
            const has1rm = !!last && last.est_1rm_kg > 0;
            return (
              <tr key={id}>
                <td className="icon">
                  <PrintThumb exerciseId={id} />
                </td>
                <td>
                  <div>{exerciseLabel(id)}</div>
                  <PrintTypeTag exerciseId={id} />
                </td>
                <td className="num">{points.length}</td>
                <td className="num">{has1rm ? kg(first.est_1rm_kg) : "—"}</td>
                <td className="num">{has1rm ? kg(last.est_1rm_kg) : "—"}</td>
                <td className="num">
                  {has1rm && points.length > 1
                    ? `${signed(last.est_1rm_kg - first.est_1rm_kg)} kg`
                    : "—"}
                </td>
                <td className="num">{best > 0 ? `${best} kg` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="footer-note">{t("export.exercise.summaryNote")}</p>
    </section>
  );
}

// The summary table (when shown) then a block per exercise. The progress
// report renders this nested inside its own Exercises section.
export function ExerciseProgressBody({
  list,
  show,
  nested = false,
  view = DATE_VIEW,
}: {
  list: ExerciseSeries[];
  show: ShowPart;
  nested?: boolean;
  view?: ChartView;
}) {
  return (
    <>
      {show("summary") && list.length > 1 && <SummaryTable list={list} nested={nested} />}
      {list.map((s) => (
        <ExerciseBlock key={s.id} series={s} show={show} nested={nested} view={view} />
      ))}
    </>
  );
}

// Each exercise's sessions in the window, oldest first. `window` undefined =
// the server's rolling look-back (the Progress tab's day view).
export async function loadExerciseSeries(
  ids: ExerciseId[],
  window: Period | undefined,
): Promise<ExerciseSeries[]> {
  return Promise.all(
    ids.map(async (id) => {
      const r = await getWorkoutProgressExerciseId(id, window);
      const points = [...(r.points as unknown as ExerciseProgressPoint[])].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      return { id, points };
    }),
  );
}

// One exercise as it reads on Workout → Progress: same window, and the chart
// menu's average + spacing. Without a window the printed period spans the
// sessions found.
export async function exportExerciseProgressPdf(
  id: ExerciseId,
  window: Period | undefined,
  view: ChartView,
): Promise<void> {
  const list = await loadExerciseSeries([id], window);
  const dates = list.flatMap((s) => s.points.map((p) => p.date));
  const period = window ?? { from: dates[0] ?? "", to: dates[dates.length - 1] ?? "" };
  const title = exerciseLabel(id);
  await printDocument(
    `${title} ${period.from} – ${period.to}`,
    <>
      <PrintHeader
        kind={i18n.t("export.kinds.exerciseProgress")}
        title={title}
        subtitle={`${isoToDisplay(period.from)} – ${isoToDisplay(period.to)} · ${chartViewNote(view)}`}
      />
      <ExerciseProgressBody list={list} show={() => true} view={view} />
    </>,
  );
}
