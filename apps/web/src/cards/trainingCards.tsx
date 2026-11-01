// Result cards for training tools: strength, plates, warm-ups, volume and heart-rate zones.
import { getExercise, type StrengthLevelName } from "@fa/shared";
import { useTranslation } from "react-i18next";

import { exerciseName, humanize, muscleGroupLabel } from "../lib/catalogLabels";
import { ExerciseIcon } from "../lib/exerciseIcon";
import { cn } from "../lib/utils";
import { BigStat, CardShell, isObj, LB_PER_KG, ListRow, massLabel, num, str } from "./primitives";
import type { ResultCardProps } from "./resultCards";
import {
  type LevelBand,
  STRENGTH_LEVEL_META,
  StrengthLevelBadge,
  StrengthLevelScale,
} from "./strengthViews";

// ---------- compute_heart_rate_zones ----------
// Five bpm bands. Zone names are localized by number rather than read from the
// result's English `name`.
export function HeartRateZonesCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || !Array.isArray(data.zones)) return null;
  const max = num(data.max_heart_rate);
  if (max == null) return null;
  const zones = data.zones.filter(isObj).map((z) => ({
    zone: num(z.zone),
    lowPct: num(z.low_pct),
    highPct: num(z.high_pct),
    low: num(z.low_bpm),
    high: num(z.high_bpm),
  }));
  const karvonen = data.method === "karvonen";
  return (
    <CardShell
      category={category}
      title={t("cards.hrZones.title")}
      subtitle={karvonen ? t("cards.hrZones.karvonen") : t("cards.hrZones.percentMax")}
    >
      <BigStat
        value={max.toFixed(0)}
        unit="bpm"
        label={
          data.max_heart_rate_estimated === true
            ? t("cards.hrZones.maxEstimated")
            : t("cards.hrZones.max")
        }
      />
      <div className="mt-2">
        {zones.map((z) =>
          z.zone != null && z.low != null && z.high != null ? (
            <ListRow
              key={z.zone}
              label={`${t("cards.hrZones.zone", { n: z.zone })} · ${t(`cards.hrZones.names.z${z.zone}`)}`}
              sub={z.lowPct != null && z.highPct != null ? `${z.lowPct}–${z.highPct}%` : null}
              value={`${z.low}–${z.high} bpm`}
            />
          ) : null,
        )}
      </div>
    </CardShell>
  );
}

// ---------- convert_rpe ----------
export function RpeCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const e1rm = num(data.e1rm_kg);
  if (e1rm == null) return null;
  const imperial = data.units === "imperial";
  const inputs = isObj(data.inputs) ? data.inputs : null;
  const reps = inputs ? num(inputs.reps) : null;
  const rpe = inputs ? num(inputs.rpe) : null;
  const pct = num(data.pct_of_1rm);
  const rir = num(data.rir);
  const tReps = num(data.target_reps);
  const tRpe = num(data.target_rpe);
  const tKg = num(data.target_kg);
  const loads = Array.isArray(data.rep_loads) ? data.rep_loads.filter(isObj) : [];
  return (
    <CardShell
      category={category}
      title={t("cards.rpe.title")}
      subtitle={reps != null && rpe != null ? t("cards.rpe.set", { reps, rpe }) : null}
    >
      <BigStat value={massLabel(e1rm, imperial)} label={t("cards.rpe.e1rm")} />
      <div className="mt-2">
        {pct != null && <ListRow label={t("cards.rpe.pctOf1rm")} value={`${pct}%`} />}
        {rir != null && <ListRow label={t("cards.rpe.rir")} value={String(rir)} />}
        {tReps != null && tRpe != null && tKg != null && (
          <ListRow
            label={t("cards.rpe.target", { reps: tReps, rpe: tRpe })}
            value={massLabel(tKg, imperial)}
          />
        )}
      </div>
      {loads.length > 0 && tRpe != null && (
        <div className="mt-2 border-t pt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {t("cards.rpe.loadsAt", { rpe: tRpe })}
          </div>
          {loads.map((l) => {
            const r = num(l.reps);
            const kg = num(l.kg);
            const p = num(l.pct);
            return r != null && kg != null ? (
              <ListRow
                key={r}
                label={t("cards.rpe.reps", { n: r })}
                sub={p != null ? `${p}%` : null}
                value={massLabel(kg, imperial)}
              />
            ) : null;
          })}
        </div>
      )}
    </CardShell>
  );
}

// ---------- plan_warmup_sets ----------
// Loads are already in the result's own unit (the ramp, like plate racking,
// works in whatever unit it was given), so they are shown as-is.
function platesLabel(perSide: unknown): string | null {
  if (!Array.isArray(perSide) || perSide.length === 0) return null;
  return perSide
    .filter(isObj)
    .map((p) => `${num(p.count)}×${num(p.plate_kg)}`)
    .join(" + ");
}
export function WarmupCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || !Array.isArray(data.sets) || !isObj(data.top)) return null;
  const unit = str(data.unit) === "lb" ? "lb" : "kg";
  const topLoad = num(data.top.load);
  const topReps = num(data.top.reps);
  if (topLoad == null || topReps == null) return null;
  const sets = data.sets.filter(isObj);
  const row = (s: Record<string, unknown>, i: number, isTop = false) => {
    const load = num(s.load);
    const reps = num(s.reps);
    const pct = num(s.pct);
    if (load == null || reps == null) return null;
    const plates = platesLabel(s.per_side);
    return (
      <ListRow
        key={i}
        label={
          isTop
            ? t("cards.warmup.topSet")
            : i === 0
              ? t("cards.warmup.emptyBar")
              : t("cards.warmup.setN", { n: i, pct })
        }
        sub={plates ? t("cards.warmup.perSide", { plates, unit }) : null}
        value={`${reps} × ${load} ${unit}`}
      />
    );
  };
  return (
    <CardShell
      category={category}
      title={t("cards.warmup.title")}
      subtitle={t("cards.warmup.to", { load: topLoad, unit, reps: topReps })}
    >
      {sets.map((s, i) => row(s, i))}
      <div className="mt-1 border-t pt-1">{row(data.top, sets.length, true)}</div>
    </CardShell>
  );
}

// ---------- compute_training_volume ----------
const VOLUME_VERDICT_CLASS: Record<string, string> = {
  under: "text-amber-600 dark:text-amber-400",
  ok: "text-emerald-600 dark:text-emerald-400",
  over: "text-amber-600 dark:text-amber-400",
};
export function TrainingVolumeCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const weekly = num(data.weekly_tonnage_kg);
  if (weekly == null) return null;
  const imperial = data.units === "imperial";
  const tonnage = (kg: number) =>
    `${Math.round(imperial ? kg * LB_PER_KG : kg).toLocaleString()} ${imperial ? "lb" : "kg"}`;
  const session = num(data.session_tonnage_kg);
  const perWeek = num(data.sessions_per_week);
  const target = isObj(data.target) ? data.target : null;
  const min = target ? num(target.min) : null;
  const max = target ? num(target.max) : null;
  const muscles = Array.isArray(data.muscles) ? data.muscles.filter(isObj) : [];
  return (
    <CardShell
      category={category}
      title={t("cards.volume.title")}
      subtitle={perWeek != null ? t("cards.volume.sessions", { n: perWeek }) : null}
    >
      <BigStat
        value={tonnage(weekly)}
        label={session != null ? t("cards.volume.perSession", { v: tonnage(session) }) : undefined}
      />
      {muscles.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {min != null && max != null
              ? t("cards.volume.weeklySets", { min, max })
              : t("cards.volume.weeklySetsPlain")}
          </div>
          {muscles.map((m) => {
            const group = str(m.group);
            const sets = num(m.weekly_sets);
            const verdict = str(m.verdict);
            if (!group || sets == null) return null;
            return (
              <div key={group} className="flex items-baseline justify-between gap-2 py-0.5 text-xs">
                <span className="min-w-0 wrap-break-word">{muscleGroupLabel(group)}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="font-medium">{sets}</span>
                  {verdict && (
                    <span className={cn("ms-1.5 text-[11px]", VOLUME_VERDICT_CLASS[verdict])}>
                      {t(`cards.volume.verdict.${verdict}`)}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

// ---------- estimate_training_kcal ----------
export function TrainingKcalCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const total = num(data.total_kcal);
  if (total == null) return null;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return (
    <CardShell category={category} title={t("cards.training.burn")}>
      <BigStat value={total.toFixed(0)} unit="kcal" label={t("cards.training.estimatedTotal")} />
      {entries.length > 0 && (
        <div className="mt-2 divide-y divide-border/60">
          {entries.map((e, i) => {
            if (!isObj(e)) return null;
            const act = str(e.activity);
            const dur = num(e.duration_min);
            const kcal = num(e.kcal);
            return (
              <ListRow
                key={i}
                label={act ? humanize(act) : t("cards.training.activity")}
                sub={dur != null ? `${dur.toFixed(0)} min` : null}
                value={kcal != null ? `${kcal.toFixed(0)} kcal` : null}
              />
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

// ---------- compute_one_rep_max ----------
export function OneRepMaxCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const oneRm = num(data.one_rep_max_kg);
  if (oneRm == null) return null;
  const inputs = isObj(data.inputs) ? data.inputs : null;
  const w = inputs ? num(inputs.weight_kg) : null;
  const reps = inputs ? num(inputs.reps) : null;
  // Optional lift label — set only by the manual calculator (the chat tool
  // never sends it), so the card can name which lift is being estimated.
  const exName = str(data.exercise_name);
  const from =
    w != null && reps != null ? t("cards.strength.oneRepMax.from", { weight: w, reps }) : null;
  const subtitle = exName ? (from ? `${exName} · ${from}` : exName) : from;
  const epley = num(data.epley_kg);
  const brzycki = num(data.brzycki_kg);
  const table = Array.isArray(data.rep_table) ? data.rep_table : [];
  const showReps = [1, 2, 3, 5, 8, 10, 12];
  const rows = showReps
    .map((r) => table.find((x) => isObj(x) && num(x.reps) === r))
    .filter((x): x is Record<string, unknown> => isObj(x));
  return (
    <CardShell category={category} title={t("cards.strength.oneRepMax.title")} subtitle={subtitle}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <BigStat
          value={oneRm.toFixed(1)}
          unit="kg"
          label={t("cards.strength.oneRepMax.estimated")}
        />
        <div className="text-[11px] text-muted-foreground">
          {epley != null && (
            <div>{t("cards.strength.oneRepMax.epley", { value: epley.toFixed(1) })}</div>
          )}
          {brzycki != null && (
            <div>{t("cards.strength.oneRepMax.brzycki", { value: brzycki.toFixed(1) })}</div>
          )}
        </div>
      </div>
      {rows.length > 0 && (
        <>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {t("cards.strength.oneRepMax.repTable")}
          </div>
          <div className="grid grid-cols-4 gap-x-3 gap-y-0.5 sm:grid-cols-7">
            {rows.map((r) => (
              <div key={num(r.reps)!} className="text-center text-xs">
                <div className="font-medium tabular-nums">{num(r.weight_kg)?.toFixed(1)}</div>
                <div className="text-[10px] text-muted-foreground">
                  ×{num(r.reps)} · {num(r.percent_of_1rm)}%
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </CardShell>
  );
}

// ---------- assess_strength_level ----------
export function StrengthLevelCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const ex = isObj(data.exercise) ? data.exercise : null;
  const level = str(data.level) as StrengthLevelName | null;
  const perf = num(data.performance);
  const percentile = num(data.percentile);
  const bands = Array.isArray(data.reference_bands) ? data.reference_bands : [];
  if (ex == null || level == null || perf == null || bands.length !== 5) return null;
  const unit = data.performance_unit === "reps" ? "reps" : "kg";
  const ratio = num(data.bodyweight_ratio);
  const next = isObj(data.next_level) ? data.next_level : null;
  const levelBands: LevelBand[] = bands.map((b) => {
    const o = b as Record<string, unknown>;
    return {
      level: str(o.level) as StrengthLevelName,
      percentile: num(o.percentile) ?? 0,
      min: num(o.min) ?? 0,
      max: num(o.max),
    };
  });
  const unitLabel = unit === "kg" ? "kg" : t("cards.strength.repsShort");
  return (
    <CardShell
      category={category}
      title={
        (str(ex.catalog_id) ? exerciseName(str(ex.catalog_id)) : str(ex.name)) ??
        t("cards.strength.level.title")
      }
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ExerciseIcon exerciseId={str(ex.catalog_id)} className="size-9" />
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">
              {unit === "reps" ? perf.toFixed(0) : perf.toFixed(1)}
            </span>
            <span className="text-xs text-muted-foreground">{unitLabel}</span>
          </div>
        </div>
        <StrengthLevelBadge level={level} />
      </div>
      <StrengthLevelScale bands={levelBands} performance={perf} unit={unit} />
      <p className="mt-2 text-[11px] text-muted-foreground">
        {percentile != null && t("cards.strength.level.strongerThan", { pct: percentile })}
        {ratio != null && ` · ${t("cards.strength.level.ratio", { ratio: ratio.toFixed(2) })}`}
      </p>
      {next != null && num(next.remaining) != null && num(next.remaining)! > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {t("cards.strength.level.nextLevel", {
            remaining: num(next.remaining)!.toFixed(unit === "reps" ? 0 : 1),
            unit: unitLabel,
            level: t(`cards.strength.level.${str(next.level)}`),
          })}
        </p>
      )}
    </CardShell>
  );
}

// ---------- compute_powerlifting_score ----------
export function PowerliftingCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const wilks = num(data.wilks);
  const dots = num(data.dots);
  const ipf = num(data.ipf_gl);
  const total = num(data.total_kg);
  if (wilks == null && dots == null && ipf == null) return null;
  const lifts = isObj(data.lifts) ? data.lifts : null;
  const parts = lifts
    ? (["squat_kg", "bench_kg", "deadlift_kg"] as const)
        .map((k) => num(lifts[k]))
        .filter((v): v is number => v != null)
    : [];
  return (
    <CardShell
      category={category}
      title={t("cards.strength.powerlifting.title")}
      subtitle={
        total != null ? t("cards.strength.powerlifting.total", { total: total.toFixed(1) }) : null
      }
    >
      <div className="flex flex-wrap gap-5">
        {wilks != null && (
          <BigStat value={wilks.toFixed(1)} label={t("cards.strength.powerlifting.wilks")} />
        )}
        {dots != null && (
          <BigStat value={dots.toFixed(1)} label={t("cards.strength.powerlifting.dots")} />
        )}
        {ipf != null && (
          <BigStat value={ipf.toFixed(1)} label={t("cards.strength.powerlifting.ipfgl")} />
        )}
      </div>
      {parts.length > 0 && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {t("cards.strength.powerlifting.breakdown", {
            parts: parts.map((v) => `${v}`).join(" + "),
          })}
        </div>
      )}
    </CardShell>
  );
}

// ---------- strength_symmetry ----------
export function SymmetryCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const sym = num(data.symmetry_pct);
  const lifts = Array.isArray(data.lifts) ? data.lifts : [];
  if (sym == null || lifts.length === 0) return null;
  const weakest = isObj(data.weakest) ? data.weakest : null;
  return (
    <CardShell category={category} title={t("cards.strength.symmetry.title")}>
      <div className="mb-2">
        <BigStat value={`${sym}%`} label={t("cards.strength.symmetry.balanced")} />
      </div>
      <div className="space-y-1">
        {lifts.map((l, i) => {
          if (!isObj(l)) return null;
          const level = str(l.level) as StrengthLevelName | null;
          const pct = num(l.percentile) ?? 0;
          return (
            <div key={str(l.exercise) ?? i} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 truncate">{str(l.name) ?? str(l.exercise)}</span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    level ? STRENGTH_LEVEL_META[level].bar : "bg-primary",
                  )}
                  style={{ width: `${Math.min(100, Math.max(3, pct))}%` }}
                />
              </div>
              {level && <StrengthLevelBadge level={level} />}
            </div>
          );
        })}
      </div>
      {weakest != null &&
        num(data.spread_percentile) != null &&
        num(data.spread_percentile)! > 10 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t("cards.strength.symmetry.lagging", {
              lift: str(weakest.name) ?? str(weakest.exercise),
            })}
          </p>
        )}
    </CardShell>
  );
}

// ---------- plate_barbell_racking ----------
export function PlateRackingCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data)) return null;
  const perSide = Array.isArray(data.per_side) ? data.per_side : null;
  const loaded = num(data.loaded);
  const target = num(data.target);
  if (perSide == null || loaded == null || target == null) return null;
  const unit = str(data.unit) === "lb" ? "lb" : "kg";
  const exact = data.exact === true;
  return (
    <CardShell
      category={category}
      title={t("cards.strength.plates.title")}
      subtitle={t("cards.strength.plates.target", { target, unit })}
    >
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">
        {t("cards.strength.plates.perSide")}
      </div>
      {perSide.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {perSide.map((p, i) => {
            if (!isObj(p)) return null;
            const plate = num(p.plate);
            const count = num(p.count);
            if (plate == null || count == null) return null;
            return (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs font-medium tabular-nums"
              >
                {count}× {plate}
                <span className="text-[10px] text-muted-foreground">{unit}</span>
              </span>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">{t("cards.strength.plates.barOnly")}</div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">
        {exact
          ? t("cards.strength.plates.loaded", { loaded, unit })
          : t("cards.strength.plates.closest", { loaded, unit })}
      </div>
    </CardShell>
  );
}

// ---------- last_sets_for_exercise ----------
export function LastSetsCard({ data, category }: ResultCardProps) {
  const { t } = useTranslation();
  if (!isObj(data) || !Array.isArray(data.sets) || !data.sets.length) return null;
  const exId = str(data.exercise_id);
  const name =
    (exId && getExercise(exId) ? exerciseName(exId) : null) ?? str(data.exercise_name) ?? exId;
  const suggested = isObj(data.suggested_next) ? num(data.suggested_next.weight_kg) : null;
  return (
    <CardShell
      category={category}
      title={name ? humanize(name) : t("cards.sets.title")}
      subtitle={suggested != null ? t("cards.sets.next", { kg: suggested.toFixed(1) }) : null}
    >
      <div className="divide-y divide-border/60">
        {data.sets.slice(0, 8).map((s, i) => {
          if (!isObj(s)) return null;
          const reps = num(s.reps);
          const weight = num(s.weight_kg);
          const rpe = num(s.rpe);
          const orm = num(s.est_1rm_kg);
          const when = str(s.completed_at);
          return (
            <ListRow
              key={i}
              label={
                weight != null && reps != null
                  ? `${weight.toFixed(1)} kg × ${reps}`
                  : t("cards.sets.set")
              }
              sub={
                [when ? when.slice(0, 10) : null, rpe != null ? `RPE ${rpe}` : null]
                  .filter(Boolean)
                  .join(" · ") || null
              }
              value={orm != null ? `1RM ~${orm.toFixed(0)}` : null}
            />
          );
        })}
      </div>
    </CardShell>
  );
}
