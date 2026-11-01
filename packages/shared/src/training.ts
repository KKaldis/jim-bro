/**
 * Training energy expenditure (METs-based).
 *
 * Formula (ACSM): kcal/min = MET × 3.5 × weight_kg / 200
 * Total: kcal = MET × 3.5 × weight_kg × duration_min / 200
 *
 * MET values approximate the Compendium of Physical Activities (Ainsworth et al.
 * 2011). They're population estimates; individual variance is ±15–25%.
 *
 * Importantly: do NOT subtract these kcal from the daily target. The user's
 * `activity_level` (sedentary…extreme) already includes typical exercise.
 * This number is informational — useful for "did today's session match my
 * expected burn?" but double-counting if applied to remaining macros.
 */

// Curated set of common activities. Names are snake_case to match the rest
// of the system. Keys are the lookup names; if an activity isn't here, the
// caller must pass an explicit `met` value.
export const MET_TABLE: Record<string, number> = {
  // Walking / running
  walking_slow: 2.5,
  walking_brisk: 3.8,
  walking_uphill: 5.3,
  running_easy: 6.0, // ~10 km/h
  running_moderate: 8.3, // ~12 km/h
  running_fast: 11.5, // ~15 km/h
  // Cycling
  cycling_easy: 4.0, // <16 km/h
  cycling_moderate: 8.0, // 16–20 km/h
  cycling_fast: 10.0, // 20–25 km/h
  // Swimming / rowing
  swimming_moderate: 6.0,
  swimming_vigorous: 9.8,
  rowing_moderate: 7.0,
  rowing_vigorous: 8.5,
  // Cardio machines
  elliptical: 5.0,
  stair_climber: 8.8,
  // Resistance training
  weight_training_light: 3.5,
  weight_training_moderate: 5.0,
  weight_training_vigorous: 6.0,
  // Bodyweight / mobility
  calisthenics_moderate: 3.8,
  calisthenics_vigorous: 8.0,
  yoga: 2.5,
  pilates: 3.0,
  stretching: 2.3,
  // Mixed / sport
  hiit: 8.0,
  crossfit: 8.0,
  boxing_bag: 5.5,
  boxing_sparring: 7.8,
  basketball: 6.5,
  soccer: 7.0,
  tennis_singles: 8.0,
  tennis_doubles: 6.0,
};

export type ActivityInput = {
  activity?: string; // canonical name; resolved against MET_TABLE
  met?: number; // explicit override (wins if both supplied)
  duration_min: number;
  intensity_modifier?: number; // optional multiplier (e.g. 1.1 for "kept HR high")
};

export type ActivityResult = {
  activity: string | null;
  met_used: number;
  source: "explicit" | "table" | "modified";
  duration_min: number;
  kcal: number;
};

export type TrainingKcalResult = {
  weight_kg: number;
  entries: ActivityResult[];
  total_kcal: number;
  notes: string[];
};

export function resolveMet(input: { activity?: string; met?: number }): {
  met: number;
  source: "explicit" | "table";
  activity: string | null;
} {
  if (input.met != null) {
    if (!Number.isFinite(input.met) || input.met <= 0) {
      throw new Error(`met must be > 0 (got ${input.met})`);
    }
    return { met: input.met, source: "explicit", activity: input.activity ?? null };
  }
  const name = (input.activity ?? "").trim().toLowerCase();
  if (!name) {
    throw new Error("either activity (from MET table) or met (explicit value) required");
  }
  const found = MET_TABLE[name];
  if (found == null) {
    throw new Error(
      `unknown activity '${name}' — pass an explicit met value, or use one of: ${Object.keys(
        MET_TABLE,
      )
        .slice(0, 12)
        .join(", ")}, …`,
    );
  }
  return { met: found, source: "table", activity: name };
}

export function kcalForActivity(weight_kg: number, met: number, duration_min: number): number {
  return Math.round((met * 3.5 * weight_kg * duration_min) / 200);
}

export function estimateTrainingKcal(
  weight_kg: number,
  entries: ActivityInput[],
): TrainingKcalResult {
  if (!Number.isFinite(weight_kg) || weight_kg <= 0) {
    throw new Error("weight_kg required (positive number)");
  }
  if (!entries.length) {
    throw new Error("entries[] required (at least one activity)");
  }
  const out: ActivityResult[] = [];
  const notes: string[] = [];
  let total = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.duration_min) || e.duration_min <= 0) {
      throw new Error(`duration_min must be > 0 (got ${e.duration_min})`);
    }
    const resolved = resolveMet(e);
    let met = resolved.met;
    let source: "explicit" | "table" | "modified" = resolved.source;
    if (e.intensity_modifier != null) {
      if (!Number.isFinite(e.intensity_modifier) || e.intensity_modifier <= 0) {
        throw new Error("intensity_modifier must be > 0");
      }
      met = met * e.intensity_modifier;
      source = "modified";
    }
    const kcal = kcalForActivity(weight_kg, met, e.duration_min);
    out.push({
      activity: resolved.activity,
      met_used: Math.round(met * 100) / 100,
      source,
      duration_min: e.duration_min,
      kcal,
    });
    total += kcal;
  }
  notes.push(
    "MET-based estimate; expect ±15–25% individual variance. Do NOT subtract from daily macro target — activity_level already accounts for typical training.",
  );
  return { weight_kg, entries: out, total_kcal: total, notes };
}

/**
 * Resistance-training energy expenditure as a HYBRID of two components:
 *
 *  1. Mechanical work — Σ(load × reps) × g × bar-path, over the lifting and
 *     lowering phases, divided by gross efficiency (+ a small EPOC afterburn).
 *     This is what distinguishes a heavy, high-volume session from a light one:
 *     two lifters training the same 45 min burn differently if one moves 12 t and
 *     the other 4 t. But taken alone it UNDER-reads real cost — it's 0 for an
 *     isometric hold and ignores stabilization, bracing, and the metabolism that
 *     stays elevated through the rest periods.
 *
 *  2. A MET baseline — MET × 3.5 × bodyweight × minutes / 200 — covering that
 *     "always-on" metabolic cost the work term misses. Crucially, the minutes are
 *     derived from the SET COUNT (~3 min per set, incl. rest), NEVER wall-clock,
 *     so a session left "active" for hours/days can't inflate the burn.
 *
 *   kcal ≈ w · [Σ(load × reps) × g × ROM × phase / efficiency × epoc]
 *          + (1 − w) · [MET × 3.5 × bodyweight × (sets × min_per_set) / 200]
 *
 * The 50/50 blend keeps the work signal (heavier ⇒ more) while a flat MET can't
 * wipe it out, and lands close to indirect-calorimetry figures (~300–400 kcal for
 * a full-body hour) instead of the work-only ~250. Without a bodyweight we can't
 * form the MET term, so we fall back to the work-only estimate.
 */
const G = 9.81;
const J_PER_KCAL = 4184;
// Tunable model parameters (documented above). Kept together so the calibration
// is easy to find and adjust.
const RT_ROM_M = 0.5; // average vertical bar path per rep, metres
const RT_PHASE_FACTOR = 1.5; // concentric (1.0) + eccentric at ~half metabolic cost
const RT_GROSS_EFFICIENCY = 0.13; // whole-movement gross efficiency (low for lifting)
const RT_EPOC_FACTOR = 1.1; // ~10% afterburn
const RT_BODYWEIGHT_FRACTION = 0.5; // moved mass for a bodyweight rep, as a fraction of bodyweight
const RT_MET_BASELINE = 5.0; // moderate resistance training (ACSM/Compendium tier)
const RT_MIN_PER_SET = 3; // bounded time proxy per counted set (work + rest); NOT wall-clock
const RT_WORK_WEIGHT = 0.5; // blend weight: w·work + (1−w)·MET-baseline

export type ResistanceSetLoad = { weight_kg: number; reps: number };

export type ResistanceKcalResult = {
  total_kcal: number; // hybrid (work + MET baseline), or work-only when no bodyweight
  work_kcal: number; // mechanical-work component, before the MET blend
  met_baseline_kcal: number; // MET-baseline component (0 when no bodyweight → work-only)
  assumed_min: number; // set-count-derived minutes used for the baseline (0 when work-only)
  total_volume_kg: number; // effective tonnage (Σ load × reps) used in the estimate
  total_reps: number;
  sets_counted: number;
  mechanical_work_kj: number;
  notes: string[];
};

export function estimateResistanceKcal(
  sets: ResistanceSetLoad[],
  bodyweight_kg?: number | null,
): ResistanceKcalResult {
  let volume = 0;
  let reps = 0;
  let counted = 0;
  let workJ = 0;
  let usedBodyweight = false;
  for (const s of sets) {
    const r = Number(s.reps);
    if (!Number.isFinite(r) || r <= 0) continue;
    let load = Number(s.weight_kg);
    if (!Number.isFinite(load) || load <= 0) {
      // Bodyweight movement logged with no external load (push-ups, pull-ups):
      // approximate the moved mass as a fraction of bodyweight so it isn't zero.
      if (bodyweight_kg != null && bodyweight_kg > 0) {
        load = RT_BODYWEIGHT_FRACTION * bodyweight_kg;
        usedBodyweight = true;
      } else {
        continue;
      }
    }
    const v = load * r;
    volume += v;
    reps += r;
    counted += 1;
    workJ += v * G * RT_ROM_M * RT_PHASE_FACTOR;
  }
  const metabolicJ = (workJ / RT_GROSS_EFFICIENCY) * RT_EPOC_FACTOR;
  const workKcal = metabolicJ / J_PER_KCAL;

  // Blend in the MET baseline when we have a bodyweight and something to time.
  // Minutes come from the set count, not the clock, so an "active" session can't
  // inflate the burn. No bodyweight ⇒ keep the work-only estimate.
  let total = workKcal;
  let metBaselineKcal = 0;
  let assumedMin = 0;
  if (bodyweight_kg != null && bodyweight_kg > 0 && counted > 0) {
    assumedMin = counted * RT_MIN_PER_SET;
    metBaselineKcal = kcalForActivity(bodyweight_kg, RT_MET_BASELINE, assumedMin);
    total = RT_WORK_WEIGHT * workKcal + (1 - RT_WORK_WEIGHT) * metBaselineKcal;
  }

  const notes: string[] = [];
  if (metBaselineKcal > 0) {
    notes.push(
      "Hybrid estimate: a MET baseline for the session (metabolism that stays elevated through the sets and rests, plus stabilization/bracing) blended 50/50 with the mechanical work of the load moved (load × reps × bar path), so heavier, higher-volume sessions burn more than light ones of the same length.",
      'Session minutes are derived from the number of sets (~3 min each, incl. rest), not the clock, so a session left "active" can\'t inflate the burn. Assumes ~0.5 m average bar path per rep. Expect ±30% individual variance.',
    );
  } else {
    notes.push(
      "Work-based estimate: energy scales with total mechanical work (load × reps × bar path), so heavier, higher-volume sessions burn more than light ones of the same length. Reads lower than a duration estimate because it excludes rest-between-sets metabolism. Assumes ~0.5 m average bar path per rep; expect ±30% individual variance.",
    );
  }
  notes.push(
    "Do NOT subtract from your daily target — activity_level already covers typical training.",
  );
  if (usedBodyweight) {
    notes.push(
      `Bodyweight sets (no external load) were estimated at ${Math.round(RT_BODYWEIGHT_FRACTION * 100)}% of bodyweight moved per rep.`,
    );
  }
  return {
    total_kcal: Math.round(total),
    work_kcal: Math.round(workKcal),
    met_baseline_kcal: Math.round(metBaselineKcal),
    assumed_min: assumedMin,
    total_volume_kg: Math.round(volume),
    total_reps: reps,
    sets_counted: counted,
    mechanical_work_kj: Math.round(workJ / 1000),
    notes,
  };
}

// Cardio work (running/cycling/rowing…) is energetically the opposite of lifting:
// the burn tracks TIME at an intensity, not mechanical load. So cardio sets are
// costed the MET way — MET × 3.5 × bodyweight × minutes / 200 — keyed off the
// exercise. The catalog carries no MET, so each cardio exercise maps to a
// representative MET_TABLE tier here (a moderate default; without logged pace we
// can't tell an easy jog from a sprint).
export const CARDIO_MET_DEFAULTS: Record<string, string> = {
  walking: "walking_brisk",
  treadmill_run: "running_moderate",
  stationary_bike_ride: "cycling_moderate",
  elliptical_session: "elliptical",
  rowing_machine: "rowing_moderate",
  stair_climber_session: "stair_climber",
  // Timed holds, logged by duration like cardio but far less demanding.
  plank: "calisthenics_moderate",
  side_plank: "calisthenics_moderate",
};

// MET for a cardio exercise id — its mapped tier, else a generic moderate-cardio
// value (~6) so an unmapped cardio movement still estimates rather than reading 0.
export function cardioMetFor(exerciseId: string): number {
  const key = CARDIO_MET_DEFAULTS[exerciseId];
  const met = key ? MET_TABLE[key] : undefined;
  return met ?? 6;
}

// Calories for a single logged cardio set from its duration. Returns 0 when
// there's no positive duration or bodyweight (nothing to estimate from).
export function estimateCardioSetKcal(
  exerciseId: string,
  durationSec: number,
  bodyweightKg: number,
): number {
  if (!(durationSec > 0) || !(bodyweightKg > 0)) return 0;
  return kcalForActivity(bodyweightKg, cardioMetFor(exerciseId), durationSec / 60);
}
