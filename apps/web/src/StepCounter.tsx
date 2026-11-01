/**
 * Step-counter UI. Two consumers share the same daily aggregate (`GET/POST
 * /steps`, keyed by date):
 *
 *   - <WorkoutStepCard> — the interactive "Walking" card on today's Workout
 *     screen. Drives the accelerometer step detector (useStepDetector), shows a
 *     live count, and flushes the running total to the server. Today only —
 *     auto-counting a past day makes no sense.
 *   - <StepProgress> — the presentational number + goal bar, reused by the
 *     Dashboard's read-only steps tile (any selected day).
 *
 * The detector only counts while the page is foregrounded (a browser sensor
 * limitation, not a bug), so this is framed as "start a walk", not a
 * background pedometer. The server stores the absolute daily total, so writes
 * are idempotent and a manual correction simply overwrites.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Footprints, Pause, Pencil, Play, Square } from "lucide-react";
import { postSteps, useGetSteps } from "./api/endpoints/default/default";
import { StepsLogRequest } from "@fa/shared/schemas";
import { useStepDetector } from "./lib/useStepDetector";
import { apiErr } from "./lib/apiErr";
import { useDayContext } from "./lib/dayContext";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import { cn } from "./lib/utils";

export const DEFAULT_STEP_GOAL = 10000;

// Flush the running total to the server this often while tracking, so a
// crash / hard-close loses at most this many seconds of steps.
const FLUSH_INTERVAL_MS = 15_000;

// Presentational steps + goal: a big tabular number and a goal progress bar.
// Pure — both the live card and the dashboard tile feed it resolved numbers.
export function StepProgress({
  steps,
  goal,
  compact = false,
  className,
}: {
  steps: number;
  goal: number;
  // Tighter layout for the Workout card (smaller number, drops the % caption
  // since the button sits alongside). The dashboard tile uses the full form.
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const pct = goal > 0 ? Math.min(100, Math.round((steps / goal) * 100)) : 0;
  const reached = goal > 0 && steps >= goal;
  return (
    <div className={cn(compact ? "space-y-1.5" : "space-y-2", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn("font-bold tracking-tight tabular-nums", compact ? "text-2xl" : "text-3xl")}
        >
          {steps.toLocaleString()}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("widgets.ofGoal", { goal: goal.toLocaleString() })}
          {compact && (
            <>
              {" · "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  reached ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
                )}
              >
                {pct}%
              </span>
            </>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            reached ? "bg-emerald-500" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          {reached ? t("widgets.goalReached") : t("widgets.pctOfDailyGoal", { pct })}
        </p>
      )}
    </div>
  );
}

// Compact SVG progress ring for steps — the goal gauge twin of <WaterRing>, so
// the dashboard's Steps and Hydration inlines read the same. Fills with the
// primary color, flipping to success once the goal is reached, over a dashed
// "to fill" track. The center shows % of goal.
export function StepsRing({
  steps,
  goal,
  size = 44,
}: {
  steps: number;
  goal: number;
  size?: number;
}) {
  const pct = goal > 0 ? Math.min(1, steps / goal) : 0;
  const reached = goal > 0 && steps >= goal;
  const stroke = size >= 80 ? 9 : 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <div
      data-keep-round
      className="gauge-ring relative shrink-0 rounded-full ring-1 ring-border ring-inset"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        {/* Dashed track so the empty gauge still reads as "to fill". */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray="4 3"
          className="stroke-muted-foreground/30"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
          style={{
            stroke: reached ? "var(--success)" : "var(--primary)",
            transition: "stroke-dashoffset 300ms ease, stroke 300ms ease",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center leading-none">
        <span className="text-[10px] font-semibold tabular-nums">{Math.round(pct * 100)}%</span>
      </div>
    </div>
  );
}

// Compact steps control for embedding in another card's title (the dashboard
// Workout card's `right` slot): a progress ring + the live count, mirroring
// <HydrationInline> on the Nutrition card.
//
// For *today* it also exposes an inline play/pause toggle that drives the same
// foreground step detector as <WorkoutStepCard>, persisting the running total
// to the server. Past days stay read-only (auto-counting them makes no sense).
export function StepsInline({ dateIso }: { dateIso: string }) {
  const { t } = useTranslation();
  const { todayIso } = useDayContext();
  const queryClient = useQueryClient();
  const stepsQ = useGetSteps({ date: dateIso });
  const detector = useStepDetector();

  const committed = stepsQ.data?.steps ?? 0;
  const goal = stepsQ.data?.goal ?? DEFAULT_STEP_GOAL;

  // While tracking, the live total is the server value captured at start()
  // plus what the detector has counted since (see <WorkoutStepCard>).
  const baseRef = useRef(0);
  const tracking = detector.tracking;
  const steps = tracking ? baseRef.current + detector.steps : committed;

  const displayRef = useRef(steps);
  displayRef.current = steps;

  const [busy, setBusy] = useState(false);

  const flush = useCallback(
    async (final: boolean) => {
      try {
        await postSteps({ date: todayIso, steps: displayRef.current });
        if (final) await queryClient.invalidateQueries();
      } catch {
        // Best-effort save; the full Walking card surfaces sensor/save errors.
      }
    },
    [todayIso, queryClient],
  );

  const handleStart = async () => {
    baseRef.current = committed;
    detector.reset();
    await detector.start();
  };

  const handleStop = async () => {
    detector.stop();
    setBusy(true);
    await flush(true);
    detector.reset();
    setBusy(false);
  };

  // Periodic + lifecycle flush while tracking — mirrors <WorkoutStepCard> so a
  // background/close loses at most one interval of steps.
  useEffect(() => {
    if (!tracking) return;
    const id = window.setInterval(() => void flush(false), FLUSH_INTERVAL_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush(false);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [tracking, flush]);

  const reached = goal > 0 && steps >= goal;
  // Counting only makes sense for today, and only where a motion sensor exists.
  const canToggle = dateIso === todayIso && detector.supported;

  return (
    <div className="flex items-center gap-2">
      <Footprints className="size-4 shrink-0 text-primary" aria-label={t("widgets.steps")} />
      <StepsRing steps={steps} goal={goal} size={44} />
      <div className="flex flex-col items-center gap-1">
        {canToggle && (
          <Button
            // Always primary so the control reads as the card's call-to-action,
            // counting or not.
            size="sm"
            // Fixed width + centered so swapping Start/Pause (different label
            // widths) doesn't resize the button and shove the ring sideways.
            // Pulse while counting so an active walk is obvious at a glance.
            className={cn(
              "h-7 w-18 justify-center gap-1 px-2 text-xs",
              tracking && "animate-pulse",
            )}
            disabled={busy}
            onClick={() => void (tracking ? handleStop() : handleStart())}
            aria-label={tracking ? t("widgets.pauseStepCounting") : t("widgets.startStepCounting")}
          >
            {tracking ? (
              <>
                <Pause className="size-3.5 fill-current" /> {t("widgets.pause")}
              </>
            ) : (
              <>
                <Play className="size-3.5 fill-current" /> {t("widgets.start")}
              </>
            )}
          </Button>
        )}
        <span className="flex items-baseline gap-1 leading-none">
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              reached && "text-emerald-600 dark:text-emerald-400",
            )}
          >
            {steps.toLocaleString()}
          </span>
        </span>
      </div>
    </div>
  );
}

// Read-only steps tile for the Dashboard. Shows whichever day the dashboard is
// viewing; counting + corrections happen on the Workout screen's card.
export function DashboardStepsCard({ dateIso, isToday }: { dateIso: string; isToday: boolean }) {
  const { t } = useTranslation();
  const stepsQ = useGetSteps({ date: dateIso });
  const steps = stepsQ.data?.steps ?? 0;
  const goal = stepsQ.data?.goal ?? DEFAULT_STEP_GOAL;
  const pct = goal > 0 ? Math.round((steps / goal) * 100) : 0;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Footprints className="size-4 text-primary" />
          {t("widgets.steps")}
          <span className="ms-auto text-sm font-normal text-muted-foreground tabular-nums">
            {pct}%{!isToday && ` · ${t("widgets.pastDay")}`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {stepsQ.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <StepProgress steps={steps} goal={goal} />
        )}
      </CardContent>
    </Card>
  );
}

// The interactive Walking card for today. Owns the detector + persistence.
export function WorkoutStepCard() {
  const { t } = useTranslation();
  const { todayIso } = useDayContext();
  const queryClient = useQueryClient();
  const stepsQ = useGetSteps({ date: todayIso });
  const detector = useStepDetector();

  const committed = stepsQ.data?.steps ?? 0;
  const goal = stepsQ.data?.goal ?? DEFAULT_STEP_GOAL;

  // While tracking, the live total is the server value captured at start()
  // plus what the detector has counted since — we deliberately don't refetch
  // mid-walk, so `base` stays put and the absolute write is base+live.
  const baseRef = useRef(0);
  const tracking = detector.tracking;
  const display = tracking ? baseRef.current + detector.steps : committed;

  const displayRef = useRef(display);
  displayRef.current = display;

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const flush = useCallback(
    async (final: boolean) => {
      try {
        await postSteps({ date: todayIso, steps: displayRef.current });
        if (final) await queryClient.invalidateQueries();
      } catch (e) {
        setErr(apiErr(e));
      }
    },
    [todayIso, queryClient],
  );

  const handleStart = async () => {
    setErr(null);
    setEditing(false);
    baseRef.current = committed;
    detector.reset();
    await detector.start();
  };

  const handleStop = async () => {
    detector.stop();
    setSaving(true);
    await flush(true);
    detector.reset();
    setSaving(false);
  };

  // Periodic + lifecycle flush while tracking. Backgrounding the app (screen
  // lock, tab switch) silences the sensor, so we save on hide too.
  useEffect(() => {
    if (!tracking) return;
    const id = window.setInterval(() => void flush(false), FLUSH_INTERVAL_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush(false);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [tracking, flush]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Footprints className="size-4 text-primary" />
          {t("widgets.walking")}
          {tracking && (
            <Badge variant="secondary" className="gap-1">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              {t("widgets.counting")}
            </Badge>
          )}
        </CardTitle>
        {!tracking && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={() => setEditing((v) => !v)}
            aria-label={t("widgets.editSteps")}
          >
            <Pencil className="size-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-3">
          {stepsQ.isPending ? (
            <Skeleton className="h-10 flex-1" />
          ) : (
            <StepProgress steps={display} goal={goal} compact className="min-w-0 flex-1" />
          )}
          {!editing &&
            detector.supported &&
            (tracking ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-8 shrink-0 gap-1 px-2.5"
                onClick={() => void handleStop()}
                disabled={saving}
              >
                <Square className="size-3.5" />
                {saving ? "…" : t("widgets.stop")}
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 shrink-0 gap-1 px-2.5"
                onClick={() => void handleStart()}
              >
                <Play className="size-3.5" />
                {t("widgets.start")}
              </Button>
            ))}
        </div>

        {editing && !tracking && (
          <ManualStepEditor
            initialSteps={committed}
            initialGoal={goal}
            date={todayIso}
            onSaved={async () => {
              setEditing(false);
              await queryClient.invalidateQueries();
            }}
            onCancel={() => setEditing(false)}
          />
        )}

        {!editing && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {!detector.supported
              ? t("widgets.noMotionSensor")
              : detector.permission === "denied"
                ? t("widgets.motionBlocked")
                : tracking
                  ? t("widgets.countingWhileOpen")
                  : t("widgets.countsWhileOpen")}
          </p>
        )}

        {(err || detector.error) && (
          <p className="text-[11px] text-destructive">{err ?? detector.error}</p>
        )}
      </CardContent>
    </Card>
  );
}

// Inline editor for a manual correction: absolute step count + daily goal.
function ManualStepEditor({
  initialSteps,
  initialGoal,
  date,
  onSaved,
  onCancel,
}: {
  initialSteps: number;
  initialGoal: number;
  date: string;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState(String(initialSteps));
  const [goal, setGoal] = useState(String(initialGoal));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const stepsNum = Math.max(0, Math.round(Number(steps) || 0));
    const goalNum = Math.max(0, Math.round(Number(goal) || 0));
    setSaving(true);
    setErr(null);
    try {
      await postSteps(StepsLogRequest.parse({ date, steps: stepsNum, goal: goalNum || null }));
      await onSaved();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t("widgets.stepsLabel")}
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={steps}
            disabled={saving}
            onChange={(e) => setSteps(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t("widgets.dailyGoal")}
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={goal}
            disabled={saving}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
