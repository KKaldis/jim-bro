/**
 * Tool definitions — Body math · stateless calculators (no saved profile required).
 */
export const BODY_MATH_DEFS = [
  {
    name: "compute_bmi",
    description:
      "Compute BMI (kg / m²) from inline inputs WITHOUT requiring a saved profile. Use this whenever the user asks 'what's my BMI', 'am I overweight by BMI', or asks for a healthy-weight range for their height. Returns BMI, WHO category, and the healthy-weight band (kg) for the given height. NEVER do the BMI arithmetic OR unit conversions in your head — pass the values as the user gave them and set units accordingly. Always reads back the high-muscle caveat (BMI doesn't distinguish lean from fat) when reporting to the user.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        weight_kg: {
          type: "number",
          description: "Required when units=metric. Pass weight_lb when units=imperial.",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        height_cm: {
          type: "number",
          description: "Required when units=metric. Pass height_in when units=imperial.",
        },
        height_in: { type: "number", description: "Use with units=imperial." },
      },
    },
  },
  {
    name: "compute_ffmi",
    description:
      "Compute Fat-Free Mass Index (FFMI) from inline inputs WITHOUT requiring a saved profile. Use when the user asks 'what's my FFMI', 'how muscular am I', 'how close to the natural ceiling', or wants to track lean-mass progression separately from weight. Requires body_fat_pct — if the user doesn't have it, run estimate_body_fat first (navy circumferences or deurenberg). Returns FFMI, normalized FFMI (height-adjusted to 1.8m), fat-free mass kg, fat mass kg, and a category using the Kouri 1995 reference scale. NEVER do the FFMI arithmetic OR unit conversions in your head — pass the values as the user gave them and set units accordingly. When reporting, always pass on the notes the tool returns (FFMI is only as good as the BF% input; the ~25 'natural ceiling' refers to the normalized value, not the raw one).",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        weight_kg: {
          type: "number",
          description: "Required when units=metric. Pass weight_lb when units=imperial.",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        height_cm: {
          type: "number",
          description: "Required when units=metric. Pass height_in when units=imperial.",
        },
        height_in: { type: "number", description: "Use with units=imperial." },
        body_fat_pct: {
          type: "number",
          description:
            "Required. Body fat as a percentage (e.g. 18.5 for 18.5%). If unknown, run estimate_body_fat first.",
        },
      },
      required: ["sex", "body_fat_pct"],
    },
  },
  {
    name: "compute_bmr",
    description:
      "Compute BMR / TDEE / daily macro target from inline inputs WITHOUT requiring a saved profile. Use this whenever the user asks 'what's my BMR', 'how many calories should I eat', or wants to compare scenarios ('what if I trained 5x instead of 3x'). NEVER do the BMR/TDEE arithmetic OR unit conversions in your head — pass the values as the user gave them and set units accordingly. Uses Mifflin-St Jeor by default; switches to Katch-McArdle if body_fat_pct is provided. activity_level and goal are optional: omit them for BMR-only; include them for TDEE and macro split.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        sex: { type: "string", enum: ["male", "female"] },
        weight_kg: {
          type: "number",
          description: "Required when units=metric. Pass weight_lb when units=imperial.",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        height_cm: {
          type: "number",
          description: "Required when units=metric. Pass height_in when units=imperial.",
        },
        height_in: { type: "number", description: "Use with units=imperial." },
        age: {
          type: "integer",
          description: "Age in years. Either age or dob is required.",
        },
        dob: {
          type: "string",
          description: "YYYY-MM-DD. Takes precedence over age if both given.",
        },
        body_fat_pct: {
          type: "number",
          description: "Optional. When provided, Katch-McArdle is used (more accurate).",
        },
        activity_level: {
          type: "string",
          enum: ["sedentary", "light", "moderate", "very", "extreme"],
          description: "Required for TDEE. Omit for BMR-only.",
        },
        goal: {
          type: "string",
          enum: ["cut", "maintain", "recomp", "lean_bulk"],
          description: "Required for daily macro target. Omit to skip macro split.",
        },
      },
      required: ["sex"],
    },
  },
  {
    name: "compute_macro_split",
    description:
      "Split a calorie target the user ALREADY HAS into protein / carbs / fat / fibre grams, WITHOUT requiring a saved profile. Use for 'I eat 2200 kcal, what should my macros be', 'split 1800 calories for a cut'. If the user has no calorie number yet, use compute_bmr (which computes TDEE and the split together). Protein is set per kg of lean mass (bodyweight if body_fat_pct is omitted) by goal, fat at 0.9 g/kg, carbs fill the rest. NEVER do the arithmetic in your head. Returns grams, percent of calories per macro, and notes (including when the target is too low to leave any carbs) — pass the notes on.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        kcal: { type: "number", description: "Daily calorie target to split." },
        weight_kg: {
          type: "number",
          description:
            "Bodyweight. Required when units=metric. Pass weight_lb when units=imperial.",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        body_fat_pct: {
          type: "number",
          description:
            "Optional. When provided, protein is based on lean mass instead of bodyweight.",
        },
        goal: { type: "string", enum: ["cut", "maintain", "recomp", "lean_bulk"] },
      },
      required: ["kcal", "goal"],
    },
  },
  {
    name: "compute_protein_target",
    description:
      "Daily protein target in grams from bodyweight, optional body fat and goal, WITHOUT requiring a saved profile. Use for 'how much protein should I eat', 'protein per day for a cut', 'how much protein per meal'. Same per-kg rule as compute_bmr's macro split (2.4 g/kg lean mass on a cut, 2.2 maintain/recomp, 1.8 lean bulk), so the two never disagree. Returns grams/day, per-meal split, g per kg bodyweight, and the RDA floor for reference. NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        weight_kg: {
          type: "number",
          description:
            "Bodyweight. Required when units=metric. Pass weight_lb when units=imperial.",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        body_fat_pct: {
          type: "number",
          description:
            "Optional. When provided, protein is based on lean mass instead of bodyweight.",
        },
        goal: { type: "string", enum: ["cut", "maintain", "recomp", "lean_bulk"] },
        meals: {
          type: "integer",
          description: "Optional meals per day for the per-meal split (default 4).",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "compute_calorie_deficit",
    description:
      "Plan a cut to a goal weight, WITHOUT requiring a saved profile: daily calories, deficit, weekly loss and weeks to goal, plus the cut macro split. Use for 'how many calories to lose 10 kg', 'how long to get to 75 kg', 'what deficit do I need'. Maintenance comes from the same Mifflin-St Jeor / Katch-McArdle maths as compute_bmr; the deficit is weekly_loss_pct of bodyweight × 7700 kcal/kg. Intake is never set below 1500 kcal (men) / 1200 (women) — when capped, `capped` is true and the timeline stretches. goal_weight must be below current weight. NEVER do the arithmetic in your head; pass on the notes (recalculate every 4-5 kg, aggressive-rate and low-goal-BMI warnings).",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        sex: { type: "string", enum: ["male", "female"] },
        age: { type: "integer", description: "Age in years." },
        weight_kg: {
          type: "number",
          description:
            "Bodyweight. Required when units=metric. Pass weight_lb when units=imperial.",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        height_cm: {
          type: "number",
          description: "Required when units=metric. Pass height_in when units=imperial.",
        },
        height_in: { type: "number", description: "Use with units=imperial." },
        body_fat_pct: {
          type: "number",
          description:
            "Optional. Switches maintenance to Katch-McArdle and bases protein on lean mass.",
        },
        activity_level: {
          type: "string",
          enum: ["sedentary", "light", "moderate", "very", "extreme"],
        },
        goal_weight_kg: { type: "number", description: "Use with units=metric." },
        goal_weight_lb: { type: "number", description: "Use with units=imperial." },
        weekly_loss_pct: {
          type: "number",
          description:
            "Planned loss per week as % of bodyweight, 0.25-1.5. Default 0.5 (sustainable); above 1 costs more muscle.",
        },
      },
      required: ["sex", "age", "activity_level"],
    },
  },
  {
    name: "estimate_body_fat",
    description:
      "Estimate body fat % when the user doesn't have a DEXA/BIA reading. NEVER guess body fat from a photo, do the math in your head, OR do unit conversions in your head — pass the measurements as the user gave them and set units accordingly. Two methods: 'navy' uses circumferences (waist + neck + height for men; waist + hip + neck + height for women) and is the more accurate option when measurements are taken correctly (waist at navel, neck below larynx, hip at widest point). 'deurenberg' uses BMI + age + sex when no tape measure is available — call out that it's a population-level estimate with ±4-5% error. 'army' is the 2023 US Army one-site tape test: a single waist girth at the navel plus bodyweight, no height or neck needed — use it when the user only has a waist measurement or asks for the Army method. State measurement assumptions back to the user before calling. Results are not auto-saved; if the user wants this on their profile, follow up with update_profile.",
    schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["navy", "deurenberg", "army"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): cm + kg. imperial: inches + lb. The tool converts internally before applying the formula.",
        },
        sex: { type: "string", enum: ["male", "female"] },
        // height (navy + deurenberg)
        height_cm: { type: "number", description: "navy/deurenberg + metric." },
        height_in: { type: "number", description: "navy/deurenberg + imperial." },
        // navy:
        neck_cm: { type: "number", description: "navy + metric. Measured below the larynx." },
        neck_in: { type: "number", description: "navy + imperial." },
        waist_cm: {
          type: "number",
          description:
            "navy/army + metric. Navy: men at the navel, women at the narrowest point. Army: everyone at the navel.",
        },
        waist_in: { type: "number", description: "navy/army + imperial." },
        hip_cm: { type: "number", description: "navy + metric, women only — widest point." },
        hip_in: { type: "number", description: "navy + imperial, women only." },
        // deurenberg:
        weight_kg: { type: "number", description: "deurenberg/army + metric." },
        weight_lb: { type: "number", description: "deurenberg/army + imperial." },
        age: { type: "integer", description: "deurenberg only." },
      },
      required: ["method", "sex"],
    },
  },
  {
    name: "compute_lean_body_mass",
    description:
      "Lean body mass (fat-free mass) and fat mass, WITHOUT requiring a saved profile. Use for 'what's my lean body mass', 'how much of me is muscle / fat-free', 'what's my fat mass'. With body_fat_pct it is weight × (1 − BF); without one it estimates from height and weight with Boer (also returns James and Hume for comparison). NEVER do the arithmetic in your head. Pass on the notes — the formulas assume average muscularity.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        sex: { type: "string", enum: ["male", "female"] },
        weight_kg: { type: "number", description: "Bodyweight. Use with units=metric." },
        weight_lb: { type: "number", description: "Bodyweight. Use with units=imperial." },
        height_cm: { type: "number", description: "Use with units=metric." },
        height_in: { type: "number", description: "Use with units=imperial." },
        body_fat_pct: {
          type: "number",
          description: "Optional. When given, lean mass is computed from it directly.",
        },
      },
      required: ["sex"],
    },
  },
  {
    name: "get_body_composition",
    description:
      "The user's CURRENT body composition, read from their latest logged weigh-in (body_comp_entry) — renders a summary card with body-fat %, BMI, FFMI/lean mass, and weight (each with its color-graded gauge). Call this whenever the user asks about their existing numbers — 'what's my body composition', 'what's my body fat', 'what's my BMI', 'how muscular am I', 'where am I at' — INSTEAD of reciting the figures you already see in profile_summary.latest_body_comp. The card IS the answer; reciting from context shows no card. When the user asks about ONE specific metric ('what's my body fat', 'what's my BMI', 'how muscular am I' → ffmi, 'what do I weigh'), pass `focus` so the card shows just that stat instead of the full grid; omit it for the whole composition ('where am I at', 'body composition'). This reads stored data and computes nothing new — for hypothetical/ad-hoc math from values the user supplies inline, use compute_bmi / compute_ffmi / estimate_body_fat instead. Reports an error if the user has no profile or no weigh-in yet (onboard them with update_profile + log_body_comp).",
    schema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          enum: ["body_fat", "bmi", "ffmi", "weight"],
          description:
            "Optional. When the user asks about a SINGLE current metric, pass it so the card renders just that stat (with its gauge + matching trend): 'what's my body fat' → body_fat, 'what's my BMI' → bmi, 'how muscular am I' / FFMI / lean mass → ffmi, 'what do I weigh' → weight. Omit for the full body-composition view.",
        },
        window_days: {
          type: "integer",
          description:
            "Optional. Window (in days) for the weight/body-fat/lean-mass trend deltas shown on the card. Defaults to 14.",
        },
      },
    },
  },
  {
    name: "estimate_vo2_max",
    description:
      "Estimate VO₂max (ml·kg⁻¹·min⁻¹) — the standard measure of aerobic / cardio fitness — from age, sex, and resting heart rate, WITHOUT requiring a saved profile. Use whenever the user asks 'what's my VO₂max', 'how's my cardio / aerobic fitness', 'estimate my cardio level', or gives you a resting heart-rate reading. Uses the Uth (2004) HRmax/HRrest ratio; HRmax defaults to the Tanaka estimate (208 − 0.7 × age) unless the user gives a measured value. NEVER do the arithmetic in your head — pass the values the user gave. resting_heart_rate must be a true RESTING reading (seated/lying after a few minutes of quiet), not a daytime or post-exercise pulse — confirm that with the user if unsure. Returns the VO₂max estimate, the HRmax used, and a fitness category (poor/fair/good/excellent/superior) from age- and sex-specific population norms. ALWAYS pass on the notes the tool returns (it's an estimate, accuracy depends on a true resting HR, categories are reference ranges).",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        age: {
          type: "integer",
          description: "Age in years. Required (used to estimate HRmax).",
        },
        resting_heart_rate: {
          type: "number",
          description:
            "Resting heart rate in bpm — measured seated or lying down after a few minutes of rest (ideally first thing in the morning). Plausible range 30-120.",
        },
        max_heart_rate: {
          type: "number",
          description:
            "Optional measured/known max heart rate in bpm (from a max-effort test or chest-strap monitor). When omitted, the tool estimates it from age (Tanaka: 208 − 0.7 × age).",
        },
      },
      required: ["sex", "age", "resting_heart_rate"],
    },
  },
  {
    name: "compute_ideal_weight",
    description:
      "Ideal body weight for a height and sex from the four classic formulas (Devine, Robinson, Miller, Hamwi) plus the healthy BMI 18.5-24.9 weight range, WITHOUT requiring a saved profile. Use for 'what's my ideal weight', 'what should I weigh at my height'. The formulas come from drug dosing and ignore muscle — always pass that caveat on, and for someone who lifts point to FFMI / body fat instead. NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): height in cm. imperial: height in inches. Results are always kg.",
        },
        sex: { type: "string", enum: ["male", "female"] },
        height_cm: { type: "number", description: "Use with units=metric." },
        height_in: { type: "number", description: "Use with units=imperial." },
      },
      required: ["sex"],
    },
  },
  {
    name: "compute_heart_rate_zones",
    description:
      "Max heart rate and five training zones in bpm, WITHOUT requiring a saved profile. Use for 'what are my heart rate zones', 'what's my zone 2', 'what heart rate should I run at', 'what's my max heart rate'. HRmax is the Tanaka estimate (208 − 0.7 × age) unless the user gives a measured one, the same as estimate_vo2_max. With a resting heart rate the zones use Karvonen (heart-rate reserve); without, plain % of max. NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        age: { type: "integer", description: "Age in years." },
        resting_heart_rate: {
          type: "number",
          description: "Optional true resting HR in bpm (30-120). Switches the zones to Karvonen.",
        },
        max_heart_rate: {
          type: "number",
          description: "Optional measured max HR in bpm. Omitted → Tanaka estimate from age.",
        },
      },
      required: ["age"],
    },
  },
  {
    name: "compute_water_intake",
    description:
      "Recommended daily water to DRINK, WITHOUT requiring a saved profile: 35 ml/kg bodyweight + ~600 ml per hour of exercise + 500 ml on a hot day. Use for 'how much water should I drink', 'what should my water goal be'. This only computes — to SAVE it as the user's daily goal, follow up with update_profile water_goal_ml (ask first). NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        weight_kg: { type: "number", description: "Bodyweight. Use with units=metric." },
        weight_lb: { type: "number", description: "Bodyweight. Use with units=imperial." },
        exercise_min: { type: "number", description: "Optional minutes of exercise that day." },
        climate: {
          type: "string",
          enum: ["temperate", "hot"],
          description: "Optional, default temperate.",
        },
        sex: {
          type: "string",
          enum: ["male", "female"],
          description: "Optional — adds the EFSA reference intake.",
        },
      },
    },
  },
  {
    name: "compute_step_calories",
    description:
      "Calories burned and distance walked from a step count, plus a daily step goal for the user's age (Paluch 2022), WITHOUT requiring a saved profile. Use for 'how many calories is 10,000 steps', 'how far is 8k steps', 'how many steps should I do a day'. Stride is estimated from height; net_kcal excludes resting burn and is the figure to quote. NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg, height in cm. imperial: weight in lb, height in inches. The tool converts internally.",
        },
        steps: { type: "number", description: "Step count." },
        sex: { type: "string", enum: ["male", "female"] },
        weight_kg: { type: "number", description: "Bodyweight. Use with units=metric." },
        weight_lb: { type: "number", description: "Bodyweight. Use with units=imperial." },
        height_cm: { type: "number", description: "Use with units=metric." },
        height_in: { type: "number", description: "Use with units=imperial." },
        pace: {
          type: "string",
          enum: ["slow", "brisk"],
          description: "Optional walking pace, default brisk.",
        },
        age: {
          type: "integer",
          description: "Optional — picks the step-goal band (over 60 is lower).",
        },
      },
      required: ["steps", "sex"],
    },
  },
  {
    name: "log_cardio",
    description:
      "Save a cardio-fitness reading (resting heart rate, optional max HR) as a dated entry so VO₂max can be TRACKED over time on the Progress screen — this is the persistent counterpart to estimate_vo2_max (which only computes, never saves). Use when the user wants to record/track their resting HR or VO₂max ('log my resting heart rate', 'track my cardio fitness', 'save this — 58 bpm this morning'). Reads age + sex from the saved profile to derive and snapshot VO₂max + its fitness category at write time, so the profile must exist first (call update_profile if not). resting_heart_rate must be a true RESTING reading (seated/lying after a few minutes of rest). Returns the saved entry with the computed VO₂max, category, and total entry count. For a one-off 'what's my VO₂max' with no desire to save, use estimate_vo2_max instead.",
    schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD; defaults to today.",
        },
        resting_heart_rate: {
          type: "number",
          description:
            "Resting heart rate in bpm — measured seated/lying after a few minutes of rest (ideally on waking). Required. Plausible range 30-120.",
        },
        max_heart_rate: {
          type: "number",
          description:
            "Optional measured/known max HR in bpm. When omitted, it's estimated from age (Tanaka: 208 − 0.7 × age).",
        },
        notes: {
          type: "string",
          description: "Optional free-text note (e.g. 'after a rest week').",
        },
      },
      required: ["resting_heart_rate"],
    },
  },
  {
    name: "delete_cardio_entry",
    description:
      "Delete a single saved cardio reading by its entry id (the `id` field on entries returned from the Progress data). Use to undo a wrong log. Returns {deleted:true} on success, or an error if no entry with that id belongs to the user.",
    schema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "The cardio entry's row id.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "update_cardio_entry",
    description:
      "Edit a saved cardio reading in place by its entry id (the `id` field on entries returned from the Progress data) — WITHOUT deleting and re-logging. Use to fix a wrong log ('that resting HR was 56, not 65') or to MOVE the reading to a different day ('that reading was actually yesterday') — pass `date` to move it. Preserves the entry's id and original logged-at timestamp. When you change resting_heart_rate or max_heart_rate, VO₂max and its fitness category are recomputed from the profile and re-snapshotted. Pass ONLY the fields you want to change; omitted fields keep their current value. Returns the updated entry with the recomputed VO₂max. Prefer this over delete_cardio_entry + log_cardio for any correction.",
    schema: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "The cardio entry's row id (from the Progress data).",
        },
        date: {
          type: "string",
          description:
            "YYYY-MM-DD — pass ONLY to move the entry to a different day (e.g. 'that was yesterday'). Omit to keep it on its current date.",
        },
        resting_heart_rate: {
          type: "number",
          description:
            "Optional — new resting heart rate in bpm (seated/lying after rest). When given, VO₂max is recomputed. Plausible range 30-120.",
        },
        max_heart_rate: {
          type: "number",
          description:
            "Optional — new measured/known max HR in bpm. Pass to set or correct it; pass 0/empty to clear it back to the age-based estimate. When given, VO₂max is recomputed.",
        },
        notes: {
          type: "string",
          description: "Optional free-text note. Pass an empty string to clear it.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "log_measurements",
    description:
      "Save the user's tape-measure CIRCUMFERENCES for a day so muscle proportions can be TRACKED over time on Body → Measurements (and so compute_ideal_proportions / classify_body_shape auto-fill them next time). One measuring session per day: calling again for the same date MERGES into it — omitted fields keep their value, null clears one. Muscle girths (shoulders, chest, flexed arm, forearm, thigh, calf) are stored on the measurement session. Waist / neck / hip are SHARED with body composition: they're written onto that day's weigh-in (where they also drive the Navy body-fat estimate), so passing them edits the weigh-in. If there's no weigh-in that day, waist / neck / hip need `weight_kg` too (a new weigh-in is created) — ask the user for today's weight rather than guessing. Values are metric cm (convert inches × 2.54 and state it). All circumferences are wrap-around measurements, never straight-line widths. Use for 'log my measurements', 'my arm is 40 cm now', 'save these girths'. For a one-off comparison with no desire to save, call compute_ideal_proportions directly.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today." },
        shoulders_cm: {
          type: "number",
          description: "Around the widest point of the deltoids, arms relaxed.",
        },
        chest_cm: {
          type: "number",
          description: "Chest (men) / bust (women) at the fullest point.",
        },
        arm_cm: { type: "number", description: "Upper arm FLEXED at the peak of the biceps." },
        forearm_cm: { type: "number", description: "Forearm at its widest, fist clenched." },
        thigh_cm: {
          type: "number",
          description: "Upper thigh at its widest, just below the glutes.",
        },
        calf_cm: { type: "number", description: "Calf at its widest." },
        waist_cm: {
          type: "number",
          description: "Shared with the day's weigh-in. Navy method: at the navel.",
        },
        neck_cm: {
          type: "number",
          description: "Shared with the day's weigh-in. Just below the larynx.",
        },
        hip_cm: {
          type: "number",
          description: "Shared with the day's weigh-in. Widest point of the glutes.",
        },
        weight_kg: {
          type: "number",
          description: "Only needed when passing waist / neck / hip on a day with no weigh-in yet.",
        },
        notes: { type: "string", description: "Optional note on the measuring session." },
        time: {
          type: "string",
          description: "HH:MM (24h, local) when it was measured. Optional; omit if unknown.",
        },
      },
      required: [],
    },
  },
  {
    name: "compute_max_potential",
    description:
      "Estimate the user's drug-free maximum muscular potential (Casey Butt 2008 formula) from wrist + ankle circumferences, height, and sex. Wrist and ankle are skeletal-frame proxies that don't change with training — the result is a LIFETIME CEILING for lean body mass, not a near-term target. Use whenever the user asks 'how much muscle can I build naturally', 'what's my genetic ceiling', 'what's the most I could weigh lean', or wants to compare their current physique to their potential. Returns max LBM and max total weight at the evaluated body-fat %, a reference band at typical body-fat levels (stage / very lean / athletic / maintainable), and rule-of-thumb predicted max girths for chest, neck, bicep, forearm, thigh, and calf. NEVER do the arithmetic OR unit conversions in your head — pass values as the user gave them and set units accordingly. The formula was fit on male champion natural bodybuilders; female estimates apply a 0.85 scalar with weaker validation — flag that caveat. ALWAYS pass on the notes the tool returns (lifetime ceiling vs near-term, measurement consistency, circumference ratios are approximate). Wrist is measured at the narrowest point distal to the styloid; ankle at the narrowest point above the lateral malleolus — state those if the user just gave you a number.",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): cm. imperial: inches. The tool converts internally.",
        },
        height_cm: {
          type: "number",
          description: "Required when units=metric. Pass height_in when units=imperial.",
        },
        height_in: { type: "number", description: "Use with units=imperial." },
        wrist_cm: {
          type: "number",
          description:
            "Wrist circumference at the narrowest point, distal to the styloid (the bony bump on the pinky side). Required when units=metric.",
        },
        wrist_in: { type: "number", description: "Use with units=imperial." },
        ankle_cm: {
          type: "number",
          description:
            "Ankle circumference at the narrowest point ABOVE the lateral malleolus (not at the ankle bone itself). Required when units=metric.",
        },
        ankle_in: { type: "number", description: "Use with units=imperial." },
        target_body_fat_pct: {
          type: "number",
          description:
            "Body fat % at which to evaluate the LBM ceiling (LBM is slightly higher off-season than at stage-lean). Optional — defaults to 8% (male) / 18% (female).",
        },
      },
      required: ["sex"],
    },
  },
  {
    name: "compute_ideal_proportions",
    description:
      "Compare the user's tape measurements against 'ideal' aesthetic proportions scaled to their skeletal frame (wrist), and rank which body parts lag. Renders a radar chart (100% = ideal) plus a per-part table. Men: classic Grecian ideal (chest 6.5x wrist, waist 70% of chest, flexed arm / neck / calf 2.5x wrist; McCallum's ratios for forearm, thigh and hips; golden-ratio shoulders 1.618x waist). Women: the app's hourglass convention (bust = hips = 6.0x wrist, waist 70% of hips, golden-ratio shoulders, limb targets from lean trained women) - there's no published wrist-based female standard, so say it's a convention. Use for 'what are my ideal measurements', 'what should my arms/chest/waist be', 'which body part is lagging', 'am I proportional', 'golden ratio / Adonis index', or before recommending which muscles to prioritise. To judge whether the user's workout PLAN covers these priorities, call review_training_plan instead (it runs this comparison itself — don't call both). All inputs are CIRCUMFERENCES (tape wrapped around the body, snug and level) except height - never straight-line widths; if the user gives a width (e.g. 'shoulders 48 cm across'), ask for the wrap-around measurement instead. Every girth is optional - pass whatever the user measured; at least 3 parts make a useful profile. Sex, height, wrist (profile) and waist / neck / hips (latest weigh-in) auto-fill when omitted. The result's `priorities` list the lagging parts with the app's muscle ids - use them to suggest training focus (`reduce_waist` is a fat-loss lever, not ab training). NEVER do the arithmetic or unit conversions yourself. Pass on the notes (aesthetic reference, not a health target; measurement method).",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): cm. imperial: inches. The tool converts internally.",
        },
        wrist_cm: {
          type: "number",
          description:
            "Wrist circumference at the narrowest point just below the hand (frame anchor). Auto-filled from the profile.",
        },
        wrist_in: { type: "number", description: "Use with units=imperial." },
        height_cm: {
          type: "number",
          description: "Optional, for waist-to-height. Auto-filled from the profile.",
        },
        height_in: { type: "number", description: "Use with units=imperial." },
        shoulders_cm: {
          type: "number",
          description:
            "Shoulder circumference around the widest point of the deltoids, arms relaxed.",
        },
        shoulders_in: { type: "number", description: "Use with units=imperial." },
        chest_cm: {
          type: "number",
          description: "Chest (men) / bust (women) at the fullest point.",
        },
        chest_in: { type: "number", description: "Use with units=imperial." },
        waist_cm: {
          type: "number",
          description: "Waist at the narrowest point. Auto-filled from the latest weigh-in.",
        },
        waist_in: { type: "number", description: "Use with units=imperial." },
        hips_cm: {
          type: "number",
          description:
            "Hips at the widest point of the glutes. Auto-filled from the latest weigh-in.",
        },
        hips_in: { type: "number", description: "Use with units=imperial." },
        arm_cm: { type: "number", description: "Upper arm FLEXED at the peak of the biceps." },
        arm_in: { type: "number", description: "Use with units=imperial." },
        forearm_cm: { type: "number", description: "Forearm at its widest, fist clenched." },
        forearm_in: { type: "number", description: "Use with units=imperial." },
        neck_cm: {
          type: "number",
          description: "Neck just below the Adam's apple. Auto-filled from the latest weigh-in.",
        },
        neck_in: { type: "number", description: "Use with units=imperial." },
        thigh_cm: {
          type: "number",
          description: "Upper thigh at its widest, just below the glutes.",
        },
        thigh_in: { type: "number", description: "Use with units=imperial." },
        calf_cm: { type: "number", description: "Calf at its widest." },
        calf_in: { type: "number", description: "Use with units=imperial." },
      },
      required: [],
    },
  },
  {
    name: "review_training_plan",
    description:
      "Judge whether a workout plan gives the user's LAGGING body parts enough work: tallies weekly sets per body part from the plan (primary-muscle sets count 1, secondary 0.5) and sets them against the compute_ideal_proportions priorities, with a verdict per part (under / ok / over vs ~10-20 sets/week; lagging parts need 12+). One call does the whole comparison — it reads the plan and the latest measurements itself, so do NOT also call get_workout_plans or compute_ideal_proportions for this. Use for 'is my plan enough for my proportions', 'does my program fix my weak points', 'what should I add to my plan', 'am I training my arms enough'. Also returns `screen_totals` — the EXACT 'Muscle totals' the user sees on their plan in the app (Groups and Muscles views; primary muscles only, full credit). When the user quotes numbers from their plan screen, they come from there: answer with those, and explain any difference to `parts` as indirect/secondary work. Never call the app's numbers an 'external tracker'. Also returns `days` (per-day exercise/set counts) and `issues` (unscheduled_days, missing_target_weights, long_sessions) — structural problems to raise alongside volume. No card: answer in a few short lines from `gaps` (the under-dosed priority parts), the per-part verdicts and `issues`, naming concrete fixes (more sets for a part, an exercise to add, assigning weekdays). If `waist_priority` is true, say the waist is a fat-loss lever, not a training one. Errors with no_plan / proportions_unavailable — then say what's missing (a plan, or a wrist + tape measurements).",
    schema: {
      type: "object",
      properties: {
        plan_id: {
          type: "integer",
          description: "Plan to review. Omit for the user's ACTIVE plan.",
        },
      },
      required: [],
    },
  },
  {
    name: "classify_body_shape",
    description:
      "Classify the user's body shape from tape CIRCUMFERENCES (wrapped around the body, snug and level — never straight-line widths) and give their waist-to-hip ratio with the WHO risk band. Women (bust, waist, hips, optional high hip ~18 cm / 7 in below the waist): FFIT apparel rules as used by calculator.net - hourglass, bottom hourglass, top hourglass, spoon, triangle, inverted triangle, rectangle. Men (chest, waist, hips, optional shoulders): Alfrik's rules - trapezoid, triangle, rectangle, v_taper (inverted triangle), oval - with a shoulder/chest-to-waist taper fallback when no rule matches. Use for 'what's my body shape / body type', 'am I an hourglass / pear / apple', 'do I have a V-taper', 'what's my waist-to-hip ratio'. This is SHAPE from girths - for ideal proportions or which muscle lags, use compute_ideal_proportions. Sex (profile) and waist / hips (latest weigh-in) auto-fill when omitted. NEVER do the arithmetic or unit conversions yourself. Pass on the notes (it's a clothing-fit category; WHR is the health-relevant number).",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): cm. imperial: inches. The tool converts internally.",
        },
        bust_cm: {
          type: "number",
          description: "Women: bust over the fullest part, in a fitted bra.",
        },
        bust_in: { type: "number", description: "Use with units=imperial." },
        chest_cm: { type: "number", description: "Men: chest at nipple level." },
        chest_in: { type: "number", description: "Use with units=imperial." },
        shoulders_cm: {
          type: "number",
          description:
            "Men, optional: shoulder circumference around the deltoids - enables the Adonis index.",
        },
        shoulders_in: { type: "number", description: "Use with units=imperial." },
        waist_cm: {
          type: "number",
          description: "Waist at the narrowest point. Auto-filled from the latest weigh-in.",
        },
        waist_in: { type: "number", description: "Use with units=imperial." },
        high_hip_cm: {
          type: "number",
          description:
            "Women, optional: ~18 cm (7 in) below the natural waist. Separates spoon from bottom hourglass.",
        },
        high_hip_in: { type: "number", description: "Use with units=imperial." },
        hips_cm: {
          type: "number",
          description:
            "Hips at the widest point of the glutes. Auto-filled from the latest weigh-in.",
        },
        hips_in: { type: "number", description: "Use with units=imperial." },
      },
      required: [],
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
