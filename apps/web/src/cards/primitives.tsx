// Building blocks shared by the result cards: shell, stats, macro bars and value readers.
import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { relativeDay, today, toIso } from "../dateRange";
import i18n from "../i18n";
import { categoryMeta, type ToolCategory } from "../lib/toolCategory";
import type { View } from "../lib/uiStore";
import { cn } from "../lib/utils";
import { useCardNav } from "./cardNav";

// ---------- defensive readers ----------
export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

// ---------- shared chrome ----------
export function CardShell({
  category,
  title,
  subtitle,
  children,
}: {
  category: ToolCategory;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  const meta = categoryMeta(category);
  const Icon = meta.Icon;
  return (
    <div className="my-1 rounded-xl border border-edge bg-card p-3 text-card-foreground shadow-surface">
      <div className="mb-2 flex items-center gap-1.5">
        <Icon className={cn("size-3.5", meta.iconClass)} aria-hidden />
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        {subtitle != null && subtitle !== "" && (
          <span className="ms-auto text-[11px] text-muted-foreground">{subtitle}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export function BigStat({
  value,
  unit,
  label,
  tone,
}: {
  value: string;
  unit?: string;
  label?: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col">
      <div
        className="text-2xl leading-none font-semibold"
        style={tone ? { color: tone } : undefined}
      >
        {value}
        {unit && <span className="ms-1 text-sm font-normal text-muted-foreground">{unit}</span>}
      </div>
      {label && <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>}
    </div>
  );
}

// The muted day-context tag on the right of a day-scoped result card's header.
// It's a button that jumps the matching data screen to the card's day (so the
// user can open the full log) — for today as well as past days — via the same
// setSelectedDate + show_screen plumbing the agent uses. The label is computed
// LIVE ("Today" only when the date is actually today) so a card built today
// reads as its date once the day rolls over, instead of staying "Today" forever
// off a stale flag. With no CardNav in context (cards outside chat) it degrades
// to plain text.
function DayTag({
  date,
  screen,
  tab,
  prefix,
}: {
  date: string;
  screen: View;
  tab?: string;
  prefix?: string;
}) {
  const { t } = useTranslation();
  const nav = useCardNav();
  const isToday = date === toIso(today());
  // Relative label (Today/Yesterday/Tomorrow, else "27 Jan") so card headers
  // read like the rest of the chat instead of a raw ISO date. The prefix
  // ("as of ") is dropped for Today since "Today" already reads cleanly.
  const label = relativeDay(date);
  const text = isToday ? label : `${prefix ?? ""}${label}`;
  if (!nav) return <>{text}</>;
  return (
    <button
      type="button"
      onClick={() => nav.navigateToDate(date, screen, tab)}
      className="group inline-flex items-center gap-0.5 rounded-sm text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      title={isToday ? t("cards.dayTag.openToday") : t("cards.dayTag.openDate", { date })}
    >
      <span className="underline decoration-primary/50 decoration-dotted underline-offset-2 transition-all group-hover:decoration-solid">
        {text}
      </span>
      <ArrowUpRight className="size-3" aria-hidden />
    </button>
  );
}

// Build the header day tag for a day-scoped card. Needs the result's `date` to
// navigate; falls back to a plain "Today" label when only the is_today flag is
// present (no date to jump to), or null when there's no day context at all.
export function dayTag(
  data: Record<string, unknown>,
  screen: View,
  opts?: { prefix?: string; tab?: string },
): React.ReactNode {
  const date = str(data.date);
  if (!date) return data.is_today === true ? i18n.t("cards.dayTag.today") : null;
  return <DayTag date={date} screen={screen} tab={opts?.tab} prefix={opts?.prefix} />;
}

// A small row used by the list-style cards: a label on the left, a value on the
// right, optional sub-line under the label.
export function ListRow({
  label,
  sub,
  value,
}: {
  label: string;
  sub?: string | null;
  value?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-xs">
      <div className="min-w-0 wrap-break-word">
        <span>{label}</span>
        {sub && <span className="text-muted-foreground"> · {sub}</span>}
      </div>
      {value && <span className="shrink-0 font-medium tabular-nums">{value}</span>}
    </div>
  );
}

// ---------- weight display for the energy/body calculator cards ----------
// Shared results are metric; tools echo the caller's `units`, so a user working
// in pounds reads pounds back.
export const LB_PER_KG = 2.2046226218;
export function massLabel(kg: number, imperial: boolean): string {
  return imperial ? `${(kg * LB_PER_KG).toFixed(1)} lb` : `${kg.toFixed(1)} kg`;
}
