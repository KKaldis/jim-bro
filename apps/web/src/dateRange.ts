export type Granularity = "day" | "week" | "month" | "all" | "custom";

// A user-picked explicit range, used when granularity === "custom". Both ends
// are inclusive ISO YYYY-MM-DD, same contract as `Range`.
export type CustomRange = { from: string; to: string };

export type Range = { from: string; to: string; label: string };

// "All" is a bounded look-back (a truly open range would make the day-by-day
// aggregation on both client and server iterate an unbounded number of days).
// Screens then trim it to the first day that actually has data — see clipToData.
const ALL_LOOKBACK_DAYS = 365;

// Sensible starting point for the custom range picker: the last week.
export function defaultCustomRange(): CustomRange {
  const to = today();
  const from = new Date(to);
  from.setDate(from.getDate() - 7);
  return { from: toIso(from), to: toIso(to) };
}

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromIso(s: string): Date {
  return new Date(s + "T00:00:00");
}

export function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Week starts Monday.
function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // Mon=0
  out.setDate(out.getDate() - diff);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// `anchor` is any date inside the desired period. `custom` is only read when
// g === "custom"; the other granularities derive their range from `anchor`.
export function rangeFor(g: Granularity, anchor: Date, custom?: CustomRange): Range {
  if (g === "day") {
    const iso = toIso(anchor);
    return { from: iso, to: iso, label: humanDay(anchor) };
  }
  if (g === "week") {
    const start = startOfWeek(anchor);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return {
      from: toIso(start),
      to: toIso(end),
      label: `${MONTH_SHORT[start.getMonth()]} ${start.getDate()} – ${MONTH_SHORT[end.getMonth()]} ${end.getDate()}`,
    };
  }
  if (g === "month") {
    const start = startOfMonth(anchor);
    const end = endOfMonth(anchor);
    return {
      from: toIso(start),
      to: toIso(end),
      label: `${MONTH_SHORT[start.getMonth()]} ${start.getFullYear()}`,
    };
  }
  if (g === "all") {
    const to = today();
    const from = new Date(to);
    from.setDate(from.getDate() - ALL_LOOKBACK_DAYS);
    const fromIso = toIso(from);
    const toIso_ = toIso(to);
    return { from: fromIso, to: toIso_, label: spanLabel(fromIso, toIso_) };
  }
  // custom — order the two ends so `from <= to` (the API rejects from > to).
  const a = custom?.from || toIso(today());
  const b = custom?.to || toIso(today());
  const from = a <= b ? a : b;
  const to = a <= b ? b : a;
  return { from, to, label: spanLabel(from, to) };
}

export function shift(g: Granularity, anchor: Date, dir: -1 | 1): Date {
  const d = new Date(anchor);
  if (g === "day") d.setDate(d.getDate() + dir);
  else if (g === "week") d.setDate(d.getDate() + 7 * dir);
  else if (g === "month") d.setMonth(d.getMonth() + dir);
  // "all"/"custom" don't step — RangeNav hides the prev/next arrows for them.
  return d;
}

// "All" means "everything there is, up to a year back": once the screen knows
// its earliest data date inside the fetched look-back window, start the range
// there so a newer account doesn't get months of empty leading days. Other
// granularities are fixed calendar periods and pass through untouched.
export function clipToData(range: Range, g: Granularity, firstDataIso?: string | null): Range {
  if (g !== "all" || !firstDataIso || firstDataIso <= range.from || firstDataIso > range.to) {
    return range;
  }
  return { from: firstDataIso, to: range.to, label: spanLabel(firstDataIso, range.to) };
}

// "13 Nov 2024 – 20 Nov 2024" span for the all/custom ranges (the year is
// dropped by toDisplay when it's the current one).
function spanLabel(from: string, to: string): string {
  return `${toDisplay(fromIso(from))} – ${toDisplay(fromIso(to))}`;
}

export function humanDay(d: Date): string {
  const t = today();
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  const display = toDisplay(d);
  if (diff === 0) return `Today · ${display}`;
  if (diff === -1) return `Yesterday · ${display}`;
  if (diff === 1) return `Tomorrow · ${display}`;
  return display;
}

// How many whole days `iso` is from today (negative = past, positive = future).
export function dayDiffFromToday(iso: string): number {
  return Math.round((fromIso(iso).getTime() - today().getTime()) / 86_400_000);
}

// Compact relative day label for chips/badges. "Today"/"Yesterday"/"Tomorrow"
// for the immediate neighbours, else "27 Jan" ("27 Jan 2024" outside this year)
// — short and human, never a raw ISO/DD-MM-YYYY string. The single source of
// truth for relative day labels across the chat cards and the header badge.
export function relativeDay(iso: string): string {
  const diff = dayDiffFromToday(iso);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  return toDisplay(fromIso(iso));
}

// "13 Nov" for the current year, "13 Nov 2024" otherwise. The year is only
// noise when it's the one we're in, so drop it then and keep it for any other.
function toDisplay(d: Date): string {
  const base = `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  return d.getFullYear() === today().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}
