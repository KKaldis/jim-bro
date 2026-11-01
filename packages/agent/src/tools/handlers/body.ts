/**
 * Body composition & progress tools.
 */
import { type BodyCompEntry, buildProgress, computeBodyMetrics } from "@fa/shared";

import { UserStorage } from "../../storage.ts";
import { readTime, todayIso } from "./shared.ts";

export async function doLogBodyComp(storage: UserStorage, input: Record<string, unknown>) {
  const profile = await storage.loadProfile();
  if (!profile) {
    throw new Error(
      "no profile yet — call update_profile first (need sex + height_cm to derive BMI/FFMI from the weigh-in)",
    );
  }
  const weight_kg = Number(input.weight_kg);
  if (!Number.isFinite(weight_kg) || weight_kg <= 0) {
    throw new Error("weight_kg required and must be > 0");
  }
  const bfMethod =
    input.body_fat_method != null
      ? (String(input.body_fat_method) as BodyCompEntry["body_fat_method"])
      : null;
  const raw = {
    date: String(input.date ?? todayIso()),
    weight_kg,
    body_fat_pct: input.body_fat_pct != null ? Number(input.body_fat_pct) : null,
    body_fat_method: bfMethod,
    waist_cm: input.waist_cm != null ? Number(input.waist_cm) : null,
    neck_cm: input.neck_cm != null ? Number(input.neck_cm) : null,
    hip_cm: input.hip_cm != null ? Number(input.hip_cm) : null,
    notes: input.notes ? String(input.notes) : "",
    time: readTime(input.time) ?? null,
  };
  const computed = computeBodyMetrics({
    sex: profile.sex,
    height_cm: profile.height_cm,
    weight_kg: raw.weight_kg,
    body_fat_pct: raw.body_fat_pct,
    waist_cm: raw.waist_cm,
    neck_cm: raw.neck_cm,
    hip_cm: raw.hip_cm,
  });
  const entry: BodyCompEntry = {
    ...raw,
    body_fat_pct_navy: computed.body_fat_pct_navy,
    bmi: computed.bmi,
    ffmi: computed.ffmi,
    ffmi_normalized: computed.ffmi_normalized,
    fat_free_mass_kg: computed.fat_free_mass_kg,
    fat_mass_kg: computed.fat_mass_kg,
  };
  await storage.appendBodyComp(entry);
  const all = await storage.readBodyComp();
  // Trend delta vs the previous entry — small affordance so the agent can
  // call out "−0.6 kg vs last week" without a follow-up tool call.
  const prev = all.length >= 2 ? all[all.length - 2] : null;
  const delta = prev?.weight_kg != null ? Math.round((weight_kg - prev.weight_kg) * 10) / 10 : null;
  return {
    logged: entry,
    computed: {
      bmi: computed.bmi,
      body_fat_pct_navy: computed.body_fat_pct_navy,
      effective_body_fat_pct: computed.effective_body_fat_pct,
      fat_free_mass_kg: computed.fat_free_mass_kg,
      fat_mass_kg: computed.fat_mass_kg,
      ffmi: computed.ffmi,
      ffmi_normalized: computed.ffmi_normalized,
    },
    trend: prev ? { previous_date: prev.date, weight_delta_kg: delta } : null,
    total_entries: all.length,
  };
}

export async function doProgressReport(storage: UserStorage, input: Record<string, unknown>) {
  const entries = await storage.readBodyComp();
  return buildProgress(entries, input.window_days ? Number(input.window_days) : 14);
}

export async function doDeleteBodyCompEntry(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? "").trim();
  if (!date) throw new Error("date required");
  const removed = await storage.deleteBodyCompEntries(date);
  return { removed_count: removed, date };
}

// Edit an existing weigh-in in place. Resolves the target entry (by
// original_date, else the most recent), merges the provided fields over its
// existing raw inputs, recomputes the derived metrics against the profile
// (same path as doLogBodyComp), and writes it back. `date` (when given) moves
// the entry to a new day. `undefined` fields are kept; explicit `null` clears.
export async function doUpdateBodyCompEntry(storage: UserStorage, input: Record<string, unknown>) {
  const profile = await storage.loadProfile();
  if (!profile) {
    throw new Error(
      "no profile yet — call update_profile first (need sex + height_cm to derive BMI/FFMI)",
    );
  }
  const all = await storage.readBodyComp();
  if (all.length === 0) throw new Error("no body-composition entries to edit");

  // entry_id pins the exact row (the Body page passes the clicked row's id);
  // original_date locates by day (the newest weigh-in on it, matching the chat
  // path). entry_id wins so editing the older of two same-day entries can't
  // silently overwrite the newer one.
  const entryId = input.entry_id != null && input.entry_id !== "" ? Number(input.entry_id) : null;
  const locator = input.original_date != null ? String(input.original_date).trim() : "";
  let existing: BodyCompEntry | undefined;
  if (entryId != null && Number.isFinite(entryId)) {
    existing = all.find((e) => e.id === entryId);
    if (!existing) throw new Error(`no body entry with id ${entryId}`);
  } else if (locator) {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].date === locator) {
        existing = all[i];
        break;
      }
    }
    if (!existing) throw new Error(`no body entry on ${locator}`);
  } else {
    existing = all[all.length - 1];
  }
  const originalDate = existing.date;

  // undefined → keep existing; null → clear; value → coerce to number.
  const pickNum = (key: string, fallback: number | null): number | null => {
    const v = input[key];
    if (v === undefined) return fallback;
    if (v === null || v === "") return null;
    return Number(v);
  };
  const newDate =
    input.date != null && String(input.date).trim() ? String(input.date).trim() : originalDate;
  const weight_kg = input.weight_kg !== undefined ? Number(input.weight_kg) : existing.weight_kg;
  if (weight_kg == null || !Number.isFinite(weight_kg) || weight_kg <= 0) {
    throw new Error("weight_kg must be > 0");
  }
  const bfMethod =
    input.body_fat_method !== undefined
      ? input.body_fat_method == null
        ? null
        : (String(input.body_fat_method) as BodyCompEntry["body_fat_method"])
      : (existing.body_fat_method ?? null);

  const raw = {
    date: newDate,
    weight_kg,
    body_fat_pct: pickNum("body_fat_pct", existing.body_fat_pct),
    body_fat_method: bfMethod,
    waist_cm: pickNum("waist_cm", existing.waist_cm),
    neck_cm: pickNum("neck_cm", existing.neck_cm ?? null),
    hip_cm: pickNum("hip_cm", existing.hip_cm ?? null),
    notes: input.notes !== undefined ? String(input.notes ?? "") : (existing.notes ?? ""),
    time: input.time !== undefined ? (readTime(input.time) ?? null) : (existing.time ?? null),
  };
  const computed = computeBodyMetrics({
    sex: profile.sex,
    height_cm: profile.height_cm,
    weight_kg: raw.weight_kg,
    body_fat_pct: raw.body_fat_pct,
    waist_cm: raw.waist_cm,
    neck_cm: raw.neck_cm,
    hip_cm: raw.hip_cm,
  });
  const entry: BodyCompEntry = {
    ...raw,
    body_fat_pct_navy: computed.body_fat_pct_navy,
    bmi: computed.bmi,
    ffmi: computed.ffmi,
    ffmi_normalized: computed.ffmi_normalized,
    fat_free_mass_kg: computed.fat_free_mass_kg,
    fat_mass_kg: computed.fat_mass_kg,
  };
  // When the caller pinned a row id, update exactly that row; otherwise fall
  // back to the date locator (newest weigh-in on the day), matching the chat path.
  const ok =
    existing.id != null && entryId != null && Number.isFinite(entryId)
      ? await storage.updateBodyCompById(existing.id, entry)
      : await storage.updateBodyCompForDate(originalDate, entry);
  if (!ok) throw new Error(`no body entry on ${originalDate}`);
  return {
    updated: entry,
    original_date: originalDate,
    computed: {
      bmi: computed.bmi,
      body_fat_pct_navy: computed.body_fat_pct_navy,
      effective_body_fat_pct: computed.effective_body_fat_pct,
      fat_free_mass_kg: computed.fat_free_mass_kg,
      fat_mass_kg: computed.fat_mass_kg,
      ffmi: computed.ffmi,
      ffmi_normalized: computed.ffmi_normalized,
    },
  };
}
