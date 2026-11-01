/**
 * Core tools: session, profile & navigation.
 */
import {
  type ActivityLevel,
  ageFromBirthYear,
  dayTargetFromPlan,
  dayTotals,
  dietDayForDate,
  type Goal,
  type Profile,
  type Sex,
} from "@fa/shared";

import { UserStorage } from "../../storage.ts";
import { readLength, stripHtmlToText, todayIso } from "./shared.ts";

// ---------- handlers ----------

// Fetch a URL and return cleaned plain text. Companion to web_search for
// providers that don't have a server-side URL reader (Anthropic has its own
// web_search server tool; Kimi has $web_search; neither provides a fetcher
// portable enough to skip this client-side implementation). Strips script /
// style / HTML, decodes a few common entities, collapses whitespace, and
// caps length so we don't blow the context budget on a 200KB page.
export async function doWebFetch(input: Record<string, unknown>): Promise<unknown> {
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  if (!rawUrl) return { error: "url is required" };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `invalid url: ${rawUrl}` };
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") {
    return { error: `unsupported protocol: ${url.protocol}` };
  }
  const requested =
    typeof input.max_chars === "number" && Number.isFinite(input.max_chars)
      ? Math.floor(input.max_chars)
      : 8000;
  const maxChars = Math.max(500, Math.min(32_000, requested));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "user-agent": "jim-bro/1.0 web_fetch",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
    });
    const ctype = res.headers.get("content-type") ?? "";
    const isText =
      ctype.includes("text/") || ctype.includes("application/json") || ctype.includes("xml");
    if (!isText) {
      return {
        url: res.url,
        status: res.status,
        error: `non-text content-type: ${ctype}`,
      };
    }
    const body = await res.text();
    const { title, content } = stripHtmlToText(body);
    const truncated = content.length > maxChars;
    return {
      url: res.url,
      status: res.status,
      title,
      content: truncated ? content.slice(0, maxChars) : content,
      truncated,
    };
  } catch (err) {
    return {
      url: url.toString(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// The form gate captures the user's pick and rewrites the tool_use input with
// `choice` populated before this handler runs. We just echo it back to the
// model — no storage writes, no side effects. If the user dismissed the
// prompt with no choice (shouldn't happen since cancel takes the canceled
// branch in agent.ts, but defend anyway), return a structured error so the
// model can ask in plain chat instead.
export function doAskUser(input: Record<string, unknown>): unknown {
  const choice = input.choice;
  if (typeof choice !== "string" || !choice) {
    return { error: "no choice was made — ask the user in chat instead" };
  }
  return { choice };
}

// Multi-select counterpart: the user confirms a (possibly empty) set of picked
// option values. An empty array is a valid answer ("none of these"), so unlike
// ask_user we don't treat it as an error — only a non-array (never confirmed)
// is. Cancel is handled by the gate, which returns {canceled: true} directly.
export function doAskUserMulti(input: Record<string, unknown>): unknown {
  const raw = input.choices;
  if (!Array.isArray(raw)) {
    return { error: "no choices were confirmed — ask the user in chat instead" };
  }
  const choices = raw.filter((c): c is string => typeof c === "string" && !!c);
  return { choices };
}

// Screen ids the frontend can navigate to. Keep in sync with the `View` type
// in apps/web/src/App.tsx and the show_screen enum in the tool schema above.
export const APP_SCREENS = ["dashboard", "nutrition", "workout", "body"] as const;
export type AppScreen = (typeof APP_SCREENS)[number];

// Sub-tabs each screen exposes via the optional `tab` arg of show_screen.
// Keep in sync with the section/tab state in the web page components
// (Nutrition.tsx NUT_SECTIONS, Workout.tsx tab union). Screens with an empty
// list have no sub-tabs.
export const SCREEN_TABS: Record<AppScreen, readonly string[]> = {
  dashboard: [],
  nutrition: ["summary", "pantry", "diet"],
  workout: ["plans", "training", "progress"],
  body: ["composition", "measurements"],
};

// No storage writes — the actual navigation happens in the frontend, driven
// by the `show_screen` stream event the agent loop emits after a successful
// call (mirrors the view_date_hint wire-up in agent.ts).
export function doShowScreen(input: Record<string, unknown>): unknown {
  const screen = typeof input.screen === "string" ? input.screen : "";
  if (!(APP_SCREENS as readonly string[]).includes(screen)) {
    return {
      error: `unknown screen: ${JSON.stringify(input.screen)} — must be one of ${APP_SCREENS.join(", ")}`,
    };
  }
  const tab = typeof input.tab === "string" ? input.tab : "";
  if (tab) {
    const valid = SCREEN_TABS[screen as AppScreen];
    if (!valid.includes(tab)) {
      return {
        error: `unknown tab: ${JSON.stringify(input.tab)} for screen ${screen} — ${valid.length ? `must be one of ${valid.join(", ")}` : "this screen has no sub-tabs"}`,
      };
    }
    return { ok: true, screen, tab };
  }
  return { ok: true, screen };
}

export async function getTodaysMacros(storage: UserStorage, input: Record<string, unknown> = {}) {
  const today = todayIso();
  const requested = typeof input.date === "string" ? input.date.trim() : "";
  if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    return { error: `date must be YYYY-MM-DD (got: ${JSON.stringify(requested)})` };
  }
  const date = requested || today;
  const isToday = date === today;

  const profile = await storage.loadProfile();
  if (!profile) return { profile_missing: true, today, date };

  const [dietPlan, mealLog, bodyComp, steps, water] = await Promise.all([
    storage.loadActiveDietPlan(),
    storage.loadMealLog(date),
    storage.readBodyComp(),
    storage.readSteps(date),
    storage.loadWater(date),
  ]);

  const target = dayTargetFromPlan(dietPlan, date, profile);
  const totals = dayTotals(mealLog, target, date);

  const weekday = new Date(date + "T00:00:00")
    .toLocaleDateString("en-US", { weekday: "long" })
    .toLowerCase();

  const dietDay = dietDayForDate(dietPlan, date);

  const lastBC = bodyComp.length ? bodyComp[bodyComp.length - 1] : null;

  return {
    date,
    is_today: isToday,
    weekday,
    diet_day: dietDay ? { id: dietDay.id, name: dietDay.name, target: dietDay.target } : null,
    eaten_today: totals.eaten,
    target_today: totals.target,
    remaining_today: totals.remaining,
    meal_count_today: totals.meal_count,
    // The day's individual logged meals (slot + per-item food/grams/macros), so
    // the agent can answer "what did I eat" item-by-item and resolve back-refs
    // like "add another wrap, same as lunch" without asking the user to retype
    // it. `eaten_today` above is the authoritative sum — do NOT re-tally these.
    meals: (mealLog?.meals ?? []).map((m) => ({
      slot: m.slot,
      time: m.time ?? null,
      items: m.items.map((i) => ({
        food: i.food,
        grams: i.grams,
        kcal: i.kcal,
        p: i.p,
        f: i.f,
        c: i.c,
        fiber: i.fiber ?? null,
      })),
    })),
    // Daily pedometer aggregate (the PWA step counter). `steps` is the total
    // for the day; `goal` is the user's per-day target (null = app default).
    steps_today: { steps: steps.steps, goal: steps.goal },
    // Hydration. `goal_ml` is the persistent profile goal (null = app default).
    water_today: { ml: water.ml, goal_ml: profile.water_goal_ml ?? null },
    // Cached "recommended" target (#1) from the profile — derived from goal +
    // latest weigh-in, independent of the active plan's prescribed target_today.
    // null until there's enough info (profile + a weigh-in). Lets the agent show
    // recommendation vs plan side by side.
    recommended_target:
      profile.target_kcal != null
        ? {
            kcal: profile.target_kcal,
            p: profile.target_protein_g ?? null,
            f: profile.target_fat_g ?? null,
            c: profile.target_carbs_g ?? null,
            fiber: profile.target_fiber_g ?? null,
            computed_at: profile.targets_computed_at ?? null,
          }
        : null,
    last_body_comp: lastBC,
    profile_summary: {
      sex: profile.sex,
      birth_year: profile.birth_year,
      age: ageFromBirthYear(profile.birth_year),
      height_cm: profile.height_cm,
      activity_level: profile.activity_level,
      goal: profile.goal,
      target_weight_kg: profile.target_weight_kg ?? null,
      restrictions: profile.restrictions ?? [],
      // Stable skeletal-frame proxies for the drug-free muscular-potential
      // estimate (compute_max_potential). Optional — null when the user never
      // measured them. Surfaced here so the agent KNOWS they're on file and can
      // pass them straight to compute_max_potential instead of re-asking.
      wrist_cm: profile.wrist_cm ?? null,
      ankle_cm: profile.ankle_cm ?? null,
      units: profile.units ?? "metric",
      // Product language. Author stored content (recipe/meal names, notes,
      // descriptions) in THIS language regardless of the conversation language.
      language: profile.language ?? "en",
      // Current weight + BF live on body_comp_entry, not the profile. Surface
      // them here too so the agent doesn't have to make a second tool call to
      // greet the user with up-to-date numbers.
      latest_body_comp: lastBC
        ? {
            date: lastBC.date,
            weight_kg: lastBC.weight_kg,
            body_fat_pct: lastBC.body_fat_pct ?? lastBC.body_fat_pct_navy ?? null,
            body_fat_source:
              lastBC.body_fat_pct != null
                ? (lastBC.body_fat_method ?? "entered")
                : lastBC.body_fat_pct_navy != null
                  ? "navy_estimate"
                  : null,
            bmi: lastBC.bmi ?? null,
            ffmi: lastBC.ffmi ?? null,
          }
        : null,
    },
  };
}

export async function doUpdateProfile(storage: UserStorage, input: Record<string, unknown>) {
  const existing = await storage.loadProfile();
  const isNew = !existing;

  const next: Partial<Profile> = { ...(existing ?? {}) };

  if (input.sex !== undefined) {
    const v = String(input.sex);
    if (v !== "male" && v !== "female") {
      throw new Error("sex must be 'male' or 'female'");
    }
    next.sex = v as Sex;
  }

  const currentYear = new Date().getFullYear();
  if (input.birth_year !== undefined) {
    const by = Number(input.birth_year);
    if (!Number.isInteger(by) || by < 1900 || by > currentYear) {
      throw new Error(`birth_year must be a year between 1900 and ${currentYear}`);
    }
    next.birth_year = by;
  } else if (input.age !== undefined) {
    const age = Number(input.age);
    if (!Number.isFinite(age) || age <= 0 || age > 120) {
      throw new Error("age must be a positive number under 120");
    }
    next.birth_year = currentYear - Math.floor(age);
  }

  if (input.height_cm !== undefined) next.height_cm = Number(input.height_cm);

  // weight / body-fat used to live here. They moved to body_comp_entry —
  // accepting them silently would let an old agent prompt corrupt the new
  // contract, so reject loudly and steer the agent to log_body_comp.
  if (
    input.weight_kg !== undefined ||
    input.body_fat_pct !== undefined ||
    input.body_fat_method !== undefined
  ) {
    throw new Error(
      "weight_kg / body_fat_pct / body_fat_method are not profile fields anymore — " +
        "call log_body_comp instead. The latest body_comp_entry is the source of truth.",
    );
  }

  if (input.activity_level !== undefined) {
    const v = String(input.activity_level);
    const allowed: ActivityLevel[] = ["sedentary", "light", "moderate", "very", "extreme"];
    if (!allowed.includes(v as ActivityLevel)) {
      throw new Error(`activity_level must be one of: ${allowed.join(", ")}`);
    }
    next.activity_level = v as ActivityLevel;
  }

  if (input.goal !== undefined) {
    const v = String(input.goal);
    const allowed: Goal[] = ["cut", "maintain", "recomp", "lean_bulk"];
    if (!allowed.includes(v as Goal)) {
      throw new Error(`goal must be one of: ${allowed.join(", ")}`);
    }
    next.goal = v as Goal;
  }

  if (input.target_weight_kg !== undefined) {
    next.target_weight_kg = input.target_weight_kg === null ? null : Number(input.target_weight_kg);
  }
  if (input.restrictions !== undefined) {
    next.restrictions = Array.isArray(input.restrictions)
      ? (input.restrictions as unknown[]).map(String)
      : [];
  }
  if (input.notes !== undefined) next.notes = String(input.notes);

  if (input.gym_machine_ids !== undefined) {
    // Optional equipment-availability filter. Store the list as given (deduped,
    // stringified); null/empty clears the constraint. Unknown ids are tolerated
    // — no catalog membership check, mirroring the no-FK exercise/machine refs.
    next.gym_machine_ids =
      input.gym_machine_ids === null
        ? null
        : Array.isArray(input.gym_machine_ids)
          ? Array.from(new Set((input.gym_machine_ids as unknown[]).map(String)))
          : [];
  }

  if (input.units !== undefined) {
    const v = String(input.units);
    if (v !== "metric" && v !== "imperial") {
      throw new Error("units must be 'metric' or 'imperial'");
    }
    next.units = v;
  }

  if (input.language !== undefined) {
    const v = String(input.language);
    if (!["en", "el", "ar", "sq", "fa", "ur", "nl", "it"].includes(v)) {
      throw new Error("language must be one of 'en', 'el', 'ar', 'sq', 'fa', 'ur', 'nl', 'it'");
    }
    next.language = v as Profile["language"];
  }

  // Persistent everyday hydration goal (ml). 0 (or negative) clears it → the
  // app default applies. Single source of truth for the daily water target.
  if (input.water_goal_ml !== undefined) {
    if (input.water_goal_ml === null) {
      next.water_goal_ml = null;
    } else {
      const g = Math.round(Number(input.water_goal_ml));
      next.water_goal_ml = Number.isFinite(g) && g > 0 ? g : null;
    }
  }

  // Frame measurements are optional and only stored if explicitly given. Read
  // them through the unit-aware helper so imperial (*_in) inputs are converted
  // to the metric storage value, same as height/wrist/ankle elsewhere.
  const measureUnits = (next.units === "imperial" ? "imperial" : "metric") as "metric" | "imperial";
  if (input.wrist_cm !== undefined || input.wrist_in !== undefined) {
    next.wrist_cm = readLength(input, "wrist_cm", "wrist_in", measureUnits, false, "wrist").cm;
  }
  if (input.ankle_cm !== undefined || input.ankle_in !== undefined) {
    next.ankle_cm = readLength(input, "ankle_cm", "ankle_in", measureUnits, false, "ankle").cm;
  }

  const required: Array<keyof Profile> = [
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
  ];
  const missing = required.filter((k) => next[k] == null);
  if (missing.length) {
    throw new Error(
      `cannot save profile — still missing required fields: ${missing.join(
        ", ",
      )}. Ask the user for these before calling update_profile again.`,
    );
  }

  await storage.saveProfile(next as Profile);
  return {
    saved: true,
    created: isNew,
    profile: next,
    hint: "call compute_targets next if the user wants BMR/TDEE/macro targets.",
  };
}

// Record a user-facing feature request (submit_feature_request). Stores a row
// in tool_feature_request scoped to the user; returns the new id so the agent
// can acknowledge it was filed.
export async function doSubmitFeatureRequest(storage: UserStorage, input: Record<string, unknown>) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("title is required (a short summary of the requested feature)");
  const details =
    typeof input.details === "string" && input.details.trim() ? input.details.trim() : null;
  const { id, createdAt } = await storage.addFeatureRequest({ title, details });
  return {
    ok: true,
    id,
    title,
    ...(details ? { details } : {}),
    created_at: createdAt.toISOString(),
  };
}
