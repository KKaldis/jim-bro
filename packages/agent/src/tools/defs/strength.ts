/**
 * Tool definitions — Strength · StrengthLevel calculators (no saved profile required).
 */
export const STRENGTH_DEFS = [
  {
    name: "convert_rpe",
    description:
      "Convert between RPE, reps in reserve and % of 1RM with the RTS-style chart, and plan a load: from a set the user did (weight × reps @ RPE) it returns the estimated 1RM and the load for a target set (target_reps @ target_rpe, default a single @ 8), plus loads for 1-10 reps at the target RPE. Use for 'what's 100 kg × 5 @ 8 as a max', 'what should I use for 3 @ RPE 8', 'what does RPE 7 mean'. Reps 1-12, RPE 6-10 in half steps. NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): loads in kg. imperial: loads in lb.",
        },
        weight_kg: { type: "number", description: "Load of the known set. Use with units=metric." },
        weight_lb: {
          type: "number",
          description: "Load of the known set. Use with units=imperial.",
        },
        reps: { type: "integer", description: "Reps of the known set (1-12)." },
        rpe: { type: "number", description: "RPE of the known set (6-10, half steps)." },
        target_reps: {
          type: "integer",
          description: "Optional reps for the set to plan (default 1).",
        },
        target_rpe: {
          type: "number",
          description: "Optional RPE for the set to plan (default 8).",
        },
      },
      required: ["reps", "rpe"],
    },
  },
  {
    name: "plan_warmup_sets",
    description:
      "Warm-up ramp to a top set with the plates per side for each set: empty bar × 10, then ~40% × 5, 60% × 3, 75% × 2, 85% × 1 (plus 92% × 1 before a top set of 3 reps or fewer), rounded to loadable weights. Use for 'how should I warm up to 140 kg', 'warm-up sets for a 315 squat'. NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        unit: {
          type: "string",
          enum: ["kg", "lb"],
          description: "Unit of the loads (default kg).",
        },
        top_weight: { type: "number", description: "The working / top-set load." },
        top_reps: { type: "integer", description: "Optional reps of the top set (default 5)." },
        bar_weight: { type: "number", description: "Optional bar weight (default 20 kg / 45 lb)." },
      },
      required: ["top_weight"],
    },
  },
  {
    name: "compute_training_volume",
    description:
      "Training volume for a workout the user DESCRIBES (not their logged history): tonnage (sets × reps × load) per session and per week, and weekly hard sets per primary muscle group judged against the 10-20 sets/week hypertrophy range. Use for 'is 4×8 bench twice a week enough for chest', 'how much volume is this session'. For volume from their LOGGED workouts or saved plan use progress_report / review_training_plan instead. Exercises accept catalog ids or plain names. NEVER do the arithmetic in your head.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): loads in kg. imperial: loads in lb.",
        },
        exercises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              exercise: {
                type: "string",
                description: "Catalog id or name, e.g. 'barbell bench press'.",
              },
              sets: { type: "integer" },
              reps: { type: "integer" },
              weight: {
                type: "number",
                description: "Load per rep in the chosen unit (0 for bodyweight).",
              },
            },
            required: ["exercise", "sets", "reps"],
          },
        },
        sessions_per_week: {
          type: "integer",
          description: "How often this session runs a week (default 1).",
        },
      },
      required: ["exercises"],
    },
  },
  {
    name: "compute_one_rep_max",
    description:
      "Estimate a one-rep max (1RM) from a submaximal set AND show the predicted load for every rep count (a %-of-1RM training table). Use whenever the user asks 'what's my 1RM / max', 'I did 100kg for 5 — what's my max', or wants training percentages off a recent set. NEVER do the 1RM math OR unit conversions in your head — pass the values as the user gave them and set units accordingly. Shows Epley (default) and Brzycki side by side; reps 1–5 are most accurate and past ~12 it's a rough guide (the tool flags this).",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "metric (default): weight in kg. imperial: weight in lb. The tool converts internally.",
        },
        weight_kg: {
          type: "number",
          description:
            "Weight lifted. Required when units=metric; pass weight_lb when units=imperial.",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        reps: {
          type: "integer",
          description: "Reps completed at that weight (>= 1). A set of 1 just returns that weight.",
        },
        formula: {
          type: "string",
          enum: ["epley", "brzycki", "average"],
          description: "Which estimate to headline. Default epley (matches StrengthLevel).",
        },
      },
      required: ["reps"],
    },
  },
  {
    name: "assess_strength_level",
    description:
      "Rank a lift against StrengthLevel's population standards — Beginner / Novice / Intermediate / Advanced / Elite plus a percentile — from the exercise, the user's sex + bodyweight, and their best effort. Covers 287 lifts (barbell, dumbbell, machine, cable, bodyweight). Use whenever the user asks 'how strong is my bench / squat / deadlift', 'am I intermediate', 'what level is a 140kg deadlift at my bodyweight', 'is my lift any good'. NEVER do the ranking OR unit conversions in your head. Pass `exercise` as a StrengthLevel slug ('bench-press', 'squat', 'deadlift', 'overhead-press', 'barbell-row', 'front-squat', 'romanian-deadlift', 'pull-ups', 'dips', 'push-ups' …), the exact exercise name, or a workout-catalog exercise id. Provide the effort ONE of these ways: `one_rep_max` for weighted lifts; `weight`+`reps` to have the tool estimate the 1RM; `reps` alone for bodyweight movements scored by reps (push-ups, sit-ups, bodyweight squat). For weighted calisthenics (pull-ups, dips, muscle-ups) pass the ADDED weight as `one_rep_max` (negative = assisted). Optional `age` applies StrengthLevel's masters age adjustment (standards ease off after ~40). ALWAYS pass on the notes the tool returns (population reference ranges, not a verdict).",
    schema: {
      type: "object",
      properties: {
        exercise: {
          type: "string",
          description:
            "StrengthLevel slug (e.g. 'bench-press', 'squat', 'deadlift', 'overhead-press', 'barbell-row', 'front-squat', 'romanian-deadlift', 'incline-bench-press', 'close-grip-bench-press', 'pull-ups', 'chin-ups', 'dips', 'push-ups', 'sit-ups', 'barbell-curl'), the exact exercise name, or a workout-catalog exercise id. 287 lifts supported.",
        },
        sex: { type: "string", enum: ["male", "female"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): kg. imperial: lb. The tool converts internally.",
        },
        bodyweight_kg: {
          type: "number",
          description:
            "The user's bodyweight. Required when units=metric; pass bodyweight_lb when units=imperial.",
        },
        bodyweight_lb: { type: "number", description: "Use with units=imperial." },
        one_rep_max_kg: {
          type: "number",
          description:
            "The lift's one-rep max in kg (units=metric). For weighted calisthenics pass the ADDED weight (negative = assisted). Omit for reps-based movements.",
        },
        one_rep_max_lb: { type: "number", description: "Use with units=imperial." },
        weight_kg: {
          type: "number",
          description:
            "Alternative to one_rep_max: the weight of a set (kg); pair with `reps` and the tool estimates the 1RM (Epley).",
        },
        weight_lb: { type: "number", description: "Use with units=imperial." },
        reps: {
          type: "integer",
          description:
            "For reps-based movements (push-ups, sit-ups, bodyweight squat, crunches…) this IS the score: your best single-set rep count. For weighted movements, pair with `weight` to estimate a 1RM.",
        },
        age: {
          type: "integer",
          description:
            "Optional. Applies StrengthLevel's age adjustment (standards ease off after ~40). Omit for the 25–40 peak band.",
        },
      },
      required: ["exercise", "sex"],
    },
  },
  {
    name: "compute_powerlifting_score",
    description:
      "Compute the bodyweight-normalized powerlifting scores — Wilks (classic), DOTS, and IPF GoodLift (GL) — that let lifters of different sizes compare a squat/bench/deadlift total fairly. Use when the user asks 'what's my Wilks', 'my DOTS score', 'IPF GL points', 'how does my total compare across weight classes'. Provide the three lifts (they're summed) OR a `total` directly, plus sex + bodyweight. NEVER do the scoring OR unit conversions in your head. Defaults to raw (classic) — pass equipment=equipped for suited/shirted totals (affects IPF GL only).",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): kg. imperial: lb. The tool converts internally.",
        },
        bodyweight_kg: {
          type: "number",
          description: "Required when units=metric; pass bodyweight_lb when units=imperial.",
        },
        bodyweight_lb: { type: "number", description: "Use with units=imperial." },
        squat_kg: { type: "number", description: "Best squat (kg). Summed into the total." },
        bench_kg: { type: "number", description: "Best bench (kg). Summed into the total." },
        deadlift_kg: { type: "number", description: "Best deadlift (kg). Summed into the total." },
        squat_lb: { type: "number", description: "Use with units=imperial." },
        bench_lb: { type: "number", description: "Use with units=imperial." },
        deadlift_lb: { type: "number", description: "Use with units=imperial." },
        total_kg: {
          type: "number",
          description: "The competition total (kg). Give this OR the three lifts.",
        },
        total_lb: { type: "number", description: "Use with units=imperial." },
        equipment: {
          type: "string",
          enum: ["raw", "equipped"],
          description:
            "raw (default) or equipped (supportive suit/shirt). Only changes the IPF GL coefficients.",
        },
      },
      required: ["sex"],
    },
  },
  {
    name: "strength_symmetry",
    description:
      "Compare several lifts to spot muscular imbalances — each lift is ranked on its own StrengthLevel standard, then compared by PERCENTILE so a strong bench next to a lagging squat shows up even though the kilograms differ. Use when the user asks 'are my lifts balanced', 'which lift is lagging', 'is my bench ahead of my legs', 'compare my big lifts'. Provide sex, bodyweight, and 2+ lifts (each with a one-rep max, or weight+reps, or reps for bodyweight movements). NEVER eyeball the comparison. Optional `age` applies the same age adjustment as assess_strength_level.",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): kg. imperial: lb. Applies to every lift's weights.",
        },
        bodyweight_kg: {
          type: "number",
          description: "Required when units=metric; pass bodyweight_lb when units=imperial.",
        },
        bodyweight_lb: { type: "number", description: "Use with units=imperial." },
        age: { type: "integer", description: "Optional age for the masters adjustment." },
        lifts: {
          type: "array",
          description: "At least two lifts to compare.",
          items: {
            type: "object",
            properties: {
              exercise: {
                type: "string",
                description: "StrengthLevel slug, exact name, or catalog exercise id.",
              },
              one_rep_max: {
                type: "number",
                description: "The lift's 1RM in the chosen unit (added weight for calisthenics).",
              },
              weight: {
                type: "number",
                description:
                  "Alternative: a set's weight (chosen unit); pair with reps to estimate the 1RM.",
              },
              reps: {
                type: "integer",
                description:
                  "Reps — the score for bodyweight movements, or paired with weight to estimate a 1RM.",
              },
            },
            required: ["exercise"],
          },
        },
      },
      required: ["sex", "lifts"],
    },
  },
  {
    name: "plate_barbell_racking",
    description:
      "Work out which plates to load on EACH side of the barbell to hit a target weight. Use when the user asks 'what plates for 142.5kg', 'how do I load 225lb', 'plates per side for my working weight'. NEVER do the plate math in your head. Defaults: a 20kg Olympic bar + standard kg plates (25/20/15/10/5/2.5/1.25), or a 45lb bar + lb plates (45/35/25/10/5/2.5) when units=imperial. Reports the closest achievable load when the target isn't exactly loadable.",
    schema: {
      type: "object",
      properties: {
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description: "metric (default): kg. imperial: lb.",
        },
        target_kg: {
          type: "number",
          description:
            "Target total weight (bar + plates). Required when units=metric; pass target_lb when units=imperial.",
        },
        target_lb: { type: "number", description: "Use with units=imperial." },
        bar_kg: {
          type: "number",
          description: "Bar weight (kg). Default 20 (metric) / 45 lb (imperial).",
        },
        bar_lb: { type: "number", description: "Use with units=imperial." },
        available_plates: {
          type: "array",
          items: { type: "number" },
          description:
            "Optional. Plate denominations you have (in the chosen unit), each usable in pairs. Defaults to standard gym plates.",
        },
      },
      required: [],
    },
  },
  {
    name: "compute_targets",
    description:
      "Compute BMR (Mifflin-St Jeor; Katch-McArdle if body fat known), TDEE, and daily macro target. Reads the user's profile (sex/height/age/activity/goal) AND the LATEST body_comp_entry (weight, body fat). Errors with profile_missing or no_body_comp if either piece is unset — onboard with update_profile + log_body_comp first. The result is ALSO cached on the profile automatically (it refreshes on every profile / weigh-in change), so this tool is for showing the breakdown and for save_as_default. Call after profile changes, after a fresh weigh-in, or when the user asks 'what should my calories be'.",
    schema: {
      type: "object",
      properties: {
        save_as_default: {
          type: "boolean",
          description: "If true, write daily_target into the diet plan's default_target.",
        },
        plan_id: {
          type: "integer",
          description: "With save_as_default: which plan to write to. Omit = the active plan.",
        },
      },
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
