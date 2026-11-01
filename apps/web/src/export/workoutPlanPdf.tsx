import { useTranslation } from "react-i18next";
import {
  exerciseFields,
  getExercise,
  planMuscleTotals,
  type Weekday,
  type WorkoutPlan,
  type WorkoutPlanDay,
} from "@fa/shared";
import i18n from "../i18n";
import { bucketLabel, bucketsForExercise } from "../components/MuscleViewToggle";
import { exerciseLabel } from "../forms/workoutControls";
import { type MuscleView, useUiStore } from "../lib/uiStore";
import { PrintHeader, printDocument } from "./printDoc";
import {
  PrintMuscleIcon,
  PrintThumb,
  PrintTypeTag,
  ShareBar,
  type WeekCell,
  WEEK_ORDER,
  WeekStrip,
} from "./printViz";

const daySets = (d: WorkoutPlanDay) => d.exercises.reduce((m, e) => m + e.target_sets, 0);

// Compound / isolation exercise counts for a muscle row, as type pills.
function TypeCounts({ compound, isolation }: { compound: number; isolation: number }) {
  const { t } = useTranslation();
  if (compound === 0 && isolation === 0) return null;
  return (
    <span className="type-tags">
      {compound > 0 && (
        <span className="type-tag compound">
          {compound} {t("workout.exerciseType.compound")}
        </span>
      )}
      {isolation > 0 && (
        <span className="type-tag isolation">
          {isolation} {t("workout.exerciseType.isolation")}
        </span>
      )}
    </span>
  );
}

function WorkoutPlanDoc({ plan, view }: { plan: WorkoutPlan; view: MuscleView }) {
  const { t } = useTranslation();
  const scheduled = new Set(plan.days.flatMap((d) => d.weekdays));
  const totalSets = plan.days.reduce((n, d) => n + daySets(d), 0);
  const week: Partial<Record<Weekday, WeekCell[]>> = {};
  for (const d of plan.days)
    for (const w of d.weekdays)
      (week[w] ??= []).push({
        title: d.name,
        note: t("export.workout.setsShort", { count: daySets(d) }),
      });
  return (
    <>
      <PrintHeader
        kind={t("export.kinds.workoutPlan")}
        title={plan.name}
        subtitle={[
          t("export.workout.daysCount", { count: plan.days.length }),
          t("export.workout.setsPerRotation", { count: totalSets }),
          scheduled.size > 0
            ? WEEK_ORDER.filter((w) => scheduled.has(w))
                .map((w) => t(`workout.weekdays.${w}`))
                .join(", ")
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      {scheduled.size > 0 && <WeekStrip cells={week} />}
      {plan.notes && <p className="muted">{plan.notes}</p>}
      <MuscleTotals days={plan.days} view={view} />
      {plan.days.map((d, i) => {
        const sets = daySets(d);
        // Every muscle the day trains, for one pass of the day (the weekly
        // totals below multiply by scheduled weekdays).
        const focus = planMuscleTotals([{ exercises: d.exercises }], (id) =>
          bucketsForExercise(id, view),
        );
        return (
          // Page 1 is the overview (schedule + weekly totals); days follow.
          <section key={d.id} className={i === 0 ? "page-start block" : "block"}>
            <div className="block-head">
              <h3>
                {d.name}
                {d.focus && <span className="muted"> · {d.focus}</span>}
              </h3>
              <span className="chips">
                {d.weekdays.map((w) => (
                  <span key={w} className="chip">
                    {t(`workout.weekdays.${w}`)}
                  </span>
                ))}
              </span>
            </div>
            {d.exercises.length === 0 ? (
              <p className="muted small">{t("workout.noExercises")}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "4%" }}>#</th>
                    <th colSpan={2}>{t("export.workout.exercise")}</th>
                    <th className="num">{t("export.workout.sets")}</th>
                    <th className="num">{t("export.workout.target")}</th>
                    <th className="num">{t("export.workout.weight")}</th>
                    <th>{t("export.workout.notes")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...d.exercises]
                    .sort((a, b) => a.order - b.order)
                    .map((e, i) => {
                      const fields = exerciseFields(getExercise(e.exercise_id));
                      const target = fields.reps
                        ? e.target_reps != null
                          ? t("export.workout.reps", { count: e.target_reps })
                          : "—"
                        : e.target_duration_sec != null
                          ? formatDuration(e.target_duration_sec)
                          : e.target_distance_m != null
                            ? `${e.target_distance_m} m`
                            : "—";
                      return (
                        <tr key={e.id}>
                          <td className="muted">{i + 1}</td>
                          <td className="icon">
                            <PrintThumb exerciseId={e.exercise_id} machineId={e.machine_id} />
                          </td>
                          <td>
                            <div>{exerciseLabel(e.exercise_id)}</div>
                            <PrintTypeTag exerciseId={e.exercise_id} />
                          </td>
                          <td className="num">{e.target_sets}</td>
                          <td className="num">{target}</td>
                          <td className="num">
                            {e.target_weight_kg != null ? `${e.target_weight_kg} kg` : "—"}
                          </td>
                          <td className="muted small">{e.notes ?? ""}</td>
                        </tr>
                      );
                    })}
                </tbody>
                <tfoot>
                  <tr>
                    <td />
                    <td colSpan={2}>{t("export.workout.total")}</td>
                    <td className="num">{sets}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            )}
            {focus.length > 0 && (
              <div className="day-muscles">
                <div className="legend-title">{t("export.workout.daySummary")}</div>
                <div className="day-muscle-grid">
                  {focus.map((m) => (
                    <div key={m.group} className="day-muscle">
                      <PrintMuscleIcon id={m.group} view={view} />
                      <div>
                        <div className="day-muscle-name">{bucketLabel(m.group, view)}</div>
                        <div className="muted small">
                          {t("export.workout.setsShort", { count: m.sets })}
                          {m.reps > 0 &&
                            ` · ${t("formsAdmin.workoutPlan.repCount", { count: m.reps })}`}
                        </div>
                        <TypeCounts compound={m.compound} isolation={m.isolation} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

// Weekly sets / reps per muscle — the plan card's "Total per week" panel
// (planMuscleTotals), in the groups-vs-muscles view the user last picked.
// The bar scales each row's sets against the busiest muscle.
function MuscleTotals({ days, view }: { days: WorkoutPlan["days"]; view: MuscleView }) {
  const { t } = useTranslation();
  const totals = planMuscleTotals(days, (id) => bucketsForExercise(id, view));
  if (totals.length === 0) return null;
  const max = Math.max(...totals.map((r) => r.sets));
  return (
    <section className="keep">
      <h2>{t("formsAdmin.workoutPlan.muscleTotals")}</h2>
      <table>
        <thead>
          <tr>
            <th colSpan={2}>{t("export.workout.muscle")}</th>
            <th style={{ width: "34%" }} />
            <th className="num">{t("export.workout.setsPerWeek")}</th>
            <th className="num">{t("export.workout.volume")}</th>
          </tr>
        </thead>
        <tbody>
          {totals.map(({ group, sets, reps, seconds, compound, isolation }) => (
            <tr key={group}>
              <td className="icon">
                <PrintMuscleIcon id={group} view={view} />
              </td>
              <td>
                <div style={{ textTransform: "capitalize" }}>{bucketLabel(group, view)}</div>
                <TypeCounts compound={compound} isolation={isolation} />
              </td>
              <td>
                <ShareBar value={sets} max={max} />
              </td>
              <td className="num">{sets}</td>
              <td className="num">
                {[
                  reps > 0 && t("formsAdmin.workoutPlan.repCount", { count: reps }),
                  seconds > 0 &&
                    (seconds >= 60
                      ? t("formsAdmin.workoutPlan.holdMinutes", {
                          value: Math.round((seconds / 60) * 10) / 10,
                        })
                      : t("formsAdmin.workoutPlan.holdSeconds", { value: seconds })),
                ]
                  .filter(Boolean)
                  .join(" + ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="footer-note">{t("export.workout.muscleNote")}</p>
    </section>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m} min`;
}

export function exportWorkoutPlanPdf(plan: WorkoutPlan): Promise<void> {
  return printDocument(
    `${plan.name} — ${i18n.t("export.kinds.workoutPlan")}`,
    <WorkoutPlanDoc plan={plan} view={useUiStore.getState().muscleView} />,
  );
}
