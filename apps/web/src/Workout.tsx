import type { WorkoutCatalog, WorkoutPlan, WorkoutSession } from "@fa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Dumbbell, type LucideIcon, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { RangeNav } from "./RangeNav.tsx";
import { SectionSubNav } from "./components/SectionSubNav";
import { WorkoutStepCard } from "./StepCounter";
import {
  useGetWorkoutCatalog,
  useGetWorkoutPlans,
  useGetWorkoutSessions,
} from "./api/endpoints/default/default";
import { Skeleton } from "./components/ui/skeleton";
import { clipToData, toIso } from "./dateRange.ts";
import { apiErr } from "./lib/apiErr";
import { useDayContext, useDaySnapshot } from "./lib/dayContext";
import { PageTitle } from "./lib/pageChrome";
import { useUiStore, type WorkoutSection } from "./lib/uiStore";
import { useDateRange } from "./lib/useDateRange.ts";
import { useMinLoading } from "./lib/useMinLoading";
import { PlanEditorDialog, PlansList } from "./workout/PlansTab";
import { ProgressTab, TrainingBurnCard } from "./workout/ProgressTab";
import { SessionsTab } from "./workout/SessionsTab";
import type { EditPlan } from "./workout/shared";

const EMPTY_PLAN: EditPlan = {
  name: "",
  notes: "",
  days: [],
};

export function Workout({
  navTab = null,
}: {
  // Agent-driven sub-tab navigation (show_screen tab arg). `key` changes on
  // every request so the sync effect re-fires even for a repeat of the same tab.
  navTab?: { tab: string; key: number } | null;
}) {
  const { t } = useTranslation();
  // The day the Sessions tab is viewing is the shared selected day — Dashboard,
  // Nutrition, Body and the agent all stay in sync. Arrows shift selectedDate
  // for the whole app, not just this tab.
  const { selectedDate: anchor, setSelectedDate: setAnchor, isToday } = useDayContext();
  const granularity = useUiStore((s) => s.workoutGranularity);
  const setGranularity = useUiStore((s) => s.setWorkoutGranularity);
  const { range, customRange, setCustomRange } = useDateRange(granularity, anchor);
  const [editing, setEditing] = useState<EditPlan | null>(null);
  // Finished session being edited inline on the Training tab. Lifted here so the
  // burn chart's tooltip can open a day's session for editing.
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  // Day tapped on the week/month burn chart; its trainings list below the chart.
  const [burnDate, setBurnDate] = useState<string | null>(null);
  // Last section the user viewed, persisted in the UI store so reopening
  // Workout lands back where they left off, not always on Training.
  const tab = useUiStore((s) => s.workoutSection);
  const setTab = useUiStore((s) => s.setWorkoutSection);
  useEffect(() => {
    if (navTab && WORKOUT_SECTIONS.some((s) => s.id === navTab.tab)) {
      setTab(navTab.tab as WorkoutSection);
    }
    // Trigger only on navTab.key (bumps per show_screen request); setTab is a
    // stable Zustand setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTab?.key]);

  // Server cache (FIXES #6): catalog/plans/sessions come from React Query, so a
  // mutation invalidates and refetches in the background without flashing. The
  // generated wire types mirror the @fa/shared shapes — bridge at the boundary.
  const catalogQ = useGetWorkoutCatalog();
  const plansQ = useGetWorkoutPlans();
  const sessionsQ = useGetWorkoutSessions({ from: range.from, to: range.to });
  const catalog = (catalogQ.data as unknown as WorkoutCatalog | undefined) ?? null;
  const plans = (plansQ.data?.plans as unknown as WorkoutPlan[] | undefined) ?? [];
  const activePlanId = plansQ.data?.active_plan_id ?? null;
  const sessions = (sessionsQ.data?.sessions as unknown as WorkoutSession[] | undefined) ?? [];
  // Under "all" the period starts at the first logged session instead of a
  // full year back (see clipToData) — drives the label, burn chart and Progress.
  const firstSession = sessions.reduce<string | null>(
    (min, s) => (min == null || s.date < min ? s.date : min),
    null,
  );
  const dataRange = useMemo(
    () => clipToData(range, granularity, firstSession),
    [range, granularity, firstSession],
  );

  // Latest weigh-in (as of the anchor day) — drives the MET-based burn estimate
  // shown on the burn card and inline on each session. Shared so the two stay
  // consistent; React Query dedupes this with other consumers of the snapshot.
  const daySnap = useDaySnapshot(toIso(anchor));
  const bodyweightKg = useMemo(() => {
    const bc = daySnap.data?.bodyComp ?? [];
    return bc.length > 0 ? (bc[bc.length - 1].weight_kg ?? null) : null;
  }, [daySnap.data]);

  const queryClient = useQueryClient();
  // Used as the `onChanged` callback throughout: invalidate the cache so every
  // affected query (sessions, plans, the dashboard's workout card) refetches.
  const refresh = useCallback(() => queryClient.invalidateQueries(), [queryClient]);

  const loading = catalogQ.isPending || plansQ.isPending || sessionsQ.isPending;
  const showLoader = useMinLoading(loading);
  const firstError = catalogQ.error ?? plansQ.error ?? sessionsQ.error;
  const err = firstError ? apiErr(firstError) : null;

  const activeSection = WORKOUT_SECTIONS.find((s) => s.id === tab) ?? WORKOUT_SECTIONS[0];
  const SectionIcon = activeSection.Icon;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Only the content area scrolls (scrollbar lives in this inner div); the
          sub-nav sits below it so the scrollbar stops above the bar, like the
          chat input. The scroller is full-width so the scrollbar sits at the
          panel edge; content is centered to max-w-3xl inside it. */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 md:pb-0">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-5 sm:py-6">
          <PageTitle Icon={SectionIcon} help={activeSection.id}>
            {t(activeSection.labelKey)}
          </PageTitle>

          {tab !== "plans" && (
            <RangeNav
              granularity={granularity}
              anchor={anchor}
              onGranularity={setGranularity}
              onAnchor={setAnchor}
              customRange={customRange}
              onCustomRange={setCustomRange}
              dataFrom={firstSession}
              allowFuture
            />
          )}

          {tab === "training" && (
            <div className="space-y-4">
              {/* Live step counter — a "today" widget, so only when the day in
                view is today. Past days show their step total on the Dashboard. */}
              {isToday && <WorkoutStepCard />}
              {showLoader && (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}
              {err && <p className="text-sm text-destructive">{err}</p>}
              {!showLoader && catalog && (
                <>
                  <TrainingBurnCard
                    sessions={sessions}
                    granularity={granularity}
                    range={dataRange}
                    bodyweightKg={bodyweightKg}
                    selectedDate={burnDate}
                    onSelectDate={setBurnDate}
                  />
                  <SessionsTab
                    catalog={catalog}
                    plans={plans}
                    sessions={sessions}
                    anchor={anchor}
                    granularity={granularity}
                    bodyweightKg={bodyweightKg}
                    onChanged={refresh}
                    editingId={editingSessionId}
                    setEditingId={setEditingSessionId}
                    selectedDate={burnDate}
                  />
                </>
              )}
            </div>
          )}

          {tab === "progress" && (
            <div className="space-y-4">
              {catalog ? (
                <ProgressTab
                  catalog={catalog}
                  granularity={granularity}
                  range={dataRange}
                  sessions={sessions}
                />
              ) : (
                <Skeleton className="h-24 w-full" />
              )}
            </div>
          )}

          {tab === "plans" && (
            <div className="space-y-4">
              {showLoader && (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              )}
              {err && <p className="text-sm text-destructive">{err}</p>}
              {!showLoader && catalog && (
                <PlansList
                  plans={plans}
                  activePlanId={activePlanId}
                  catalog={catalog}
                  onEdit={(p) => setEditing(planToEdit(p))}
                  onNew={() => setEditing(EMPTY_PLAN)}
                  onChanged={refresh}
                />
              )}
            </div>
          )}

          {catalog && editing && (
            <PlanEditorDialog
              open
              onClose={() => setEditing(null)}
              plan={editing}
              onSaved={async () => {
                setEditing(null);
                await refresh();
              }}
            />
          )}
        </div>
      </div>

      <WorkoutSubNav section={tab} onSection={setTab} />
    </div>
  );
}

// Bottom-locked sub-nav for the Workout page's sections — same pattern and
// styling as Nutrition's sub-nav: stacked above the app's primary bottom nav,
// full-content-width bleed, pinned flush to the bottom of the scroll area.
// WorkoutSection is owned by the UI store (it persists the active section).
const WORKOUT_SECTIONS: Array<{
  id: WorkoutSection;
  // i18n key under workout.sections.* for the section label.
  labelKey: string;
  Icon: LucideIcon;
}> = [
  { id: "training", labelKey: "workout.sections.training", Icon: Dumbbell },
  { id: "progress", labelKey: "workout.sections.progress", Icon: TrendingUp },
  { id: "plans", labelKey: "workout.sections.plans", Icon: ClipboardList },
];

function WorkoutSubNav({
  section,
  onSection,
}: {
  section: WorkoutSection;
  onSection: (s: WorkoutSection) => void;
}) {
  const { t } = useTranslation();
  return (
    <SectionSubNav
      sections={WORKOUT_SECTIONS}
      section={section}
      onSection={onSection}
      label={(id) => t(WORKOUT_SECTIONS.find((s) => s.id === id)!.labelKey)}
      ariaLabel={t("workout.subNavLabel")}
      tourPrefix="workout"
    />
  );
}

// ---------- Plan editor dialog ----------

function planToEdit(p: WorkoutPlan): EditPlan {
  return {
    id: p.id,
    name: p.name,
    notes: p.notes ?? "",
    days: p.days.map((d) => ({
      id: d.id,
      weekdays: [...d.weekdays],
      name: d.name,
      focus: d.focus ?? "",
      exercises: d.exercises.map((e) => ({
        id: e.id,
        exercise_id: e.exercise_id,
        machine_id: e.machine_id ?? null,
        order: e.order,
        target_sets: e.target_sets,
        target_reps: e.target_reps ?? null,
        target_weight_kg: e.target_weight_kg ?? null,
        target_duration_sec: e.target_duration_sec ?? null,
        notes: e.notes ?? "",
      })),
    })),
  };
}
