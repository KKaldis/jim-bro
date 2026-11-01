// Result cards for body tools: BMI/FFMI/body fat, composition, proportions and progress.
import { RadarChart } from "@/components/radar-chart";
import type { Sex, Vo2MaxCategory } from "@fa/shared";
import { Dumbbell, Gauge, Minus, Percent, Scale, TrendingDown, TrendingUp } from "lucide-react";
import { cloneElement, Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { ProfileStat } from "../Dashboard";
import { humanize } from "../lib/catalogLabels";
import { gaugeColorScale, MetricGauge, proportionKind } from "../lib/metricGauge";
import { cn } from "../lib/utils";
import { Vo2MaxResultView } from "../workout/CardioSection";
import { BigStat, CardShell, dayTag, isObj, ListRow, massLabel, num, str } from "./primitives";
import type { ResultCardProps } from "./resultCards";

// ---------- compute_bmi ----------
export function BmiCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const bmi = num(data.bmi);
  if (bmi == null) return null;
  const cat = str(data.category);
  const band = isObj(data.healthy_weight_range_kg) ? data.healthy_weight_range_kg : null;
  const low = band ? num(band.low) : null;
  const high = band ? num(band.high) : null;
  return (
    <CardShell category={category} title="BMI">
      <BigStat value={bmi.toFixed(1)} label={cat ? humanize(cat) : undefined} />
      <MetricGauge kind="bmi" value={bmi} />
      {low != null && high != null && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {t("cards.bmi.healthyRange", { low: low.toFixed(1), high: high.toFixed(1) })}
        </div>
      )}
    </CardShell>
  );
}

// ---------- compute_ffmi ----------
export function FfmiCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const ffmi = num(data.ffmi);
  const norm = num(data.normalized_ffmi);
  if (ffmi == null && norm == null) return null;
  const cat = str(data.category);
  const sex =
    isObj(data.inputs) && (data.inputs.sex === "male" || data.inputs.sex === "female")
      ? (data.inputs.sex as Sex)
      : undefined;
  const ffm = num(data.fat_free_mass_kg);
  const fatMass = num(data.fat_mass_kg);
  return (
    <CardShell category={category} title="FFMI">
      <div className="flex flex-wrap gap-5">
        {ffmi != null && <BigStat value={ffmi.toFixed(1)} label="FFMI" />}
        {norm != null && <BigStat value={norm.toFixed(1)} label={t("cards.ffmi.normalized")} />}
        {ffm != null && (
          <BigStat value={ffm.toFixed(1)} unit="kg" label={t("cards.body.leanMass")} />
        )}
        {fatMass != null && (
          <BigStat value={fatMass.toFixed(1)} unit="kg" label={t("cards.leanMass.fatMass")} />
        )}
      </div>
      <MetricGauge kind="ffmi" value={norm ?? ffmi} sex={sex} />
      {cat && <div className="mt-1 text-[11px] text-muted-foreground">{humanize(cat)}</div>}
      {ffm != null && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {t("cards.leanMass.composition")}
        </p>
      )}
    </CardShell>
  );
}

// ---------- estimate_body_fat ----------
export function BodyFatCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const bf = num(data.body_fat_pct);
  if (bf == null) return null;
  const method = str(data.method);
  const sex =
    isObj(data.inputs) && (data.inputs.sex === "male" || data.inputs.sex === "female")
      ? (data.inputs.sex as Sex)
      : undefined;
  return (
    <CardShell
      category={category}
      title={t("cards.body.bodyFat")}
      subtitle={method ? t("cards.bodyFat.methodEstimate", { method }) : null}
    >
      <BigStat value={bf.toFixed(1)} unit="%" />
      <MetricGauge kind="bodyFat" value={bf} sex={sex} />
    </CardShell>
  );
}

// ---------- get_body_composition ----------
// The user's CURRENT composition from their latest weigh-in. Reuses the SAME
// ProfileStat tile + MetricGauge grid the Dashboard's "Body composition" card
// renders (apps/web/src/Dashboard.tsx) — one component, two surfaces — so the
// chat card is visually identical to the screen, plus a trend block.
export function BodyCompositionCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || data.error) return null;
  const sex = data.sex === "male" || data.sex === "female" ? (data.sex as Sex) : undefined;
  const heightCm = num(data.height_cm);
  const weight = num(data.weight_kg);
  const bf = num(data.body_fat_pct);
  const bmi = num(data.bmi);
  const ffmiNorm = num(data.ffmi_normalized);
  const ffmi = num(data.ffmi);
  const ffmiVal = ffmiNorm ?? ffmi;
  const lean = num(data.fat_free_mass_kg);
  // Nothing card-able → fall back to the agent's prose.
  if (bf == null && bmi == null && ffmiVal == null && weight == null) return null;
  const bfMethod = str(data.body_fat_method);
  const navy = data.body_fat_source === "navy_estimate";
  const bfTag = navy ? "(navy)" : bfMethod ? `(${bfMethod})` : undefined;
  // `focus` lets a single-metric question ("what's my body fat") render just
  // that stat instead of the full grid; omitted → the whole composition.
  const focus = str(data.focus);

  // Each tile is tagged with its focus key + the trend label it pairs with, so
  // a focused view can show only the matching stat and its delta.
  const tiles: Array<{ key: string; trendLabel: string | null; el: ReactElement }> = [];
  if (weight != null) {
    tiles.push({
      key: "weight",
      trendLabel: t("cards.body.weight"),
      el: (
        <ProfileStat
          icon={Scale}
          label={t("cards.body.weight")}
          value={`${weight.toFixed(1)} kg`}
          gauge={<MetricGauge kind="weight" value={weight} heightCm={heightCm} />}
        />
      ),
    });
  }
  if (bf != null) {
    tiles.push({
      key: "body_fat",
      trendLabel: t("cards.body.bodyFat"),
      el: (
        <ProfileStat
          icon={Percent}
          label={t("cards.body.bodyFat")}
          value={`${bf.toFixed(1)}%`}
          tag={bfTag}
          gauge={<MetricGauge kind="bodyFat" value={bf} sex={sex} />}
        />
      ),
    });
  }
  if (bmi != null) {
    tiles.push({
      key: "bmi",
      trendLabel: null,
      el: (
        <ProfileStat
          icon={Gauge}
          label="BMI"
          value={bmi.toFixed(1)}
          gauge={<MetricGauge kind="bmi" value={bmi} />}
        />
      ),
    });
  }
  if (ffmiVal != null) {
    tiles.push({
      key: "ffmi",
      trendLabel: t("cards.body.leanMass"),
      el: (
        <ProfileStat
          icon={Dumbbell}
          label="FFMI"
          value={ffmiVal.toFixed(1)}
          sub={lean != null ? t("cards.body.kgLean", { kg: lean.toFixed(1) }) : undefined}
          gauge={<MetricGauge kind="ffmi" value={ffmiVal} sex={sex} />}
        />
      ),
    });
  }

  // Narrow to the focused metric when one is asked for and present; otherwise
  // (no focus, or the focused metric isn't available) show everything.
  const focusedTiles = focus ? tiles.filter((t) => t.key === focus) : [];
  const shown = focusedTiles.length ? focusedTiles : tiles;
  const isFocused = shown.length === 1;

  const FOCUS_TITLE: Record<string, string> = {
    weight: t("cards.body.weight"),
    body_fat: t("cards.body.bodyFat"),
    bmi: "BMI",
    ffmi: "FFMI",
  };
  const title =
    isFocused && focus
      ? (FOCUS_TITLE[focus] ?? t("cards.body.composition"))
      : t("cards.body.composition");

  const trend = isObj(data.trend) ? data.trend : null;
  const allTrendDeltas = trend
    ? [
        { label: t("cards.body.weight"), delta: num(trend.weight_kg), unit: "kg" },
        { label: t("cards.body.bodyFat"), delta: num(trend.body_fat_pct), unit: "%" },
        { label: t("cards.body.leanMass"), delta: num(trend.fat_free_mass_kg), unit: "kg" },
      ]
    : [];
  // In a focused view show only the trend row that pairs with the shown stat.
  const focusTrendLabel = isFocused ? shown[0]?.trendLabel : null;
  const trendDeltas = isFocused
    ? allTrendDeltas.filter((d) => d.label === focusTrendLabel)
    : allTrendDeltas;
  const hasTrend = trendDeltas.some((d) => d.delta != null);
  const trendWindow = trend ? num(trend.window_days) : null;

  return (
    <CardShell
      category={category}
      title={title}
      subtitle={dayTag(data, "body", { prefix: t("cards.body.asOf") })}
    >
      <div className={cn("grid gap-2.5", isFocused ? "grid-cols-1" : "grid-cols-2")}>
        {shown.map((t) => (
          // In a focused view the card header already names the metric, so drop
          // the tile's own (redundant) icon + label row.
          <Fragment key={t.key}>
            {isFocused ? cloneElement(t.el, { hideLabel: true }) : t.el}
          </Fragment>
        ))}
      </div>
      {hasTrend && (
        <div className="mt-3 border-t border-border/60 pt-2">
          <div className="mb-0.5 text-[11px] text-muted-foreground">
            {trendWindow != null
              ? t("cards.body.vsPriorDays", { count: trendWindow })
              : t("cards.body.trend")}
          </div>
          {trendDeltas.map((d) => (
            <DeltaRow key={d.label} label={d.label} delta={d.delta} unit={d.unit} />
          ))}
        </div>
      )}
    </CardShell>
  );
}

// ---------- estimate_vo2_max ----------
// Reuses Vo2MaxResultView (the same headline + category reference scale the
// Workout cardio section renders) so the chat card matches that screen exactly.
export function Vo2MaxCard({ data, category }: ResultCardProps) {
  if (!isObj(data)) return null;
  const vo2 = num(data.vo2_max);
  // Reference bands are sex/age-specific; without them fall back to prose.
  const inputs = isObj(data.inputs) ? data.inputs : null;
  const sex =
    inputs && (inputs.sex === "male" || inputs.sex === "female") ? (inputs.sex as Sex) : null;
  const age = inputs ? num(inputs.age) : null;
  if (vo2 == null || sex == null || age == null) return null;
  const cat = str(data.category);
  return (
    <CardShell category={category} title="VO₂max">
      <Vo2MaxResultView
        vo2Max={vo2}
        category={cat ? (cat as Vo2MaxCategory) : null}
        sex={sex}
        age={age}
        restingHr={num(data.resting_heart_rate)}
        maxHr={num(data.max_heart_rate)}
        maxHrEstimated={data.max_heart_rate_estimated === true}
      />
    </CardShell>
  );
}

// ---------- compute_ideal_weight ----------
export function IdealWeightCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const avg = num(data.average_kg);
  if (avg == null) return null;
  const imperial = data.units === "imperial";
  const formulas: Array<[string, number | null]> = [
    ["Devine", num(data.devine_kg)],
    ["Robinson", num(data.robinson_kg)],
    ["Miller", num(data.miller_kg)],
    ["Hamwi", num(data.hamwi_kg)],
  ];
  const band = isObj(data.healthy_bmi_range_kg) ? data.healthy_bmi_range_kg : null;
  const low = band ? num(band.low) : null;
  const high = band ? num(band.high) : null;
  return (
    <CardShell category={category} title={t("cards.idealWeight.title")}>
      <BigStat value={massLabel(avg, imperial)} label={t("cards.idealWeight.average")} />
      <div className="mt-2">
        {formulas.map(([name, kg]) =>
          kg != null ? <ListRow key={name} label={name} value={massLabel(kg, imperial)} /> : null,
        )}
        {low != null && high != null && (
          <ListRow
            label={t("cards.idealWeight.healthyBmi")}
            value={`${massLabel(low, imperial)} – ${massLabel(high, imperial)}`}
          />
        )}
      </div>
    </CardShell>
  );
}

// ---------- compute_lean_body_mass ----------
export function LeanBodyMassCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const lean = num(data.lean_mass_kg);
  if (lean == null) return null;
  const imperial = data.units === "imperial";
  const fat = num(data.fat_mass_kg);
  const leanPct = num(data.lean_pct);
  const formulas: Array<[string, number | null]> = [
    ["Boer", num(data.boer_kg)],
    ["James", num(data.james_kg)],
    ["Hume", num(data.hume_kg)],
  ];
  return (
    <CardShell
      category={category}
      title={t("cards.leanMass.title")}
      subtitle={
        data.basis === "body_fat"
          ? t("cards.leanMass.fromBodyFat")
          : t("cards.leanMass.fromFormula")
      }
    >
      <BigStat
        value={massLabel(lean, imperial)}
        label={leanPct != null ? t("cards.leanMass.pctOfWeight", { pct: leanPct }) : undefined}
      />
      <div className="mt-2">
        {fat != null && (
          <ListRow label={t("cards.leanMass.fatMass")} value={massLabel(fat, imperial)} />
        )}
        {formulas.map(([name, kg]) =>
          kg != null ? <ListRow key={name} label={name} value={massLabel(kg, imperial)} /> : null,
        )}
      </div>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {t("cards.leanMass.composition")}
      </p>
    </CardShell>
  );
}

// ---------- compute_max_potential ----------
export function MaxPotentialCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const lbm = num(data.max_lean_body_mass_kg);
  const weight = num(data.max_weight_kg);
  if (lbm == null && weight == null) return null;
  const bf = num(data.evaluated_at_body_fat_pct);
  const remaining = num(data.remaining_lean_mass_gain_kg);
  const pctOfPotential = num(data.pct_of_potential);
  const girths = isObj(data.predicted_max_circumferences_cm)
    ? data.predicted_max_circumferences_cm
    : null;
  const girthRows: Array<{ label: string; key: string }> = [
    { label: t("cards.maxPotential.chest"), key: "chest" },
    { label: t("cards.maxPotential.neck"), key: "neck" },
    { label: t("cards.maxPotential.bicep"), key: "bicep_flexed" },
    { label: t("cards.maxPotential.forearm"), key: "forearm" },
    { label: t("cards.maxPotential.thigh"), key: "thigh" },
    { label: t("cards.maxPotential.calf"), key: "calf" },
  ];
  return (
    <CardShell
      category={category}
      title={t("cards.maxPotential.title")}
      subtitle={bf != null ? t("cards.maxPotential.atBodyFat", { pct: bf.toFixed(0) }) : null}
    >
      <div className="mb-2 flex flex-wrap gap-5">
        {weight != null && (
          <BigStat value={weight.toFixed(1)} unit="kg" label={t("cards.maxPotential.maxWeight")} />
        )}
        {lbm != null && (
          <BigStat value={lbm.toFixed(1)} unit="kg" label={t("cards.maxPotential.maxLeanMass")} />
        )}
        {remaining != null && remaining > 0 && (
          <BigStat
            value={`+${remaining.toFixed(1)}`}
            unit="kg"
            // The % lives on the gauge below — don't repeat it here.
            label={t("cards.maxPotential.leanToGain")}
            tone="var(--primary)"
          />
        )}
      </div>
      {pctOfPotential != null && (
        <div className="mb-3">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">{t("cards.maxPotential.howClose")}</span>
            <span className="font-medium tabular-nums">
              {t("cards.maxPotential.pctOfCeiling", { pct: pctOfPotential })}
            </span>
          </div>
          <MetricGauge kind="potential" value={pctOfPotential} />
        </div>
      )}
      {girths && (
        <div className="grid grid-cols-3 gap-x-3 gap-y-1">
          {girthRows.map((r) => {
            const v = num((girths as Record<string, unknown>)[r.key]);
            if (v == null) return null;
            return (
              <div key={r.key} className="text-xs">
                <span className="text-muted-foreground">{r.label} </span>
                <span className="font-medium">{v.toFixed(0)}cm</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">
        {t("cards.maxPotential.ceilingNote")}
      </div>
    </CardShell>
  );
}

// ---------- compute_ideal_proportions ----------
// Girth in the result's unit system (results are always cm on the wire).
function girth(cm: number, imperial: boolean): string {
  return imperial ? `${(cm / 2.54).toFixed(1)} in` : `${cm.toFixed(1)} cm`;
}

export function IdealProportionsCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  return (
    <CardShell
      category={category}
      title={t("cards.proportions.title")}
      // The day the girths were measured — opens Body → Measurements on it,
      // like the body-composition card's "as of" tag.
      subtitle={dayTag(data, "body", { prefix: t("cards.body.asOf"), tab: "measurements" })}
    >
      <ProportionsBody data={data} />
    </CardShell>
  );
}

// The card's contents without the shell, so the Body → Measurements page can
// show it in its own card. The page drops the source note and places the
// stats and focus chips itself.
export function ProportionsBody({
  data,
  focusChips = true,
  notes: showNotes = true,
  radarLabelsInside = false,
  stats = true,
  tint = false,
}: {
  data: unknown;
  focusChips?: boolean;
  notes?: boolean;
  radarLabelsInside?: boolean;
  // Color the radar by the proportion gauge's bands.
  tint?: boolean;
  // false when the page shows ProportionsStats elsewhere.
  stats?: boolean;
}) {
  const { t } = useTranslation();
  if (!isObj(data) || !Array.isArray(data.rows)) return null;
  const imperial = data.units === "imperial";
  const rows = data.rows.filter(isObj).map((r) => ({
    part: str(r.part) ?? "",
    ideal: num(r.ideal_cm),
    actual: num(r.actual_cm),
    pct: num(r.pct_of_ideal),
    status: str(r.status),
  }));
  const priorities = Array.isArray(data.priorities)
    ? data.priorities.filter(isObj).map((p) => ({ part: str(p.part) ?? "", action: str(p.action) }))
    : [];
  const focus = new Set(priorities.filter((p) => p.action === "train").map((p) => p.part));
  const score = num(data.proportion_score);
  const ratios = isObj(data.ratios) ? data.ratios : {};
  const adonis = num(ratios.shoulder_to_waist);
  const whtr = num(ratios.waist_to_height);
  const partLabel = (p: string) => t(`cards.proportions.parts.${p}`);
  const measured = rows.filter((r) => r.actual != null && r.pct != null && r.ideal != null);
  const notes = Array.isArray(data.notes)
    ? data.notes.filter((n): n is string => typeof n === "string")
    : [];
  // Waist and hips are judged on their own bands (too big is bad), so their
  // vertices are colored separately from the gradient the other parts share.
  const radarColors = tint ? gaugeColorScale("proportion") : null;
  const vertexColor = (part: string, pct: number) =>
    tint && proportionKind(part) !== "proportion"
      ? gaugeColorScale(proportionKind(part))?.colorAt(pct)
      : undefined;

  return (
    <>
      {stats && (
        <div className="mb-2 flex flex-wrap gap-5">
          {score != null && (
            <BigStat
              value={`${score}`}
              unit="%"
              label={t("cards.proportions.score")}
              tone="var(--primary)"
            />
          )}
          {adonis != null && (
            <BigStat value={adonis.toFixed(2)} label={t("cards.proportions.adonis")} />
          )}
          {whtr != null && <BigStat value={whtr.toFixed(2)} label={t("cards.proportions.whtr")} />}
        </div>
      )}

      {measured.length >= 3 ? (
        <RadarChart
          className="my-2"
          referenceLabel={t("cards.proportions.ideal")}
          labelsInside={radarLabelsInside}
          colorScale={radarColors}
          axes={measured.map((r) => ({
            key: r.part,
            label: partLabel(r.part),
            value: r.pct!,
            emphasis: focus.has(r.part) || r.status === "above_ideal",
            color: vertexColor(r.part, r.pct!),
            detail: [
              `${t("cards.proportions.you")} ${girth(r.actual!, imperial)} · ${t("cards.proportions.ideal")} ${girth(r.ideal!, imperial)}`,
              ...(r.status ? [t(`cards.proportions.status.${r.status}`)] : []),
            ],
          }))}
        />
      ) : (
        <p className="my-2 rounded-lg border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
          {t("cards.proportions.needThree")}
        </p>
      )}

      {focusChips && <ProportionsFocus data={data} className="mt-2" />}
      {showNotes && notes[0] && (
        <div className="mt-2 text-[11px] text-muted-foreground">{notes[0]}</div>
      )}
    </>
  );
}

// The proportion score as one centred line — the Body page's headline above
// the radar. (Shoulder : waist and waist : height stay on the chat card; on
// the page the Shoulders / Waist tiles already carry that information.)
export function ProportionsStats({ data, className }: { data: unknown; className?: string }) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const score = num(data.proportion_score);
  if (score == null) return null;
  return (
    <div className={cn("flex items-baseline justify-center gap-1.5", className)}>
      <span className="text-sm text-muted-foreground">{t("cards.proportions.score")}</span>
      <span className="text-xl font-semibold tabular-nums" style={{ color: "var(--primary)" }}>
        {score}%
      </span>
    </div>
  );
}

// "Focus:" chips for the lagging parts of a compute_ideal_proportions result.
export function ProportionsFocus({ data, className }: { data: unknown; className?: string }) {
  const { t } = useTranslation();
  if (!isObj(data) || !Array.isArray(data.priorities)) return null;
  const priorities = data.priorities
    .filter(isObj)
    .map((p) => ({ part: str(p.part) ?? "", action: str(p.action) }));
  if (priorities.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)}>
      <span className="text-muted-foreground">{t("cards.proportions.focus")}</span>
      {priorities.map((p) => (
        <span key={p.part} className="rounded-full border px-2 py-0.5">
          {p.action === "reduce_waist"
            ? t("cards.proportions.reduceWaist")
            : t(`cards.proportions.parts.${p.part}`)}
        </span>
      ))}
    </div>
  );
}

// ---------- classify_body_shape ----------
const WHR_RISK_CLASS: Record<string, string> = {
  low: "text-emerald-600 dark:text-emerald-400",
  moderate: "text-amber-600 dark:text-amber-400",
  high: "text-red-600 dark:text-red-400",
};

export function BodyShapeCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const shape = str(data.shape);
  const whr = num(data.waist_to_hip);
  if (!shape || whr == null) return null;
  const risk = str(data.whr_risk) ?? "low";
  const taper = num(data.taper_ratio);
  const basis = str(data.taper_basis);
  const also = Array.isArray(data.also_matches)
    ? data.also_matches.filter((x): x is string => typeof x === "string")
    : [];
  const notes = Array.isArray(data.notes)
    ? data.notes.filter((n): n is string => typeof n === "string")
    : [];
  return (
    <CardShell category={category} title={t("cards.bodyShape.title")}>
      <div className="text-xl/tight font-semibold">{t(`cards.bodyShape.shapes.${shape}`)}</div>
      <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
        {t(`cards.bodyShape.desc.${shape}`)}
      </p>
      <div className="flex flex-wrap gap-5">
        <div className="flex flex-col">
          <div className="text-2xl leading-none font-semibold">{whr.toFixed(2)}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t("cards.bodyShape.whr")} ·{" "}
            <span className={WHR_RISK_CLASS[risk]}>{t(`cards.bodyShape.risk.${risk}`)}</span>
          </div>
        </div>
        {taper != null && (
          <BigStat
            value={taper.toFixed(2)}
            label={t(
              basis === "shoulders" ? "cards.bodyShape.adonis" : "cards.bodyShape.chestTaper",
            )}
          />
        )}
      </div>
      {also.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          {t("cards.bodyShape.alsoFits")}{" "}
          {also.map((a) => t(`cards.bodyShape.shapes.${a}`)).join(", ")}
        </div>
      )}
      {notes.map((n) => (
        <div key={n} className="mt-1 text-[11px] text-muted-foreground">
          {n}
        </div>
      ))}
    </CardShell>
  );
}

// ---------- progress_report ----------
function DeltaRow({ label, delta, unit }: { label: string; delta: number | null; unit: string }) {
  if (delta == null) return null;
  const up = delta > 0.05;
  const down = delta < -0.05;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const tone = up
    ? "text-amber-600 dark:text-amber-400"
    : down
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("inline-flex items-center gap-1 font-medium tabular-nums", tone)}>
        <Icon className="size-3" aria-hidden />
        {delta > 0 ? "+" : ""}
        {delta.toFixed(1)} {unit}
      </span>
    </div>
  );
}
export function ProgressCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || data.error) return null;
  const windowDays = num(data.window_days);
  const cur = isObj(data.current_window) ? data.current_window : null;
  const delta = isObj(data.delta) ? data.delta : null;
  const curWeight = cur ? num(cur.avg_weight_kg) : null;
  if (!delta && curWeight == null) return null;
  return (
    <CardShell
      category={category}
      title={t("cards.progress.title")}
      subtitle={windowDays != null ? t("cards.progress.lastDays", { count: windowDays }) : null}
    >
      {curWeight != null && (
        <div className="mb-2">
          <BigStat value={curWeight.toFixed(1)} unit="kg" label={t("cards.progress.avgWeight")} />
        </div>
      )}
      {delta && (
        <div>
          <DeltaRow label={t("cards.body.weight")} delta={num(delta.weight_kg)} unit="kg" />
          <DeltaRow label={t("cards.body.bodyFat")} delta={num(delta.body_fat_pct)} unit="%" />
          <DeltaRow
            label={t("cards.body.leanMass")}
            delta={num(delta.fat_free_mass_kg)}
            unit="kg"
          />
          <DeltaRow label={t("cards.progress.waist")} delta={num(delta.waist_cm)} unit="cm" />
        </div>
      )}
    </CardShell>
  );
}
