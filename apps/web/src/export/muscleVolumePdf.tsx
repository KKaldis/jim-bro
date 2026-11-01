/**
 * "Volume by muscle group" PDF: the Workout → Progress volume card as shown —
 * same period, metric (volume / sets) and grouping (groups / muscles). A ranked
 * totals table, then per group its weekly bars and the exercises behind them
 * (the card's expanded detail). Opened from the card's filter row.
 */
import {
  type ExerciseId,
  getExercise,
  type MuscleGroupId,
  setVolume,
  type WorkoutSession,
} from "@fa/shared";
import { bucketLabel, bucketsForExercise } from "../components/MuscleViewToggle";
import { exerciseLabel } from "../forms/workoutControls";
import i18n from "../i18n";
import { isoToDisplay } from "../lib/dateFormat";
import type { MuscleView } from "../lib/uiStore";
import { PrintHeader, printDocument } from "./printDoc";
import { PrintBarChart, PrintMuscleIcon, PrintTypeTag, ShareBar } from "./printViz";

export type VolumeMetric = "volume" | "sets";
// A group as the card lists it: its weeks (Monday + totals, 0 = not trained)
// on the period's shared week axis, and the period totals.
export type VolumeRow = {
  groupId: MuscleGroupId;
  weeks: Array<{ week: string; volume: number; sets: number }>;
  totalVolume: number;
  totalSets: number;
};

const kg = (n: number) => `${Math.round(n).toLocaleString()} kg`;

type ExerciseTally = Map<ExerciseId, { volume: number; sets: number }>;
type TypeSplit = { type: "compound" | "isolation"; count: number; volume: number; sets: number };

// A group's exercises split by type, as the card's expanded detail: per type,
// how many exercises and their volume / sets. Cardio is left out.
function typeSplit(exercises: ExerciseTally | undefined): TypeSplit[] {
  return (["compound", "isolation"] as const)
    .map((type) => {
      const of = [...(exercises ?? [])].filter(([id]) => getExercise(id)?.type === type);
      return {
        type,
        count: of.length,
        volume: of.reduce((n, [, e]) => n + e.volume, 0),
        sets: of.reduce((n, [, e]) => n + e.sets, 0),
      };
    })
    .filter((s) => s.count > 0);
}

// "2 Compound" pill in the app's badge styling (classes in printDoc's CSS).
function TypePill({ split }: { split: TypeSplit }) {
  return (
    <span className={`type-tag ${split.type}`}>
      {split.count} {i18n.t(`workout.exerciseType.${split.type}`)}
    </span>
  );
}

export function exportMuscleVolumePdf({
  rows,
  metric,
  view,
  period,
  sessions,
}: {
  rows: VolumeRow[];
  metric: VolumeMetric;
  view: MuscleView;
  period: { from: string; to: string };
  sessions: WorkoutSession[];
}): Promise<void> {
  const t = i18n.t.bind(i18n);
  const title = t("workout.volumeByGroup");
  const pick = (v: { volume: number; sets: number }) => (metric === "volume" ? v.volume : v.sets);
  const total = (r: VolumeRow) => (metric === "volume" ? r.totalVolume : r.totalSets);
  const max = Math.max(0, ...rows.map(total));
  // Per group: the exercises that fed it, same attribution as the server (a
  // set counts in full toward every primary group of its exercise).
  const byGroup = new Map<MuscleGroupId, ExerciseTally>();
  for (const s of sessions)
    for (const set of s.sets)
      for (const g of bucketsForExercise(set.exercise_id, view)) {
        const m = byGroup.get(g) ?? new Map();
        const ex = m.get(set.exercise_id) ?? { volume: 0, sets: 0 };
        ex.volume += setVolume(set);
        ex.sets += 1;
        m.set(set.exercise_id, ex);
        byGroup.set(g, m);
      }
  const subtitle = [
    `${isoToDisplay(period.from)} – ${isoToDisplay(period.to)}`,
    t(metric === "volume" ? "workout.metricVolume" : "workout.metricSets"),
    t(view === "group" ? "workout.muscleViewGroups" : "workout.muscleViewMuscles"),
  ].join(" · ");
  return printDocument(
    `${title} ${period.from} – ${period.to}`,
    <>
      <PrintHeader kind={t("export.report.sections.training")} title={title} subtitle={subtitle} />
      <table className="keep">
        <thead>
          <tr>
            <th colSpan={2}>{t("export.workout.muscle")}</th>
            <th style={{ width: "36%" }} />
            <th className="num">{t("workout.metricVolume")}</th>
            <th className="num">{t("workout.metricSets")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.groupId}>
              <td className="icon">
                <PrintMuscleIcon id={r.groupId} view={view} />
              </td>
              <td>
                <div style={{ textTransform: "capitalize" }}>{bucketLabel(r.groupId, view)}</div>
                <span className="type-tags">
                  {typeSplit(byGroup.get(r.groupId)).map((s) => (
                    <TypePill key={s.type} split={s} />
                  ))}
                </span>
              </td>
              <td>
                <ShareBar value={total(r)} max={max} />
              </td>
              <td className="num" style={metric === "volume" ? { fontWeight: 700 } : undefined}>
                {kg(r.totalVolume)}
              </td>
              <td className="num" style={metric === "sets" ? { fontWeight: 700 } : undefined}>
                {r.totalSets}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.map((r) => {
        const exercises = [...(byGroup.get(r.groupId) ?? [])].sort((a, b) =>
          metric === "volume" ? b[1].volume - a[1].volume : b[1].sets - a[1].sets,
        );
        const split = typeSplit(byGroup.get(r.groupId));
        return (
          <section key={r.groupId} className="section keep">
            <h2 style={{ textTransform: "capitalize" }}>
              <PrintMuscleIcon id={r.groupId} view={view} />
              {bucketLabel(r.groupId, view)}
            </h2>
            {r.weeks.length > 1 && (
              <PrintBarChart
                bars={r.weeks.map((w) => ({ label: isoToDisplay(w.week), value: pick(w) }))}
                unit={metric === "volume" ? "kg" : t("export.report.sets")}
              />
            )}
            {split.length > 0 && (
              <div className="stats">
                {split.map((s) => (
                  <div key={s.type} className="stat">
                    <TypePill split={s} />
                    <div className="stat-value" style={{ fontSize: "11pt" }}>
                      {s.volume > 0 ? kg(s.volume) : "—"}
                    </div>
                    <div className="stat-note">{t("workout.setsShort", { count: s.sets })}</div>
                  </div>
                ))}
              </div>
            )}
            {exercises.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>{t("export.workout.exercise")}</th>
                    <th style={{ textAlign: "center" }}>{t("export.workout.type")}</th>
                    <th className="num">{t("workout.metricVolume")}</th>
                    <th className="num">{t("workout.metricSets")}</th>
                  </tr>
                </thead>
                <tbody>
                  {exercises.map(([id, ex]) => (
                    <tr key={id}>
                      <td>{exerciseLabel(id)}</td>
                      <td style={{ textAlign: "center" }}>
                        <PrintTypeTag exerciseId={id} />
                      </td>
                      <td className="num">{ex.volume > 0 ? kg(ex.volume) : "—"}</td>
                      <td className="num">{ex.sets}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </>,
  );
}
