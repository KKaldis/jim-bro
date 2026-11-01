// SVG radar (spider) chart for a profile of percentages against a common
// reference — e.g. each body part's girth as % of its ideal, where the dashed
// 100% ring IS the ideal. One series only: the shape of the polygon against
// the ring is the read ("which side caves in").
//
// Unlike the line charts, the viewBox is square and scaled uniformly (default
// preserveAspectRatio), so SVG <text> for the spoke labels doesn't stretch.
// Every vertex has an oversized hit target; hover or tap pops a tooltip.
import { useId, useState } from "react";
import type { ColorScale } from "@/components/chart";
import { cn } from "@/lib/utils";

export type RadarAxis = {
  key: string;
  label: string;
  // Percent of the reference (100 = on the reference ring).
  value: number;
  // Tooltip lines under the label (e.g. "You 38 cm · Ideal 44.5 cm").
  detail?: string[];
  // Draws the vertex hollow + bolds the label — e.g. the parts to prioritise.
  emphasis?: boolean;
  // The vertex's own color, overriding colorScale (e.g. a part judged on
  // different bands than the rest).
  color?: string;
};

const SIZE = 300;
const C = SIZE / 2;
const R = 100; // radius of the outer ring
const LABEL_R = R + 20;
// With labels inside, the rings fill the box and the spoke labels sit just
// inside the outer ring — the 125%+ band real profiles rarely reach — so a
// narrow column still gets a readable chart.
const R_INSIDE = 138;

export function RadarChart({
  axes,
  reference = 100,
  referenceLabel,
  labelsInside = false,
  colorScale,
  className,
}: {
  axes: RadarAxis[];
  reference?: number;
  referenceLabel?: string;
  labelsInside?: boolean;
  // Tint the series by value (in the axes' percent units): a radial gradient
  // from the centre out, so the outline takes the color of the band each
  // stretch of it sits in, and each vertex its own value's color.
  colorScale?: ColorScale | null;
  className?: string;
}) {
  const radius = labelsInside ? R_INSIDE : R;
  const [active, setActive] = useState<string | null>(null);
  // useId's punctuation isn't safe inside url(#…).
  const gradId = `radar-grad-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (axes.length < 3) return null;

  // Scale: the centre is `min`, not 0 — real profiles sit around 80–110%, and
  // a zero centre squeezes exactly those differences into the outer rim. The
  // rings are labelled so the offset is visible. At least 125% at the edge so
  // the reference ring has headroom; grows in 25% steps for overdeveloped
  // parts. Values outside [min, max] are clamped.
  const min = Math.min(50, Math.floor(Math.min(...axes.map((a) => a.value)) / 25) * 25);
  const max = Math.max(125, Math.ceil(Math.max(...axes.map((a) => a.value)) / 25) * 25);
  const rings: number[] = [];
  for (let p = min + 25; p <= max; p += 25) rings.push(p);
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / axes.length;
  const at = (i: number, pct: number): [number, number] => {
    const r = ((Math.min(Math.max(pct, min), max) - min) / (max - min)) * radius;
    return [C + r * Math.cos(angle(i)), C + r * Math.sin(angle(i))];
  };
  const ring = (pct: number) =>
    axes
      .map((_, i) =>
        at(i, pct)
          .map((n) => n.toFixed(1))
          .join(","),
      )
      .join(" ");
  const polygon = axes
    .map((a, i) =>
      at(i, a.value)
        .map((n) => n.toFixed(1))
        .join(","),
    )
    .join(" ");
  const activeIdx = axes.findIndex((a) => a.key === active);
  // Gradient offsets are fractions of the radius, which maps min…max.
  const gradient = colorScale && colorScale.stops.length >= 2 ? colorScale.stops : null;
  const paint = gradient ? `url(#${gradId})` : "currentColor";
  const vertexColor = (a: RadarAxis) => a.color ?? colorScale?.colorAt(a.value) ?? "currentColor";

  return (
    <div dir="ltr" className={cn("relative mx-auto w-full max-w-80", className)}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width="100%"
        className="block overflow-visible text-primary"
        role="img"
        aria-label={axes.map((a) => `${a.label} ${Math.round(a.value)}%`).join(", ")}
        onMouseLeave={() => setActive(null)}
      >
        {gradient && (
          <defs>
            <radialGradient id={gradId} gradientUnits="userSpaceOnUse" cx={C} cy={C} r={radius}>
              {gradient.map((s, i) => (
                <stop
                  key={i}
                  offset={Math.min(1, Math.max(0, (s.value - min) / (max - min)))}
                  style={{ stopColor: s.color }}
                />
              ))}
            </radialGradient>
          </defs>
        )}
        {/* Recessive scaffolding: rings + spokes. */}
        {rings.map((p) => (
          <polygon key={p} points={ring(p)} fill="none" className="stroke-muted" strokeWidth={1} />
        ))}
        {/* Ring values along the first spoke (the reference ring is labelled below). */}
        {rings
          .filter((p) => p !== reference)
          .map((p) => (
            <text
              key={p}
              x={C + 3}
              y={C - ((p - min) / (max - min)) * radius - 3}
              className="fill-muted-foreground"
              fontSize={8}
            >
              {p}%
            </text>
          ))}
        {axes.map((a, i) => {
          const [x, y] = at(i, max);
          return (
            <line
              key={a.key}
              x1={C}
              y1={C}
              x2={x}
              y2={y}
              className="stroke-muted"
              strokeWidth={1}
            />
          );
        })}
        {/* Reference ring (the ideal). */}
        <polygon
          points={ring(reference)}
          fill="none"
          className="stroke-muted-foreground"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        {referenceLabel && (
          <text
            x={C + 3}
            y={C - ((reference - min) / (max - min)) * radius - 3}
            className="fill-muted-foreground"
            fontSize={9}
          >
            {referenceLabel}
          </text>
        )}
        {/* The series. */}
        <polygon
          points={polygon}
          fill={paint}
          fillOpacity={0.14}
          stroke={paint}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {axes.map((a, i) => {
          const [x, y] = at(i, a.value);
          const isActive = activeIdx === i;
          return (
            <g key={a.key}>
              <circle
                cx={x}
                cy={y}
                r={isActive ? 5.5 : 4}
                fill={a.emphasis ? "var(--card)" : vertexColor(a)}
                stroke={a.emphasis ? vertexColor(a) : "var(--card)"}
                strokeWidth={2}
              />
              <circle
                cx={x}
                cy={y}
                r={14}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setActive(a.key)}
                onClick={() => setActive(isActive ? null : a.key)}
              />
            </g>
          );
        })}
        {/* Spoke labels: outside, anchored away from the centre so they never
            overlap it; inside, anchored toward it so they stay in the box. */}
        {axes.map((a, i) => {
          const cos = Math.cos(angle(i));
          const sin = Math.sin(angle(i));
          const side = Math.abs(cos) < 0.2 ? 0 : cos > 0 ? 1 : -1;
          const anchor = side === 0 ? "middle" : side > 0 !== labelsInside ? "start" : "end";
          const labelR = labelsInside ? R_INSIDE - 4 : LABEL_R;
          const dy = labelsInside
            ? sin > 0.2
              ? -4
              : sin < -0.2
                ? 11
                : 4
            : sin > 0.2
              ? 8
              : sin < -0.2
                ? -2
                : 3;
          return (
            <text
              key={a.key}
              x={C + labelR * cos}
              y={C + labelR * sin + dy}
              textAnchor={anchor}
              fontSize={labelsInside ? 12 : 11}
              className={cn(
                "cursor-pointer fill-foreground",
                a.emphasis ? "font-semibold" : "fill-muted-foreground",
              )}
              onMouseEnter={() => setActive(a.key)}
              onClick={() => setActive(activeIdx === i ? null : a.key)}
            >
              {a.label}
            </text>
          );
        })}
      </svg>
      {activeIdx >= 0 && (
        <RadarTooltip axis={axes[activeIdx]} pos={at(activeIdx, axes[activeIdx].value)} />
      )}
    </div>
  );
}

function RadarTooltip({ axis, pos }: { axis: RadarAxis; pos: [number, number] }) {
  const leftPct = (pos[0] / SIZE) * 100;
  const xTransform =
    leftPct < 30 ? "translate-x-0" : leftPct > 70 ? "-translate-x-full" : "-translate-x-1/2";
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 -translate-y-full rounded-md border bg-popover px-2 py-1 text-[11px] whitespace-nowrap shadow-overlay",
        xTransform,
      )}
      style={{ left: `${leftPct}%`, top: `calc(${(pos[1] / SIZE) * 100}% - 8px)` }}
    >
      <div className="font-medium">
        {axis.label} · {Math.round(axis.value)}%
      </div>
      {axis.detail?.map((d) => (
        <div key={d} className="text-muted-foreground">
          {d}
        </div>
      ))}
    </div>
  );
}
