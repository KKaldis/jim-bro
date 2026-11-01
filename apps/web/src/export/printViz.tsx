/**
 * Static visuals for the PDF exports — print has no hover, so every figure
 * labels its own values. Single-series figures use the accent; the one
 * categorical figure (the macro energy split) uses the validated
 * protein / fat / carbs slots in fixed order, always with a labelled legend.
 */
import { useTranslation } from "react-i18next";
import { intlLocale } from "../i18n";
import {
  exerciseIconUrl,
  getExercise,
  machineIconUrl,
  type Macros,
  type Weekday,
} from "@fa/shared";
import { BucketMap } from "../components/MuscleViewToggle";
import type { MuscleView } from "../lib/uiStore";
import { toIso } from "../dateRange";
import { isoToDisplay } from "../lib/dateFormat";

export const WEEK_ORDER: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// Exercise silhouette (or its machine's). A plain eager <img>: the app's
// ExerciseThumb is lazy-loaded, which never fires in an off-screen frame.
export function PrintThumb({
  exerciseId,
  machineId,
}: {
  exerciseId: string;
  machineId?: string | null;
}) {
  const machine = machineId ?? getExercise(exerciseId)?.machine_id;
  const url = (machine && machineIconUrl(machine)) || exerciseIconUrl(exerciseId);
  return url ? <img src={url} alt="" className="thumb" /> : <span className="thumb" />;
}

// The exercise's type pill (compound / isolation / cardio), as the app's
// ExerciseTypeBadge. Nothing for ids not in the catalog.
export function PrintTypeTag({ exerciseId }: { exerciseId: string }) {
  const { t } = useTranslation();
  const type = getExercise(exerciseId)?.type;
  if (!type) return null;
  return (
    <span className="type-tags">
      <span className={`type-tag ${type}`}>{t(`workout.exerciseType.${type}`)}</span>
    </span>
  );
}

// The anatomy icon the app shows next to a muscle bucket.
export function PrintMuscleIcon({ id, view }: { id: string; view: MuscleView }) {
  return (
    <span className="mmap">
      <BucketMap id={id} view={view} />
    </span>
  );
}

// ---------- macros ----------

const MACRO_KEYS = ["p", "f", "c"] as const;
const KCAL_PER_G = { p: 4, f: 9, c: 4 } as const;
// Full class names (styled in vizCss) so they're never built dynamically.
const MACRO_CLASS = { p: "m-p", f: "m-f", c: "m-c" } as const;

// Where the energy comes from: one 100% bar split protein / fat / carbs by
// kcal, plus a legend carrying grams and share (the carbs hue is under 3:1 on
// white, so the numbers are always printed beside it).
export function MacroSplit({ macros }: { macros: Macros }) {
  const { t } = useTranslation();
  const kcal = MACRO_KEYS.map((k) => macros[k] * KCAL_PER_G[k]);
  const total = kcal.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const labels = { p: t("export.protein"), f: t("export.fat"), c: t("export.carbs") };
  return (
    <div className="split">
      <div className="split-bar" role="img" aria-label={t("export.viz.energySplit")}>
        {MACRO_KEYS.map((k, i) =>
          kcal[i] > 0 ? (
            <span key={k} className={MACRO_CLASS[k]} style={{ flexGrow: kcal[i] }} />
          ) : null,
        )}
      </div>
      <div className="legend">
        <span className="legend-title">{t("export.viz.energySplit")}</span>
        {MACRO_KEYS.map((k, i) => (
          <span key={k} className="legend-item">
            <span className={`swatch ${MACRO_CLASS[k]}`} />
            {labels[k]} <b>{Math.round((kcal[i] / total) * 100)}%</b>
            <span className="muted"> · {Math.round(macros[k])} g</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// Planned / eaten vs a target, one single-hue row per macro (the app's
// MacroBars, in print). Past 100% the bar stays full and the overshoot
// shows as a darker cap plus the printed percentage.
export function TargetBars({ value, target }: { value: Macros; target: Macros }) {
  const { t } = useTranslation();
  const rows = [
    { key: "kcal" as const, label: t("export.kcal"), unit: "" },
    { key: "p" as const, label: t("export.protein"), unit: " g" },
    { key: "f" as const, label: t("export.fat"), unit: " g" },
    { key: "c" as const, label: t("export.carbs"), unit: " g" },
  ];
  return (
    <div className="tbars">
      {rows.map((r) => {
        const v = value[r.key];
        const goal = target[r.key];
        const pct = goal > 0 ? (v / goal) * 100 : 0;
        return (
          <div key={r.key} className="tbar">
            <span className="tbar-label">{r.label}</span>
            <span className="bar">
              <span
                className={pct > 105 ? "over" : undefined}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </span>
            <span className="tbar-value">
              {Math.round(v)}
              <span className="muted">
                {" "}
                / {Math.round(goal)}
                {r.unit}
              </span>
              <b>{Math.round(pct)}%</b>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------- schedule ----------

export type WeekCell = { title?: string; note?: string };

// Mon → Sun at a glance; unscheduled weekdays read as rest.
export function WeekStrip({ cells }: { cells: Partial<Record<Weekday, WeekCell[]>> }) {
  const { t } = useTranslation();
  return (
    <div className="week">
      {WEEK_ORDER.map((w) => {
        const items = cells[w] ?? [];
        return (
          <div key={w} className={items.length ? "week-day on" : "week-day"}>
            <div className="week-name">{t(`workout.weekdays.${w}`).slice(0, 3)}</div>
            {items.length === 0 ? (
              <div className="week-rest">{t("export.viz.rest")}</div>
            ) : (
              items.map((c, i) => (
                <div key={i}>
                  <div className="week-title">{c.title}</div>
                  {c.note && <div className="week-note">{c.note}</div>}
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- charts ----------

// Vertical single-series bars (days or weeks) with an optional dashed
// reference line (the target). Labels: the reference value, the max bar, and
// the first / last x labels — enough to read it on paper without clutter.
export function PrintBarChart({
  bars,
  reference,
  referenceLabel,
  unit,
}: {
  bars: Array<{ label: string; value: number }>;
  reference?: number | null;
  referenceLabel?: string;
  unit: string;
}) {
  if (bars.length === 0) return null;
  const W = 640;
  const H = 160;
  const pad = { l: 40, r: 10, t: 16, b: 22 };
  // Round axis: a 1 / 2 / 2.5 / 5 × 10ⁿ step, ~3 gridlines above zero.
  const top = Math.max(...bars.map((b) => b.value), reference ?? 0) || 1;
  const raw = top / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const max = Math.ceil((top * 1.08) / step) * step;
  const innerW = W - pad.l - pad.r;
  const slot = innerW / bars.length;
  const gap = Math.min(2, slot * 0.25);
  const bw = Math.max(1, slot - gap);
  const sy = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const base = sy(0);
  const peak = bars.reduce((best, b, i) => (b.value > bars[best].value ? i : best), 0);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const r = Math.min(4, bw / 2);
  const refText = `${referenceLabel ?? ""} ${Math.round(reference ?? 0)}`.trim();
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={unit}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} className="chart-grid" />
          <text x={pad.l - 6} y={sy(v) + 3} textAnchor="end" className="chart-axis">
            {v}
          </text>
        </g>
      ))}
      {bars.map((b, i) => {
        const x = pad.l + i * slot + gap / 2;
        const y = sy(b.value);
        const h = Math.max(0, base - y);
        // Rounded data end, square at the baseline.
        const rr = Math.min(r, h);
        const d = `M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + bw - rr}Q${x + bw},${y} ${x + bw},${y + rr}V${base}Z`;
        return <path key={i} d={d} className="chart-bar" />;
      })}
      {reference != null && reference > 0 && (
        <g>
          <line
            x1={pad.l}
            x2={W - pad.r}
            y1={sy(reference)}
            y2={sy(reference)}
            className="chart-ref"
          />
          {/* White backing so the label stays legible over the bars. */}
          <rect
            x={W - pad.r - refText.length * 6.6 - 6}
            y={sy(reference) - 16}
            width={refText.length * 6.6 + 8}
            height={14}
            rx={3}
            fill="#fff"
            opacity={0.9}
          />
          <text x={W - pad.r} y={sy(reference) - 5} textAnchor="end" className="chart-label">
            {refText}
          </text>
        </g>
      )}
      <text
        x={pad.l + peak * slot + slot / 2}
        y={sy(bars[peak].value) - 4}
        textAnchor="middle"
        className="chart-label"
      >
        {Math.round(bars[peak].value)}
      </text>
      <text x={pad.l} y={H - 4} className="chart-axis">
        {bars[0].label}
      </text>
      <text x={W - pad.r} y={H - 4} textAnchor="end" className="chart-axis">
        {bars[bars.length - 1].label}
      </text>
    </svg>
  );
}

// ---------- calendar heatmap ----------

export type HeatCell = { color: string | null; dashed?: boolean };
export type HeatLegend = { color: string | null; dashed?: boolean; label: string };

// Day numbers flip to white on the darker fills (WCAG relative luminance).
function isDark(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.25;
}

// GitHub-style calendar: one column per week (Mon at top), one cell per day
// of the period, coloured by `cell`. Cells grow up to 20px for short periods
// and shrink to fit a year; month labels sit above the week they start in.
// No hover in print, so the legend spells out every colour.
export function CalendarHeatmap({
  from,
  to,
  cell,
  legend,
}: {
  from: string;
  to: string;
  cell: (iso: string) => HeatCell;
  legend: HeatLegend[];
}) {
  const { t } = useTranslation();
  const start = new Date(from + "T00:00:00");
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(to + "T00:00:00");
  const weeks = Math.floor((end.getTime() - start.getTime()) / (7 * 864e5)) + 1;
  const month = new Intl.DateTimeFormat(intlLocale(), {
    month: "short",
  });
  // Up to ~3 months reads best as a wall calendar (Mon–Sun across, a row
  // per week, day numbers in the cells); longer periods as a year strip
  // (a column per week, weekdays down the side).
  const calendar = weeks <= 14;
  const W = 640;
  const labelW = calendar ? 34 : 30;
  const topH = 16;
  const size = calendar
    ? Math.max(26, Math.min(44, Math.floor(520 / weeks)))
    : Math.max(6, Math.min(20, Math.floor((W - labelW) / weeks)));
  const gap = size >= 10 ? 3 : 2;
  const width = labelW + (calendar ? 7 : weeks) * size;
  const height = topH + (calendar ? weeks : 7) * size;
  const pos = (week: number, day: number) =>
    calendar
      ? { x: labelW + day * size, y: topH + week * size }
      : { x: labelW + week * size, y: topH + day * size };

  const cells: React.ReactNode[] = [];
  const months: React.ReactNode[] = [];
  let lastMonth = -1;
  let lastLabelWeek = -10;
  for (let w = 0; w < weeks; w++) {
    for (let r = 0; r < 7; r++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + r);
      const iso = toIso(d);
      if (iso < from || iso > to) continue;
      // Label the week holding the first in-range day of each month.
      if (d.getMonth() !== lastMonth) {
        lastMonth = d.getMonth();
        if (calendar || w - lastLabelWeek >= 3) {
          const at = pos(w, 0);
          months.push(
            calendar ? (
              <text key={`m${w}`} x={0} y={at.y + (size - gap) / 2 + 3} className="chart-axis">
                {month.format(d)}
              </text>
            ) : (
              <text key={`m${w}`} x={at.x} y={11} className="chart-axis">
                {month.format(d)}
              </text>
            ),
          );
          lastLabelWeek = w;
        }
      }
      const v = cell(iso);
      const { x, y } = pos(w, r);
      cells.push(
        <g key={iso}>
          <rect
            x={x}
            y={y}
            width={size - gap}
            height={size - gap}
            rx={Math.min(4, (size - gap) / 4)}
            fill={v.color ?? "#fff"}
            className={v.dashed ? "heat-empty" : v.color ? undefined : "heat-none"}
          />
          {calendar && (
            <text
              x={x + 4}
              y={y + 11}
              className={v.color && isDark(v.color) ? "heat-day on-dark" : "heat-day"}
            >
              {d.getDate()}
            </text>
          )}
        </g>,
      );
    }
  }
  // Weekday names: all seven across the top (calendar) or Mon/Wed/Fri down
  // the side (strip).
  const dayLabels = calendar
    ? WEEK_ORDER.map((wd, i) => (
        <text key={wd} x={labelW + i * size} y={11} className="chart-axis">
          {t(`workout.weekdays.${wd}`).slice(0, 3)}
        </text>
      ))
    : [0, 2, 4].map((r) => (
        <text key={r} x={0} y={topH + r * size + (size - gap) / 2 + 3} className="chart-axis">
          {t(`workout.weekdays.${WEEK_ORDER[r]}`).slice(0, 3)}
        </text>
      ));
  return (
    <div className="heat">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: `${(width / W) * 100}%` }}
        role="img"
        aria-label={legend.map((l) => l.label).join(", ")}
      >
        {months}
        {dayLabels}
        {cells}
      </svg>
      <div className="legend">
        {legend.map((l) => (
          <span key={l.label} className="legend-item">
            <span
              className={l.dashed ? "swatch heat-empty-swatch" : "swatch"}
              style={{ background: l.color ?? "#fff" }}
            />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Print twin of the app's proportions radar (components/radar-chart.tsx,
// which leans on Tailwind classes the print frame doesn't have): each spoke is
// a body part's girth as % of its ideal, the dashed ring IS the ideal (100%),
// and the polygon's shape against it is the read. Same scale rule as the app:
// the centre is ≤ 50% so real profiles (80–110%) aren't squeezed into the
// rim; the edge is ≥ 125%. Values are printed at each vertex label.
export function PrintRadar({
  axes,
}: {
  axes: Array<{ key: string; label: string; value: number; emphasis?: boolean }>;
}) {
  if (axes.length < 3) return null;
  const S = 320;
  const C = S / 2;
  const R = 104;
  const LABEL_R = R + 24;
  const min = Math.min(50, Math.floor(Math.min(...axes.map((a) => a.value)) / 25) * 25);
  const max = Math.max(125, Math.ceil(Math.max(...axes.map((a) => a.value)) / 25) * 25);
  const rings: number[] = [];
  for (let v = min + 25; v <= max; v += 25) rings.push(v);
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / axes.length;
  const at = (i: number, pct: number, r = R): [number, number] => {
    const k = (Math.min(Math.max(pct, min), max) - min) / (max - min);
    return [C + k * r * Math.cos(angle(i)), C + k * r * Math.sin(angle(i))];
  };
  const poly = (pct: (i: number) => number) =>
    axes
      .map((_, i) =>
        at(i, pct(i))
          .map((n) => n.toFixed(1))
          .join(","),
      )
      .join(" ");
  return (
    <svg
      className="radar"
      viewBox={`0 0 ${S} ${S}`}
      role="img"
      aria-label={axes.map((a) => `${a.label} ${Math.round(a.value)}%`).join(", ")}
    >
      {rings.map((v) => (
        <polygon
          key={v}
          points={poly(() => v)}
          className={v === 100 ? "radar-ideal" : "radar-ring"}
        />
      ))}
      {rings
        .filter((v) => v !== 100)
        .map((v) => (
          <text key={v} x={C + 3} y={at(0, v)[1] - 2} className="radar-tick">
            {v}%
          </text>
        ))}
      {axes.map((a, i) => {
        const [x, y] = at(i, max);
        return <line key={a.key} x1={C} y1={C} x2={x} y2={y} className="radar-ring" />;
      })}
      <polygon points={poly((i) => axes[i].value)} className="radar-shape" />
      {axes.map((a, i) => {
        const [x, y] = at(i, a.value);
        return (
          <circle
            key={a.key}
            cx={x}
            cy={y}
            r={a.emphasis ? 4.5 : 3.5}
            className={a.emphasis ? "radar-dot focus" : "radar-dot"}
          />
        );
      })}
      {axes.map((a, i) => {
        const ang = angle(i);
        const x = C + LABEL_R * Math.cos(ang);
        const y = C + LABEL_R * Math.sin(ang);
        const anchor =
          Math.abs(Math.cos(ang)) < 0.2 ? "middle" : Math.cos(ang) > 0 ? "start" : "end";
        return (
          <text
            key={a.key}
            x={x}
            y={y}
            textAnchor={anchor}
            className={a.emphasis ? "radar-label focus" : "radar-label"}
          >
            <tspan x={x} dy="-0.2em">
              {a.label}
            </tspan>
            <tspan x={x} dy="1.15em" className="radar-pct">
              {Math.round(a.value)}%
            </tspan>
          </text>
        );
      })}
      <text x={C + 3} y={at(0, 100)[1] - 2} className="radar-tick ideal">
        100%
      </text>
    </svg>
  );
}

// Small-multiple trend for a grid of related series (one per body part).
// Each tile has its own y-range (sites differ by tens of cm), so tiles
// compare shape and direction; the printed latest value and change carry the
// magnitude. Labels sit in HTML around the plot so they stay full-size.
export function MiniTrend({
  label,
  points,
  unit,
  digits = 1,
  note,
}: {
  label: string;
  points: Array<{ date: string; value: number }>;
  unit: string;
  digits?: number;
  // An extra line under the dates (e.g. the part's % of ideal).
  note?: string;
}) {
  const W = 200;
  const H = 56;
  const pad = 6;
  const xs = points.map((p) => new Date(p.date + "T00:00:00").getTime());
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const lo = Math.min(...points.map((p) => p.value));
  const hi = Math.max(...points.map((p) => p.value));
  const span = hi - lo || 1;
  const sx = (x: number) => pad + ((x - x0) / Math.max(1, x1 - x0)) * (W - 2 * pad);
  const sy = (v: number) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(p.value).toFixed(1)}`)
    .join("");
  const first = points[0];
  const last = points[points.length - 1];
  const change = last.value - first.value;
  return (
    <div className="trend">
      <div className="trend-head">
        <span className="trend-label">{label}</span>
        <span className="trend-value">
          {last.value.toFixed(digits)} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <line
          x1={pad}
          x2={W - pad}
          y1={sy(first.value)}
          y2={sy(first.value)}
          className="trend-base"
        />
        <path d={path} className="chart-line" />
        {[0, points.length - 1].map((i) => (
          <circle key={i} cx={sx(xs[i])} cy={sy(points[i].value)} r={3.5} className="chart-dot" />
        ))}
      </svg>
      <div className="trend-foot">
        <span>{isoToDisplay(first.date)}</span>
        <b>
          {change > 0 ? "+" : change < 0 ? "−" : "±"}
          {Math.abs(change).toFixed(digits)} {unit}
        </b>
        <span>{isoToDisplay(last.date)}</span>
      </div>
      {note && <div className="trend-note">{note}</div>}
    </div>
  );
}

// Horizontal share bar for a table cell (a row's part of the whole).
export function ShareBar({ value, max }: { value: number; max: number }) {
  return (
    <span className="bar">
      <span style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

// Print stylesheet for the figures above (appended to printDoc's).
export function vizCss(accent: string): string {
  return `
.thumb { width: 26px; height: 26px; object-fit: contain; display: inline-block; vertical-align: middle; }
td.icon { width: 34px; padding-right: 0; }
.mmap { display: inline-block; width: 30px; height: 30px; vertical-align: middle; }
.mmap svg { width: 100%; height: 100%; display: block; }
:root {
  --muscle-outline: #9ca3af; --muscle-body: #eceef1;
  --muscle-primary: ${accent}; --muscle-secondary: #b7cdf2;
}
.m-p { background: #2a78d6; }
.m-f { background: #eb6834; }
.m-c { background: #1baf7a; }
.split { margin: 0 0 14px; break-inside: avoid; }
.split-bar { display: flex; gap: 2px; height: 12px; border-radius: 6px; overflow: hidden; }
.split-bar > span { display: block; min-width: 2px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 6px; font-size: 8.5pt; align-items: center; }
.legend-title { color: #71717a; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; font-size: 7.5pt; }
.legend-item { display: inline-flex; align-items: center; gap: 5px; }
.legend-item b { font-variant-numeric: tabular-nums; }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.tbars { display: grid; gap: 7px; margin: 0 0 12px; break-inside: avoid; }
.tbar { display: grid; grid-template-columns: 92px 1fr 170px; gap: 10px; align-items: center; font-size: 9pt; }
.tbar-label { color: #52525b; font-weight: 600; }
.tbar .bar { margin-top: 0; height: 10px; }
.tbar-value { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tbar-value b { display: inline-block; min-width: 38px; margin-left: 6px; }
.bar > span.over { background: color-mix(in oklab, ${accent} 70%, #000); }
.week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin: 0 0 18px; break-inside: avoid; }
.week-day { border: 1px solid #e4e4e7; border-radius: 8px; padding: 7px 8px; min-height: 58px; background: #fafafa; }
.week-day.on { border-color: color-mix(in oklab, ${accent} 45%, #fff); background: color-mix(in oklab, ${accent} 8%, #fff); }
.week-name { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #71717a; margin-bottom: 3px; }
.week-day.on .week-name { color: ${accent}; }
.week-title { font-size: 8.5pt; font-weight: 650; line-height: 1.25; }
.week-note { font-size: 7.5pt; color: #71717a; }
.week-rest { font-size: 8pt; color: #a1a1aa; }
.chart-bar { fill: ${accent}; }
.chart-ref { stroke: #52525b; stroke-width: 1.25; stroke-dasharray: 4 3; }
.heat { margin: 2px 0 16px; break-inside: avoid; }
.heat svg { display: block; height: auto; max-width: 100%; }
.heat-empty { stroke: #c4c4cc; stroke-width: 1; stroke-dasharray: 2 1.5; }
.heat-none { stroke: #ececef; stroke-width: 1; }
.heat-empty-swatch { border: 1px dashed #b4b4bc; }
.heat-day { font-size: 8.5px; fill: #52525b; font-variant-numeric: tabular-nums; }
.heat-day.on-dark { fill: #fff; }
.log-head td { background: #f6f6f7; font-weight: 650; border-top: 1px solid #e4e4e7; padding-top: 8px; }
.log-head .muted { font-weight: 400; }
.radar { display: block; width: 100%; max-width: 330px; height: auto; overflow: visible; }
.radar-ring { fill: none; stroke: #e4e4e7; stroke-width: 1; }
.radar-ideal { fill: none; stroke: #52525b; stroke-width: 1.25; stroke-dasharray: 4 3; }
.radar-shape { fill: color-mix(in oklab, ${accent} 14%, transparent); stroke: ${accent}; stroke-width: 2; stroke-linejoin: round; }
.radar-dot { fill: ${accent}; stroke: #fff; stroke-width: 2; }
.radar-dot.focus { fill: #fff; stroke: ${accent}; stroke-width: 2.5; }
.radar-tick { fill: #a1a1aa; font-size: 8px; }
.radar-tick.ideal { fill: #52525b; font-weight: 600; }
.radar-label { fill: #3f3f46; font-size: 10px; }
.radar-label.focus { font-weight: 700; fill: #18181b; }
.radar-pct { fill: #71717a; font-variant-numeric: tabular-nums; }
.props { display: grid; grid-template-columns: 330px 1fr; gap: 18px; align-items: center; margin: 4px 0 14px; break-inside: avoid; }
.props-side .stats { grid-template-columns: 1fr 1fr; }
.ideal-bar { position: relative; display: block; height: 10px; border-radius: 5px; background: #f0f0f2; }
.ideal-bar > span { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: ${accent}; }
.ideal-bar > i { position: absolute; top: -3px; bottom: -3px; width: 0; border-left: 1.5px dashed #52525b; }
.two-up { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 0 0 10px; break-inside: avoid; }
.trends { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0 0 14px; }
.trend { border: 1px solid #e4e4e7; border-radius: 10px; padding: 8px 10px 6px; break-inside: avoid; }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.trend-label { font-size: 8.5pt; font-weight: 600; }
.trend-value { font-size: 10.5pt; font-weight: 700; font-variant-numeric: tabular-nums; }
.trend svg { display: block; width: 100%; height: auto; margin: 4px 0 2px; }
.trend-base { stroke: #e4e4e7; stroke-width: 1; stroke-dasharray: 3 3; }
.trend-foot { display: flex; justify-content: space-between; font-size: 7.5pt; color: #71717a; font-variant-numeric: tabular-nums; }
.trend-foot b { color: #18181b; }
.trend-note { margin-top: 3px; padding-top: 3px; border-top: 1px solid #f0f0f2; font-size: 8pt; color: #52525b; }
.share { display: flex; align-items: center; gap: 8px; }
.share .bar { flex: 1; margin-top: 0; }
`;
}
