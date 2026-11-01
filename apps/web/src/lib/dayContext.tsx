import { useCallback, useMemo } from "react";
import { fromIso, today, toIso } from "../dateRange";
import { useGetDashboard } from "../api/endpoints/default/default";
import { useUiStore } from "./uiStore";

// A single source of truth for "which day is the UI looking at right now".
// Dashboard, Nutrition, Workout, and Body all read selectedDate from here so
// switching screens preserves the day, and the agent's view_date_hint can
// move every screen in lockstep with one setter.
//
// The selected day lives in the shared Zustand UI store (cross-screen state,
// not persisted — a fresh open lands on today). `useDayContext()` is a thin
// adapter that derives the Date + today helpers on top of it so consumers keep
// the same shape they always had. (The selected date crossing midnight is rare
// enough that we don't bother with a timer here; reload covers it.)

export type DayContextValue = {
  selectedDate: Date;
  selectedDateIso: string;
  todayDate: Date;
  todayIso: string;
  isToday: boolean;
  setSelectedDate: (d: Date) => void;
  setSelectedDateIso: (iso: string) => void;
};

export function useDayContext(): DayContextValue {
  const selectedDateIso = useUiStore((s) => s.selectedDateIso);
  const setSelectedDateIso = useUiStore((s) => s.setSelectedDateIso);
  const selectedDate = useMemo(() => fromIso(selectedDateIso), [selectedDateIso]);
  const todayDate = useMemo(() => today(), []);
  const todayIso = useMemo(() => toIso(todayDate), [todayDate]);
  const setSelectedDate = useCallback(
    (d: Date) => setSelectedDateIso(toIso(d)),
    [setSelectedDateIso],
  );
  return {
    selectedDate,
    selectedDateIso,
    todayDate,
    todayIso,
    isToday: selectedDateIso === todayIso,
    setSelectedDate,
    setSelectedDateIso,
  };
}

// One-shot day snapshot. Bundles the data Dashboard/Nutrition/Workout/Body
// would all want about a single day (profile + today macros/meals + body
// comp history). Reuses the existing /dashboard endpoint — it
// already returns this shape.
//
// Backed by React Query (FIXES #6): the per-date result is cached and shared
// across consumers (no parallel duplicate fetches), and a mutation invalidates
// the cache via queryClient instead of bumping a global counter — so a single
// log no longer flashes every screen.

type Macros = { kcal: number; p: number; f: number; c: number; fiber?: number };
type MealItem = Macros & {
  food: string;
  grams: number;
  source?: string;
  category?: string;
  display_name?: string;
};
type Meal = { slot: string; time?: string; items: MealItem[] };
type BodyCompEntry = {
  date: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
  body_fat_pct_navy?: number | null;
  body_fat_method?: string | null;
  waist_cm: number | null;
  neck_cm?: number | null;
  hip_cm?: number | null;
  bmi: number | null;
  ffmi: number | null;
  ffmi_normalized: number | null;
  fat_free_mass_kg: number | null;
  fat_mass_kg?: number | null;
  notes?: string;
};
// Profile is now stable identity + targets only. "Current weight" lives on
// the most recent BodyCompEntry; consumers read it from data.bodyComp.
type Profile = {
  sex: string;
  birth_year: number;
  height_cm: number;
  activity_level: string;
  goal: string;
  target_weight_kg?: number | null;
  wrist_cm?: number | null;
  ankle_cm?: number | null;
  units?: "metric" | "imperial" | null;
} | null;

export type DaySnapshot = {
  date: string;
  is_today: boolean;
  today_iso: string;
  weekday?: string;
  profile: Profile;
  today: {
    meals: Meal[];
    eaten: Macros;
    eaten_from_meals?: Macros;
    target: Macros | null;
    remaining: Macros | null;
    meal_count: number;
  };
  bodyComp: BodyCompEntry[];
};

export function useDaySnapshot(dateIso: string): {
  data: DaySnapshot | null;
  loading: boolean;
  error: string | null;
} {
  const q = useGetDashboard({ date: dateIso });
  return {
    // The generated DashboardResponse is structurally the wire shape this hook
    // has always returned; bridge it to the local DaySnapshot view type.
    data: (q.data as unknown as DaySnapshot) ?? null,
    // isPending is only true on the first load (no cached data); background
    // refetches after invalidation keep `data` and don't flip this — no flash.
    loading: q.isPending,
    error: q.error ? ((q.error as { error?: string }).error ?? String(q.error)) : null,
  };
}
