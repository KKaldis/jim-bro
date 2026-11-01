// Workout → Sessions: the day's sessions, starting/logging a session, and set entry.
import { EmptyState } from "@/components/EmptyState";
import {
  type Exercise,
  exerciseFields,
  type ExerciseId,
  getExercise,
  isTimedExercise,
  type LastExerciseSet,
  type MachineId,
  muscleGroupsForExercise,
  trackedMetricsFor,
  type Weekday,
  type WorkoutCatalog,
  type WorkoutPlan,
  type WorkoutPlanDay,
  type WorkoutPlanExercise,
  type WorkoutSession,
  type WorkoutSet,
} from "@fa/shared";
import { WorkoutSetRequest } from "@fa/shared/schemas";
import type { TFunction } from "i18next";
import {
  CalendarDays,
  ChartLine,
  Check,
  ChevronDown,
  ChevronRight,
  Dumbbell,
  Flame,
  Info,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  deleteWorkoutSessionsId,
  deleteWorkoutSessionsIdSetsSetId,
  patchWorkoutSessionsId,
  postWorkoutSessions,
  postWorkoutSessionsIdSets,
  useGetWorkoutExercisesIdLastSets,
} from "../api/endpoints/default/default";
import { ExerciseTrendPanel } from "../components/ExerciseTrendPanel";
import { ExerciseTypeBadge } from "../components/ExerciseTypeBadge";
import { HelpPopover } from "../components/HelpPopover";
import { muscleGroupNames, MuscleMap } from "../components/MuscleMap";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { type Granularity, today, toIso } from "../dateRange";
import { useExerciseMuscleNames } from "../forms/workoutControls";
import { intlLocale } from "../i18n";
import { apiErr } from "../lib/apiErr";
import { exerciseName, machineName } from "../lib/catalogLabels";
import { formatTime24, isoToDisplay } from "../lib/dateFormat";
import { ExerciseThumb } from "../lib/exerciseIcon";
import { sessionBurnKcal, totalBurnKcal } from "../lib/trainingBurn";
import { cn } from "../lib/utils";
import { ExerciseHowToDialog, ExercisePicker } from "./PlansTab";

const WEEKDAYS: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// Weekday for any Date — Monday-zeroed to match the WEEKDAYS array order.
function weekdayFor(d: Date): Weekday {
  const i = d.getDay(); // 0=Sun..6=Sat
  return WEEKDAYS[(i + 6) % 7];
}

// ---------- Today tab ----------

// Pull every plan-day across all plans that's pinned to a given weekday.
// A user can have multiple plans (e.g. PPL + accessory) — the "Start
// workout" UI lets them pick which day applies right now. Plan days with
// multiple weekdays match against each one independently.
function planDaysForWeekday(
  plans: WorkoutPlan[],
  weekday: Weekday,
): Array<{ plan: WorkoutPlan; day: WorkoutPlanDay }> {
  const out: Array<{ plan: WorkoutPlan; day: WorkoutPlanDay }> = [];
  for (const p of plans) {
    for (const d of p.days) {
      if (d.weekdays.includes(weekday)) out.push({ plan: p, day: d });
    }
  }
  return out;
}

export function SessionsTab({
  catalog,
  plans,
  sessions,
  anchor,
  granularity,
  bodyweightKg,
  onChanged,
  editingId,
  setEditingId,
  selectedDate,
}: {
  catalog: WorkoutCatalog;
  plans: WorkoutPlan[];
  sessions: WorkoutSession[];
  anchor: Date;
  granularity: Granularity;
  bodyweightKg: number | null;
  onChanged: () => void | Promise<void>;
  // Finished session being edited (reopened in the logging panel). Resolved
  // against the current session list so it clears itself if the session is
  // deleted or the user navigates to a range that no longer includes it.
  editingId: number | null;
  setEditingId: (id: number | null) => void;
  // Range view: the day tapped on the burn chart, whose trainings are listed.
  selectedDate: string | null;
}) {
  const { t } = useTranslation();
  const planDayFor = (s: WorkoutSession): WorkoutPlanDay | null =>
    s.plan_day_id
      ? (plans.flatMap((p) => p.days).find((d) => d.id === s.plan_day_id) ?? null)
      : null;
  const planFor = (s: WorkoutSession): WorkoutPlan | null =>
    s.plan_day_id ? (plans.find((p) => p.days.some((d) => d.id === s.plan_day_id)) ?? null) : null;

  const editing = sessions.find((s) => s.id === editingId && s.duration_min != null) ?? null;

  // The auto-expanded live panel — the picker's "Continue" button scrolls here.
  const activeRef = useRef<HTMLDivElement>(null);

  if (granularity !== "day") {
    // Range view: every unfinished session (one can be left open per day),
    // plus the logged trainings of the day tapped on the burn chart — the
    // chart is the overview, so nothing is listed until a day is picked. No
    // Start panel here — that's day-anchored. User picks the day tab to log.
    const unfinished = sessions
      .filter((s) => s.duration_min == null)
      .sort((a, b) => b.date.localeCompare(a.date));
    const selectedFinished = selectedDate
      ? sessions.filter((s) => s.date === selectedDate && s.duration_min != null)
      : [];
    return (
      <div className="space-y-4">
        {unfinished.map((s) => (
          <div key={s.id}>
            <ActiveSessionPanel
              session={s}
              planDay={planDayFor(s)}
              catalog={catalog}
              onChanged={onChanged}
            />
          </div>
        ))}
        {selectedDate && (
          <TrainingBurnDayCard
            date={selectedDate}
            sessions={selectedFinished}
            planDayFor={planDayFor}
            planFor={planFor}
            bodyweightKg={bodyweightKg}
            catalog={catalog}
            editingId={editing?.id ?? null}
            onEdit={setEditingId}
            onChanged={onChanged}
            onDoneEditing={() => setEditingId(null)}
          />
        )}
        {sessions.length === 0 && (
          <EmptyState icon={Dumbbell}>{t("workout.noWorkoutsInRange")}</EmptyState>
        )}
      </div>
    );
  }

  // Day view.
  const weekday = weekdayFor(anchor);
  const matches = planDaysForWeekday(plans, weekday);
  const anchorIso = toIso(anchor);
  const todayIsoStr = toIso(today());
  const dayKind: "past" | "today" | "future" =
    anchorIso < todayIsoStr ? "past" : anchorIso > todayIsoStr ? "future" : "today";

  // A session is "active" while duration_min is null. Reachable on any date:
  // past = retroactive log in progress, today = live workout, future = draft.
  const active = sessions.find((s) => s.duration_min == null) ?? null;
  const finished = sessions.filter((s) => s.duration_min != null);

  return (
    <div className="space-y-4">
      {/* "Training for the day" picker sits on top. Each plan-day reflects its
          state: a finished day drops out (it's in the burn card below), the
          in-progress day becomes a dashed "Continue" button that scrolls to the
          live panel. Hidden only while a finished session is edited inline. */}
      {editing == null && (
        <StartSessionPanel
          anchorIso={anchorIso}
          dayKind={dayKind}
          weekday={weekday}
          matches={matches}
          plans={plans}
          finished={finished}
          active={active}
          onStarted={onChanged}
          onContinueActive={() =>
            activeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        />
      )}
      {/* Live/partial session auto-expands so sets can be logged in place. */}
      {active && (
        <div ref={activeRef}>
          <ActiveSessionPanel
            session={active}
            planDay={planDayFor(active)}
            catalog={catalog}
            onChanged={onChanged}
          />
        </div>
      )}
      <TrainingBurnDayCard
        sessions={finished}
        planDayFor={planDayFor}
        planFor={planFor}
        bodyweightKg={bodyweightKg}
        catalog={catalog}
        editingId={editing?.id ?? null}
        onEdit={setEditingId}
        onChanged={onChanged}
        onDoneEditing={() => setEditingId(null)}
      />
    </div>
  );
}

// Day-view roll-up: the selected day's finished sessions, listed as editable
// rows inside one "Training burn" card with the day total in the header. Each
// row carries its own burn (logged kcal, or a MET estimate from duration) and
// an Edit button — so the trainings and their kcal live in a single place, not
// duplicated across a separate burn card + session list. Editing a row expands
// the logging panel inline, nested within this same card.
// The "?" by a Training burn title: how the burn is worked out, and what the
// "≈" on estimated figures means.
export function BurnHelp({ description }: { description: string }) {
  const { t } = useTranslation();
  return (
    <HelpPopover
      label={t("workout.burnHelpAria")}
      heading={t("workout.trainingBurn")}
      align="start"
    >
      <p>{description}</p>
      <p>{t("workout.estimatedNote")}</p>
    </HelpPopover>
  );
}

function TrainingBurnDayCard({
  date,
  sessions,
  planDayFor,
  planFor,
  bodyweightKg,
  catalog,
  editingId,
  onEdit,
  onChanged,
  onDoneEditing,
}: {
  // Shown in the header when the card lists a day picked from the range chart.
  date?: string;
  sessions: WorkoutSession[];
  planDayFor: (s: WorkoutSession) => WorkoutPlanDay | null;
  // The plan the session's day belongs to, named on the row's second line.
  planFor: (s: WorkoutSession) => WorkoutPlan | null;
  bodyweightKg: number | null;
  catalog: WorkoutCatalog;
  // Id of the session being edited inline, or null. When it matches a row, that
  // row expands into the ActiveSessionPanel in place of its summary.
  editingId: number | null;
  onEdit: (id: number) => void;
  onChanged: () => void | Promise<void>;
  onDoneEditing: () => void;
}) {
  const { t } = useTranslation();
  // Rows opened to read their sets — viewing, separate from editing.
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(() => new Set());
  const toggleOpen = (id: number) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (sessions.length === 0) return null;
  const total = totalBurnKcal(sessions, bodyweightKg);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Flame className="size-4 text-primary" />
            {t("workout.trainingBurn")}
            <BurnHelp description={t("workout.burnDayDescription")} />
          </CardTitle>
          {total.count > 0 && (
            <span className="inline-flex shrink-0 items-baseline gap-1 rounded-full bg-linear-to-br from-primary/20 to-primary/5 px-3 py-1 ring-1 ring-primary/20 ring-inset">
              <span className="text-base leading-none font-bold text-primary tabular-nums">
                {Math.round(total.kcal).toLocaleString()}
              </span>
              <span className="text-[11px] font-medium text-primary/70">
                {t("workout.kcal")}
                {total.estimated ? " ≈" : ""}
              </span>
            </span>
          )}
        </div>
        {date && (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
            <CalendarDays className="size-3.5 text-primary" />
            <span className="text-foreground">
              {new Date(`${date}T00:00:00`).toLocaleDateString(intlLocale(), { weekday: "long" })}
            </span>
            <span className="text-muted-foreground tabular-nums">{isoToDisplay(date)}</span>
          </span>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="divide-y border-t">
          {sessions.map((s) => {
            // Editing this row: swap the summary for the inline logging panel.
            if (s.id === editingId) {
              return (
                <div key={s.id} className="py-3">
                  <ActiveSessionPanel
                    key={`edit-${s.id}`}
                    session={s}
                    planDay={planDayFor(s)}
                    catalog={catalog}
                    onChanged={onChanged}
                    editing
                    onDoneEditing={onDoneEditing}
                  />
                </div>
              );
            }
            const planDay = planDayFor(s);
            const plan = planFor(s);
            const burn = sessionBurnKcal(s, bodyweightKg);
            const exerciseCount = new Set(s.sets.map((x) => x.exercise_id)).size;
            const setCount = s.sets.length;
            const open = openIds.has(s.id);
            return (
              <div key={s.id} className="space-y-1 py-2.5">
                {/* Title row: the plan day ("Day 1 – Upper", or the session's
                    name when ad hoc), its Done badge, and its kcal by the
                    chevron; long names wrap rather than truncate on mobile.
                    Tapping it opens the session's sets read-only, without
                    entering edit. */}
                <button
                  type="button"
                  onClick={() => toggleOpen(s.id)}
                  aria-expanded={open}
                  aria-label={t(open ? "workout.hideSets" : "workout.showSets")}
                  className="flex w-full items-start gap-2 rounded-sm text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="min-w-0 text-sm font-medium wrap-break-word">
                    {planDay
                      ? `${planDay.name}${planDay.focus ? ` – ${planDay.focus}` : ""}`
                      : (s.name ?? t("workout.workoutFallbackName"))}
                  </span>
                  <Badge variant="secondary" className="shrink-0">
                    {t("workout.done")}
                  </Badge>
                  <span className="flex-1" />
                  {burn && (
                    <span className="inline-flex shrink-0 items-baseline gap-0.5 text-sm font-semibold tabular-nums">
                      {Math.round(burn.kcal).toLocaleString()}
                      <span className="text-xs font-normal text-muted-foreground">
                        {t("workout.kcal")}
                        {burn.estimated ? " ≈" : ""}
                      </span>
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
                      !open && "-rotate-90",
                    )}
                  />
                </button>
                {/* Below the title: the parent plan, then time and sets, with
                    Edit on the right. The session's own name ("Plan: Day 1 -
                    Upper A") would only repeat the two. */}
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 space-y-0.5 text-xs text-muted-foreground">
                    {plan && <div className="wrap-break-word">{plan.name}</div>}
                    <div>
                      {[
                        planDay ? null : t("workout.adHoc"),
                        s.duration_min != null
                          ? t("workout.minutesShort", { n: s.duration_min })
                          : null,
                        `${t("workout.setsCount", { count: setCount })} ${t("workout.acrossExercises", { count: exerciseCount })}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onEdit(s.id)}
                      className="h-7 gap-1 px-2"
                      aria-label={t("workout.editWorkout")}
                    >
                      <Pencil className="size-4" />
                      {t("common.edit")}
                    </Button>
                  </div>
                </div>
                {open && <SessionSetsView session={s} catalog={catalog} />}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// A finished session read-only: its exercises in logged order, each in its own
// card with its sets and — for loaded lifts — the same trend graph the logging
// card opens.
function SessionSetsView({
  session,
  catalog,
}: {
  session: WorkoutSession;
  catalog: WorkoutCatalog;
}) {
  const { t } = useTranslation();
  const [trendFor, setTrendFor] = useState<ExerciseId | null>(null);
  const byExercise = new Map<ExerciseId, WorkoutSet[]>();
  for (const x of session.sets) {
    const arr = byExercise.get(x.exercise_id) ?? [];
    arr.push(x);
    byExercise.set(x.exercise_id, arr);
  }
  if (byExercise.size === 0) {
    return <p className="pt-2 text-xs text-muted-foreground">{t("workout.noSetsLogged")}</p>;
  }
  return (
    <div className="space-y-3 pt-2">
      {[...byExercise].map(([exId, sets]) => {
        const exercise = catalog.exercises.find((e) => e.id === exId) ?? null;
        const machineId = sets[0].machine_id ?? exercise?.machine_id ?? null;
        // No load to chart: cardio, or a timed hold (its reps are seconds).
        const isCardio =
          sets.every((x) => x.duration_sec != null && x.duration_sec > 0) ||
          isTimedExercise(exercise);
        const trendOpen = trendFor === exId;
        return (
          <div
            key={exId}
            className="space-y-2 rounded-lg border border-edge bg-card p-2.5 shadow-tile"
          >
            <div className="flex items-center gap-2">
              <ExerciseThumb exerciseId={exId} machineId={machineId} className="size-9" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{exerciseName(exercise ?? exId)}</div>
                {machineId && (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {machineName(machineId)}
                  </div>
                )}
              </div>
              {!isCardio && (
                <Button
                  size="icon"
                  variant="outline"
                  className={cn(
                    "size-7 shrink-0",
                    trendOpen && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
                  )}
                  aria-label={t("workout.trendButton")}
                  aria-expanded={trendOpen}
                  title={t("workout.trendButton")}
                  onClick={() => setTrendFor(trendOpen ? null : exId)}
                >
                  <ChartLine className="size-3.5" />
                </Button>
              )}
            </div>
            <ul className="divide-y divide-border/60 border-y border-border/60 text-xs">
              {sets.map((x) => (
                <li key={x.id} className="flex items-center gap-2 py-1.5">
                  <span className="font-medium">
                    {t("workout.setLabel", { index: x.set_index })}
                  </span>
                  <span>{setText(x, t)}</span>
                  {x.rpe != null && (
                    <span className="text-muted-foreground">
                      {t("workout.rpe", { value: x.rpe })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {/* The card is p-2.5. */}
            {trendOpen && <ExerciseTrendPanel exerciseId={exId} bleed="-mx-2" />}
          </div>
        );
      })}
    </div>
  );
}

function StartSessionPanel({
  anchorIso,
  dayKind,
  weekday,
  matches,
  plans,
  finished,
  active,
  onStarted,
  onContinueActive,
}: {
  anchorIso: string;
  dayKind: "past" | "today" | "future";
  weekday: Weekday;
  matches: Array<{ plan: WorkoutPlan; day: WorkoutPlanDay }>;
  plans: WorkoutPlan[];
  // The day's already-logged sessions and the single in-progress one (if any).
  // They drive per-day button state: finished days drop out, the active day
  // becomes a "Continue" button.
  finished: WorkoutSession[];
  active: WorkoutSession | null;
  onStarted: () => void | Promise<void>;
  // Scroll the auto-expanded live panel into view to keep logging/editing.
  onContinueActive: () => void;
}) {
  const { t } = useTranslation();
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  // Per-plan-day state, keyed on plan_day_id. A day with a finished session is
  // done; the day matching the in-progress session is "active". While any
  // session is active no new one can be started (one active session at a time),
  // so idle start buttons are disabled — only "Continue" stays live.
  const finishedDayIds = new Set(
    finished.map((s) => s.plan_day_id).filter((id): id is number => id != null),
  );
  const activeDayId = active?.plan_day_id ?? null;
  const dayStatus = (id: number): "finished" | "active" | "idle" =>
    finishedDayIds.has(id) ? "finished" : active && activeDayId === id ? "active" : "idle";
  const continueClass = "border-dashed border-primary text-primary hover:text-primary";

  // Plan days NOT scheduled for today's weekday — surfaced behind a collapsed
  // section so you can train off-schedule without falling back to ad-hoc and
  // losing the prescribed exercises/targets.
  const matchIds = new Set(matches.map((m) => m.day.id));
  const otherDays: Array<{ plan: WorkoutPlan; day: WorkoutPlanDay }> = [];
  for (const p of plans) {
    for (const d of p.days) {
      if (!matchIds.has(d.id)) otherDays.push({ plan: p, day: d });
    }
  }

  const start = async (planDayId: number | null, name: string | null) => {
    setStarting(true);
    setErr(null);
    try {
      await postWorkoutSessions({
        date: anchorIso,
        plan_day_id: planDayId,
        name,
      });
      await onStarted();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setStarting(false);
    }
  };

  const headline = active
    ? t("workout.headline.inProgress")
    : matches.length === 0
      ? dayKind === "today"
        ? t("workout.headline.noPlanToday")
        : dayKind === "past"
          ? t("workout.headline.noPlanPast")
          : t("workout.headline.noPlanFuture")
      : matches.length === 1
        ? `${
            dayKind === "past"
              ? t("workout.headline.singlePast")
              : dayKind === "future"
                ? t("workout.headline.singleFuture")
                : t("workout.headline.singleToday")
          }: ${matches[0].day.name}${matches[0].day.focus ? ` · ${matches[0].day.focus}` : ""}`
        : dayKind === "past"
          ? t("workout.headline.pickPast")
          : dayKind === "future"
            ? t("workout.headline.pickFuture")
            : t("workout.headline.pickToday");

  const startVerb =
    dayKind === "past"
      ? t("workout.startVerb.log")
      : dayKind === "future"
        ? t("workout.startVerb.plan")
        : t("workout.startVerb.start");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 capitalize">
          <CalendarDays className="size-4 text-primary" />
          {t(`workout.weekdays.${weekday}`)}
        </CardTitle>
        <CardDescription>{headline}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {matches.map(({ plan, day }) => {
          const status = dayStatus(day.id);
          // Finished: it's done and listed in the burn card — drop the button.
          if (status === "finished") return null;
          if (status === "active") {
            return (
              <Button
                key={day.id}
                onClick={onContinueActive}
                variant="outline"
                className={cn("w-full justify-start", continueClass)}
              >
                {t("workout.continueDay", { name: day.name })}
                {day.focus && <span className="ms-2 text-xs opacity-70">· {day.focus}</span>}
              </Button>
            );
          }
          return (
            <Button
              key={day.id}
              disabled={starting || active != null}
              onClick={() => start(day.id, `${plan.name}: ${day.name}`)}
              className="w-full justify-start"
              variant="default"
            >
              {`${startVerb} ${day.name}`}
              {day.focus && <span className="ms-2 text-xs opacity-70">· {day.focus}</span>}
            </Button>
          );
        })}
        {active && activeDayId == null ? (
          // In-progress ad-hoc session: continue it rather than start another.
          <Button
            onClick={onContinueActive}
            variant="outline"
            className={cn("w-full", continueClass)}
          >
            {t("workout.continueAdHoc")}
          </Button>
        ) : (
          <Button
            disabled={starting || active != null}
            onClick={() => start(null, "Ad-hoc")}
            variant={matches.length === 0 ? "default" : "outline"}
            className="w-full"
          >
            {matches.length === 0
              ? t("workout.startAdHocWorkout", { verb: startVerb })
              : t("workout.startAdHocNoPlan", { verb: startVerb })}
          </Button>
        )}

        {otherDays.length > 0 && (
          <div className="space-y-2 pt-1">
            <button
              type="button"
              onClick={() => setShowOthers((v) => !v)}
              className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn("size-3 transition-transform", !showOthers && "-rotate-90")}
              />
              {t("workout.otherPlanDays", { count: otherDays.length })}
            </button>
            {showOthers && (
              <div className="space-y-1.5">
                {otherDays.map(({ plan, day }) => {
                  const status = dayStatus(day.id);
                  if (status === "finished") return null;
                  const isActive = status === "active";
                  return (
                    <Button
                      key={day.id}
                      disabled={!isActive && (starting || active != null)}
                      onClick={() =>
                        isActive ? onContinueActive() : start(day.id, `${plan.name}: ${day.name}`)
                      }
                      variant="outline"
                      className={cn("h-auto w-full justify-start py-2", isActive && continueClass)}
                    >
                      <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <span className="truncate text-sm">
                          {isActive && t("workout.continuePrefix")}
                          <span className={cn(!isActive && "text-muted-foreground")}>
                            {plan.name}:
                          </span>{" "}
                          {day.name}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {day.focus || t("workout.noFocus")}
                          {day.weekdays.length > 0 && (
                            <span>
                              {" · "}
                              {day.weekdays.map((w) => t(`workout.weekdays.${w}`)).join(", ")}
                            </span>
                          )}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

function ActiveSessionPanel({
  session,
  planDay,
  catalog,
  onChanged,
  editing = false,
  onDoneEditing,
}: {
  session: WorkoutSession;
  planDay: WorkoutPlanDay | null;
  catalog: WorkoutCatalog;
  onChanged: () => void | Promise<void>;
  // Edit mode: a finished session reopened for corrections. Sets save the
  // same way; "Finish" becomes "Done" and the duration is taken from the
  // input (prefilled with the logged value) instead of the wall-clock.
  editing?: boolean;
  onDoneEditing?: () => void;
}) {
  const { t } = useTranslation();
  const [adHocPickerOpen, setAdHocPickerOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  // Used when started_at is null (retroactive log or planned session) — the
  // user types how long the workout took since we can't subtract wall-clock.
  // In edit mode it's prefilled with the previously logged duration.
  const [manualDuration, setManualDuration] = useState<number | "">(
    editing && session.duration_min != null ? Math.round(session.duration_min) : 60,
  );

  const setsByExercise = useMemo(() => {
    const map = new Map<ExerciseId, WorkoutSet[]>();
    for (const s of session.sets) {
      const arr = map.get(s.exercise_id) ?? [];
      arr.push(s);
      map.set(s.exercise_id, arr);
    }
    return map;
  }, [session.sets]);

  // Two sets of exercises to render: those prescribed by the plan-day (with
  // target sets/reps from the plan) and any ad-hoc exercises the user added
  // mid-session (no target — pure free logging).
  const planExercises = planDay?.exercises ?? [];
  const planExerciseIds = new Set(planExercises.map((e) => e.exercise_id));
  const adHocExerciseIds = Array.from(setsByExercise.keys()).filter(
    (id) => !planExerciseIds.has(id),
  );

  const startedLabel = session.started_at ? formatTime24(new Date(session.started_at)) : null;

  const finish = async () => {
    setFinishing(true);
    setActionErr(null);
    try {
      // Live workouts (started_at present): compute duration from wall-clock.
      // Backdated / planned (started_at null) and edit mode: use what the
      // user typed — never recompute from started_at when editing, the
      // session may have finished long ago.
      const typed =
        typeof manualDuration === "number" && Number.isFinite(manualDuration) && manualDuration > 0
          ? Math.round(manualDuration)
          : null;
      const minutes = editing
        ? (typed ?? Math.round(session.duration_min ?? 0))
        : session.started_at
          ? Math.max(1, Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000))
          : (typed ?? 0);
      await patchWorkoutSessionsId({ duration_min: minutes }, session.id);
      await onChanged();
      onDoneEditing?.();
    } catch (e) {
      setActionErr(apiErr(e));
    } finally {
      setFinishing(false);
    }
  };

  const discard = async () => {
    setActionErr(null);
    try {
      await deleteWorkoutSessionsId(session.id);
      await onChanged();
      onDoneEditing?.();
    } catch (e) {
      setActionErr(apiErr(e));
    }
  };

  const addAdHoc = (ex: Exercise) => {
    // Adding an ad-hoc exercise = it appears in the list as soon as the
    // user logs the first set. To make it visible immediately, seed an
    // empty entry by inserting an empty array — handled in JSX below by
    // checking both sources.
    setsByExercise.set(ex.id, setsByExercise.get(ex.id) ?? []);
    setAdHocPickerOpen(false);
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 truncate">
              <span className="truncate">
                {session.name ??
                  (editing ? t("workout.workoutFallbackName") : t("workout.todaysSession"))}
              </span>
              {editing && <Badge variant="outline">{t("workout.editing")}</Badge>}
            </CardTitle>
            <CardDescription>
              {editing && <span className="font-mono">{isoToDisplay(session.date)} · </span>}
              {planDay
                ? `${planDay.name}${planDay.focus ? ` · ${planDay.focus}` : ""}`
                : t("workout.adHoc")}
              {!editing && startedLabel && (
                <span className="text-muted-foreground">
                  {" · "}
                  {t("workout.startedAt", { time: startedLabel })}
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {(!session.started_at || editing) && (
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                {t("workout.min")}
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={manualDuration}
                  onChange={(e) =>
                    setManualDuration(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  className={cn(
                    "h-7 w-14 rounded-sm border bg-background px-1.5 text-end text-xs",
                    "focus:ring-1 focus:ring-ring focus:outline-none",
                  )}
                  aria-label={t("workout.durationInMinutes")}
                />
              </label>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDiscardOpen(true)}
              disabled={finishing}
            >
              {editing ? t("workout.delete") : t("workout.discard")}
            </Button>
            <Button size="sm" onClick={finish} disabled={finishing} className="gap-1">
              <Check className="size-4" />
              {finishing ? t("common.saving") : editing ? t("workout.done") : t("workout.finish")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {actionErr && <p className="text-sm text-destructive">{actionErr}</p>}

          {planExercises.length === 0 && adHocExerciseIds.length === 0 && (
            <EmptyState icon={Dumbbell}>{t("workout.noExercisesYet")}</EmptyState>
          )}

          {planExercises.map((pe) => (
            <ExerciseLogCard
              key={pe.id}
              sessionId={session.id}
              catalog={catalog}
              prescribed={pe}
              sets={setsByExercise.get(pe.exercise_id) ?? []}
              onChanged={onChanged}
            />
          ))}

          {adHocExerciseIds.map((exId) => (
            <ExerciseLogCard
              key={`adhoc-${exId}`}
              sessionId={session.id}
              catalog={catalog}
              prescribed={null}
              exerciseId={exId}
              sets={setsByExercise.get(exId) ?? []}
              onChanged={onChanged}
            />
          ))}

          <Button
            variant="outline"
            onClick={() => setAdHocPickerOpen(true)}
            className="w-full gap-1"
          >
            <Plus className="size-4" /> {t("workout.addExercise")}
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {editing ? t("workout.deleteWorkoutTitle") : t("workout.discardWorkoutTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("workout.discardWorkoutBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={discard}
              className={buttonVariants({ variant: "destructive" })}
            >
              {editing ? t("workout.delete") : t("workout.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {adHocPickerOpen && (
        <ExercisePicker
          catalog={catalog}
          onPick={addAdHoc}
          onClose={() => setAdHocPickerOpen(false)}
        />
      )}
    </>
  );
}

function ExerciseLogCard({
  sessionId,
  catalog,
  prescribed,
  exerciseId,
  sets,
  onChanged,
}: {
  sessionId: number;
  catalog: WorkoutCatalog;
  // Either prescribed (from the plan-day) OR exerciseId (ad-hoc) must be set.
  prescribed: WorkoutPlanExercise | null;
  exerciseId?: ExerciseId;
  sets: WorkoutSet[];
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const muscleNames = useExerciseMuscleNames();
  const exId = prescribed?.exercise_id ?? exerciseId!;
  const exercise = catalog.exercises.find((e) => e.id === exId) ?? null;
  const meta = exercise?.metadata ?? null;
  const machineId = prescribed?.machine_id ?? exercise?.machine_id ?? null;
  // The exercise's primary muscle groups; falls back to what the machine
  // targets for exercises missing from the catalog.
  const exerciseGroups = useMemo(() => {
    const own = muscleGroupsForExercise(exId);
    if (own.length || !machineId) return own;
    return catalog.machines.find((m) => m.id === machineId)?.muscle_groups ?? [];
  }, [exId, machineId, catalog]);
  const targetSets = prescribed?.target_sets;
  const targetReps = prescribed?.target_reps;
  const targetWeight = prescribed?.target_weight_kg ?? null;

  // Last-time hint: the most recent N sets of this exercise across ANY past
  // session. Filtered to exclude sets from the current session so the hint is
  // meaningfully historical. Hint failure is non-fatal (null = no hint).
  const lastSetsQ = useGetWorkoutExercisesIdLastSets(exId, { limit: 10 });
  const lastSets = useMemo<LastExerciseSet[] | null>(
    () =>
      lastSetsQ.data
        ? (lastSetsQ.data.sets as unknown as LastExerciseSet[]).filter(
            (s) => s.session_id !== sessionId,
          )
        : null,
    [lastSetsQ.data, sessionId],
  );

  // Default reps/weight for the inline form: prefer the LAST set logged in
  // THIS session (progressive — same load), then target from the plan, then
  // last-session top set, then bare defaults.
  const defaultReps = sets[sets.length - 1]?.reps ?? targetReps ?? lastSets?.[0]?.reps ?? 8;
  const defaultWeight =
    sets[sets.length - 1]?.weight_kg ?? targetWeight ?? lastSets?.[0]?.weight_kg ?? 0;
  // Timed holds (plank) log seconds, prescribed in target_duration_sec.
  const timed = isTimedExercise(exercise);
  const targetDuration = prescribed?.target_duration_sec ?? null;
  // Cardio (walk, run…) is prescribed and logged in minutes, not reps.
  const cardio = exerciseFields(exercise).distance;
  const cardioTarget =
    targetDuration != null
      ? t("workout.minutesShort", { n: +(targetDuration / 60).toFixed(1) })
      : null;
  const defaultSeconds =
    sets[sets.length - 1]?.duration_sec ?? targetDuration ?? lastSets?.[0]?.duration_sec ?? 30;

  // Set deletion is confirmed before removing — like every other delete in the
  // app. pendingSet holds the set awaiting confirmation.
  const [pendingSet, setPendingSet] = useState<WorkoutSet | null>(null);
  const [deletingSet, setDeletingSet] = useState(false);
  // "How to" reference media, revealed under the title. Only when the exercise
  // actually carries metadata (most don't).
  const [metaOpen, setMetaOpen] = useState(false);

  // Once all scheduled sets are logged (e.g. 3 of a 3×12), auto-collapse the
  // card so the focus moves to the next exercise. The header stays clickable so
  // the user can re-expand to log extra sets or delete one. Only auto-collapses
  // on the transition into "complete" — a manual re-expand isn't undone.
  // Prescribed exercises auto-complete once every target set is logged. Ad-hoc
  // exercises have no target, so there's nothing to count against — completion
  // is marked manually via the "Mark as done" button below. Either way,
  // isComplete drives the collapse + the title checkmark.
  const [manualDone, setManualDone] = useState(false);
  const isComplete = targetSets != null ? sets.length >= targetSets : manualDone;
  // Every card starts collapsed so the session reads as a list; tap to open.
  const [collapsed, setCollapsed] = useState(true);
  const wasComplete = useRef(isComplete);
  useEffect(() => {
    if (isComplete && !wasComplete.current) setCollapsed(true);
    wasComplete.current = isComplete;
  }, [isComplete]);

  const deleteSet = async () => {
    if (!pendingSet) return;
    setDeletingSet(true);
    try {
      await deleteWorkoutSessionsIdSetsSetId(sessionId, pendingSet.id);
      setPendingSet(null);
      await onChanged();
    } catch {
      // Non-fatal; the set stays listed on failure.
    } finally {
      setDeletingSet(false);
    }
  };

  return (
    <>
      {/* Not done: dashed primary outline. Soft has no outlines, so there an
          open exercise sinks into the page (an empty slot to fill) with a
          primary stripe on its leading edge, and pops up once done. */}
      <Card
        className={cn(
          "rounded-lg shadow-none soft:shadow-tile",
          !isComplete &&
            "border-dashed border-primary soft:border-s-4 soft:border-solid soft:border-transparent soft:border-s-primary soft:shadow-well",
        )}
      >
        <CardHeader
          className="cursor-pointer space-y-2 pb-3"
          onClick={() => setCollapsed((c) => !c)}
        >
          {/* Title on its own row so long names aren't squeezed by the icons (mobile). */}
          <div className="flex items-center gap-2">
            <CardTitle className="flex min-w-0 flex-1 items-center gap-2 text-base">
              <span className="truncate">{exerciseName(exercise ?? exId)}</span>
              {exercise && <ExerciseTypeBadge type={exercise.type} />}
              {isComplete && <Check className="size-4 shrink-0 text-primary" />}
            </CardTitle>
            {meta && (
              <button
                type="button"
                // Stop the header toggle: "How to" must not collapse the card.
                onClick={(e) => {
                  e.stopPropagation();
                  setMetaOpen((v) => !v);
                }}
                aria-haspopup="dialog"
                className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Info className="size-3.5" />
                {t("workout.howTo")}
              </button>
            )}
            {collapsed ? (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <ExerciseThumb exerciseId={exId} machineId={machineId} className="size-11" />
            <div className="min-w-0 flex-1 space-y-1">
              {machineId && (
                <div className="truncate text-xs font-medium text-foreground/80">
                  {machineName(machineId)}
                </div>
              )}
              {exerciseGroups.length > 0 && (
                <div className="truncate text-[11px] text-muted-foreground">
                  {/* The finer targets when the catalog knows it; else the machine's groups. */}
                  {(() => {
                    const ex = getExercise(exId);
                    return ex ? muscleNames(ex) : muscleGroupNames(exerciseGroups);
                  })()}
                </div>
              )}
              <div className="space-y-0.5 pt-0.5 text-xs">
                <SetHint label={targetSets != null ? t("workout.targetLabel") : null}>
                  {targetSets != null
                    ? cardio
                      ? `${targetSets > 1 ? `${targetSets}×` : ""}${cardioTarget ?? "—"}`
                      : timed
                        ? targetWeight
                          ? t("workout.targetTimedWithWeight", {
                              sets: targetSets,
                              sec: targetDuration,
                              weight: targetWeight,
                            })
                          : t("workout.targetTimed", { sets: targetSets, sec: targetDuration })
                        : targetWeight
                          ? t("workout.targetWithWeight", {
                              sets: targetSets,
                              reps: targetReps,
                              weight: targetWeight,
                            })
                          : t("workout.target", { sets: targetSets, reps: targetReps })
                    : t("workout.adHoc")}
                </SetHint>
                {lastSets && lastSets.length > 0 && (
                  <SetHint label={t("workout.lastLabel")}>
                    {summarizeLastSets(lastSets, cardio ? "minutes" : timed ? "seconds" : "reps")}
                  </SetHint>
                )}
              </div>
            </div>
            {exerciseGroups.length > 0 && (
              <MuscleMap
                groups={exerciseGroups}
                muscles={getExercise(exId)?.primary_muscles}
                className="h-11"
              />
            )}
          </div>
          {/* The plan's note for this exercise (cues, tempo, setup) — full width
              and wrapped, since it's read mid-set; stays visible when collapsed. */}
          {prescribed?.notes && (
            <p className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-xs whitespace-pre-wrap text-muted-foreground">
              <StickyNote
                className="mt-px size-3.5 shrink-0"
                aria-label={t("workout.exerciseNotes")}
              />
              <span className="min-w-0">{prescribed.notes}</span>
            </p>
          )}
        </CardHeader>
        {!collapsed && (
          <CardContent className="space-y-2 pb-3">
            {sets.length > 0 && (
              <ul className="divide-y divide-border/60 border-y border-border/60 text-xs">
                {sets.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 py-1">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">
                        {t("workout.setLabel", { index: s.set_index })}
                      </span>
                      <span>{setText(s, t)}</span>
                      {s.rpe != null && (
                        <span className="text-muted-foreground">
                          {t("workout.rpe", { value: s.rpe })}
                        </span>
                      )}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      aria-label={t("workout.deleteSet")}
                      onClick={() => setPendingSet(s)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <InlineSetForm
              sessionId={sessionId}
              exercise={exercise}
              exerciseId={exId}
              machineId={machineId}
              defaultReps={defaultReps}
              defaultWeight={defaultWeight}
              defaultSeconds={defaultSeconds}
              complete={isComplete}
              onLogged={onChanged}
            />

            {/* Ad-hoc exercises have no target set count to auto-complete against,
              so completion is manual. (Prescribed exercises complete on their
              own once all target sets are logged.) */}
            {targetSets == null && (
              <button
                type="button"
                onClick={() => setManualDone((d) => !d)}
                className={cn(
                  "flex w-full items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium transition-colors",
                  manualDone
                    ? "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 soft:border-transparent soft:bg-background soft:shadow-pressed"
                    : "border-dashed text-muted-foreground hover:bg-accent soft:border-transparent soft:shadow-control soft:hover:bg-background soft:hover:text-primary",
                )}
              >
                <Check className="size-3.5" />
                {manualDone ? t("workout.doneTapToReopen") : t("workout.markAsDone")}
              </button>
            )}
          </CardContent>
        )}
      </Card>

      {/* Outside the Card: portal events still bubble through React, and the
          header's click collapses the card. */}
      {meta && <ExerciseHowToDialog exerciseId={exId} open={metaOpen} onOpenChange={setMetaOpen} />}

      <AlertDialog open={pendingSet != null} onOpenChange={(o) => !o && setPendingSet(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workout.deleteSetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSet
                ? t("workout.deleteSetBody", {
                    index: pendingSet.set_index,
                    reps: pendingSet.reps,
                    weight: pendingSet.weight_kg,
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSet}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void deleteSet();
              }}
              disabled={deletingSet}
              className={buttonVariants({ variant: "destructive" })}
            >
              {deletingSet ? t("workout.deleting") : t("workout.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// One "LABEL  value" line under an exercise card title (target / last time).
// A logged set as text: seconds (+ kg) for a timed hold, duration (+ distance)
// for cardio, reps × kg otherwise.
function setText(s: WorkoutSet, t: TFunction): string {
  if (isTimedExercise(getExercise(s.exercise_id))) {
    const sec = s.duration_sec ?? 0;
    return s.weight_kg > 0
      ? t("workout.timedSetWithWeight", { sec, weight: s.weight_kg })
      : t("workout.timedSet", { sec });
  }
  if (s.duration_sec != null && s.duration_sec > 0) {
    const min = Math.round(s.duration_sec / 60);
    return s.distance_m != null && s.distance_m > 0
      ? t("workout.cardioSetWithDistance", { min, km: (s.distance_m / 1000).toFixed(2) })
      : t("workout.cardioSet", { min });
  }
  return t("workout.repsAtWeight", { reps: s.reps, weight: s.weight_kg });
}

function SetHint({ label, children }: { label: string | null; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      {label && (
        <span className="w-16 shrink-0 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
      )}
      <span className="truncate font-medium tabular-nums">{children}</span>
    </div>
  );
}

function summarizeLastSets(sets: LastExerciseSet[], unit: "reps" | "seconds" | "minutes"): string {
  // Group consecutive identical sets (e.g. "3×8 @ 60kg"). Walks newest →
  // oldest but presents oldest → newest in the typical training-log order.
  const reversed = [...sets].reverse();
  // A timed hold reads as seconds ("3×60s"), cardio as minutes ("1×30min").
  const amount = (s: LastExerciseSet) =>
    unit === "seconds"
      ? `${s.duration_sec ?? 0}s`
      : unit === "minutes"
        ? `${Math.round((s.duration_sec ?? 0) / 60)}min`
        : String(s.reps);
  const groups: Array<{ amount: string; weight_kg: number; count: number }> = [];
  for (const s of reversed) {
    const last = groups[groups.length - 1];
    if (last && last.amount === amount(s) && last.weight_kg === s.weight_kg) {
      last.count++;
    } else {
      groups.push({ amount: amount(s), weight_kg: s.weight_kg, count: 1 });
    }
  }
  return groups
    .slice(-3) // cap at last 3 groups to keep the hint short
    .map((g) => `${g.count}×${g.amount}${g.weight_kg > 0 ? `@${g.weight_kg}kg` : ""}`)
    .join(", ");
}

function InlineSetForm({
  sessionId,
  exercise,
  exerciseId,
  machineId,
  defaultReps,
  defaultWeight,
  defaultSeconds,
  complete = false,
  onLogged,
}: {
  sessionId: number;
  // Resolved catalog exercise (null for ids not in the catalog). Drives whether
  // this is a cardio set (duration/distance) or a strength set (reps/weight).
  exercise: Exercise | null;
  exerciseId: ExerciseId;
  machineId: MachineId | null;
  defaultReps: number;
  defaultWeight: number;
  defaultSeconds: number;
  complete?: boolean;
  onLogged: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const isCardio = exercise ? trackedMetricsFor(exercise).includes("duration_distance") : false;
  // The inputs this exercise uses (exerciseFields): reps for lifts, seconds
  // for a timed hold — both with weight. A hold has no 1RM to chart, so like
  // cardio it gets no trend.
  const fields = exerciseFields(exercise);
  const isTimed = !isCardio && fields.duration;
  const noLoad = isCardio || isTimed;
  const [reps, setReps] = useState<number>(defaultReps);
  const [seconds, setSeconds] = useState<number>(defaultSeconds);
  const [weight, setWeight] = useState<number>(defaultWeight);
  const [rpe, setRpe] = useState<number | "">("");
  // Cardio inputs: minutes + optional km (converted to sec/m on submit).
  const [durationMin, setDurationMin] = useState<number>(0);
  const [distanceKm, setDistanceKm] = useState<number>(0);
  const [logging, setLogging] = useState(false);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [trendOpen, setTrendOpen] = useState(false);

  // When the prescribed defaults shift (e.g. user just logged a set so the
  // last-set defaults moved), follow along.
  useEffect(() => setReps(defaultReps), [defaultReps]);
  useEffect(() => setWeight(defaultWeight), [defaultWeight]);
  useEffect(() => setSeconds(defaultSeconds), [defaultSeconds]);

  const canLog = isCardio
    ? durationMin > 0
    : isTimed
      ? seconds > 0
      : Number.isFinite(reps) && reps > 0;

  const log = async () => {
    if (!canLog) return;
    setLogging(true);
    setLogErr(null);
    try {
      const payload = isCardio
        ? {
            exercise_id: exerciseId,
            machine_id: machineId,
            // Cardio sets carry no load; the burn comes from duration × MET.
            reps: 0,
            weight_kg: 0,
            duration_sec: Math.round(durationMin * 60),
            ...(distanceKm > 0 ? { distance_m: Math.round(distanceKm * 1000) } : {}),
          }
        : {
            exercise_id: exerciseId,
            machine_id: machineId,
            // A timed hold's seconds go in duration_sec; reps stay 0.
            reps: isTimed ? 0 : reps,
            weight_kg: weight,
            ...(isTimed ? { duration_sec: Math.round(seconds) } : {}),
            ...(rpe !== "" && Number.isFinite(rpe) ? { rpe } : {}),
          };
      await postWorkoutSessionsIdSets(WorkoutSetRequest.parse(payload), sessionId);
      if (isCardio) {
        setDurationMin(0);
        setDistanceKm(0);
      } else {
        setRpe(""); // reps/weight stay so straight-set logging is one click
      }
      await onLogged();
    } catch (e) {
      setLogErr(apiErr(e));
    } finally {
      setLogging(false);
    }
  };

  return (
    <div className="space-y-1.5">
      {/* Mobile: the inputs and Log share one row at any width — equal
          columns, labels stacked above. From sm up it's the inline flex row. */}
      <div
        className={cn(
          "grid items-end gap-2 sm:flex sm:flex-wrap",
          isCardio ? "grid-cols-[1fr_1fr_auto]" : "grid-cols-[1fr_1fr_1fr_auto]",
        )}
      >
        {isCardio ? (
          <>
            <NumberField
              label={t("workout.durationLabel")}
              value={durationMin}
              min={0}
              step={1}
              onChange={setDurationMin}
            />
            <NumberField
              label={t("workout.distanceLabel")}
              value={distanceKm}
              min={0}
              step={0.1}
              optional
              onChange={setDistanceKm}
            />
          </>
        ) : (
          <>
            {isTimed ? (
              <NumberField
                label={t("workout.secondsLabel")}
                value={seconds}
                min={1}
                step={5}
                onChange={setSeconds}
              />
            ) : (
              <NumberField label={t("workout.repsLabel")} value={reps} min={1} onChange={setReps} />
            )}
            <NumberField
              label={t("workout.kgLabel")}
              value={weight}
              min={0}
              step={0.5}
              onChange={setWeight}
            />
            <label className={FIELD_LABEL}>
              {t("workout.rpeLabel")}
              <input
                type="number"
                value={rpe}
                min={1}
                max={10}
                step={0.5}
                onChange={(e) => setRpe(e.target.value === "" ? "" : Number(e.target.value))}
                className={FIELD_INPUT}
                placeholder="—"
              />
            </label>
          </>
        )}
        {/* Last-20-sets chart for this lift (1RM / weight / volume). Strength
            only — cardio sets carry no load to plot. Icon here from sm up; on
            mobile a full-width History button under the row toggles it. */}
        {!noLoad && (
          <Button
            size="icon"
            variant="outline"
            className={cn(
              "ms-auto hidden size-8 shrink-0 sm:inline-flex",
              trendOpen && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
            )}
            aria-label={t("workout.trendButton")}
            aria-expanded={trendOpen}
            title={t("workout.trendButton")}
            onClick={() => setTrendOpen((o) => !o)}
          >
            <ChartLine className="size-3.5" />
          </Button>
        )}
        <Button
          size="sm"
          variant={complete ? "outline" : "default"}
          onClick={log}
          disabled={logging || !canLog}
          className={cn("ms-auto", !noLoad && "sm:ms-0")}
        >
          {logging ? "…" : t("workout.logSet")}
        </Button>
      </div>
      {!noLoad && (
        <button
          type="button"
          aria-expanded={trendOpen}
          onClick={() => setTrendOpen((o) => !o)}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium transition-[color,background-color,box-shadow] sm:hidden soft:border-transparent",
            trendOpen
              ? "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 soft:bg-background soft:shadow-pressed soft:hover:bg-background"
              : "text-muted-foreground hover:bg-accent soft:shadow-control soft:hover:bg-transparent soft:hover:text-primary",
          )}
        >
          <ChartLine className="size-3.5" />
          {t("workout.trendHistory")}
        </button>
      )}
      {logErr && <p className="text-xs text-destructive">{logErr}</p>}
      {/* Inside ExerciseLogCard's CardContent: p-2, sm:p-5. */}
      {trendOpen && <ExerciseTrendPanel exerciseId={exerciseId} bleed="-mx-1.5 sm:-mx-4" />}
    </div>
  );
}

// Set-logging fields: label stacked over a full-width input in the mobile
// grid column, inline label + fixed-width input from sm up.
const FIELD_LABEL =
  "flex min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground sm:shrink-0 sm:flex-row sm:items-center sm:gap-1";
const FIELD_INPUT =
  "h-8 w-full min-w-0 rounded-md border border-edge bg-background px-1.5 text-end text-xs shadow-field focus:ring-1 focus:ring-ring focus:outline-none sm:h-7 sm:w-14";

function NumberField({
  label,
  value,
  onChange,
  min,
  step = 1,
  optional,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  step?: number;
  optional?: boolean;
}) {
  return (
    <label className={FIELD_LABEL}>
      {label}
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        step={step}
        onChange={(e) => {
          const n = e.target.value === "" ? 0 : Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        className={FIELD_INPUT}
        placeholder={optional ? "—" : undefined}
      />
    </label>
  );
}
