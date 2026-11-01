// Compact "health bar" gauge for body-composition metrics — a smooth color
// gradient (red → amber → green) with a marker showing where the current
// value sits and a colored level label beneath it. Gives an at-a-glance
// optical read of whether a BMI / body-fat % / FFMI reading is good.
//
// Zone boundaries mirror the category functions in shared/src/bmr.ts (BMI =
// WHO cutoffs; FFMI = Kouri et al. 1995 on the normalized value; body-fat %
// = ACE/general fitness bands, which differ by sex).

import type { ColorScale, ColorStop } from "@/components/chart";
import i18n from "../i18n";
import { useTheme } from "./theme";

type Sex = "male" | "female";

// good = in the healthy/optimal band, warn = sub-optimal but not alarming,
// bad = unhealthy / outside the natural range.
type Tone = "good" | "warn" | "bad";

const TONE_COLOR: Record<Tone, string> = {
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
};

// A zone spans from the previous boundary (or scale.min for the first) up to
// `to`; the last zone's `to` equals scale.max. `label` holds an i18n key token
// under lib.gauge.* resolved to display text via zoneLabel().
type Zone = { to: number; tone: Tone; label: string };
type Scale = { min: number; max: number; zones: Zone[] };

// Resolve a zone's i18n token to localized display text.
function zoneLabel(z: Zone): string {
  return i18n.t(`lib.gauge.${z.label}`);
}

const BMI_SCALE: Scale = {
  min: 15,
  max: 40,
  zones: [
    { to: 18.5, tone: "warn", label: "underweight" },
    { to: 25, tone: "good", label: "normal" },
    { to: 30, tone: "warn", label: "overweight" },
    { to: 40, tone: "bad", label: "obese" },
  ],
};

// Body-fat % bands (ACE): the optimal "athletic/fitness" window and the
// essential-fat floor both differ markedly between sexes.
const BODY_FAT_SCALE: Record<Sex, Scale> = {
  male: {
    min: 4,
    max: 35,
    zones: [
      { to: 6, tone: "warn", label: "veryLean" },
      { to: 14, tone: "good", label: "athletic" },
      { to: 18, tone: "good", label: "fit" },
      { to: 25, tone: "warn", label: "average" },
      { to: 35, tone: "bad", label: "high" },
    ],
  },
  female: {
    min: 10,
    max: 42,
    zones: [
      { to: 14, tone: "warn", label: "very lean" },
      { to: 21, tone: "good", label: "athletic" },
      { to: 25, tone: "good", label: "fit" },
      { to: 32, tone: "warn", label: "average" },
      { to: 42, tone: "bad", label: "high" },
    ],
  },
};

// Weight has no inherent "good" band — but paired with height it does: the
// healthy weight range for a person's height is just the BMI cutoffs
// (18.5 / 25 / 30 / 40) multiplied by height². Same signal as the BMI gauge,
// re-expressed in the kg the user actually tracks. Built per-render because
// the scale depends on the individual's height.
function weightScale(heightCm: number): Scale {
  const hh = (heightCm / 100) ** 2; // height² in m²
  const at = (bmi: number) => bmi * hh;
  return {
    min: at(15),
    max: at(40),
    zones: [
      { to: at(18.5), tone: "warn", label: "underweight" },
      { to: at(25), tone: "good", label: "healthy" },
      { to: at(30), tone: "warn", label: "overweight" },
      { to: at(40), tone: "bad", label: "obese" },
    ],
  };
}

// FFMI uses the normalized (height-adjusted) value; boundaries match
// ffmiCategory() in bmr.ts. Higher is more muscular, until the natural
// ceiling (25 male / 21.5 female) is crossed.
const FFMI_SCALE: Record<Sex, Scale> = {
  male: {
    min: 16,
    max: 27,
    zones: [
      { to: 18, tone: "warn", label: "belowAverage" },
      { to: 20, tone: "good", label: "aboveAverage" },
      { to: 22.5, tone: "good", label: "outstanding" },
      { to: 25, tone: "good", label: "extremelyHigh" },
      { to: 27, tone: "bad", label: "aboveNatural" },
    ],
  },
  female: {
    min: 12,
    max: 23,
    zones: [
      { to: 14, tone: "warn", label: "belowAverage" },
      { to: 17, tone: "good", label: "aboveAverage" },
      { to: 19, tone: "good", label: "outstanding" },
      { to: 21.5, tone: "good", label: "extremelyHigh" },
      { to: 23, tone: "bad", label: "aboveNatural" },
    ],
  },
};

// Current lean mass as % of the frame-predicted natural ceiling (Casey Butt).
// Bands are training-age rules of thumb: untrained adults typically sit around
// 65–75%, years of good training reach the high 80s, and the last few % take
// most of a lifting career. Past 100% the formula is off (or not natural).
const POTENTIAL_SCALE: Scale = {
  min: 55,
  max: 105,
  zones: [
    { to: 75, tone: "warn", label: "beginner" },
    { to: 85, tone: "good", label: "intermediate" },
    { to: 92, tone: "good", label: "advanced" },
    { to: 100, tone: "good", label: "nearCeiling" },
    { to: 105, tone: "bad", label: "aboveNatural" },
  ],
};

// A girth as % of its frame-scaled ideal (computeIdealProportions'
// pct_of_ideal). The ideal is a range, missed either way: bands mirror
// statusOf in shared/src/proportions.ts — under 90 lagging, 90-97 close,
// 97-105 on target, past that above ideal — and turn red well outside it.
const PROPORTION_SCALE: Scale = {
  min: 70,
  max: 130,
  zones: [
    { to: 85, tone: "bad", label: "lagging" },
    { to: 90, tone: "warn", label: "lagging" },
    { to: 97, tone: "warn", label: "close" },
    { to: 105, tone: "good", label: "onTarget" },
    { to: 115, tone: "warn", label: "aboveIdeal" },
    { to: 130, tone: "bad", label: "wellAboveIdeal" },
  ],
};

// The waist is inverted — smaller is better — so its pct_of_ideal is
// ideal / actual, capped at 100: under 95 means it's above the ideal girth.
const WAIST_PROPORTION_SCALE: Scale = {
  min: 70,
  max: 100,
  zones: [
    { to: 95, tone: "warn", label: "aboveIdeal" },
    { to: 100, tone: "good", label: "onTarget" },
  ],
};

type Kind = "bmi" | "bodyFat" | "ffmi" | "weight" | "potential" | "proportion" | "waistProportion";

// The proportion gauge a body part is judged on.
export function proportionKind(part: string): Kind {
  return part === "waist" ? "waistProportion" : "proportion";
}

function scaleFor(
  kind: Kind,
  sex: Sex | null | undefined,
  heightCm: number | null | undefined,
): Scale | null {
  if (kind === "bmi") return BMI_SCALE;
  if (kind === "potential") return POTENTIAL_SCALE;
  if (kind === "proportion") return PROPORTION_SCALE;
  if (kind === "waistProportion") return WAIST_PROPORTION_SCALE;
  if (kind === "weight") {
    return heightCm && heightCm > 0 ? weightScale(heightCm) : null;
  }
  if (!sex) return null; // body-fat / FFMI bands are sex-specific
  return kind === "bodyFat" ? BODY_FAT_SCALE[sex] : FFMI_SCALE[sex];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// The zone a value lands in (first zone whose upper bound it's below; the last
// zone catches everything at or above the scale max).
function activeZone(scale: Scale, value: number): Zone {
  for (const z of scale.zones) if (value < z.to) return z;
  return scale.zones[scale.zones.length - 1];
}

// Each zone's color anchored at its midpoint, with the end zones pinned to the
// scale's min / max so the gradient fills edge to edge.
function colorStops(scale: Scale): ColorStop[] {
  const stops: ColorStop[] = [];
  let prev = scale.min;
  scale.zones.forEach((z, i) => {
    const color = TONE_COLOR[z.tone];
    if (i === 0) stops.push({ value: scale.min, color });
    stops.push({ value: (prev + z.to) / 2, color });
    if (i === scale.zones.length - 1) stops.push({ value: scale.max, color });
    prev = z.to;
  });
  return stops;
}

// Smooth left-to-right bar gradient; CSS interpolates between the stops for
// the soft "sexy" blend.
function gradientFor(scale: Scale): string {
  const span = scale.max - scale.min || 1;
  const pct = (v: number) => ((clamp(v, scale.min, scale.max) - scale.min) / span) * 100;
  const stops = colorStops(scale).map((s) => `${s.color} ${pct(s.value).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

// Solid zone bands with hard edges, for the brutal style (no blends).
function bandsFor(scale: Scale): string {
  const span = scale.max - scale.min || 1;
  const pct = (v: number) => ((clamp(v, scale.min, scale.max) - scale.min) / span) * 100;
  let prev = scale.min;
  const bands = scale.zones.map((z, i) => {
    const to = i === scale.zones.length - 1 ? scale.max : z.to;
    const band = `${TONE_COLOR[z.tone]} ${pct(prev).toFixed(1)}% ${pct(to).toFixed(1)}%`;
    prev = z.to;
    return band;
  });
  return `linear-gradient(90deg, ${bands.join(", ")})`;
}

// The same zones as a chart color scale, so a progress line is tinted by the
// band each value falls in — a reading's color on the chart matches where it
// sits on its gauge. Null when the scale is unknown (no sex / height).
export function gaugeColorScale(
  kind: Kind,
  sex?: Sex | null,
  heightCm?: number | null,
): ColorScale | null {
  const scale = scaleFor(kind, sex, heightCm);
  if (!scale) return null;
  return {
    stops: colorStops(scale),
    colorAt: (v) => TONE_COLOR[activeZone(scale, v).tone],
  };
}

// The values at the bar's left and right edges, for labelling them in another
// unit (e.g. a girth's % of ideal as cm).
export function gaugeRange(
  kind: Kind,
  sex?: Sex | null,
  heightCm?: number | null,
): { min: number; max: number } | null {
  const scale = scaleFor(kind, sex, heightCm);
  return scale ? { min: scale.min, max: scale.max } : null;
}

export function MetricGauge({
  kind,
  value,
  sex,
  heightCm,
  projected,
  ends,
}: {
  // Labels under the bar's left and right edges; the zone label moves to the
  // middle between them.
  ends?: [string, string] | null;
  kind: Kind;
  value: number | null | undefined;
  sex?: Sex | null;
  // Required for kind="weight" — the healthy band is derived from height.
  heightCm?: number | null;
  // "Projected" mode (chat preview cards): a not-yet-committed value to mark on
  // the same scale — e.g. the BMI/FFMI/body-fat a hypothetical weigh-in would
  // produce. Drawn as a hollow handle with the resulting zone label, so a
  // weigh-in preview reads "current → projected" without logging anything.
  projected?: number | null;
}) {
  const { style } = useTheme();
  const scale = scaleFor(kind, sex, heightCm);
  if (value == null || !Number.isFinite(value) || !scale) return null;

  const span = scale.max - scale.min || 1;
  const posPct = clamp((value - scale.min) / span, 0, 1) * 100;
  const zone = activeZone(scale, value);

  const projecting =
    projected != null && Number.isFinite(projected) && Math.abs(projected - value) > 0.05;
  const projPct = projecting ? clamp((projected - scale.min) / span, 0, 1) * 100 : null;
  const projZone = projecting ? activeZone(scale, projected as number) : null;

  return (
    <div className="mt-1.5" title={`${value.toFixed(1)} · ${zoneLabel(zone)}`}>
      <div
        dir="ltr"
        className="relative h-2 w-full rounded-full ring-1 ring-black/5 ring-inset"
        style={{ background: style === "brutal" ? bandsFor(scale) : gradientFor(scale) }}
      >
        {/* Projected marker: a hollow handle the committed one sits in front of. */}
        {projPct != null && (
          <div
            className="absolute top-1/2 h-3.5 w-1.5 -translate-1/2 rounded-full bg-background shadow-sm ring-2 ring-foreground/60"
            style={{ left: `${projPct}%` }}
          />
        )}
        {/* Slider-handle marker pinned to the value's position. */}
        <div
          className="absolute top-1/2 h-3.5 w-1.5 -translate-1/2 rounded-full bg-foreground shadow-sm ring-2 ring-background"
          style={{ left: `${posPct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-medium">
        {ends && <span className="text-muted-foreground tabular-nums">{ends[0]}</span>}
        <span style={{ color: TONE_COLOR[zone.tone] }}>{zoneLabel(zone)}</span>
        {projZone != null && (
          <span style={{ color: TONE_COLOR[projZone.tone] }}>
            → {(projected as number).toFixed(1)} · {zoneLabel(projZone)}
          </span>
        )}
        {ends && <span className="text-muted-foreground tabular-nums">{ends[1]}</span>}
      </div>
    </div>
  );
}
