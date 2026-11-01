import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { type Granularity, today, toIso } from "../dateRange";
import i18n, { getInitialLanguage, type Language } from "../i18n";

// Single client-side store for shared + persisted UI state, backed by Zustand.
//
// - `persist` (localStorage key "fa.ui") hydrates synchronously on load, so
//   there's no flash of default state. `partialize` whitelists exactly what
//   survives a reload — preferences, not transient session state.
// - `devtools` exposes the store to the Redux DevTools browser extension
//   (named actions + time-travel), enabled in dev only.
//
// This is the home for "remember what the user chose" UI state and genuinely
// cross-screen client state (the selected day) — including the product
// `language` (the profile is the source of truth; this mirrors it so the UI can
// switch instantly and render the right language before the profile query
// resolves). The product `language` also seeds the agent's reply locale in Chat
// (which defaults to it and re-syncs on change, with an optional session-only
// override in the chat picker). The chat "thinking" toggle and infra caches
// (IndexedDB images, SW caches, install-nudge sessionStorage) live outside this
// store on purpose.

export type View = "dashboard" | "nutrition" | "workout" | "body" | "calculators" | "usage";
export type ThemePreference = "system" | "light" | "dark";
// Visual style layered over light/dark: the default flat look, the
// neumorphic "soft" one or the neo-brutalist "brutal" one (src/theme/*.css).
export type ThemeStyle = "flat" | "soft" | "brutal";
export type WorkoutSection = "training" | "progress" | "plans";
export type NutritionSection = "summary" | "pantry" | "diet" | "recipes";
export type BodySection = "composition" | "measurements";
export type MacroView = "per100" | "available";
export type PantrySort = "name" | "quantity" | "kcal" | "protein" | "carbs" | "fat";
// How the Body progress charts lay out their x axis: "date" spreads points
// across the selected range at their real dates (gaps in logging show as gaps),
// "even" spaces them one slot apart so a sparse series stays readable.
export type ChartSpacing = "date" | "even";
// Window of the trailing-average line over the Body charts, in days (0 = off).
export type ChartAverage = 0 | 7 | 14 | 30;
// Body composition chart lines: tinted by the metric's gauge bands ("scale") or
// the flat primary color ("solid").
export type ChartColor = "scale" | "solid";
// How many recent sets the logging trend chart fetches, and whether it plots
// each set or one point per training day.
export type TrendSetCount = 10 | 20 | 50 | 100;
export type TrendGrouping = "set" | "day";
// Muscle breakdowns (progress volume, plan totals, exercise filters): the 8
// coarse groups, or the finer per-muscle targets (MUSCLE_TARGETS).
export type MuscleView = "group" | "target";
// What the Training burn cards measure: energy burned, or time trained.
export type BurnMetric = "kcal" | "duration";
// Food-log previews: bars for just the item being logged, or the whole day
// with the item stacked (ghosted) on top of what's already eaten.
export type LogPreviewMode = "item" | "day";

type UiState = {
  // Persisted preferences.
  theme: ThemePreference;
  themeStyle: ThemeStyle;
  // Product/UI language. Mirrors profile.language (source of truth); persisted
  // so the shell + logged-out screens render in the right language immediately.
  language: Language;
  view: View;
  workoutSection: WorkoutSection;
  nutritionSection: NutritionSection;
  bodySection: BodySection;
  // Range granularity is remembered per screen — each has its own sensible
  // default (Body tracks slow-moving body comp, so it opens on month).
  dashboardGranularity: Granularity;
  workoutGranularity: Granularity;
  nutritionGranularity: Granularity;
  bodyGranularity: Granularity;
  bodyChartSpacing: ChartSpacing;
  // Window of the average line the Body charts (Composition and Measurements) overlay, 0 for none.
  bodyChartAverage: ChartAverage;
  bodyChartColor: ChartColor;
  // The same two chart preferences for Workout (Progress and the logging
  // trend), kept apart from Body's so each screen remembers its own.
  workoutChartSpacing: ChartSpacing;
  workoutChartAverage: ChartAverage;
  workoutTrendSets: TrendSetCount;
  workoutTrendGrouping: TrendGrouping;
  muscleView: MuscleView;
  burnMetric: BurnMetric;
  // Pantry table display preferences.
  pantryMacroView: MacroView;
  pantrySort: PantrySort;
  pantryOrder: "asc" | "desc";
  logPreviewMode: LogPreviewMode;
  // Whether the dashboard profile card's "Targets & energy" detail is expanded.
  dashboardProfileExpanded: boolean;
  // Chat "extended thinking" toggle. Shared (not just Chat-local) so the
  // thinking/reset drawer can also live over the data screens on mobile, and
  // persisted so the choice survives a reload.
  thinking: boolean;
  // User ids that have finished (or skipped) the app tour on this device, so it
  // auto-opens once per new account rather than on every login.
  tourSeenBy: string[];

  // Shared, NOT persisted: the day every data screen is looking at. Excluded
  // from `partialize` so a fresh open always lands on today.
  selectedDateIso: string;
  // NOT persisted: a request from anywhere (chat, dialogs) to open a data view
  // the way the user menu does — App also raises the mobile drawer for it. The
  // key changes on every request so asking for the same view twice still fires.
  viewRequest: { view: View; key: number } | null;
  // NOT persisted: whether the app tour overlay is showing (auto-opened for new
  // accounts, or replayed from the user menu).
  tourOpen: boolean;
  // NOT persisted: whether the current tour step wants the data panel showing.
  // App mirrors it onto the mobile data drawer (desktop always shows the panel).
  tourDrawer: boolean;
  // NOT persisted: a request to open the profile dialog, which lives inside the
  // user menu. Keyed like viewRequest so repeat requests still fire.
  profileRequest: number;

  setTheme: (theme: ThemePreference) => void;
  setThemeStyle: (themeStyle: ThemeStyle) => void;
  setLanguage: (language: Language) => void;
  setView: (view: View) => void;
  setWorkoutSection: (section: WorkoutSection) => void;
  setNutritionSection: (section: NutritionSection) => void;
  setBodySection: (section: BodySection) => void;
  setDashboardGranularity: (g: Granularity) => void;
  setWorkoutGranularity: (g: Granularity) => void;
  setNutritionGranularity: (g: Granularity) => void;
  setBodyGranularity: (g: Granularity) => void;
  setBodyChartSpacing: (s: ChartSpacing) => void;
  setBodyChartAverage: (days: ChartAverage) => void;
  setBodyChartColor: (c: ChartColor) => void;
  setWorkoutChartSpacing: (s: ChartSpacing) => void;
  setWorkoutChartAverage: (days: ChartAverage) => void;
  setWorkoutTrendSets: (n: TrendSetCount) => void;
  setWorkoutTrendGrouping: (g: TrendGrouping) => void;
  setMuscleView: (v: MuscleView) => void;
  setBurnMetric: (m: BurnMetric) => void;
  setPantryMacroView: (v: MacroView) => void;
  setPantrySort: (s: PantrySort) => void;
  setPantryOrder: (o: "asc" | "desc") => void;
  setLogPreviewMode: (m: LogPreviewMode) => void;
  setDashboardProfileExpanded: (expanded: boolean) => void;
  setThinking: (thinking: boolean) => void;
  setSelectedDateIso: (iso: string) => void;
  requestView: (view: View) => void;
  startTour: () => void;
  setTourDrawer: (open: boolean) => void;
  // Closes the tour and remembers that this user has seen it.
  endTour: (userId: string) => void;
  requestProfile: () => void;
};

// Thinking is OFF for new users: replies come faster and cheaper, and the chat
// toggle turns it on. One-time migration read: `thinking` used to live in its
// own localStorage key ("fa.thinking"), so a user who had that key keeps their
// choice; thereafter it's persisted inside "fa.ui" like every other preference
// (which also keeps it for anyone who already had the store saved).
function initialThinking(): boolean {
  try {
    const legacy = localStorage.getItem("fa.thinking");
    return legacy === null ? false : legacy !== "off";
  } catch {
    return false;
  }
}

export const useUiStore = create<UiState>()(
  devtools(
    persist(
      (set) => ({
        theme: "system",
        // First-time users get the soft style; a stored choice (incl. "flat") wins.
        themeStyle: "soft",
        language: getInitialLanguage(),
        view: "dashboard",
        workoutSection: "training",
        nutritionSection: "summary",
        bodySection: "composition",
        dashboardGranularity: "day",
        workoutGranularity: "day",
        nutritionGranularity: "day",
        bodyGranularity: "month",
        bodyChartSpacing: "even",
        bodyChartAverage: 7,
        bodyChartColor: "scale",
        workoutChartSpacing: "even",
        workoutChartAverage: 7,
        workoutTrendSets: 20,
        workoutTrendGrouping: "set",
        muscleView: "target",
        burnMetric: "kcal",
        pantryMacroView: "per100",
        pantrySort: "name",
        pantryOrder: "asc",
        logPreviewMode: "day",
        dashboardProfileExpanded: false,
        thinking: initialThinking(),
        selectedDateIso: toIso(today()),
        viewRequest: null,
        tourSeenBy: [],
        tourOpen: false,
        tourDrawer: false,
        profileRequest: 0,

        setTheme: (theme) => set({ theme }, false, "setTheme"),
        setThemeStyle: (themeStyle) => set({ themeStyle }, false, "setThemeStyle"),
        // Flip the live i18next language alongside the stored preference so every
        // subscribed component re-renders in the new language immediately.
        setLanguage: (language) => {
          void i18n.changeLanguage(language);
          set({ language }, false, "setLanguage");
        },
        setView: (view) => set({ view }, false, "setView"),
        setWorkoutSection: (workoutSection) => set({ workoutSection }, false, "setWorkoutSection"),
        setNutritionSection: (nutritionSection) =>
          set({ nutritionSection }, false, "setNutritionSection"),
        setBodySection: (bodySection) => set({ bodySection }, false, "setBodySection"),
        setDashboardGranularity: (dashboardGranularity) =>
          set({ dashboardGranularity }, false, "setDashboardGranularity"),
        setWorkoutGranularity: (workoutGranularity) =>
          set({ workoutGranularity }, false, "setWorkoutGranularity"),
        setNutritionGranularity: (nutritionGranularity) =>
          set({ nutritionGranularity }, false, "setNutritionGranularity"),
        setBodyGranularity: (bodyGranularity) =>
          set({ bodyGranularity }, false, "setBodyGranularity"),
        setBodyChartSpacing: (bodyChartSpacing) =>
          set({ bodyChartSpacing }, false, "setBodyChartSpacing"),
        setBodyChartAverage: (bodyChartAverage) =>
          set({ bodyChartAverage }, false, "setBodyChartAverage"),
        setBodyChartColor: (bodyChartColor) => set({ bodyChartColor }, false, "setBodyChartColor"),
        setWorkoutChartSpacing: (workoutChartSpacing) =>
          set({ workoutChartSpacing }, false, "setWorkoutChartSpacing"),
        setWorkoutChartAverage: (workoutChartAverage) =>
          set({ workoutChartAverage }, false, "setWorkoutChartAverage"),
        setWorkoutTrendSets: (workoutTrendSets) =>
          set({ workoutTrendSets }, false, "setWorkoutTrendSets"),
        setWorkoutTrendGrouping: (workoutTrendGrouping) =>
          set({ workoutTrendGrouping }, false, "setWorkoutTrendGrouping"),
        setMuscleView: (muscleView) => set({ muscleView }, false, "setMuscleView"),
        setBurnMetric: (burnMetric) => set({ burnMetric }, false, "setBurnMetric"),
        setPantryMacroView: (pantryMacroView) =>
          set({ pantryMacroView }, false, "setPantryMacroView"),
        setPantrySort: (pantrySort) => set({ pantrySort }, false, "setPantrySort"),
        setPantryOrder: (pantryOrder) => set({ pantryOrder }, false, "setPantryOrder"),
        setLogPreviewMode: (logPreviewMode) => set({ logPreviewMode }, false, "setLogPreviewMode"),
        setDashboardProfileExpanded: (dashboardProfileExpanded) =>
          set({ dashboardProfileExpanded }, false, "setDashboardProfileExpanded"),
        setThinking: (thinking) => set({ thinking }, false, "setThinking"),
        setSelectedDateIso: (iso) =>
          set(
            (s) => (s.selectedDateIso === iso ? s : { selectedDateIso: iso }),
            false,
            "setSelectedDateIso",
          ),
        requestView: (view) =>
          set(
            (s) => ({ viewRequest: { view, key: (s.viewRequest?.key ?? 0) + 1 } }),
            false,
            "requestView",
          ),
        startTour: () => set({ tourOpen: true, tourDrawer: false }, false, "startTour"),
        setTourDrawer: (tourDrawer) => set({ tourDrawer }, false, "setTourDrawer"),
        endTour: (userId) =>
          set(
            (s) => ({
              tourOpen: false,
              tourDrawer: false,
              tourSeenBy: s.tourSeenBy.includes(userId) ? s.tourSeenBy : [...s.tourSeenBy, userId],
            }),
            false,
            "endTour",
          ),
        requestProfile: () =>
          set((s) => ({ profileRequest: s.profileRequest + 1 }), false, "requestProfile"),
      }),
      {
        name: "fa.ui",
        version: 3,
        // v2 dropped the "year" granularity — fall saved ones back to "all".
        migrate: (persisted, version) => {
          const s = persisted as Record<string, unknown>;
          if (version < 2) {
            for (const k of [
              "dashboardGranularity",
              "workoutGranularity",
              "nutritionGranularity",
              "bodyGranularity",
            ]) {
              if (s[k] === "year") s[k] = "all";
            }
          }
          // v3: the charts default to even spacing. "date" was only ever the
          // stored default, so move everyone onto the new one.
          if (version < 3) s.bodyChartSpacing = "even";
          return s as unknown as UiState;
        },
        // Whitelist persisted keys; everything else (selectedDateIso, actions)
        // stays in-memory only.
        partialize: (s) => ({
          theme: s.theme,
          themeStyle: s.themeStyle,
          language: s.language,
          view: s.view,
          workoutSection: s.workoutSection,
          nutritionSection: s.nutritionSection,
          bodySection: s.bodySection,
          dashboardGranularity: s.dashboardGranularity,
          workoutGranularity: s.workoutGranularity,
          nutritionGranularity: s.nutritionGranularity,
          bodyGranularity: s.bodyGranularity,
          bodyChartSpacing: s.bodyChartSpacing,
          bodyChartAverage: s.bodyChartAverage,
          bodyChartColor: s.bodyChartColor,
          workoutChartSpacing: s.workoutChartSpacing,
          workoutChartAverage: s.workoutChartAverage,
          workoutTrendSets: s.workoutTrendSets,
          workoutTrendGrouping: s.workoutTrendGrouping,
          muscleView: s.muscleView,
          burnMetric: s.burnMetric,
          pantryMacroView: s.pantryMacroView,
          pantrySort: s.pantrySort,
          pantryOrder: s.pantryOrder,
          logPreviewMode: s.logPreviewMode,
          dashboardProfileExpanded: s.dashboardProfileExpanded,
          thinking: s.thinking,
          tourSeenBy: s.tourSeenBy,
        }),
      },
    ),
    { name: "fa.ui", enabled: import.meta.env.DEV },
  ),
);
