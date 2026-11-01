import {
  Activity,
  Cake,
  ChevronDown,
  Dumbbell,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  Mars,
  Percent,
  Ruler,
  Scale,
  Sparkles,
  Target,
  TrendingUp,
  User,
  Utensils,
  Venus,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useTranslation } from "react-i18next";
import {
  ACTIVITY,
  ageFromBirthYear,
  computeFfmiPotential,
  computeMaxPotential,
  computeTargets,
  GOAL_KCAL_DELTA,
  latestBodyMetrics,
  type Goal,
  type Profile,
  type WorkoutSession,
} from "@fa/shared";
import { GOAL_META, isGoal } from "./lib/goalMeta";
import { useUiStore } from "./lib/uiStore";
import { useGetWorkoutSessions } from "./api/endpoints/default/default";
import { CardHero, PageTitle } from "./lib/pageChrome";
import { StepsInline } from "./StepCounter.tsx";
import { HydrationInline } from "./HydrationCard.tsx";
import { RangeNav } from "./RangeNav.tsx";
import { formatTime24, isoToDisplay } from "./lib/dateFormat";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Skeleton } from "./components/ui/skeleton";
import { useDayContext, useDaySnapshot } from "./lib/dayContext";
import { useMinLoading } from "./lib/useMinLoading";
import { MetricGauge } from "./lib/metricGauge";
import { buildEnergyTiles, EnergyTiles } from "./lib/energyTiles";
import { TrainingBurnHeadline, totalBurnKcal } from "./lib/trainingBurn";
import { cn } from "./lib/utils";
import { compareTime, slotRank } from "./lib/mealSlots";

type Macros = { kcal: number; p: number; f: number; c: number; fiber?: number };
type MealItem = Macros & {
  food: string;
  grams: number;
  source?: string;
  category?: string;
  display_name?: string;
};
type Meal = { slot: string; time?: string; items: MealItem[] };
type Sex = "male" | "female";

export function Dashboard() {
  const { selectedDate, setSelectedDate } = useDayContext();
  // The dashboard is a day-at-a-glance view: only the daily snapshot, with date
  // navigation. Week/month roll-ups live on the per-metric tabs (Body,
  // Nutrition, Workout).
  const nav = (
    <RangeNav
      granularity="day"
      granularities={["day"]}
      anchor={selectedDate}
      onGranularity={() => {}}
      onAnchor={setSelectedDate}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* pb clears the mobile chat dock's collapsed bar that overlays the bottom
          edge; removed on md+ where there's no dock. */}
      <div className="min-h-0 flex-1 overflow-y-auto md:pb-0">
        <div className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-5 sm:py-6">
          <DashboardDay nav={nav} />
        </div>
      </div>
    </div>
  );
}

function useWorkoutRange(from: string, to: string) {
  const q = useGetWorkoutSessions({ from, to });
  return {
    // null while first-loading (no cached data) so callers show a skeleton;
    // background refetches keep the previous array (no flash).
    sessions: q.isPending
      ? null
      : ((q.data?.sessions as unknown as WorkoutSession[] | undefined) ?? []),
    error: q.error ? ((q.error as { error?: string }).error ?? String(q.error)) : null,
  };
}

function sessionVolume(s: WorkoutSession): number {
  return s.sets.reduce((acc, set) => acc + (set.weight_kg ?? 0) * (set.reps ?? 0), 0);
}

function DashboardDay({ nav }: { nav: React.ReactNode }) {
  const { t } = useTranslation();
  const { selectedDateIso } = useDayContext();
  const { data, error: err, loading } = useDaySnapshot(selectedDateIso);
  const showLoader = useMinLoading(loading);
  const profileExpanded = useUiStore((s) => s.dashboardProfileExpanded);
  const setProfileExpanded = useUiStore((s) => s.setDashboardProfileExpanded);

  if (showLoader) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("dashboard.title")} />
        {nav}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("dashboard.title")} />
        {nav}
        <p className="text-sm text-destructive">{err}</p>
      </div>
    );
  }
  if (!data) return null;

  const latestBC = data.bodyComp.length ? data.bodyComp[data.bodyComp.length - 1] : null;
  // Newest entry that carries a body-composition reading. A weight-only
  // weigh-in has no fat-free mass, so reading the potential off `latestBC`
  // would blank the tile until the next body-fat reading.
  // Body fat + FFMI come from the newest entry that measured body fat. When
  // that's older than the newest weigh-in (a weight-only log since), the tiles
  // still show it but say it predates the current weight.
  const compBC =
    latestBC && (latestBC.body_fat_pct ?? latestBC.body_fat_pct_navy) != null
      ? latestBC
      : ([...data.bodyComp]
          .reverse()
          .find((e) => (e.body_fat_pct ?? e.body_fat_pct_navy) != null) ?? null);
  // A dated note under a tile: the date bold, then what it qualifies.
  const datedNote = (iso: string, note: string) => (
    <>
      <span className="font-semibold text-foreground">{isoToDisplay(iso)}</span> · {note}
    </>
  );
  const compStale =
    compBC && compBC !== latestBC
      ? datedNote(compBC.date, t("dashboard.olderThanWeight"))
      : undefined;
  const latestComp = [...data.bodyComp].reverse().find((e) => e.fat_free_mass_kg != null) ?? null;
  const profileSex: Sex | null =
    data.profile?.sex === "male" || data.profile?.sex === "female"
      ? (data.profile.sex as Sex)
      : null;

  // Energy targets, derived client-side from the profile + latest weigh-in
  // (the dashboard wire shape carries the cached target_kcal but not the
  // maintenance/TDEE the breakdown + calorie bar reference). Needs a known
  // current weight; body fat is optional (Katch-McArdle when present, else
  // Mifflin-St Jeor). Null when we can't compute, which hides the whole
  // "Targets & energy" affordance rather than showing partial numbers.
  // Newest weight + the most recent body fat (carried forward over weight-only
  // weigh-ins) — see latestBodyMetrics.
  const metrics = latestBodyMetrics(data.bodyComp);
  const targets =
    data.profile && metrics && data.profile.height_cm
      ? computeTargets(data.profile as unknown as Profile, metrics)
      : null;

  return (
    <div className="space-y-4">
      <PageHeader title={t("dashboard.title")} />
      {nav}

      <Card className="overflow-hidden">
        {data.profile ? (
          <>
            <CardHero
              icon={User}
              title={
                <div className="flex justify-between">
                  <>{t("dashboard.yourProfile")}</>
                  {targets ? (
                    <button
                      type="button"
                      onClick={() => setProfileExpanded(!profileExpanded)}
                      aria-expanded={profileExpanded}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Target className="size-3.5" />
                      {t("dashboard.targets")}
                      <ChevronDown
                        className={cn(
                          "size-3.5 transition-transform",
                          profileExpanded && "rotate-180",
                        )}
                      />
                    </button>
                  ) : undefined}
                </div>
              }
            >
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1 capitalize">
                  {data.profile.sex === "female" ? (
                    <Venus className="size-3.5" />
                  ) : (
                    <Mars className="size-3.5" />
                  )}
                  {data.profile.sex}
                </span>
                {data.profile.birth_year != null && (
                  <span className="inline-flex items-center gap-1">
                    <Cake className="size-3.5" />
                    {t("dashboard.yrs", { age: ageFromBirthYear(data.profile.birth_year) })}
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <Ruler className="size-3.5" />
                  {data.profile.height_cm} cm
                </span>
              </div>
            </CardHero>

            <CardContent className="grid grid-cols-2 gap-2.5 pt-4 sm:pt-5">
              <GoalTile goal={data.profile.goal} activity={data.profile.activity_level} />
              {(() => {
                const height = data.profile.height_cm;
                const wrist = data.profile.wrist_cm;
                const ankle = data.profile.ankle_cm;
                const ffm = latestComp?.fat_free_mass_kg ?? null;
                // Effective body fat of that same reading (entered reading
                // beats the Navy estimate). Used to evaluate the frame ceiling
                // on the same BF basis as the current fat-free mass.
                const bf = latestComp?.body_fat_pct ?? latestComp?.body_fat_pct_navy ?? null;

                // Preferred: a frame-based lean-mass ceiling (Casey Butt) from
                // the wrist + ankle measurements on the profile — a sharper
                // "max lean mass" than the FFMI heuristic. Only render when the
                // user has actually supplied those measurements.
                if (profileSex && height && wrist != null && ankle != null) {
                  const { max_lean_body_mass_kg, max_weight_kg, evaluated_at_body_fat_pct } =
                    computeMaxPotential({
                      sex: profileSex,
                      height_cm: height,
                      wrist_cm: wrist,
                      ankle_cm: ankle,
                      // Evaluate the ceiling at the user's CURRENT body fat so the
                      // gain is a true like-for-like against current fat-free mass
                      // (the Casey-Butt LBM ceiling rises slightly with BF). Fall
                      // back to the formula default (8% / 18%) when BF is unknown
                      // or out of the formula's supported 2–40% band.
                      ...(bf != null && bf >= 2 && bf <= 40 ? { target_body_fat_pct: bf } : {}),
                    });
                  const gain =
                    ffm != null ? Math.round((max_lean_body_mass_kg - ffm) * 10) / 10 : null;
                  // Spell out the BF% the ceiling was evaluated at — the
                  // Casey-Butt LBM ceiling shifts with it, so the number is only
                  // meaningful alongside its basis.
                  const atBf = t("dashboard.atBf", { pct: Math.round(evaluated_at_body_fat_pct) });
                  // Headline the muscle gain. The sub gives both ceilings: the
                  // lean target (which makes the gain reconcile) and the implied
                  // max TOTAL bodyweight — the figure that's directly comparable
                  // to the weight stat above, since users think in bodyweight.
                  return (
                    <ProfileStat
                      center
                      icon={Sparkles}
                      label={t("dashboard.potential")}
                      value={
                        gain == null
                          ? `${max_lean_body_mass_kg.toFixed(1)} kg`
                          : gain > 0
                            ? `+${gain.toFixed(1)} kg`
                            : t("dashboard.atCeiling")
                      }
                      sub={
                        gain == null
                          ? t("dashboard.potentialTotalSub", {
                              total: Math.round(max_weight_kg),
                              atBf,
                              ceiling: max_lean_body_mass_kg.toFixed(1),
                            })
                          : t("dashboard.potentialGainSub", {
                              total: Math.round(max_weight_kg),
                              atBf,
                              from: ffm!.toFixed(1),
                              to: max_lean_body_mass_kg.toFixed(1),
                            })
                      }
                    />
                  );
                }

                // Fallback: headroom to the natural FFMI ceiling (normalized
                // 25 / 21.5) from the latest fat-free mass + height/sex. Needs a
                // body-fat reading (so FFM is known) and a known sex.
                if (ffm == null || !profileSex || !height) return null;
                const { potential_gain_kg } = computeFfmiPotential({
                  sex: profileSex,
                  height_cm: height,
                  fat_free_mass_kg: ffm,
                });
                return (
                  <ProfileStat
                    center
                    icon={TrendingUp}
                    label={t("dashboard.potentialGain")}
                    value={
                      potential_gain_kg > 0
                        ? `+${potential_gain_kg.toFixed(1)} kg`
                        : t("dashboard.atCeiling")
                    }
                    sub={t("dashboard.leanMassToFfmiCap")}
                  />
                );
              })()}
            </CardContent>
            {targets && profileExpanded && (
              <ProfileTargets
                targets={targets}
                goal={data.profile.goal as Goal}
                currentWeightKg={latestBC?.weight_kg ?? null}
                targetWeightKg={data.profile.target_weight_kg ?? null}
              />
            )}
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle>{t("dashboard.profile")}</CardTitle>
            </CardHeader>
            <CardContent>
              <EmptyState icon={UserRound}>{t("dashboard.noProfile")}</EmptyState>
            </CardContent>
          </>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHero
          icon={Utensils}
          title={t("dashboard.nutrition")}
          subtitle={t("dashboard.mealsLogged", { count: data.today.meal_count })}
          right={<HydrationInline dateIso={selectedDateIso} />}
        />
        <CardContent className="pt-4 sm:pt-5">
          {(() => {
            // Primary target is the goal-adjusted target (recomp/cut/etc.); the
            // active diet plan's kcal, when present, rides along as a marker. Fall
            // back to the diet target as primary when the goal can't be computed.
            const goalTarget = targets?.daily_target ?? null;
            const effectiveTarget = goalTarget ?? data.today.target;
            const dietKcal = goalTarget && data.today.target ? data.today.target.kcal : null;
            return (
              <>
                <MacroBars
                  eaten={data.today.eaten}
                  target={effectiveTarget}
                  maintenanceKcal={targets?.tdee ?? null}
                  goal={data.profile?.goal as Goal | undefined}
                  dietKcal={dietKcal}
                />
                {!effectiveTarget && (
                  <p className="mt-2 text-sm text-muted-foreground">{t("dashboard.noTarget")}</p>
                )}
              </>
            );
          })()}
          <div className="mt-4 overflow-x-auto">
            {data.today.meals.length === 0 ? (
              <EmptyState icon={Utensils}>{t("dashboard.nothingLoggedToday")}</EmptyState>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-start text-xs text-muted-foreground">
                    <th className="px-2 py-1.5 font-normal">{t("dashboard.colMeal")}</th>
                    <th className="px-2 py-1.5 font-normal">{t("dashboard.colTime")}</th>
                    <th className="px-2 py-1.5 text-end font-normal">P</th>
                    <th className="px-2 py-1.5 text-end font-normal">F</th>
                    <th className="px-2 py-1.5 text-end font-normal">C</th>
                    <th className="px-2 py-1.5 text-end font-normal">{t("dashboard.colFiber")}</th>
                    <th className="px-2 py-1.5 text-end font-normal">{t("dashboard.colKcal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {groupSlots(data.today.meals).map((g) => (
                    <tr key={g.slot} className="border-b last:border-0">
                      <td className="px-2 py-1.5 font-medium capitalize">{g.slot}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {g.time ? formatTime24(g.time) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{g.total.p.toFixed(0)}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{g.total.f.toFixed(0)}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{g.total.c.toFixed(0)}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums">
                        {g.total.fiber != null ? g.total.fiber.toFixed(1) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-end font-bold tabular-nums">
                        {g.total.kcal.toFixed(0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHero
          icon={HeartPulse}
          title={t("dashboard.bodyComposition")}
          subtitle={latestBC ? t("dashboard.latestWeighIn") : t("dashboard.noEntriesLogged")}
          right={
            latestBC ? (
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {(() => {
                  // The latest entry may predate the viewed day; show how stale
                  // the reading is relative to the day in view.
                  const days = daysBetween(latestBC.date, selectedDateIso);
                  return days > 0 ? t("dashboard.daysAgo", { count: days }) : t("dashboard.today");
                })()}
              </span>
            ) : undefined
          }
        />
        <CardContent className="pt-4 sm:pt-5">
          {latestBC ? (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
              <ProfileStat
                icon={Scale}
                label={t("dashboard.weight")}
                value={latestBC.weight_kg != null ? `${latestBC.weight_kg.toFixed(1)} kg` : "—"}
                // Body fat below is from an older entry: show the weight it was
                // measured at, so the drift since is visible.
                sub={
                  compStale && compBC?.weight_kg != null
                    ? datedNote(
                        compBC.date,
                        t("dashboard.bfMeasuredAt", { weight: compBC.weight_kg.toFixed(1) }),
                      )
                    : undefined
                }
                gauge={
                  <MetricGauge
                    kind="weight"
                    value={latestBC.weight_kg}
                    heightCm={data.profile?.height_cm}
                  />
                }
              />
              {(() => {
                const bf = compBC?.body_fat_pct ?? compBC?.body_fat_pct_navy ?? null;
                const navy = compBC?.body_fat_pct == null && compBC?.body_fat_pct_navy != null;
                // Surface how body fat was measured: the recorded method when
                // present, falling back to "navy" for legacy rows that only
                // carry the Navy estimate.
                const methodLabel = compBC?.body_fat_method
                  ? compBC.body_fat_method
                  : navy
                    ? t("dashboard.methodNavy")
                    : null;
                return (
                  <ProfileStat
                    icon={Percent}
                    label={t("dashboard.bodyFat")}
                    value={bf != null ? `${bf.toFixed(1)}%` : "—"}
                    tag={bf != null && methodLabel ? `(${methodLabel})` : undefined}
                    sub={compStale}
                    gauge={<MetricGauge kind="bodyFat" value={bf} sex={profileSex} />}
                  />
                );
              })()}
              <ProfileStat
                icon={Gauge}
                label={t("dashboard.bmi")}
                value={
                  latestBC.bmi != null
                    ? latestBC.bmi.toFixed(1)
                    : data.profile?.height_cm
                      ? "—"
                      : t("dashboard.setHeight")
                }
                gauge={<MetricGauge kind="bmi" value={latestBC.bmi} />}
              />
              <ProfileStat
                icon={Dumbbell}
                label={t("dashboard.ffmi")}
                value={
                  compBC?.ffmi != null && compBC.ffmi_normalized != null && profileSex
                    ? compBC.ffmi.toFixed(1)
                    : compBC == null
                      ? t("dashboard.needsBodyFat")
                      : !profileSex
                        ? t("dashboard.needsSex")
                        : "—"
                }
                sub={compBC?.ffmi != null ? compStale : undefined}
                gauge={<MetricGauge kind="ffmi" value={compBC?.ffmi_normalized} sex={profileSex} />}
              />
            </div>
          ) : (
            <EmptyState icon={Scale}>{t("dashboard.noBodyCompEntries")}</EmptyState>
          )}
        </CardContent>
      </Card>

      <WorkoutDayCard dateIso={selectedDateIso} bodyweightKg={latestBC?.weight_kg ?? null} />
    </div>
  );
}

function WorkoutDayCard({
  dateIso,
  bodyweightKg,
}: {
  dateIso: string;
  // Latest weigh-in weight, for the MET-based burn estimate when a session has
  // no logged kcal. Null hides the estimate (logged kcal still shows).
  bodyweightKg: number | null;
}) {
  const { t } = useTranslation();
  const { sessions, error } = useWorkoutRange(dateIso, dateIso);
  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("dashboard.workout")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{error}</p>
        </CardContent>
      </Card>
    );
  }
  if (sessions === null) {
    return <Skeleton className="h-32 w-full" />;
  }
  const active = sessions.find((s) => s.duration_min == null) ?? null;
  const finished = sessions.filter((s) => s.duration_min != null);
  const totalSets = sessions.reduce((acc, s) => acc + s.sets.length, 0);
  const totalVolume = sessions.reduce((acc, s) => acc + sessionVolume(s), 0);
  const totalDuration = finished.reduce((acc, s) => acc + (s.duration_min ?? 0), 0);
  const exerciseSet = new Set<string>();
  for (const s of sessions) for (const set of s.sets) exerciseSet.add(set.exercise_id);
  const burn = totalBurnKcal(sessions, bodyweightKg);

  return (
    <Card className="overflow-hidden">
      <CardHero
        icon={Dumbbell}
        title={t("dashboard.workout")}
        subtitle={t("dashboard.trainingsLogged", { count: sessions.length })}
        right={<StepsInline dateIso={dateIso} />}
      />
      <CardContent className="pt-4 sm:pt-5">
        {sessions.length === 0 ? (
          <EmptyState icon={Dumbbell}>{t("dashboard.noWorkoutLogged")}</EmptyState>
        ) : (
          <>
            {/* In the body, not the hero: beside the steps widget the name got squeezed. */}
            <div className="mb-3 flex items-start gap-2">
              {active ? (
                <Badge variant="secondary">{t("dashboard.inProgress")}</Badge>
              ) : (
                <Badge variant="outline" className="border-primary text-primary">
                  {t("dashboard.done")}
                </Badge>
              )}
              {sessions.length === 1 && sessions[0].name && (
                <span className="min-w-0 text-sm font-medium">{sessions[0].name}</span>
              )}
            </div>
            {burn.count > 0 && (
              <TrainingBurnHeadline
                kcal={burn.kcal}
                estimated={burn.estimated}
                sub={burn.estimated ? t("dashboard.estimatedFromDuration") : undefined}
                className="mb-3"
              />
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label={sessions.length === 1 ? t("dashboard.duration") : t("dashboard.totalTime")}
                value={
                  totalDuration > 0
                    ? t("dashboard.min", { count: totalDuration })
                    : active
                      ? t("dashboard.live")
                      : "—"
                }
              />
              <Stat label={t("dashboard.exercises")} value={String(exerciseSet.size)} />
              <Stat label={t("dashboard.sets")} value={String(totalSets)} />
              <Stat
                label={t("dashboard.volume")}
                value={totalVolume > 0 ? `${Math.round(totalVolume).toLocaleString()} kg` : "—"}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PageHeader({ title }: { title: string }) {
  return (
    <PageTitle Icon={LayoutDashboard} help="dashboard">
      {title}
    </PageTitle>
  );
}

function sumItems(items: MealItem[]): Macros {
  let fiberSum = 0;
  let anyFiber = false;
  const core = items.reduce(
    (acc, it) => {
      if (it.fiber != null) {
        fiberSum += it.fiber;
        anyFiber = true;
      }
      return {
        kcal: acc.kcal + it.kcal,
        p: acc.p + it.p,
        f: acc.f + it.f,
        c: acc.c + it.c,
      };
    },
    { kcal: 0, p: 0, f: 0, c: 0 },
  );
  return anyFiber ? { ...core, fiber: fiberSum } : core;
}

type SlotSummary = { slot: string; time?: string; total: Macros };

// Collapse a day's meals into one entry per slot, summing macros within each
// slot so repeated slots (e.g. two "snack"s) render as a single row.
function groupSlots(meals: Meal[]): SlotSummary[] {
  const bySlot = new Map<string, { slot: string; time?: string; items: MealItem[] }>();
  const order: string[] = [];
  for (const m of meals) {
    let g = bySlot.get(m.slot);
    if (!g) {
      g = { slot: m.slot, time: m.time, items: [] };
      bySlot.set(m.slot, g);
      order.push(m.slot);
    }
    g.items.push(...m.items);
    if (m.time && (!g.time || m.time < g.time)) g.time = m.time;
  }
  const groups = order.map((slot) => {
    const g = bySlot.get(slot)!;
    return { slot: g.slot, time: g.time, total: sumItems(g.items) };
  });
  groups.sort(
    (a, b) =>
      slotRank(a.slot) - slotRank(b.slot) ||
      compareTime(a.time, b.time) ||
      a.slot.localeCompare(b.slot),
  );
  return groups;
}

// Whole calendar days from `fromIso` to `toIso` (both YYYY-MM-DD). Negative
// when `toIso` precedes `fromIso`; used to flag how stale a reading is.
function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00`).getTime();
  const b = new Date(`${toIso}T00:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

// The training goal + activity as a standalone tile sitting beside the weight
// stat — centered, with a dashed primary outline so it reads as the user's
// steering target rather than a measured metric.
function GoalTile({ goal, activity }: { goal: string; activity?: string }) {
  const { t } = useTranslation();
  const meta = isGoal(goal) ? GOAL_META[goal] : null;
  const Icon = meta?.Icon ?? Target;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border border-edge bg-card p-3 text-center shadow-tile",
        meta?.chip,
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase",
          meta?.accent ?? "text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {t("dashboard.goal")}
      </div>
      <div className="text-lg/tight font-bold">{meta?.label ?? goal}</div>
      {activity && (
        <div className="inline-flex items-center gap-1 text-[11px] leading-snug text-muted-foreground capitalize">
          <Activity className="size-3" aria-hidden />
          {activity}
        </div>
      )}
    </div>
  );
}

// A profile stat tile: an icon + label chip, a bold value, optional sub line,
// inline tag, and a visual gauge. Exported so the chat's body-composition result
// card renders the same tile as this screen ("one component, two surfaces").
export function ProfileStat({
  icon: Icon,
  label,
  value,
  sub,
  tag,
  gauge,
  center,
  hideLabel,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: React.ReactNode;
  // Muted inline qualifier after the value (e.g. body-fat method "(navy)").
  tag?: string;
  // Optional visual gauge rendered under the value (e.g. a MetricGauge bar).
  gauge?: React.ReactNode;
  // Center-align the tile's contents (dashboard profile row); left-aligned
  // otherwise (body-composition grid).
  center?: boolean;
  // Hide the icon + label row when the metric name is already shown elsewhere
  // (e.g. a focused result card whose header already names the metric).
  hideLabel?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 overflow-hidden rounded-xl border border-edge bg-card p-3 shadow-tile",
        center && "items-center justify-center text-center",
      )}
    >
      {!hideLabel && (
        <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          <Icon className="size-3.5" aria-hidden />
          {label}
        </div>
      )}
      <div className="text-lg/tight font-bold tabular-nums">
        {value}
        {tag && <span className="text-sm font-normal text-muted-foreground"> {tag}</span>}
      </div>
      {gauge}
      {/* Notes read under the gauge, so the gauge stays next to its value. */}
      {sub && <div className="text-[11px] leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tag,
  gauge,
}: {
  label: string;
  value: string;
  // Muted line under the value (e.g. BMI/FFMI category).
  sub?: string;
  // Muted inline qualifier after the value (e.g. body-fat method "(navy)").
  tag?: string;
  // Optional visual gauge rendered under the value (e.g. a MetricGauge bar).
  gauge?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="text-sm font-medium">
        {value}
        {tag && <span className="font-normal text-muted-foreground"> {tag}</span>}
      </div>
      {gauge}
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function MacroBars({
  eaten,
  target,
  // When provided (dashboard only), the kcal row becomes a calorie-budget bar
  // that also plots maintenance (TDEE) so the user sees how their tracked
  // target sits relative to maintenance — a deficit (cut/recomp) or a surplus
  // (lean bulk). Other callers omit it and get the plain target-vs-eaten bar.
  maintenanceKcal = null,
  goal,
  // An active diet plan's daily kcal, shown as a triangle marker on the calorie
  // bar when it differs from the primary (goal-based) target. Kcal only.
  dietKcal = null,
  // The nutrition page shows a calorie ring above the bars, so it drops the
  // redundant kcal row here.
  hideKcal = false,
  // "Projected" mode (chat preview cards): the macro totals the user WOULD be at
  // after a not-yet-logged change. Each bar keeps the committed `eaten` as its
  // solid fill and ghosts the gap up to `projected` (or, when `projected` is
  // lower — an edited-down portion — fills to it and ghosts the dropped part).
  // Omit for the plain bars.
  projected = null,
  // Log previews: append each row's share of the day's target ("· 23%").
  showPct = false,
}: {
  eaten: Macros;
  target: Macros | null;
  maintenanceKcal?: number | null;
  goal?: Goal;
  dietKcal?: number | null;
  hideKcal?: boolean;
  projected?: Macros | null;
  showPct?: boolean;
}) {
  const { t } = useTranslation();
  const rows: Array<{ key: keyof Macros; label: string; unit: string }> = [
    ...(hideKcal
      ? []
      : [{ key: "kcal" as keyof Macros, label: t("dashboard.kcalLabel"), unit: "" }]),
    { key: "p", label: t("dashboard.protein"), unit: "g" },
    { key: "f", label: t("dashboard.fat"), unit: "g" },
    { key: "c", label: t("dashboard.carbs"), unit: "g" },
  ];
  const showFiber = eaten.fiber != null || target?.fiber != null;
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const e = eaten[r.key] as number;
        const t = target?.[r.key] as number | undefined;
        if (r.key === "kcal" && maintenanceKcal != null) {
          return (
            <CalorieBudgetBar
              key={r.key}
              eaten={e}
              target={t ?? null}
              maintenance={maintenanceKcal}
              goal={goal}
              dietKcal={dietKcal}
            />
          );
        }
        const pct = t && t > 0 ? Math.min(100, (e / t) * 100) : 0;
        const over = t != null && e > t;
        const pj = projected ? (projected[r.key] as number | undefined) : undefined;
        const projectedPct = pj != null && t && t > 0 ? Math.min(100, (pj / t) * 100) : undefined;
        return (
          <BarRow
            key={r.key}
            label={r.label}
            unit={r.unit}
            eaten={e}
            target={t}
            pct={pct}
            over={over}
            projected={pj}
            projectedPct={projectedPct}
            showPct={showPct}
          />
        );
      })}
      {showFiber && (
        <BarRow
          label={t("dashboard.fiber")}
          unit="g"
          eaten={eaten.fiber ?? 0}
          target={target?.fiber}
          pct={
            target?.fiber && target.fiber > 0
              ? Math.min(100, ((eaten.fiber ?? 0) / target.fiber) * 100)
              : 0
          }
          over={false}
          projected={projected?.fiber}
          projectedPct={
            projected?.fiber != null && target?.fiber && target.fiber > 0
              ? Math.min(100, (projected.fiber / target.fiber) * 100)
              : undefined
          }
          showPct={showPct}
        />
      )}
    </div>
  );
}

function BarRow({
  label,
  unit,
  eaten,
  target,
  pct,
  over,
  // "Projected" mode: the not-yet-logged total this bar would reach. Rendered as
  // a ghosted extension from the committed `eaten` fill up to `projectedPct`, and
  // the label reads the projected total so the row matches the ring's centre.
  projected,
  projectedPct,
  showPct = false,
}: {
  label: string;
  unit: string;
  eaten: number;
  target?: number;
  pct: number;
  over: boolean;
  projected?: number;
  projectedPct?: number;
  showPct?: boolean;
}) {
  const projecting = projected != null && projectedPct != null && projected > eaten + 0.5;
  // A projection BELOW the committed total (e.g. shrinking a logged portion):
  // the solid fill drops to the projection and the dropped part is ghosted.
  const shrinking = projected != null && projectedPct != null && projected < eaten - 0.5;
  const shown = projecting || shrinking ? (projected as number) : eaten;
  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-2 sm:grid-cols-[88px_1fr]">
      <div className="text-center text-xs text-muted-foreground">{label}</div>
      <div className="relative h-5 overflow-hidden rounded-full border bg-muted">
        {/* ghosted projection sits under the committed fill so the solid eaten
            portion still reads on top of it */}
        {(projecting || shrinking) && (
          <div
            className="absolute inset-y-0 inset-s-0 bg-primary/35 transition-all duration-200"
            style={{ width: `${projecting ? projectedPct : pct}%` }}
          />
        )}
        <div
          className={cn(
            "absolute inset-y-0 inset-s-0 transition-all duration-200",
            (shrinking ? target != null && shown > target : over) ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${shrinking ? projectedPct : pct}%` }}
        />
        <div className="absolute inset-0 flex items-center justify-center text-[11px] font-medium whitespace-nowrap text-white mix-blend-difference">
          <span>
            {shown.toFixed(0)}
            {unit}
          </span>
          {target != null && (
            <span className="opacity-80">
              {" "}
              / {target.toFixed(0)}
              {unit}
            </span>
          )}
          {/* Uncapped share of the target — the bar caps at 100%, the text doesn't. */}
          {showPct && target != null && target > 0 && (
            <span className="ms-1.5 font-normal opacity-80">
              ({Math.round((shown / target) * 100)}%)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// A calorie-budget bar that plots eaten + the tracked target + maintenance
// (TDEE) on one scale, so a deficit (cut/recomp) or surplus (lean bulk) reads
// at a glance. The track scales to whichever of maintenance/target/eaten is
// largest — so a bulk's above-maintenance target still fits — with a little
// headroom. The band between the target and maintenance lines is tinted (green
// for a deficit, amber for a surplus) and each is marked with a labeled line.
function CalorieBudgetBar({
  eaten,
  target,
  maintenance,
  goal,
  dietKcal = null,
}: {
  eaten: number;
  target: number | null;
  maintenance: number;
  goal?: Goal;
  dietKcal?: number | null;
}) {
  const { t } = useTranslation();
  const scaleMax = Math.max(maintenance, target ?? 0, eaten, dietKcal ?? 0, 1) * 1.06;
  const pct = (v: number) => Math.max(0, Math.min(100, (v / scaleMax) * 100));

  const surplus = target != null && target > maintenance;
  // Eating past the target only reads as "over" for deficit-style goals where
  // the target is a ceiling; for a lean bulk the target is a floor to reach, so
  // exceeding it isn't penalized in red.
  const overTarget = target != null && eaten > target && goal !== "lean_bulk";

  const bandLeft = target != null ? Math.min(pct(target), pct(maintenance)) : 0;
  const bandRight = target != null ? Math.max(pct(target), pct(maintenance)) : 0;

  const delta = target != null ? target - maintenance : 0;
  const deltaLabel =
    target == null || Math.abs(delta) < 1
      ? null
      : t("dashboard.deltaPerDay", {
          delta: `${delta > 0 ? "+" : "−"}${Math.abs(Math.round(delta))}`,
          kind: delta > 0 ? t("dashboard.surplus") : t("dashboard.deficit"),
        });

  return (
    <div className="grid grid-cols-[64px_1fr] items-center gap-2 sm:grid-cols-[88px_1fr]">
      <div className="text-center text-xs text-muted-foreground">{t("dashboard.kcalLabel")}</div>
      <div dir="ltr" className="space-y-1">
        {/* active diet plan's kcal — a triangle pointing down at the bar (the
            bar itself clips its overflow, so the marker rides above it) */}
        {dietKcal != null && (
          <div className="relative h-1.5">
            <div className="absolute top-0 -translate-x-1/2" style={{ left: `${pct(dietKcal)}%` }}>
              <div className="size-0 border-x-4 border-t-[6px] border-x-transparent border-t-sky-500" />
            </div>
          </div>
        )}
        <div className="relative h-6 overflow-hidden rounded-full border bg-muted">
          {/* deficit / surplus band between the target and maintenance lines */}
          {target != null && (
            <div
              className={cn("absolute inset-y-0", surplus ? "bg-warning/25" : "bg-success/20")}
              style={{
                left: `${bandLeft}%`,
                width: `${bandRight - bandLeft}%`,
              }}
            />
          )}
          {/* eaten fill, capped at the target when that's a ceiling */}
          <div
            className="absolute inset-y-0 inset-s-0 bg-primary transition-all duration-200"
            style={{
              width: `${pct(overTarget && target != null ? target : eaten)}%`,
            }}
          />
          {/* overflow past a deficit target, in destructive */}
          {overTarget && target != null && (
            <div
              className="absolute inset-y-0 bg-destructive transition-all duration-200"
              style={{
                left: `${pct(target)}%`,
                width: `${pct(eaten) - pct(target)}%`,
              }}
            />
          )}
          {/* maintenance reference line */}
          <div
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/70"
            style={{ left: `${pct(maintenance)}%` }}
          />
          {/* target reference line */}
          {target != null && (
            <div
              className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary"
              style={{ left: `${pct(target)}%` }}
            />
          )}
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-medium whitespace-nowrap text-white mix-blend-difference">
            <span>{Math.round(eaten)}</span>
            {target != null && <span className="opacity-80"> / {Math.round(target)}</span>}
          </div>
        </div>
        {/* legend: colored markers carry the numbers + the deficit/surplus gap */}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          {target != null && (
            <LegendItem
              className="bg-primary"
              label={t("dashboard.target", { value: Math.round(target) })}
            />
          )}
          <LegendItem
            className="bg-foreground/70"
            label={t("dashboard.maintenance", { value: Math.round(maintenance) })}
          />
          {dietKcal != null && (
            <span className="inline-flex items-center gap-1">
              <span className="size-0 border-x-[3px] border-t-[5px] border-x-transparent border-t-sky-500" />
              {t("dashboard.diet", { value: Math.round(dietKcal) })}
            </span>
          )}
          {deltaLabel && (
            <span className={cn("font-semibold", surplus ? "text-warning" : "text-success")}>
              {deltaLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("size-2 shrink-0 rounded-sm", className)} />
      {label}
    </span>
  );
}

// Radial form of the calorie-budget scale: a 270° gauge that maps 0→scaleMax
// onto the arc, with the eaten fill, a tinted band between target and
// maintenance (green deficit / amber surplus), and a tick marking each. Same
// semantics as CalorieBudgetBar, just rounded — used as the left tile of the
// nutrition day card.
export function CalorieRing({
  eaten,
  target,
  maintenance,
  goal,
  dietKcal = null,
  projected = null,
}: {
  eaten: number;
  target: number | null;
  maintenance: number | null;
  goal?: Goal;
  // An active diet plan's daily kcal, marked with a triangle on the arc when it
  // differs from the primary (goal-based) target.
  dietKcal?: number | null;
  // "Projected" mode (chat preview cards): the kcal the user WOULD be at after a
  // not-yet-logged change — e.g. a meal they're about to eat. The committed
  // `eaten` still renders as the solid fill; the gap up to `projected` draws as a
  // ghosted segment, and the centre reads the projected total. Omit (null) for
  // the plain current-state ring the dashboard shows.
  projected?: number | null;
}) {
  const { t } = useTranslation();
  const size = 168;
  const stroke = 13;
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - stroke) / 2 - 3;
  const START = 225; // bottom-left; +270° clockwise ends bottom-right
  const SWEEP = 270;

  const scaleMax =
    Math.max(maintenance ?? 0, target ?? 0, eaten, dietKcal ?? 0, projected ?? 0, 1) * 1.06;
  const frac = (v: number) => Math.max(0, Math.min(1, v / scaleMax));

  const polar = (deg: number, radius: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as const;
  };
  const arcPath = (f0: number, f1: number) => {
    const a0 = START + f0 * SWEEP;
    const a1 = START + f1 * SWEEP;
    const [x0, y0] = polar(a0, r);
    const [x1, y1] = polar(a1, r);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };

  const surplus = target != null && maintenance != null && target > maintenance;
  const overTarget = target != null && eaten > target && goal !== "lean_bulk";
  const eatenFrac = frac(eaten);
  const targetFrac = target != null ? frac(target) : null;
  const maintFrac = maintenance != null ? frac(maintenance) : null;
  const fillEnd = overTarget && targetFrac != null ? targetFrac : eatenFrac;

  // Projected overlay (chat preview): the ghosted arc from the committed `eaten`
  // up to the not-yet-logged `projected` total. Split at the target so the part
  // that would push past a ceiling ghosts in destructive, matching the committed
  // fill's over-target colouring. `shown` is the number the centre/remaining read
  // — the projected total when projecting, else the plain committed eaten.
  const projecting = projected != null && projected > eaten + 0.5;
  const projFrac = projecting ? frac(projected as number) : null;
  const projOverTarget =
    projecting &&
    targetFrac != null &&
    (projected as number) > (target as number) &&
    goal !== "lean_bulk";
  const ghostSplit = projOverTarget && targetFrac != null ? Math.max(eatenFrac, targetFrac) : null;
  const shown = projecting ? (projected as number) : eaten;

  const bandLo = targetFrac != null && maintFrac != null ? Math.min(targetFrac, maintFrac) : null;
  const bandHi = targetFrac != null && maintFrac != null ? Math.max(targetFrac, maintFrac) : null;

  const remaining = target != null ? target - shown : null;
  const delta = target != null && maintenance != null ? target - maintenance : null;
  const deltaLabel =
    delta == null || Math.abs(delta) < 1
      ? null
      : `${delta > 0 ? "+" : "−"}${Math.abs(Math.round(delta))} ${
          delta > 0 ? t("dashboard.surplus") : t("dashboard.deficit")
        }`;

  // A tick crossing the ring stroke at fraction f.
  const tick = (f: number) => {
    const a = START + f * SWEEP;
    const [x1, y1] = polar(a, r - stroke / 2 - 2);
    const [x2, y2] = polar(a, r + stroke / 2 + 2);
    return { x1, y1, x2, y2 };
  };
  const maintTick = maintFrac != null ? tick(maintFrac) : null;
  const targetTick = targetFrac != null ? tick(targetFrac) : null;

  // A small triangle sitting just outside the stroke, apex pointing in at the
  // arc — marks the active diet plan's kcal.
  const dietFrac = dietKcal != null ? frac(dietKcal) : null;
  const dietMarker = (() => {
    if (dietFrac == null) return null;
    const a = START + dietFrac * SWEEP;
    const apex = polar(a, r + stroke / 2 + 1);
    const baseR = r + stroke / 2 + 8;
    const b1 = polar(a - 4, baseR);
    const b2 = polar(a + 4, baseR);
    return `${apex[0]},${apex[1]} ${b1[0]},${b1[1]} ${b2[0]},${b2[1]}`;
  })();

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="overflow-visible"
        >
          {/* outline under the track — invisible unless a theme strokes it */}
          <path
            d={arcPath(0, 1)}
            fill="none"
            strokeWidth={stroke + 4}
            strokeLinecap="round"
            className="gauge-arc-outline stroke-transparent"
          />
          {/* track */}
          <path
            d={arcPath(0, 1)}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            className="stroke-muted"
          />
          {/* deficit / surplus band between target and maintenance */}
          {bandLo != null && bandHi != null && bandHi - bandLo > 0.001 && (
            <path
              d={arcPath(bandLo, bandHi)}
              fill="none"
              strokeWidth={stroke}
              className={surplus ? "stroke-warning/40" : "stroke-success/35"}
            />
          )}
          {/* eaten fill, capped at the target when it's a ceiling */}
          {fillEnd > 0.001 && (
            <path
              d={arcPath(0, fillEnd)}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              className="stroke-primary"
            />
          )}
          {/* overflow past a deficit target */}
          {overTarget && targetFrac != null && eatenFrac > targetFrac && (
            <path
              d={arcPath(targetFrac, eatenFrac)}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              className="stroke-destructive"
            />
          )}
          {/* projected (not-yet-logged) addition, ghosted; the part that would
              cross a ceiling ghosts in destructive to match the committed fill */}
          {projFrac != null && projFrac > eatenFrac + 0.001 && (
            <>
              <path
                d={arcPath(eatenFrac, ghostSplit ?? projFrac)}
                fill="none"
                strokeWidth={stroke}
                strokeLinecap="round"
                className="stroke-primary/35"
              />
              {ghostSplit != null && projFrac > ghostSplit + 0.001 && (
                <path
                  d={arcPath(ghostSplit, projFrac)}
                  fill="none"
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  className="stroke-destructive/40"
                />
              )}
            </>
          )}
          {/* maintenance + target ticks */}
          {maintTick && (
            <line
              {...maintTick}
              strokeWidth={2.5}
              strokeLinecap="round"
              className="stroke-foreground/70"
            />
          )}
          {targetTick && (
            <line
              {...targetTick}
              strokeWidth={2.5}
              strokeLinecap="round"
              className="stroke-primary"
            />
          )}
          {/* active diet plan marker */}
          {dietMarker && <polygon points={dietMarker} className="fill-sky-500" />}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-2xl leading-none font-bold tabular-nums">{Math.round(shown)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {target != null
              ? t("dashboard.kcalOf", { value: Math.round(target) })
              : t("dashboard.kcalLabel")}
          </div>
          {projecting && (
            <div className="mt-0.5 text-[11px] font-semibold text-primary tabular-nums">
              {t("dashboard.thisMeal", { value: Math.round(shown - eaten) })}
            </div>
          )}
          {remaining != null && (
            <div
              className={cn(
                "mt-1 text-xs font-semibold",
                remaining < 0 ? "text-destructive" : "text-success",
              )}
            >
              {remaining < 0
                ? t("dashboard.over", { value: Math.round(-remaining) })
                : t("dashboard.left", { value: Math.round(remaining) })}
            </div>
          )}
        </div>
      </div>
      {/* maintenance reference + active diet marker + deficit/surplus gap */}
      {(maintenance != null || dietKcal != null) && (
        <div className="-mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {maintenance != null && (
            <span className="inline-flex items-center gap-1">
              <span className="size-2 shrink-0 rounded-sm bg-foreground/70" />
              {t("dashboard.maint", { value: Math.round(maintenance) })}
            </span>
          )}
          {dietKcal != null && (
            <span className="inline-flex items-center gap-1">
              <span className="size-0 border-x-[3px] border-t-[5px] border-x-transparent border-t-sky-500" />
              {t("dashboard.diet", { value: Math.round(dietKcal) })}
            </span>
          )}
          {deltaLabel && (
            <span className={cn("font-semibold", surplus ? "text-warning" : "text-success")}>
              {deltaLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Expanded "Targets & energy" detail under the profile card: the full target
// breakdown (maintenance, goal-adjusted target + delta, macro targets), the
// BMR + activity math that builds those numbers, and a rough weight trajectory
// at the current daily delta.
function ProfileTargets({
  targets,
  goal,
  currentWeightKg,
  targetWeightKg,
}: {
  targets: ReturnType<typeof computeTargets>;
  goal: Goal;
  currentWeightKg: number | null;
  targetWeightKg: number | null;
}) {
  const { t } = useTranslation();
  const { tdee, daily_target, bmr_used, bmr_katch_mcardle, inputs } = targets;
  const deltaPct = Math.round(GOAL_KCAL_DELTA[goal] * 100);
  const bmrMethod = bmr_katch_mcardle != null ? t("dashboard.bmrKatch") : t("dashboard.bmrMifflin");
  const activityMult = ACTIVITY[inputs.activity_level];

  // Rough trajectory: ~7700 kcal ≈ 1 kg of body mass. Only meaningful when the
  // daily delta actually moves toward the target weight (a deficit while
  // needing to lose, or a surplus while needing to gain).
  const weeklyKg = ((daily_target.kcal - tdee) * 7) / 7700;
  const gapKg =
    currentWeightKg != null && targetWeightKg != null
      ? currentWeightKg - targetWeightKg // >0 need to lose, <0 need to gain
      : null;
  let trajectory: string | null = null;
  if (gapKg != null && Math.abs(gapKg) >= 0.1 && Math.abs(weeklyKg) > 0.001) {
    const movingToward = (gapKg > 0 && weeklyKg < 0) || (gapKg < 0 && weeklyKg > 0);
    if (movingToward) {
      const weeks = Math.round(Math.abs(gapKg) / Math.abs(weeklyKg));
      trajectory = t("dashboard.trajectoryEstimate", {
        weeks: t("dashboard.weeks", { count: weeks }),
        rate: `${weeklyKg > 0 ? "+" : "−"}${Math.abs(weeklyKg).toFixed(2)}`,
      });
    } else {
      trajectory = t("dashboard.goalDirectionMismatch");
    }
  }

  // The energy tiles read low→high (BMR floor, then maintenance + target sorted
  // by value) and highlight the goal-adjusted target the user steers toward —
  // built by the shared helper so the dashboard and the chat result cards stay
  // in lockstep, including the maintaining case where the target equals
  // maintenance and both tiles get highlighted.
  const orderedCards = buildEnergyTiles({
    bmr: bmr_used,
    tdee,
    targetKcal: daily_target.kcal,
    // Goal's own icon (shared GOAL_META) so the daily target reads with the
    // same glyph as the GoalTile + the chat result cards.
    targetIcon: GOAL_META[goal].Icon,
    bmrSub: bmrMethod,
    maintenanceSub: t("dashboard.maintenanceSub", {
      mult: activityMult,
      activity: inputs.activity_level,
    }),
    targetSub: t("dashboard.targetSub", {
      pct: `${deltaPct >= 0 ? "+" : "−"}${Math.abs(deltaPct)}`,
    }),
  });

  return (
    <div className="space-y-3 border-t bg-muted/30 p-4 sm:px-5">
      <EnergyTiles tiles={orderedCards} />
      <div className="space-y-1 text-xs text-muted-foreground">
        <div className="text-[10px] font-semibold tracking-wide uppercase">
          {t("dashboard.targetMacros")}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            {t("dashboard.protein")}{" "}
            <b className="font-semibold text-foreground">{daily_target.p} g</b>
          </span>
          <span>
            {t("dashboard.fat")} <b className="font-semibold text-foreground">{daily_target.f} g</b>
          </span>
          <span>
            {t("dashboard.carbs")}{" "}
            <b className="font-semibold text-foreground">{daily_target.c} g</b>
          </span>
          {daily_target.fiber != null && (
            <span>
              {t("dashboard.fiber")}{" "}
              <b className="font-semibold text-foreground">{daily_target.fiber} g</b>
            </span>
          )}
        </div>
      </div>
      {(targetWeightKg != null || trajectory) && (
        <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
          <div className="text-[10px] font-semibold tracking-wide uppercase">
            {t("dashboard.trajectory")}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {targetWeightKg != null && (
              <span>
                {t("dashboard.targetWeight")}{" "}
                <b className="font-semibold text-foreground">{targetWeightKg.toFixed(1)} kg</b>
              </span>
            )}
            {gapKg != null && Math.abs(gapKg) >= 0.1 && (
              <span>
                {t("dashboard.kgToGo", {
                  kg: `${gapKg > 0 ? "−" : "+"}${Math.abs(gapKg).toFixed(1)}`,
                })}
              </span>
            )}
            {trajectory && <span>{trajectory}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export { CardDescription };
