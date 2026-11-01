// Training-burn estimation + presentation, shared by the Dashboard's day
// Workout card and the Workout page's week/month burn card.
//
// A workout session may carry an explicit `kcal_burned` (entered via the log
// form / agent). When it doesn't, we estimate from the WORK the session did, per
// set: strength sets by load × reps (estimateResistanceKcal) and cardio sets by
// duration × MET (estimateCardioSetKcal) — both in packages/shared/src/training.ts.
// A set counts as cardio when it carries a positive `duration_sec`. Session
// `duration_min` is deliberately NOT used: a strength session's clock time (which
// can be days if left "active") must never inflate the burn.
import { Flame } from "lucide-react";
import { useTranslation } from "react-i18next";

import { estimateCardioSetKcal, estimateResistanceKcal, type WorkoutSession } from "@fa/shared";

import { type BurnMetric, useUiStore } from "./uiStore";
import { cn } from "./utils";

type BurnInput = Pick<WorkoutSession, "kcal_burned" | "sets">;

export type SessionBurn = { kcal: number; estimated: boolean };

// Burn for a single session: the logged `kcal_burned` when present (exact), else
// the summed per-set estimate — resistance sets by load × reps + cardio sets by
// duration × MET. Null when nothing can be estimated (no logged kcal and no
// usable sets); we never fall back to a session-duration guess.
export function sessionBurnKcal(
  session: BurnInput,
  bodyweightKg: number | null,
): SessionBurn | null {
  if (session.kcal_burned != null && Number.isFinite(session.kcal_burned)) {
    return { kcal: session.kcal_burned, estimated: false };
  }
  const sets = session.sets ?? [];
  if (sets.length === 0) return null;

  const isCardioSet = (s: (typeof sets)[number]) => s.duration_sec != null && s.duration_sec > 0;
  let kcal = 0;

  const strengthSets = sets.filter((s) => !isCardioSet(s));
  if (strengthSets.length > 0) {
    kcal += estimateResistanceKcal(
      strengthSets.map((s) => ({ weight_kg: s.weight_kg, reps: s.reps })),
      bodyweightKg,
    ).total_kcal;
  }

  if (bodyweightKg != null && bodyweightKg > 0) {
    for (const s of sets) {
      if (isCardioSet(s))
        kcal += estimateCardioSetKcal(s.exercise_id, s.duration_sec as number, bodyweightKg);
    }
  }

  return kcal > 0 ? { kcal: Math.round(kcal), estimated: true } : null;
}

// Summed burn across a set of sessions (e.g. one day, or a whole range).
// `estimated` is true when any contributing session's figure was estimated
// rather than logged; `count` is how many sessions contributed a number.
export function totalBurnKcal(
  sessions: BurnInput[],
  bodyweightKg: number | null,
): { kcal: number; estimated: boolean; count: number } {
  let kcal = 0;
  let estimated = false;
  let count = 0;
  for (const s of sessions) {
    const b = sessionBurnKcal(s, bodyweightKg);
    if (!b) continue;
    kcal += b.kcal;
    estimated = estimated || b.estimated;
    count += 1;
  }
  return { kcal, estimated, count };
}

// Logged minutes across a set of sessions — the Training burn cards' "time"
// view. Unfinished sessions (duration_min null) don't count yet.
export function totalDurationMin(sessions: Pick<WorkoutSession, "duration_min">[]): number {
  let min = 0;
  for (const s of sessions) min += s.duration_min ?? 0;
  return min;
}

// kcal ↔ time switch for the Training burn range chart. A persisted
// preference, so the choice survives a reload.
export function BurnMetricToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const metric = useUiStore((s) => s.burnMetric);
  const setMetric = useUiStore((s) => s.setBurnMetric);
  return (
    <div
      role="group"
      aria-label={t("workout.burnMetricAria")}
      className={cn(
        "inline-flex shrink-0 rounded-md bg-muted p-0.5 text-[11px] soft:gap-1.5 soft:bg-transparent soft:p-0",
        className,
      )}
    >
      {(["kcal", "duration"] as const satisfies readonly BurnMetric[]).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={metric === m}
          onClick={() => setMetric(m)}
          className={cn(
            "rounded-sm px-2 py-0.5 font-medium transition-[color,box-shadow]",
            metric === m
              ? "bg-background text-foreground shadow-xs soft:text-primary soft:shadow-pressed"
              : "text-muted-foreground hover:text-foreground soft:shadow-control soft:hover:text-primary",
          )}
        >
          {t(m === "kcal" ? "workout.kcal" : "workout.burnMetricTime")}
        </button>
      ))}
    </div>
  );
}

// Self-contained "Training burn" tile: a flame avatar, the kcal headline, and an
// optional sub-line. `estimated` appends a "≈" hint that the figure is a
// MET-based estimate rather than a logged value.
export function TrainingBurnHeadline({
  kcal,
  estimated,
  sub,
  className,
}: {
  kcal: number;
  estimated: boolean;
  sub?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-edge bg-card p-3 shadow-tile",
        className,
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15 ring-inset">
        <Flame className="size-4.5" aria-hidden />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("lib.burn.title")}
          {estimated && (
            <span title={t("lib.burn.estimateHint")} aria-hidden>
              ≈
            </span>
          )}
        </div>
        <div className="text-lg/tight font-bold tabular-nums">
          {Math.round(kcal).toLocaleString()}
          <span className="ms-1 text-xs font-normal text-muted-foreground">kcal</span>
        </div>
        {sub && <div className="text-[11px] leading-snug text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}
