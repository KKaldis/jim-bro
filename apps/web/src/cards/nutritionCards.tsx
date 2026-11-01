// Result cards for nutrition tools: day overview, targets, meals, foods and products.
import { EmptyState } from "@/components/EmptyState";
import { computeTargets, type Goal, GOAL_KCAL_DELTA, type Macros, type Profile } from "@fa/shared";
import { ChevronDown, Flame, PackageCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CalorieRing, MacroBars } from "../Dashboard";
import { HydrationCard } from "../HydrationCard";
import { Collapsible } from "../components/ui/collapsible";
import i18n from "../i18n";
import { humanize } from "../lib/catalogLabels";
import { buildEnergyTiles, type EnergyTile, EnergyTiles } from "../lib/energyTiles";
import { GOAL_META, GoalBadge, isGoal } from "../lib/goalMeta";
import { cn } from "../lib/utils";
import {
  BigStat,
  CardShell,
  dayTag,
  isObj,
  LB_PER_KG,
  ListRow,
  massLabel,
  num,
  str,
} from "./primitives";
import type { ResultCardProps } from "./resultCards";

// Coerce a wire value into a Macros object, or null if there's no kcal to show.
function macros(v: unknown): Macros | null {
  if (!isObj(v)) return null;
  const kcal = num(v.kcal);
  if (kcal == null) return null;
  return {
    kcal,
    p: num(v.p) ?? 0,
    f: num(v.f) ?? 0,
    c: num(v.c) ?? 0,
    ...(num(v.fiber) != null ? { fiber: num(v.fiber) as number } : {}),
  };
}

// Derive the day's maintenance (TDEE) the same way the dashboard / Nutrition
// page do — client-side from the profile summary + latest weigh-in carried on
// the result. Lets the calorie ring draw its maintenance reference + deficit/
// surplus band instead of a bare target-vs-eaten arc. Null until there's enough
// info (profile fields + a weight), matching useDayEnergy.
function maintenanceFor(data: Record<string, unknown>): number | null {
  const p = isObj(data.profile_summary) ? data.profile_summary : null;
  const bc = isObj(data.last_body_comp) ? data.last_body_comp : null;
  const weight = bc ? num(bc.weight_kg) : null;
  if (!p || weight == null) return null;
  if (
    !str(p.sex) ||
    num(p.birth_year) == null ||
    num(p.height_cm) == null ||
    !str(p.activity_level) ||
    !str(p.goal)
  )
    return null;
  try {
    const { tdee } = computeTargets(p as unknown as Profile, {
      weight_kg: weight,
      body_fat_pct: num(bc!.body_fat_pct) ?? num(bc!.body_fat_pct_navy),
    });
    return tdee;
  } catch {
    return null;
  }
}

// Read inputs.goal off a compute_bmr / compute_targets result, validated
// against the shared goal chrome (GoalBadge renders it).
function readGoal(data: Record<string, unknown>): Goal | null {
  const g = isObj(data.inputs) ? data.inputs.goal : undefined;
  return isGoal(g) ? g : null;
}
// The deficit/surplus the goal applies on top of TDEE, e.g. "−20% vs TDEE".
function goalDeltaSub(goal: Goal): string {
  const d = GOAL_KCAL_DELTA[goal];
  if (d === 0) return i18n.t("cards.energy.atTdee");
  return i18n.t("cards.energy.vsTdee", {
    sign: d > 0 ? "+" : "−",
    pct: Math.abs(Math.round(d * 100)),
  });
}

// A compact target-macro breakdown (protein / fat / carbs grams + kcal) for the
// cards that show a *prescription* rather than eaten-vs-target progress.
function MacroSplit({ m }: { m: Macros }) {
  const { t } = useTranslation();
  const rows: Array<{ label: string; value: string }> = [
    { label: t("cards.macros.protein"), value: `${m.p.toFixed(0)} g` },
    { label: t("cards.macros.fat"), value: `${m.f.toFixed(0)} g` },
    { label: t("cards.macros.carbs"), value: `${m.c.toFixed(0)} g` },
    ...(m.fiber != null
      ? [{ label: t("cards.macros.fiber"), value: `${m.fiber.toFixed(0)} g` }]
      : []),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {rows.map((r) => (
        <span key={r.label} className="rounded-md border bg-muted/50 px-2 py-1 text-xs">
          <span className="text-muted-foreground">{r.label} </span>
          <span className="font-medium">{r.value}</span>
        </span>
      ))}
    </div>
  );
}

// ---------- get_todays_macros ----------
export function DayOverviewCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || data.profile_missing) return null;
  const eaten = macros(data.eaten_today);
  if (!eaten) return null;
  // Primary target is the goal-based recommendation (recomp/cut/etc.); the
  // active diet plan's target rides along as a triangle marker on the ring.
  // Mirrors the dashboard / Nutrition page; falls back to the diet target as
  // primary when there's no recommendation (no weigh-in) so a plan still shows.
  const dietTarget = macros(data.target_today);
  const goalTarget = macros(data.recommended_target);
  const target = goalTarget ?? dietTarget;
  const dietKcal = goalTarget && dietTarget ? dietTarget.kcal : null;
  const maintenance = maintenanceFor(data);
  const goal =
    isObj(data.profile_summary) && str(data.profile_summary.goal)
      ? (str(data.profile_summary.goal) as Goal)
      : undefined;

  return (
    <CardShell
      category={category}
      title={t("cards.day.macros")}
      subtitle={dayTag(data, "nutrition")}
    >
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
        <div className="shrink-0">
          <CalorieRing
            eaten={eaten.kcal}
            target={target?.kcal ?? null}
            maintenance={maintenance}
            dietKcal={dietKcal}
            goal={goal}
          />
        </div>
        <div className="w-full min-w-0 flex-1">
          <MacroBars eaten={eaten} target={target} goal={goal} hideKcal />
        </div>
      </div>
    </CardShell>
  );
}

// ---------- get_water_status ----------
// Renders the SAME <HydrationCard> the nutrition (Food) day view uses — no
// bespoke chat-only card. It reads/writes the day's water live via react-query,
// so the quick-adds and manual edit work right here in the chat. We only pull
// the date out of the tool result to point it at the right day.
export function HydrationResultCard({ data }: ResultCardProps) {
  if (!isObj(data)) return null;
  const date = str(data.date);
  if (!date) return null;
  return <HydrationCard dateIso={date} dayContext={dayTag(data, "nutrition")} hideEdit />;
}

// Build the BMR / maintenance / daily-target energy tiles shared by the
// compute_targets and compute_bmr cards, so both read like the dashboard's
// "Targets & energy" panel (cards/../lib/energyTiles.tsx). The goal-adjusted
// daily target is highlighted as the number the user steers toward.
function energyTilesFor(
  bmr: number | null,
  tdee: number | null,
  target: Macros | null,
  goal: Goal | null = null,
): EnergyTile[] {
  return buildEnergyTiles({
    bmr,
    tdee,
    targetKcal: target?.kcal ?? null,
    // The target tile carries the GOAL's icon (the profile's chrome) so the goal
    // reads identically here, on the goal badge, and on the dashboard GoalTile.
    // Falls back to Flame when no goal (BMR-only scenario math).
    targetIcon: goal ? GOAL_META[goal].Icon : Flame,
    // Label the highlighted target with the goal's deficit/surplus so the number
    // is tied to the scenario that produced it.
    targetSub: goal ? goalDeltaSub(goal) : undefined,
  });
}

// A labelled target-macro row matching the dashboard's "target macros" caption.
function TargetMacros({ m }: { m: Macros }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 space-y-1.5">
      <div className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t("cards.targets.targetMacros")}
      </div>
      <MacroSplit m={m} />
    </div>
  );
}

// ---------- compute_targets ----------
// The user asked "what should my calories/targets be" → the highlighted daily
// target tile leads, with BMR + maintenance as context and the macro split below.
export function TargetsCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || data.error) return null;
  const target = macros(data.daily_target);
  const bmr = num(data.bmr_used);
  const tdee = num(data.tdee);
  const goal = readGoal(data);
  if (target == null && bmr == null) return null;
  return (
    <CardShell
      category={category}
      title={t("cards.targets.dailyTarget")}
      subtitle={goal && target != null ? <GoalBadge goal={goal} /> : null}
    >
      <EnergyTiles tiles={energyTilesFor(bmr, tdee, target, goal)} />
      {target != null && <TargetMacros m={target} />}
    </CardShell>
  );
}

// ---------- compute_bmr ----------
// The user asked "what's my BMR/TDEE" → lead with those tiles. The highlighted
// daily-target tile + macros only appear when they supplied a goal + activity
// (scenario math), so the card matches the BMR question.
export function BmrCard({ data, category }: ResultCardProps) {
  if (!isObj(data) || data.error) return null;
  const bmr = num(data.bmr_used);
  const tdee = num(data.tdee);
  const target = macros(data.daily_target);
  const goal = readGoal(data);
  if (bmr == null && tdee == null) return null;
  return (
    <CardShell
      category={category}
      title={tdee != null ? "BMR & TDEE" : "BMR"}
      subtitle={goal && target != null ? <GoalBadge goal={goal} /> : null}
    >
      <EnergyTiles tiles={energyTilesFor(bmr, tdee, target, goal)} />
      {target != null && <TargetMacros m={target} />}
    </CardShell>
  );
}

// ---------- preview_meal ----------
// "Show me the dashboard with what I'm about to eat" — the same calorie ring +
// macro bars the dashboard / DayOverviewCard draw, in projected mode: the day's
// committed `eaten_before` stays solid and this un-logged meal ghosts on top, so
// the user sees where they'd land before anything is logged. Falls back to a
// plain macro split when there's no target/day context to project against.
export function MealPreviewCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const totals = macros(data.totals);
  if (!totals) return null;
  const items = Array.isArray(data.items) ? data.items : [];
  // The day's PRIMARY target is the goal-based recommendation (recomp/cut/etc.);
  // the active diet plan's target rides along as a triangle marker. Mirrors the
  // dashboard / Nutrition page. Falls back to the diet target as primary when
  // there's no recommendation (no weigh-in), so a plan still shows something.
  const dietTarget = macros(data.target_today);
  const goalTarget = macros(data.recommended_target);
  const target = goalTarget ?? dietTarget;
  const dietKcal = goalTarget && dietTarget ? dietTarget.kcal : null;
  const eatenBefore = macros(data.eaten_before);
  const projectedEaten = macros(data.projected_eaten);
  const goal =
    isObj(data.profile_summary) && str(data.profile_summary.goal)
      ? (str(data.profile_summary.goal) as Goal)
      : undefined;
  // The full projected dashboard only makes sense with a target to steer toward;
  // without one we just show the meal's macro totals.
  const showDashboard = target != null && eatenBefore != null && projectedEaten != null;

  return (
    <CardShell
      category={category}
      title={t("cards.meal.preview")}
      subtitle={dayTag(data, "nutrition")}
    >
      {items.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {items.map((it, i) => {
            if (!isObj(it)) return null;
            const food = str(it.food) ?? t("cards.common.item");
            const grams = num(it.grams);
            const kcal = num(it.kcal);
            return (
              <div key={i} className="flex justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  {humanize(food)}
                  {grams != null && (
                    <span className="text-muted-foreground"> · {grams.toFixed(0)} g</span>
                  )}
                </span>
                {kcal != null && (
                  <span className="shrink-0 text-muted-foreground">{kcal.toFixed(0)} kcal</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showDashboard ? (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center">
          <div className="shrink-0">
            <CalorieRing
              eaten={eatenBefore.kcal}
              projected={projectedEaten.kcal}
              target={target.kcal}
              maintenance={null}
              dietKcal={dietKcal}
              goal={goal}
            />
          </div>
          <div className="w-full min-w-0 flex-1">
            <MacroBars
              eaten={eatenBefore}
              projected={projectedEaten}
              target={target}
              goal={goal}
              hideKcal
            />
          </div>
        </div>
      ) : (
        <MacroSplit m={totals} />
      )}
    </CardShell>
  );
}

// ---------- compute_macro_split ----------
// A known calorie target split into grams — the prescription chips plus each
// macro's share of calories and what the protein figure was based on.
export function MacroSplitResultCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const m = macros(data.macros);
  if (!m) return null;
  const goal = readGoal(data);
  const imperial = data.units === "imperial";
  const pct = isObj(data.pct) ? data.pct : null;
  const lbm = num(data.lean_mass_kg);
  return (
    <CardShell
      category={category}
      title={t("cards.macroSplit.title")}
      subtitle={goal ? <GoalBadge goal={goal} /> : null}
    >
      <BigStat value={m.kcal.toFixed(0)} unit="kcal" />
      <div className="mt-2">
        <MacroSplit m={m} />
      </div>
      {pct && num(pct.p) != null && num(pct.c) != null && num(pct.f) != null && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {t("cards.macroSplit.shares", { p: num(pct.p), c: num(pct.c), f: num(pct.f) })}
        </div>
      )}
      <div className="mt-1 text-[11px] text-muted-foreground">
        {lbm != null
          ? t("cards.macroSplit.leanBasis", { mass: massLabel(lbm, imperial) })
          : t("cards.macroSplit.bodyweightBasis")}
      </div>
      {data.carbs_floored === true && (
        <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {t("cards.macroSplit.carbsFloored")}
        </div>
      )}
    </CardShell>
  );
}

// ---------- compute_protein_target ----------
export function ProteinTargetCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const protein = num(data.protein_g);
  if (protein == null) return null;
  const goal = readGoal(data);
  const imperial = data.units === "imperial";
  const inputs = isObj(data.inputs) ? data.inputs : null;
  const weight = inputs ? num(inputs.weight_kg) : null;
  const perMeal = num(data.per_meal_g);
  const meals = num(data.meals);
  const rda = num(data.rda_g);
  const lbm = num(data.lean_mass_kg);
  const perUnit =
    weight != null && weight > 0
      ? (protein / (imperial ? weight * LB_PER_KG : weight)).toFixed(imperial ? 2 : 1)
      : null;
  return (
    <CardShell
      category={category}
      title={t("cards.protein.title")}
      subtitle={goal ? <GoalBadge goal={goal} /> : null}
    >
      <BigStat
        value={protein.toFixed(0)}
        unit={t("cards.protein.gPerDay")}
        label={
          perUnit != null
            ? t("cards.protein.perBodyweight", { v: perUnit, unit: imperial ? "lb" : "kg" })
            : undefined
        }
      />
      <div className="mt-2">
        {perMeal != null && meals != null && (
          <ListRow
            label={t("cards.protein.perMeal")}
            value={t("cards.protein.perMealValue", { g: perMeal, n: meals })}
          />
        )}
        <ListRow
          label={t("cards.protein.basedOn")}
          value={lbm != null ? massLabel(lbm, imperial) : t("cards.protein.bodyweight")}
          sub={lbm != null ? t("cards.body.leanMass") : null}
        />
        {rda != null && <ListRow label={t("cards.protein.rda")} value={`${rda} g`} />}
      </div>
    </CardShell>
  );
}

// ---------- compute_calorie_deficit ----------
// Daily intake to reach a goal weight at the chosen pace, with the timeline and
// the cut macro split. `capped` means the pace hit the minimum intake.
export function CalorieDeficitCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const daily = num(data.daily_kcal);
  const deficit = num(data.daily_deficit);
  if (daily == null || deficit == null) return null;
  const imperial = data.units === "imperial";
  const tdee = num(data.tdee);
  const weekly = num(data.weekly_loss_kg);
  const toLose = num(data.to_lose_kg);
  const weeks = num(data.weeks);
  const m = macros(data.macros);
  return (
    <CardShell category={category} title={t("cards.deficit.title")}>
      <BigStat
        value={daily.toFixed(0)}
        unit="kcal"
        label={t("cards.deficit.belowMaintenance", { kcal: deficit.toFixed(0) })}
      />
      <div className="mt-2">
        {tdee != null && (
          <ListRow label={t("cards.deficit.maintenance")} value={`${tdee.toFixed(0)} kcal`} />
        )}
        {weekly != null && (
          <ListRow label={t("cards.deficit.perWeek")} value={massLabel(weekly, imperial)} />
        )}
        {toLose != null && (
          <ListRow label={t("cards.deficit.toLose")} value={massLabel(toLose, imperial)} />
        )}
        {weeks != null && (
          <ListRow
            label={t("cards.deficit.timeToGoal")}
            value={t("cards.deficit.weeksValue", { n: weeks })}
          />
        )}
      </div>
      {data.capped === true && (
        <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {t("cards.deficit.capped")}
        </div>
      )}
      {m != null && <TargetMacros m={m} />}
    </CardShell>
  );
}

// ---------- compute_water_intake ----------
// Litres, with US fluid ounces alongside for a user working in imperial.
const ML_PER_FL_OZ = 29.5735;
function volumeLabel(ml: number, imperial: boolean): string {
  const l = `${(ml / 1000).toFixed(1)} L`;
  return imperial ? `${l} · ${Math.round(ml / ML_PER_FL_OZ)} fl oz` : l;
}
export function WaterIntakeCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const total = num(data.total_ml);
  if (total == null) return null;
  const imperial = data.units === "imperial";
  const base = num(data.base_ml);
  const exercise = num(data.exercise_ml);
  const climate = num(data.climate_ml);
  const glasses = num(data.glasses);
  const efsa = num(data.efsa_total_ml);
  return (
    <CardShell category={category} title={t("cards.water.title")}>
      <BigStat
        value={volumeLabel(total, imperial)}
        label={glasses != null ? t("cards.water.glasses", { n: glasses }) : undefined}
      />
      <div className="mt-2">
        {base != null && (
          <ListRow label={t("cards.water.base")} value={volumeLabel(base, imperial)} />
        )}
        {exercise != null && exercise > 0 && (
          <ListRow
            label={t("cards.water.exercise")}
            value={`+ ${volumeLabel(exercise, imperial)}`}
          />
        )}
        {climate != null && climate > 0 && (
          <ListRow label={t("cards.water.hot")} value={`+ ${volumeLabel(climate, imperial)}`} />
        )}
        {efsa != null && (
          <ListRow label={t("cards.water.efsa")} value={volumeLabel(efsa, imperial)} />
        )}
      </div>
    </CardShell>
  );
}

// ---------- compute_step_calories ----------
const KM_PER_MI = 1.609344;
export function StepCaloriesCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const net = num(data.net_kcal);
  if (net == null) return null;
  const imperial = data.units === "imperial";
  const gross = num(data.kcal);
  const km = num(data.distance_km);
  const minutes = num(data.minutes);
  const per1000 = num(data.kcal_per_1000);
  const goal = isObj(data.step_goal) ? data.step_goal : null;
  const low = goal ? num(goal.low) : null;
  const high = goal ? num(goal.high) : null;
  const pct = num(data.pct_of_goal);
  const steps = isObj(data.inputs) ? num(data.inputs.steps) : null;
  return (
    <CardShell
      category={category}
      title={t("cards.steps.title")}
      subtitle={steps != null ? t("cards.steps.steps", { n: steps.toLocaleString() }) : null}
    >
      <BigStat
        value={net.toFixed(0)}
        unit="kcal"
        label={gross != null ? t("cards.steps.gross", { kcal: gross }) : undefined}
      />
      <div className="mt-2">
        {km != null && (
          <ListRow
            label={t("cards.steps.distance")}
            value={imperial ? `${(km / KM_PER_MI).toFixed(2)} mi` : `${km.toFixed(2)} km`}
          />
        )}
        {minutes != null && (
          <ListRow label={t("cards.steps.time")} value={t("cards.steps.minutes", { n: minutes })} />
        )}
        {per1000 != null && <ListRow label={t("cards.steps.per1000")} value={`${per1000} kcal`} />}
        {low != null && high != null && (
          <ListRow
            label={t("cards.steps.goal")}
            value={`${low.toLocaleString()}–${high.toLocaleString()}`}
            sub={pct != null ? t("cards.steps.pctOfGoal", { pct }) : null}
          />
        )}
      </div>
    </CardShell>
  );
}

// ---------- lookup_food ----------
export function FoodMacroCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || data.found !== true) return null;
  const m = macros(data); // per-100 macros are spread to the top level
  if (!m) return null;
  const name = str(data.name);
  const unit = str(data.unit) === "ml" ? "ml" : "g";
  const qty = num(data.quantity);
  return (
    <CardShell
      category={category}
      title={name ? humanize(name) : t("cards.food.title")}
      subtitle={t("cards.food.per100", { kcal: m.kcal.toFixed(0), unit })}
    >
      <MacroSplit m={m} />
      {qty != null && qty > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {t("cards.food.onHand", { qty, unit })}
        </div>
      )}
    </CardShell>
  );
}

// ---------- lookup_product (OpenFoodFacts) ----------
export function ProductCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!isObj(data) || data.found !== true) return null;
  // Barcode path → single product; search path → results[].
  const product = isObj(data.product) ? data.product : null;
  const results = Array.isArray(data.results) ? data.results : null;

  if (product) {
    const m = macros(product.per_100g);
    const name = str(product.name);
    const brand = str(product.brand);
    return (
      <CardShell
        category={category}
        title={name ? name : t("cards.product.title")}
        subtitle={
          m
            ? t("cards.product.per100g", { kcal: m.kcal.toFixed(0) })
            : t("cards.product.incomplete")
        }
      >
        {brand && <div className="mb-2 text-[11px] text-muted-foreground">{brand}</div>}
        {m && <MacroSplit m={m} />}
      </CardShell>
    );
  }

  if (results && results.length) {
    const kcals = results
      .map((p) => (isObj(p) ? macros(p.per_100g) : null))
      .filter((m): m is Macros => m != null)
      .map((m) => m.kcal);
    const avgKcal = kcals.length ? kcals.reduce((a, b) => a + b, 0) / kcals.length : null;
    const subtitle =
      avgKcal != null
        ? t("cards.product.foundAvg", { count: results.length, kcal: avgKcal.toFixed(0) })
        : t("cards.product.found", { count: results.length });
    return (
      <CardShell category={category} title={t("cards.product.matches")} subtitle={subtitle}>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? t("cards.product.hide") : t("cards.product.show")}
            <ChevronDown
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
            />
          </button>
        </div>
        <Collapsible open={expanded}>
          <div className="mt-2 divide-y divide-border/60">
            {results.map((p, i) => {
              if (!isObj(p)) return null;
              const m = macros(p.per_100g);
              const name = str(p.name) ?? t("cards.product.unnamed");
              const brand = str(p.brand);
              return (
                <ListRow
                  key={i}
                  label={name}
                  sub={brand}
                  value={m ? `${m.kcal.toFixed(0)} kcal` : null}
                />
              );
            })}
          </div>
        </Collapsible>
      </CardShell>
    );
  }
  return null;
}

// ---------- substitute_food ----------
export function SubstituteCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || !Array.isArray(data.candidates) || !data.candidates.length) return null;
  return (
    <CardShell
      category={category}
      title={t("cards.substitute.title")}
      subtitle={t("cards.substitute.options", { count: data.candidates.length })}
    >
      <div className="divide-y divide-border/60">
        {data.candidates.slice(0, 5).map((c, i) => {
          if (!isObj(c)) return null;
          const name = str(c.name) ?? t("cards.common.item");
          const grams = num(c.grams);
          const m = macros(c.macros);
          return (
            <ListRow
              key={i}
              label={humanize(name)}
              sub={grams != null ? `${grams.toFixed(0)} g` : null}
              value={m ? `${m.kcal.toFixed(0)} kcal · ${m.p.toFixed(0)}p` : null}
            />
          );
        })}
      </div>
    </CardShell>
  );
}

// ---------- shopping_list ----------
export function ShoppingListCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || data.error) return null;
  const toBuy = Array.isArray(data.to_buy_only) ? data.to_buy_only : [];
  const days = num(data.days);
  if (!toBuy.length) {
    return (
      <CardShell
        category={category}
        title={t("cards.shopping.title")}
        subtitle={days != null ? t("cards.shopping.days", { count: days }) : null}
      >
        <EmptyState icon={PackageCheck} compact>
          {t("cards.shopping.nothingToBuy")}
        </EmptyState>
      </CardShell>
    );
  }
  return (
    <CardShell
      category={category}
      title={t("cards.shopping.title")}
      subtitle={t("cards.shopping.items", { count: toBuy.length })}
    >
      <div className="divide-y divide-border/60">
        {toBuy.slice(0, 12).map((r, i) => {
          if (!isObj(r)) return null;
          const food = str(r.food) ?? t("cards.common.item");
          const toBuyG = num(r.grams_to_buy);
          return (
            <ListRow
              key={i}
              label={humanize(food)}
              value={toBuyG != null ? `${toBuyG.toFixed(0)} g` : null}
            />
          );
        })}
      </div>
    </CardShell>
  );
}
