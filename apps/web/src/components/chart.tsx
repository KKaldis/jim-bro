// Shared SVG chart primitives for the progress screens (Body, Workout, …).
//
// Every chart stretches to its container via preserveAspectRatio="none" with a
// fixed pixel height equal to its viewBox height, so the y coordinate maps 1:1
// to pixels while x maps to a percentage of width. That's why the y-axis labels
// live in a plain HTML column (SVG <text> would be stretched horizontally) and
// only horizontal marks — gridlines, dashed averages — are drawn inside the SVG.
//
// The pieces are exported individually (ChartYAxis / ChartGrid / ChartTooltip)
// so bar charts can reuse the same axis + gridline + tap-tooltip scaffolding as
// the line chart without duplicating the geometry.
import { useId, useState } from "react";
import { fromIso, toIso } from "@/dateRange";
import { isoToDisplay } from "@/lib/dateFormat";
import { cn } from "@/lib/utils";

// Fixed SVG user-space width shared by every chart. x positions computed against
// this line up with ChartGrid, which spans 0…CHART_W.
export const CHART_W = 600;

export type PointDetail = { label: string; value: string };

export type ChartPoint = {
  date: string;
  value: number;
  // Stable identity for a shared selection. Sibling charts match their points
  // by this key, so tapping one reveals the same record in all of them even
  // when a series skips dates (a null metric drops its point). Defaults to the
  // date, which is enough when a date can only hold one point.
  key?: string;
  // Secondary metrics surfaced when the point is tapped (e.g. the raw
  // circumferences behind a body-fat estimate). Optional; the date + value are
  // always shown.
  detail?: PointDetail[];
};

// Colors keyed to values on the y axis (e.g. a metric's healthy / unhealthy
// bands): the line is painted with a vertical gradient through the stops, and
// each dot takes `colorAt` its own value.
export type ColorStop = { value: number; color: string };
export type ColorScale = { stops: ColorStop[]; colorAt: (v: number) => string };

// Re-express a color scale in a chart's own units, when the chart plots a
// different quantity than the scale's bands are defined on (raw vs normalized
// FFMI, a girth in cm vs its % of ideal). `toScale` converts a plotted value
// into the scale's units, `fromScale` the other way.
export function remapColorScale(
  cs: ColorScale,
  toScale: (v: number) => number,
  fromScale: (s: number) => number,
): ColorScale {
  return {
    stops: cs.stops.map((s) => ({ ...s, value: fromScale(s.value) })),
    colorAt: (v) => cs.colorAt(toScale(v)),
  };
}

export function pointKey(p: ChartPoint): string {
  return p.key ?? p.date;
}

// Evenly spaced tick values spanning [min, max] inclusive: `steps` intervals →
// steps + 1 lines. Collapses to a single tick when the series is flat.
export function axisTicks(min: number, max: number, steps = 4): number[] {
  if (!(max > min)) return [min];
  return Array.from({ length: steps + 1 }, (_, i) => min + ((max - min) * i) / steps);
}

// Compact axis label: 12345 → "12.3k", 72.5 → "72.5", 80 → "80".
export function compactNumber(v: number): string {
  // Millions keep two decimals (1.33M) — a token pack's size reads better
  // than a rounded 1.3M.
  // (≥ 999,950 so a value that would round up to "1000k" reads 1M.)
  if (Math.abs(v) >= 999_950) return `${Math.round(v / 10_000) / 100}M`;
  if (Math.abs(v) >= 1000) return `${trim(v / 1000)}k`;
  return trim(v);
}

// Precise value + unit for tooltips, where there's room for the full number.
export function fullValue(v: number, unit: string): string {
  const s = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : trim(v);
  return `${s}${unit}`;
}

// Trailing average over the last `days` calendar days at each point (the point's
// own day included), so the line reads as "where the metric has been sitting"
// rather than the day-to-day noise. Always by date, whatever the chart's
// spacing — "1w" means a week however often you log: a burst of readings can't
// drag it more than one would over the same days, and sparse logging simply
// tracks the raw values. Expects date order.
export function rollingAverage(points: ChartPoint[], days: number): number[] {
  const DAY = 86_400_000;
  let start = 0;
  let sum = 0;
  return points.map((p, i) => {
    const t = fromIso(p.date).getTime();
    sum += p.value;
    while (fromIso(points[start].date).getTime() <= t - days * DAY) sum -= points[start++].value;
    return sum / (i - start + 1);
  });
}

function trim(v: number): string {
  return String(Math.round(v * 10) / 10);
}

// Left value axis. Labels sit at the exact pixel y of each gridline so the two
// stay aligned. The unit is appended to the top (max) label only to keep the
// column narrow.
export function ChartYAxis({
  ticks,
  unit,
  yAt,
  height,
  stackUnit = false,
}: {
  ticks: number[];
  unit?: string;
  yAt: (v: number) => number;
  height: number;
  // Always put the unit on its own line, for a narrower (w-8) column where
  // width is tight.
  stackUnit?: boolean;
}) {
  // The column is a fixed w-11: a short unit (kg, %, bpm) fits beside the top
  // tick, but a long one (ml/kg/min) would spill out of the card on the left,
  // so it drops to a smaller second line just under the top number.
  const unitText = unit?.trim() ?? "";
  const longUnit = stackUnit || unitText.length > 3;
  const top = ticks.length - 1;
  return (
    <div
      className={cn(
        "relative shrink-0 text-end text-[10px] text-muted-foreground tabular-nums",
        stackUnit ? "w-8" : "w-11",
      )}
      style={{ height }}
    >
      {ticks.map((v, i) => (
        <span
          key={i}
          className="absolute inset-e-0 -translate-y-1/2 whitespace-nowrap"
          style={{ top: yAt(v) }}
        >
          {compactNumber(v)}
          {unit && !longUnit && i === top ? unit : ""}
        </span>
      ))}
      {longUnit && (
        <span
          className="absolute inset-e-0 text-[9px] leading-none whitespace-nowrap"
          style={{ top: yAt(ticks[top]) + 7 }}
        >
          {unitText}
        </span>
      )}
    </div>
  );
}

// Horizontal reference lines, one per axis tick. Drawn first so the data sits on
// top of them.
export function ChartGrid({
  ticks,
  yAt,
  width = CHART_W,
}: {
  ticks: number[];
  yAt: (v: number) => number;
  width?: number;
}) {
  return (
    <>
      {ticks.map((v, i) => {
        const y = yAt(v);
        return (
          <line key={i} x1={0} x2={width} y1={y} y2={y} className="stroke-muted" strokeWidth={1} />
        );
      })}
    </>
  );
}

// Dates beneath a chart. Given a window (`from`/`to`) the axis labels the
// window itself — the span the points are positioned within — rather than the
// first and last point, which would misrepresent where the data sits in it.
// Without one it falls back to labelling the data, which is all an
// evenly-spaced chart can say.
export function ChartXAxis({
  points,
  from,
  to,
}: {
  points: ChartPoint[];
  from?: string;
  to?: string;
}) {
  const midIdx = Math.floor((points.length - 1) / 2);
  const spansWindow = !!from && !!to && from !== to;
  const mid = spansWindow
    ? toIso(new Date((fromIso(from).getTime() + fromIso(to).getTime()) / 2))
    : points[midIdx].date;
  return (
    <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
      <span>{isoToDisplay(spansWindow ? from : points[0].date)}</span>
      {(spansWindow || points.length > 2) && <span>{isoToDisplay(mid)}</span>}
      <span>{isoToDisplay(spansWindow ? to : points[points.length - 1].date)}</span>
    </div>
  );
}

// Tooltip anchored above a tapped point. Edge points anchor their tooltip inward
// to avoid clipping. `top` is the point's pixel y; `leftPct` its x as a percent
// of the plot width.
//
// The box itself stays click-through so it can't swallow taps meant for the
// points underneath it; only the `actions` row (e.g. edit / delete for the
// tapped record) takes pointer events back.
export function ChartTooltip({
  point,
  unit,
  leftPct,
  top,
  actions,
  extra,
}: {
  point: ChartPoint;
  unit: string;
  leftPct: number;
  top: number;
  actions?: React.ReactNode;
  // Extra lines under the point's own details (e.g. the average at that point).
  extra?: PointDetail[];
}) {
  const xTransform =
    leftPct < 20 ? "translate-x-0" : leftPct > 80 ? "-translate-x-full" : "-translate-x-1/2";
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 -translate-y-full rounded-md border bg-popover px-2 py-1 text-[11px] whitespace-nowrap shadow-overlay",
        xTransform,
      )}
      style={{ left: `${leftPct}%`, top: top - 6 }}
    >
      <div className="flex flex-col gap-0.5">
        <div className="font-medium">
          {isoToDisplay(point.date)} · {fullValue(point.value, unit)}
        </div>
        {[...(point.detail ?? []), ...(extra ?? [])].map((d) => (
          <div key={d.label} className="text-muted-foreground">
            {d.label} {d.value}
          </div>
        ))}
        {actions && (
          <div className="pointer-events-auto mt-0.5 flex items-center gap-1 border-t pt-1">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

// SVG line chart with a value axis, horizontal gridlines and tap-to-inspect
// points. Every point is tappable: tapping pops a tooltip with the date, the
// precise value and any secondary `detail` metrics.
//
// Pass `from`/`to` and the x axis becomes a real date scale: each point sits at
// its own date within that window, so gaps in logging read as gaps. Without it
// points are spaced evenly, which is what a series indexed by something other
// than a date (a workout session, say) wants.
//
// Selection is uncontrolled by default (each chart remembers its own point).
// Passing `onSelectKey` hands it to the parent, which lets a stack of charts
// share one selected record — see Body's series cards.
export function LineChart({
  points,
  unit,
  height = 140,
  from,
  to,
  selectedKey,
  onSelectKey,
  tooltipActions,
  reference,
  trend,
  colorScale,
}: {
  points: ChartPoint[];
  unit: string;
  height?: number;
  // Tint the line and dots by value instead of the flat primary color.
  colorScale?: ColorScale | null;
  from?: string;
  to?: string;
  // A dashed horizontal target line (e.g. a body part's ideal girth). The y
  // range stretches to include it so it's always on screen.
  reference?: { value: number; label: string } | null;
  selectedKey?: string | null;
  onSelectKey?: (key: string | null) => void;
  // Controls rendered inside the tapped point's tooltip, for acting on the
  // record behind it.
  tooltipActions?: (point: ChartPoint) => React.ReactNode;
  // An averaging line drawn over the series: one value per point, at the same
  // x. The raw line fades to dashes behind it; the tooltip adds the average at that point.
  trend?: { values: number[]; label: string } | null;
}) {
  const [ownKey, setOwnKey] = useState<string | null>(null);
  // useId's punctuation isn't safe inside url(#…).
  const gradId = `line-grad-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const controlled = onSelectKey != null;
  const activeKey = controlled ? (selectedKey ?? null) : ownKey;
  const select = (key: string | null) => {
    if (onSelectKey) onSelectKey(key);
    else setOwnKey(key);
  };
  if (points.length === 0) return null;
  const h = height;
  const pad = 12;
  const ys = points.map((p) => p.value);
  if (reference) ys.push(reference.value);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanY = maxY - minY || 1;
  // Date scale when a window is given, otherwise even spacing by index. A
  // zero-width window (a single day) has no scale to speak of and falls back to
  // even spacing too.
  const t0 = from ? fromIso(from).getTime() : null;
  const span = t0 != null && to ? fromIso(to).getTime() - t0 : 0;
  const plotW = CHART_W - 2 * pad;
  const xAt = (i: number) => {
    if (t0 != null && span > 0) {
      const frac = (fromIso(points[i].date).getTime() - t0) / span;
      return pad + Math.min(1, Math.max(0, frac)) * plotW;
    }
    return pad + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  };
  const yAt = (v: number) => h - pad - ((v - minY) / spanY) * (h - 2 * pad);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.value).toFixed(1)}`)
    .join(" ");
  const ticks = axisTicks(minY, maxY);
  // The selected key may belong to a sibling chart's series (this metric wasn't
  // recorded that day), in which case nothing is highlighted here.
  const activeIdx = activeKey == null ? -1 : points.findIndex((p) => pointKey(p) === activeKey);
  const active = activeIdx >= 0 ? activeIdx : null;
  // The gradient runs in user space from the first stop's y to the last's, so
  // each color lands at its value's height whatever the visible range; past
  // either end it pads with the end color.
  const stops = colorScale?.stops ?? [];
  const gradient = stops.length >= 2 ? stops : null;
  const stroke = gradient ? `url(#${gradId})` : "currentColor";

  return (
    <div dir="ltr" className="flex gap-2">
      <ChartYAxis ticks={ticks} unit={unit} yAt={yAt} height={h} />
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height: h }}>
          <svg
            viewBox={`0 0 ${CHART_W} ${h}`}
            preserveAspectRatio="none"
            width="100%"
            height={h}
            className="text-primary"
          >
            {gradient && (
              <defs>
                <linearGradient
                  id={gradId}
                  gradientUnits="userSpaceOnUse"
                  x1={0}
                  x2={0}
                  y1={yAt(gradient[0].value)}
                  y2={yAt(gradient[gradient.length - 1].value)}
                >
                  {gradient.map((s, i) => {
                    const lo = gradient[0].value;
                    const range = gradient[gradient.length - 1].value - lo || 1;
                    return (
                      <stop
                        key={i}
                        offset={(s.value - lo) / range}
                        style={{ stopColor: s.color }}
                      />
                    );
                  })}
                </linearGradient>
              </defs>
            )}
            <ChartGrid ticks={ticks} yAt={yAt} />
            {reference && (
              <line
                x1={0}
                x2={CHART_W}
                y1={yAt(reference.value)}
                y2={yAt(reference.value)}
                className="stroke-muted-foreground"
                strokeWidth={1.5}
                strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <path
              d={path}
              fill="none"
              stroke={stroke}
              strokeWidth={trend ? 1.5 : 2}
              strokeOpacity={trend ? 0.35 : 1}
              strokeDasharray={trend ? "4 3" : undefined}
              // Widths and dashes in screen pixels — the SVG only stretches
              // horizontally, which would otherwise thicken steep segments.
              vectorEffect="non-scaling-stroke"
            />
            {trend && (
              <path
                d={trend.values
                  .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`)
                  .join(" ")}
                fill="none"
                stroke={stroke}
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {/* Points in HTML so they stay round: an SVG circle would stretch
              into an oval with the plot's width. Same dots as the exercise
              trend chart. */}
          {points.map((p, i) => {
            const isSelected = active === i;
            const leftPct = (xAt(i) / CHART_W) * 100;
            const top = yAt(p.value);
            return (
              <span key={i}>
                <span
                  className={cn(
                    "pointer-events-none absolute -translate-1/2 rounded-full",
                    !colorScale && "bg-primary",
                    isSelected ? "size-2" : "size-1.25",
                  )}
                  style={{
                    left: `${leftPct}%`,
                    top,
                    backgroundColor: colorScale?.colorAt(p.value),
                  }}
                />
                {/* Invisible, larger hit target so points are easy to tap. */}
                <button
                  type="button"
                  aria-label={`${isoToDisplay(p.date)} ${fullValue(p.value, unit)}`}
                  aria-pressed={isSelected}
                  className="absolute size-7 -translate-1/2 cursor-pointer rounded-full"
                  style={{ left: `${leftPct}%`, top }}
                  onClick={() => select(isSelected ? null : pointKey(p))}
                />
              </span>
            );
          })}
          {/* HTML, not SVG text: the SVG stretches horizontally. */}
          {reference && (
            <div
              className="pointer-events-none absolute inset-e-0 -translate-y-full pb-0.5 text-[10px] text-muted-foreground"
              style={{ top: yAt(reference.value) }}
            >
              {reference.label}
            </div>
          )}
          {active != null && (
            <ChartTooltip
              point={points[active]}
              unit={unit}
              leftPct={(xAt(active) / CHART_W) * 100}
              top={yAt(points[active].value)}
              actions={tooltipActions?.(points[active])}
              extra={
                trend
                  ? [{ label: trend.label, value: fullValue(trend.values[active], unit) }]
                  : undefined
              }
            />
          )}
        </div>
        <ChartXAxis points={points} from={from} to={to} />
      </div>
    </div>
  );
}
