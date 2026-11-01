/**
 * "Charts as shown" PDF: a card's trend charts exactly as charted on screen —
 * same window, one point per reading, the chart menu's average + spacing, and
 * any dashed reference line. Opened from the "Export PDF" entry of a chart
 * menu (cardio fitness, body composition, measurements).
 */
import type { ReactNode } from "react";
import { averageTrend } from "../components/SpacingToggle";
import i18n from "../i18n";
import { isoToDisplay } from "../lib/dateFormat";
import { type ChartView, chartViewNote } from "./exerciseProgressPdf";
import {
  PrintHeader,
  PrintLineChart,
  printDocument,
  signed,
  type Stat,
  StatGrid,
} from "./printDoc";

type Point = { date: string; value: number };

export type PrintChart = {
  title: string;
  points: Point[];
  unit: string;
  digits?: number;
  // Dashed target line, e.g. a part's ideal girth.
  reference?: { value: number; label: string } | null;
};

// Latest value (with its date) and its change since the first point.
export function trendStat(label: string, pts: Point[], digits = 1, unit = ""): Stat | null {
  if (pts.length === 0) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const u = unit ? ` ${unit}` : "";
  return {
    label,
    value: `${last.value.toFixed(digits)}${u}`,
    note: [
      isoToDisplay(last.date),
      pts.length > 1 &&
        i18n.t("export.report.changeFrom", {
          change: signed(last.value - first.value, digits),
          first: first.value.toFixed(digits),
        }),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function exportChartsPdf({
  title,
  period,
  view,
  top,
  stats = [],
  charts,
}: {
  title: string;
  period: { from: string; to: string };
  view: ChartView;
  // Printed under the header, before the stats (e.g. the proportions radar).
  top?: ReactNode;
  stats?: Array<Stat | null>;
  charts: PrintChart[];
}): Promise<void> {
  const t = i18n.t.bind(i18n);
  return printDocument(
    `${title} ${period.from} – ${period.to}`,
    <>
      <PrintHeader
        kind={title}
        title={title}
        subtitle={`${isoToDisplay(period.from)} – ${isoToDisplay(period.to)} · ${chartViewNote(view)}`}
      />
      {top}
      <StatGrid stats={stats.filter((s): s is Stat => s != null)} />
      {charts
        .filter((c) => c.points.length > 1)
        .map((c) => (
          <div key={c.title} className="keep">
            <h3>{c.title}</h3>
            <PrintLineChart
              points={c.points}
              unit={c.unit}
              digits={c.digits}
              even={view.spacing === "even"}
              trend={averageTrend(c.points, view.average, t)}
              reference={c.reference}
            />
          </div>
        ))}
    </>,
  );
}
