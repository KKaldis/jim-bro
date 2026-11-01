/**
 * Daily hydration tracker. Backed by the server `/water` aggregate (one
 * absolute ml total per day, keyed by date) — the same row the chat agent
 * reads/writes via log_water, so chat and UI stay in sync. The client owns the
 * running total: quick-adds read the current value and POST the new absolute
 * amount, mirroring the steps card.
 *
 *   - <HydrationCard>   — full card (ring + quick-adds + manual edit),
 *                          used on the Nutrition (Food) day view under Macros.
 *   - <HydrationInline> — ring + the two quick-adds, embedded in the dashboard
 *                          Nutrition card's title (no undo/edit).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Droplets, GlassWater, Milk, Pencil } from "lucide-react";
import {
  patchMeProfile,
  postWater,
  useGetMeProfile,
  useGetWater,
} from "./api/endpoints/default/default";
import { WaterLogRequest } from "@fa/shared/schemas";
import { apiErr } from "./lib/apiErr";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import { cn } from "./lib/utils";

// Quick-add sizes. ml chosen to match common vessels; tweak freely. Exported
// so the agent's log_water gate form can reuse the same quick-add chips.
export const GLASS_ML = 250;
export const BOTTLE_ML = 500;

// Default daily goal when the user hasn't set one. Mirrors the agent's
// DEFAULT_WATER_GOAL_ML so chat and UI agree on "% of goal".
export const DEFAULT_GOAL_ML = 2500;

export function formatLiters(ml: number): string {
  return `${(ml / 1000).toFixed(2).replace(/\.?0+$/, "")}L`;
}

// Compact SVG progress ring. Fills with the primary color, flipping to the
// success color once the goal is reached. A dashed track keeps the empty
// gauge legible, and an outline ring makes the circle read at any size.
// Exported so the agent's log_water gate form can show the same gauge.
export function WaterRing({
  ml,
  goalMl,
  size = 96,
}: {
  ml: number;
  goalMl: number;
  size?: number;
}) {
  const pct = goalMl > 0 ? Math.min(1, ml / goalMl) : 0;
  const reached = ml >= goalMl && goalMl > 0;
  const stroke = size >= 80 ? 9 : 6;
  const small = size < 80;
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
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        {!small && (
          <span className="mb-0.5 text-[10px] text-muted-foreground tabular-nums">
            {Math.round(pct * 100)}%
          </span>
        )}
        <span className={cn("font-semibold tabular-nums", small ? "text-[10px]" : "text-base")}>
          {formatLiters(ml)}
        </span>
        {!small && (
          <span className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
            of {formatLiters(goalMl)}
          </span>
        )}
      </div>
    </div>
  );
}

// Shared persistence: read the day's total + goal, and write an absolute ml
// (optionally a new goal). Writes serialize through a `saving` flag and a ref
// holding the latest intended total, so rapid quick-add taps don't race on a
// stale read.
//
// The daily goal is a PERSISTENT profile setting (single source of truth) that
// applies to every day — so it's read from the profile, and editing it PATCHes
// the profile rather than this day's row. Unset = DEFAULT_GOAL_ML.
function useWater(dateIso: string) {
  const queryClient = useQueryClient();
  const q = useGetWater({ date: dateIso });
  const profileQ = useGetMeProfile();
  const ml = q.data?.ml ?? 0;
  const goalMl = profileQ.data?.profile?.water_goal_ml ?? DEFAULT_GOAL_ML;
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Latest intended total — lets consecutive taps stack before the refetch.
  const pendingRef = useRef<number | null>(null);
  useEffect(() => {
    pendingRef.current = null;
  }, [dateIso, ml]);

  const save = async (nextMl: number, goal?: number | null) => {
    pendingRef.current = Math.max(0, Math.round(nextMl));
    setSaving(true);
    setErr(null);
    try {
      await postWater(WaterLogRequest.parse({ date: dateIso, ml: pendingRef.current }));
      // A goal edit updates the persistent profile target (applies every day),
      // not just this date. undefined = intake-only write, leave the goal alone.
      if (goal !== undefined) {
        await patchMeProfile({ water_goal_ml: goal });
      }
      await queryClient.invalidateQueries();
    } catch (e) {
      setErr(apiErr(e));
    } finally {
      setSaving(false);
    }
  };

  const add = (delta: number) => save((pendingRef.current ?? ml) + delta);

  return { ml, goalMl, saving, err, loading: q.isPending || profileQ.isPending, add, save };
}

// Inline hydration control for embedding in another card's title (the
// dashboard Nutrition card's `right` slot): a small ring + the two quick-adds.
export function HydrationInline({ dateIso }: { dateIso: string }) {
  const { t } = useTranslation();
  const { ml, goalMl, saving, add } = useWater(dateIso);
  return (
    <div className="flex items-center gap-2">
      <Droplets className="size-4 shrink-0 text-primary" aria-label={t("widgets.hydration")} />
      <WaterRing ml={ml} goalMl={goalMl} size={44} />
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={saving}
          onClick={() => void add(GLASS_ML)}
          aria-label={t("widgets.addWater", { ml: GLASS_ML })}
        >
          <GlassWater className="size-3.5" /> +{GLASS_ML}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={saving}
          onClick={() => void add(BOTTLE_ML)}
          aria-label={t("widgets.addWater", { ml: BOTTLE_ML })}
        >
          <Milk className="size-3.5" /> +{BOTTLE_ML}
        </Button>
      </div>
    </div>
  );
}

export function HydrationCard({
  dateIso,
  dayContext,
  hideEdit,
}: {
  dateIso: string;
  // Muted "Today" / date tag shown on the right of the header — passed by the
  // chat result card so it carries the same day context as the macros / meal
  // preview cards (a ReactNode there: a button that navigates to a past day).
  // Omitted on the Nutrition day view (the day is already shown).
  dayContext?: React.ReactNode;
  // Drop the manual-edit pencil — the chat result card is a read-style summary
  // (the quick-adds still write); the Nutrition day view keeps the editor.
  hideEdit?: boolean;
}) {
  return (
    <Card>
      <HydrationSection dateIso={dateIso} dayContext={dayContext} hideEdit={hideEdit} />
    </Card>
  );
}

// Hydration header + body without a Card wrapper, so it can be embedded as one
// column of a shared card (e.g. beside the day outline on the Nutrition day
// view) as well as inside its own <HydrationCard>.
export function HydrationSection({
  dateIso,
  dayContext,
  hideEdit,
}: {
  dateIso: string;
  dayContext?: React.ReactNode;
  hideEdit?: boolean;
}) {
  const { t } = useTranslation();
  const { ml, goalMl, saving, err, loading, add, save } = useWater(dateIso);
  const [editing, setEditing] = useState(false);

  return (
    <>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Droplets className="size-4 text-primary" />
          {t("widgets.hydration")}
          {dayContext && (
            <span className="ms-auto text-xs font-normal text-muted-foreground">{dayContext}</span>
          )}
          {!hideEdit && (
            <Button
              variant="ghost"
              size="icon"
              className={cn("size-7 text-muted-foreground", !dayContext && "ms-auto")}
              onClick={() => setEditing((v) => !v)}
              aria-label={t("widgets.editWaterIntake")}
            >
              <Pencil className="size-4" />
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : editing ? (
          <ManualWaterEditor
            initialMl={ml}
            initialGoal={goalMl}
            saving={saving}
            onSave={(nextMl, goal) => {
              void save(nextMl, goal);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <div className="@container">
              <div className="flex flex-col items-center justify-center gap-4">
                <WaterRing ml={ml} goalMl={goalMl} size={120} />
                <div className="flex w-full min-w-0 flex-col gap-2 @xs:w-auto">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      className="gap-1 px-1 text-xs @xs:gap-1.5 @xs:px-3 @xs:text-sm"
                      disabled={saving}
                      onClick={() => void add(GLASS_ML)}
                    >
                      <GlassWater className="size-4 shrink-0" /> +{GLASS_ML}
                      <span className="hidden @xs:inline">&nbsp;ml</span>
                    </Button>
                    <Button
                      variant="outline"
                      className="gap-1 px-1 text-xs @xs:gap-1.5 @xs:px-3 @xs:text-sm"
                      disabled={saving}
                      onClick={() => void add(BOTTLE_ML)}
                    >
                      <Milk className="size-4 shrink-0" /> +{BOTTLE_ML}
                      <span className="hidden @xs:inline">&nbsp;ml</span>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
            {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
          </>
        )}
      </CardContent>
    </>
  );
}

// Inline editor for a manual correction: absolute amount (ml) + daily goal (ml).
function ManualWaterEditor({
  initialMl,
  initialGoal,
  saving,
  onSave,
  onCancel,
}: {
  initialMl: number;
  initialGoal: number;
  saving: boolean;
  // goal: number|null writes the persistent target; undefined = leave it alone.
  onSave: (ml: number, goal?: number | null) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [ml, setMl] = useState(String(initialMl));
  const [goal, setGoal] = useState(String(initialGoal));

  const submit = () => {
    const mlNum = Math.max(0, Math.round(Number(ml) || 0));
    const goalNum = Math.max(0, Math.round(Number(goal) || 0));
    const nextGoal = goalNum || null;
    // The goal is a persistent profile setting, so only write it when it truly
    // changed — an intake-only correction shouldn't lock in the current (maybe
    // default) goal as an explicit value.
    const goalChanged = nextGoal !== (initialGoal || null);
    onSave(mlNum, goalChanged ? nextGoal : undefined);
  };

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t("widgets.intakeMl")}
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={ml}
            disabled={saving}
            onChange={(e) => setMl(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t("widgets.dailyGoalMl")}
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
