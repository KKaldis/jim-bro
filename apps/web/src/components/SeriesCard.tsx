import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { type ChartPoint, type ColorScale, LineChart } from "@/components/chart";
import { averageTrend } from "@/components/SpacingToggle";

// A tapped point: which record and which chart the tap landed on. Every chart
// highlights the record, but only the one that was tapped carries its edit /
// delete controls — a copy of the same buttons on every chart would be noise.
export type ChartSelection = { chart: string; key: string };

// One metric's line chart in its own card. A page renders several and owns the
// selection, so tapping a point on one opens that record's tooltip on all of
// them (Body → Composition and Body → Measurements).
export function SeriesCard({
  id,
  title,
  points,
  unit,
  from,
  to,
  selection,
  onSelect,
  actions,
  reference,
  average = 0,
  colorScale,
}: {
  // Identifies this series within the shared selection.
  id: string;
  title: string;
  points: ChartPoint[];
  unit: string;
  // The date window the points are placed within, or undefined for even
  // spacing — see LineChart.
  from?: string;
  to?: string;
  // Selection is owned by the page so every series highlights the same
  // weigh-in; tapping a point here opens its tooltip on the other charts too.
  selection: ChartSelection | null;
  onSelect: (selection: ChartSelection | null) => void;
  actions: (point: ChartPoint) => React.ReactNode;
  // Optional dashed target line, passed through to LineChart.
  reference?: { value: number; label: string } | null;
  // Overlay a trailing average over this many days (see rollingAverage); 0 for none.
  average?: number;
  // Tint the line by value bands (see gaugeColorScale).
  colorScale?: ColorScale | null;
}) {
  const { t } = useTranslation();
  if (points.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <LineChart
          points={points}
          unit={unit}
          from={from}
          to={to}
          selectedKey={selection?.key ?? null}
          onSelectKey={(key) => {
            // A null key means the tapped point was already the selected one.
            // On a chart that was only mirroring the selection that's a request
            // for its controls, not a dismissal — so take the selection over
            // instead of clearing it.
            if (key == null && selection != null && selection.chart !== id) {
              onSelect({ chart: id, key: selection.key });
              return;
            }
            onSelect(key == null ? null : { chart: id, key });
          }}
          // Only the tapped chart offers the controls; the rest mirror the
          // selection so you can read the same day across every metric.
          tooltipActions={selection?.chart === id ? actions : undefined}
          reference={reference}
          trend={averageTrend(points, average, t)}
          colorScale={colorScale}
        />
      </CardContent>
    </Card>
  );
}
