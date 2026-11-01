import type { TFunction } from "i18next";
import { FileDown, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type ChartPoint, rollingAverage } from "@/components/chart";
import { HelpPopover } from "@/components/HelpPopover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fromIso, type Granularity } from "@/dateRange";
import type { ChartAverage, ChartColor, ChartSpacing } from "@/lib/uiStore";
import { cn } from "@/lib/utils";

// `short` is the compact form the menu trigger shows once a window is picked.
export const AVERAGE_OPTIONS: { value: ChartAverage; key: string; short: string }[] = [
  { value: 0, key: "body.averageNone", short: "body.averageNone" },
  { value: 7, key: "body.average1w", short: "body.average1wShort" },
  { value: 14, key: "body.average2w", short: "body.average2wShort" },
  { value: 30, key: "body.average1m", short: "body.average1mShort" },
];

// Compact label for an average window — "off" / "1w" / "2w" / "1m" — so the
// controls showing it stay on one line on mobile.
export function averageShortLabel(value: ChartAverage, t: TFunction): string {
  return t(AVERAGE_OPTIONS.find((x) => x.value === value)?.short ?? "body.averageNone");
}

// The longest average window that makes sense for the charted range: a month's
// average over a week's view would just be the week's mean. Week and month go by
// the granularity (so 1m fits a 28-day February); all/custom by the days spanned.
export function averageCap({
  granularity,
  from,
  to,
}: {
  granularity: Granularity;
  from: string;
  to: string;
}): number {
  if (granularity === "week") return 7;
  if (granularity === "month") return 30;
  return Math.round((fromIso(to).getTime() - fromIso(from).getTime()) / 86_400_000) + 1;
}

// LineChart's `trend` for a series: its trailing `days`-day average (see
// rollingAverage), or null when off or a single point leaves nothing to average.
export function averageTrend(
  points: ChartPoint[],
  days: number,
  t: TFunction,
): { values: number[]; label: string } | null {
  if (days <= 0 || points.length < 2) return null;
  return { values: rollingAverage(points, days), label: t("body.averageDays", { count: days }) };
}

// The saved window, stepped down to the longest option within `cap`. The saved
// preference itself is left alone, so going back to a longer view restores it.
export function fitAverage(value: ChartAverage, cap: number): ChartAverage {
  return AVERAGE_OPTIONS.reduce<ChartAverage>(
    (best, o) => (o.value <= value && o.value <= cap ? o.value : best),
    0,
  );
}

// The small chip that opens a chart-settings menu. In soft it's a raised
// control that presses in while its menu is open.
export const CHART_MENU_TRIGGER =
  "inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground transition-[color,box-shadow] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none soft:bg-background soft:shadow-control soft:data-[state=open]:shadow-pressed soft:data-[state=open]:text-foreground";

const COLOR_OPTIONS = ["scale", "solid"] as const;
const colorKey = (v: ChartColor) => (v === "scale" ? "body.colorScale" : "body.colorSolid");

// Just the scale / solid choice, for a card with no other chart controls
// (Body → Measurements' current card, whose radar follows the same setting).
export function ChartColorMenu({
  color,
  onColor,
}: {
  color: ChartColor;
  onColor: (value: ChartColor) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={CHART_MENU_TRIGGER}>
        <SlidersHorizontal className="size-3" aria-hidden />
        <span>
          {t("body.colorLabel")}{" "}
          <span className="font-medium text-foreground">{t(colorKey(color))}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-28">
        <DropdownMenuRadioGroup value={color} onValueChange={(v) => onColor(v as ChartColor)}>
          {COLOR_OPTIONS.map((v) => (
            <DropdownMenuRadioItem key={v} value={v} className="text-xs">
              {t(colorKey(v))}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The charts' display preferences in one dropdown — the trigger shows the
// current average window and spacing, the menu picks each (averages offered up
// to `cap`, see fitAverage) — with a "?" beside it explaining what they do.
export function ChartControls({
  average,
  cap,
  onAverage,
  spacing,
  onSpacing,
  color,
  onColor,
  onExport,
}: {
  average: ChartAverage;
  cap: number;
  onAverage: (value: ChartAverage) => void;
  spacing: ChartSpacing;
  onSpacing: (value: ChartSpacing) => void;
  // Line color mode; the section is only offered where the charts support it.
  color?: ChartColor;
  onColor?: (value: ChartColor) => void;
  // Adds "Export PDF" as the menu's last entry.
  onExport?: () => void;
}) {
  const { t } = useTranslation();
  const averages = AVERAGE_OPTIONS.filter((o) => o.value <= cap);
  const spacingLabel = (v: ChartSpacing) =>
    t(v === "date" ? "body.spacingByDate" : "body.spacingEven");
  const averageLabel = averageShortLabel(average, t);
  // Picking an option leaves the menu open, so both can be changed in one go;
  // it closes on an outside tap or Esc.
  const keepOpen = (e: Event) => e.preventDefault();
  const help = ["spacingEven", "spacingDate", "average", "averageWindow", "averageCap"];
  return (
    <div className="flex items-center justify-end gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(CHART_MENU_TRIGGER, "whitespace-nowrap")}>
          <SlidersHorizontal className="size-3" aria-hidden />
          <span>
            {t("body.averageLabel")}{" "}
            <span className="font-medium text-foreground">{averageLabel}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            {t("body.spacingLabel")}{" "}
            <span className="font-medium text-foreground">{spacingLabel(spacing)}</span>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuLabel>{t("body.averageLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(average)}
            onValueChange={(v) => onAverage(Number(v) as ChartAverage)}
          >
            {averages.map((o) => (
              <DropdownMenuRadioItem
                key={o.value}
                value={String(o.value)}
                className="text-xs"
                onSelect={keepOpen}
              >
                {t(o.key)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("body.spacingLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={spacing}
            onValueChange={(v) => onSpacing(v as ChartSpacing)}
          >
            {(["even", "date"] as const).map((v) => (
              <DropdownMenuRadioItem key={v} value={v} className="text-xs" onSelect={keepOpen}>
                {spacingLabel(v)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {color && onColor && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("body.colorLabel")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={color} onValueChange={(v) => onColor(v as ChartColor)}>
                {COLOR_OPTIONS.map((v) => (
                  <DropdownMenuRadioItem key={v} value={v} className="text-xs" onSelect={keepOpen}>
                    {t(colorKey(v))}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}
          {onExport && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-xs" onSelect={onExport}>
                <FileDown className="size-3.5" />
                {t("export.exportPdf")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <HelpPopover label={t("body.chartHelp.aria")} heading={t("body.chartHelp.heading")}>
        <ul className="list-disc space-y-1.5 ps-4">
          {help.map((k) => (
            <li key={k}>{t(`body.chartHelp.${k}`)}</li>
          ))}
        </ul>
      </HelpPopover>
    </div>
  );
}
