import { useTranslation } from "react-i18next";
import { humanizeFoodName, type ResolvedDietPlan, type Weekday } from "@fa/shared";
import i18n from "../i18n";
import { formatTime24 } from "../lib/dateFormat";
import { MacroCells, MacroStats, PrintHeader, printDocument } from "./printDoc";
import { MacroSplit, ShareBar, TargetBars, type WeekCell, WeekStrip } from "./printViz";

function DietPlanDoc({ plan }: { plan: ResolvedDietPlan }) {
  const { t } = useTranslation();
  const week: Partial<Record<Weekday, WeekCell[]>> = {};
  for (const d of plan.rotation)
    for (const w of d.weekdays)
      (week[w] ??= []).push({ title: d.name, note: `${Math.round(d.totals.kcal)} kcal` });
  return (
    <>
      <PrintHeader
        kind={t("export.kinds.dietPlan")}
        title={plan.name}
        subtitle={t("export.diet.daysCount", { count: plan.rotation.length })}
      />
      {Object.keys(week).length > 0 && <WeekStrip cells={week} />}
      {plan.default_target && (
        <>
          <h2>{t("export.diet.dailyTarget")}</h2>
          <MacroStats macros={plan.default_target} />
        </>
      )}
      {plan.rotation.map((day) => {
        // Frame the day against its own target, else the plan's default.
        const ref = day.target ?? plan.default_target ?? null;
        return (
          <section key={day.id} className="section">
            <h2>
              {day.name}
              {day.weekdays.length > 0 && (
                <span className="muted small" style={{ fontWeight: 400 }}>
                  {"  "}
                  {day.weekdays.map((w) => t(`workout.weekdays.${w}`)).join(", ")}
                </span>
              )}
            </h2>
            {ref ? (
              <TargetBars value={day.totals} target={ref} />
            ) : (
              <MacroStats macros={day.totals} label={t("export.diet.planned")} />
            )}
            <MacroSplit macros={day.totals} />
            {day.meals.length === 0 ? (
              <p className="muted small">{t("diet.noMealsPlanned")}</p>
            ) : (
              day.meals.map((meal) => (
                <div key={meal.id} className="block">
                  <div className="block-head">
                    <h3 style={{ textTransform: "capitalize" }}>
                      {meal.slot}
                      {meal.time && <span className="muted"> · {formatTime24(meal.time)}</span>}
                    </h3>
                    {day.totals.kcal > 0 && (
                      <span className="meal-share">
                        <ShareBar value={meal.totals.kcal} max={day.totals.kcal} />
                        <span className="small muted">
                          {t("export.diet.shareOfDay", {
                            pct: Math.round((meal.totals.kcal / day.totals.kcal) * 100),
                          })}
                        </span>
                      </span>
                    )}
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>{t("export.diet.food")}</th>
                        <th className="num">{t("export.diet.grams")}</th>
                        <th className="num">{t("export.kcal")}</th>
                        <th className="num">{t("export.proteinShort")}</th>
                        <th className="num">{t("export.fatShort")}</th>
                        <th className="num">{t("export.carbsShort")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meal.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            {humanizeFoodName(item.food)}
                            {item.resolved == null && (
                              <span className="warn"> · {t("diet.needsMacros")}</span>
                            )}
                          </td>
                          <td className="num">{Math.round(item.grams)} g</td>
                          <MacroCells m={item.resolved} />
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>{t("export.diet.mealTotal")}</td>
                        <td />
                        <MacroCells m={meal.totals} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ))
            )}
          </section>
        );
      })}
      <p className="footer-note">{t("export.diet.footer")}</p>
    </>
  );
}

export function exportDietPlanPdf(plan: ResolvedDietPlan): Promise<void> {
  return printDocument(
    `${plan.name} — ${i18n.t("export.kinds.dietPlan")}`,
    <DietPlanDoc plan={plan} />,
  );
}
