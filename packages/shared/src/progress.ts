import type { BodyCompEntry, BodyFatMethod } from "./types.ts";

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function avg(xs: (number | null | undefined)[]): number | null {
  const xs2 = xs.filter((x): x is number => x != null);
  if (!xs2.length) return null;
  return round2(xs2.reduce((a, b) => a + b, 0) / xs2.length);
}

export type EntrySnapshot = {
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  body_fat_pct_navy: number | null;
  body_fat_method: BodyFatMethod | null;
  bmi: number | null;
  ffmi: number | null;
  ffmi_normalized: number | null;
  fat_free_mass_kg: number | null;
  fat_mass_kg: number | null;
  waist_cm: number | null;
  neck_cm: number | null;
  hip_cm: number | null;
};

export type WindowStats = {
  from: string;
  to: string;
  samples: number;
  avg_weight_kg: number | null;
  avg_body_fat_pct: number | null;
  avg_bmi: number | null;
  avg_ffmi: number | null;
  avg_ffmi_normalized: number | null;
  avg_fat_free_mass_kg: number | null;
  avg_fat_mass_kg: number | null;
  avg_waist_cm: number | null;
  avg_neck_cm: number | null;
  avg_hip_cm: number | null;
  entries: EntrySnapshot[];
};

function snapshot(e: BodyCompEntry): EntrySnapshot {
  return {
    date: e.date,
    weight_kg: e.weight_kg,
    body_fat_pct: e.body_fat_pct,
    body_fat_pct_navy: e.body_fat_pct_navy ?? null,
    body_fat_method: e.body_fat_method ?? null,
    bmi: e.bmi ?? null,
    ffmi: e.ffmi ?? null,
    ffmi_normalized: e.ffmi_normalized ?? null,
    fat_free_mass_kg: e.fat_free_mass_kg ?? null,
    fat_mass_kg: e.fat_mass_kg ?? null,
    waist_cm: e.waist_cm,
    neck_cm: e.neck_cm ?? null,
    hip_cm: e.hip_cm ?? null,
  };
}

function windowStats(entries: BodyCompEntry[], end: Date, days: number): WindowStats {
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const inWin = entries.filter((e) => {
    const d = new Date(e.date + "T00:00:00");
    return d >= start && d <= end;
  });
  return {
    from: isoDate(start),
    to: isoDate(end),
    samples: inWin.length,
    avg_weight_kg: avg(inWin.map((e) => e.weight_kg)),
    avg_body_fat_pct: avg(inWin.map((e) => e.body_fat_pct)),
    avg_bmi: avg(inWin.map((e) => e.bmi ?? null)),
    avg_ffmi: avg(inWin.map((e) => e.ffmi ?? null)),
    avg_ffmi_normalized: avg(inWin.map((e) => e.ffmi_normalized ?? null)),
    avg_fat_free_mass_kg: avg(inWin.map((e) => e.fat_free_mass_kg ?? null)),
    avg_fat_mass_kg: avg(inWin.map((e) => e.fat_mass_kg ?? null)),
    avg_waist_cm: avg(inWin.map((e) => e.waist_cm)),
    avg_neck_cm: avg(inWin.map((e) => e.neck_cm ?? null)),
    avg_hip_cm: avg(inWin.map((e) => e.hip_cm ?? null)),
    entries: inWin.map(snapshot),
  };
}

export type ProgressDelta = {
  weight_kg: number | null;
  body_fat_pct: number | null;
  bmi: number | null;
  ffmi: number | null;
  ffmi_normalized: number | null;
  fat_free_mass_kg: number | null;
  fat_mass_kg: number | null;
  waist_cm: number | null;
  neck_cm: number | null;
  hip_cm: number | null;
};

export type ProgressReport = {
  window_days: number;
  current_window: WindowStats;
  prior_window: WindowStats;
  delta: ProgressDelta;
  first_entry: string;
  last_entry: string;
  total_entries: number;
};

export function buildProgress(
  entries: BodyCompEntry[],
  windowDays = 7,
): ProgressReport | { error: string } {
  if (!entries.length) return { error: "no body composition entries yet" };
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const current = windowStats(sorted, today, windowDays);
  const priorEnd = new Date(today.getTime() - windowDays * 86_400_000);
  const prior = windowStats(sorted, priorEnd, windowDays);
  const d = (a: number | null, b: number | null) => (a != null && b != null ? round2(a - b) : null);
  return {
    window_days: windowDays,
    current_window: current,
    prior_window: prior,
    delta: {
      weight_kg: d(current.avg_weight_kg, prior.avg_weight_kg),
      body_fat_pct: d(current.avg_body_fat_pct, prior.avg_body_fat_pct),
      bmi: d(current.avg_bmi, prior.avg_bmi),
      ffmi: d(current.avg_ffmi, prior.avg_ffmi),
      ffmi_normalized: d(current.avg_ffmi_normalized, prior.avg_ffmi_normalized),
      fat_free_mass_kg: d(current.avg_fat_free_mass_kg, prior.avg_fat_free_mass_kg),
      fat_mass_kg: d(current.avg_fat_mass_kg, prior.avg_fat_mass_kg),
      waist_cm: d(current.avg_waist_cm, prior.avg_waist_cm),
      neck_cm: d(current.avg_neck_cm, prior.avg_neck_cm),
      hip_cm: d(current.avg_hip_cm, prior.avg_hip_cm),
    },
    first_entry: sorted[0].date,
    last_entry: sorted[sorted.length - 1].date,
    total_entries: sorted.length,
  };
}
