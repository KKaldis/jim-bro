import { useEffect, useMemo, useState } from "react";
import { getMeProfile, getProgressBody } from "../api/endpoints/default/default";
import { useDayContext } from "../lib/dayContext";
import type { Sex } from "./bodyComp";

// Shared, read-only context that per-tool form overrides can draw on for
// prefill values and field-visibility decisions (see OverrideDef in
// overrides.tsx). Currently sources the user's profile + most recent body
// composition entry; extend as new overrides need more.
// The profile slice carries every stable field a form override might want to
// prefill (e.g. update_profile shows the user's current values even when the
// agent only proposed a single changed field). Body readings (weight/BF) are
// NOT here — they live on the latest body_comp_entry, surfaced via lastBodyComp.
export type FormContextProfile = {
  sex: Sex | null;
  height_cm: number | null;
  birth_year?: number | null;
  activity_level?: string | null;
  goal?: string | null;
  target_weight_kg?: number | null;
  restrictions?: string[] | null;
  notes?: string | null;
  wrist_cm?: number | null;
  ankle_cm?: number | null;
  units?: "metric" | "imperial" | null;
  gym_machine_ids?: string[] | null;
};

// The async, cached slice (profile + last body comp). Merged with the live
// DayContext slice in useFormContext to form the full FormContext.
type AsyncFormContext = {
  // True when either fetch failed — the result is served but not cached, so
  // the next consumer retries instead of living with a blank profile all
  // session.
  incomplete?: boolean;
  profile: FormContextProfile | null;
  lastBodyComp: {
    weight_kg: number | null;
    date: string;
    // Tape girths from the same weigh-in (null when not taken) — prefill for
    // the proportion / body-shape calculators.
    waist_cm?: number | null;
    neck_cm?: number | null;
    hip_cm?: number | null;
    // Effective body fat of that weigh-in: a measured reading, else the Navy
    // estimate stored alongside it.
    body_fat_pct?: number | null;
  } | null;
};

export type FormContext = AsyncFormContext & {
  // The day the UI is currently focused on (shared DayContext). Data-entry
  // forms default their `date` field to this, so logging follows the day the
  // user is looking at instead of always snapping to today.
  selectedDateIso: string;
  // True when selectedDateIso is the real-world today. Only then do forms also
  // prefill a `time` field with the current clock time — a past day has no
  // meaningful "now".
  isToday: boolean;
};

const EMPTY_ASYNC: AsyncFormContext = { profile: null, lastBodyComp: null };

// Module-level cache: one fetch shared across every mounted ToolFormCard for
// the session. Gate cards are short-lived and can mount in bursts (chat
// history rehydration), so we don't want each one re-fetching.
let cached: Promise<AsyncFormContext> | null = null;

// Subscribers that want to be told when the cache is dropped so they can
// refetch — see invalidateFormContext. Without this, a gate card mounted
// before its source data was written (e.g. a log_body_comp card proposed
// alongside update_profile during onboarding) would keep the stale context
// forever, hiding sex-specific fields like the Navy hip input for women.
const listeners = new Set<() => void>();

async function loadFormContext(): Promise<AsyncFormContext> {
  // A wide window so we always catch the latest entry regardless of when it
  // was logged. The server filters by [from, to].
  const [profileRes, bodyRes] = await Promise.allSettled([
    getMeProfile(),
    getProgressBody({ from: "2000-01-01", to: "2999-12-31" }),
  ]);

  let profile: AsyncFormContext["profile"] = null;
  if (profileRes.status === "fulfilled") {
    const p = profileRes.value.profile as
      | {
          sex?: Sex;
          height_cm?: number;
          birth_year?: number;
          activity_level?: string;
          goal?: string;
          target_weight_kg?: number | null;
          restrictions?: string[];
          notes?: string;
          wrist_cm?: number | null;
          ankle_cm?: number | null;
          units?: "metric" | "imperial";
          gym_machine_ids?: string[] | null;
        }
      | null
      | undefined;
    if (p) {
      profile = {
        sex: p.sex ?? null,
        height_cm: p.height_cm ?? null,
        birth_year: p.birth_year ?? null,
        activity_level: p.activity_level ?? null,
        goal: p.goal ?? null,
        target_weight_kg: p.target_weight_kg ?? null,
        restrictions: p.restrictions ?? null,
        notes: p.notes ?? null,
        wrist_cm: p.wrist_cm ?? null,
        ankle_cm: p.ankle_cm ?? null,
        units: p.units ?? null,
        gym_machine_ids: p.gym_machine_ids ?? null,
      };
    }
  }

  let lastBodyComp: AsyncFormContext["lastBodyComp"] = null;
  if (bodyRes.status === "fulfilled") {
    const json = bodyRes.value as {
      entries?: Array<{
        weight_kg: number | null;
        date: string;
        waist_cm?: number | null;
        neck_cm?: number | null;
        hip_cm?: number | null;
        body_fat_pct?: number | null;
        body_fat_pct_navy?: number | null;
      }>;
      sex?: Sex | null;
    };
    const entries = json.entries ?? [];
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      lastBodyComp = {
        weight_kg: last.weight_kg,
        date: last.date,
        waist_cm: last.waist_cm ?? null,
        neck_cm: last.neck_cm ?? null,
        hip_cm: last.hip_cm ?? null,
        body_fat_pct: last.body_fat_pct ?? last.body_fat_pct_navy ?? null,
      };
    }
    // Fall back to the body endpoint's sex if the profile fetch missed it.
    if (!profile && json.sex) {
      profile = { sex: json.sex, height_cm: null };
    }
  }

  return {
    profile,
    lastBodyComp,
    incomplete: profileRes.status === "rejected" || bodyRes.status === "rejected",
  };
}

// Hook form: returns the (possibly still-loading) context. While loading it
// returns EMPTY so callers can render with safe defaults (e.g. hide
// sex-specific fields until sex is known).
export function useFormContext(): { ctx: FormContext; ready: boolean } {
  const [asyncCtx, setAsyncCtx] = useState<AsyncFormContext>(EMPTY_ASYNC);
  const [ready, setReady] = useState(false);
  // Live day slice — reactive, so a form that's open while the user changes the
  // selected day picks up the new default on its next prefill.
  const { selectedDateIso, isToday } = useDayContext();

  useEffect(() => {
    let cancelled = false;
    // (Re)read the shared cache, rebuilding it if it was invalidated. We keep
    // `ready` true across a refetch so fields don't flicker — `ctx` just swaps
    // to the fresh values when they land.
    const load = () => {
      if (!cached) {
        const p = loadFormContext();
        cached = p;
        // Don't pin a failed load (e.g. fired before the session cookie was
        // set) for the rest of the session — drop it so the next mount refetches.
        void p.then((c) => {
          if (c.incomplete && cached === p) cached = null;
        });
      }
      cached
        .then((c) => {
          if (!cancelled) {
            setAsyncCtx(c);
            setReady(true);
          }
        })
        .catch(() => {
          if (!cancelled) setReady(true);
        });
    };
    load();
    listeners.add(load);
    return () => {
      cancelled = true;
      listeners.delete(load);
    };
  }, []);

  const ctx = useMemo<FormContext>(
    () => ({ ...asyncCtx, selectedDateIso, isToday }),
    [asyncCtx, selectedDateIso, isToday],
  );

  return { ctx, ready };
}

// Drop the cache and tell every mounted consumer to refetch — call after a
// body-comp / profile write so prefill reflects the new latest entry and
// sex-driven field visibility (e.g. the Navy hip input) reflects the new sex,
// even for forms that were already on screen when the write happened.
export function invalidateFormContext(): void {
  cached = null;
  for (const load of listeners) load();
}
