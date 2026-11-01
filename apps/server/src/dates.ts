/**
 * Calendar-date helpers for YYYY-MM-DD strings (local time).
 */
import { jsonError } from "./http.ts";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRange(url: URL): { from: string; to: string } | { error: Response } {
  const to = url.searchParams.get("to") ?? todayIso();
  const from = url.searchParams.get("from") ?? to;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { error: jsonError(400, "from/to must be YYYY-MM-DD") };
  }
  if (from > to) {
    return { error: jsonError(400, "from must be <= to") };
  }
  return { from, to };
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

export function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Shift an ISO date by N days (signed). Used to compute default range
// windows for the workout-session list. Local-time math via Date() is fine
// here: a 1-day window difference is robust to DST.
export function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
