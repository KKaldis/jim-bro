/**
 * Tool definitions — Training · exercises, workout plans & sessions.
 */
export const TRAINING_DEFS = [
  {
    name: "estimate_training_kcal",
    description:
      "Estimate calories burned during a training session using the MET (Metabolic Equivalent) formula: kcal = MET × 3.5 × weight_kg × duration_min / 200. NEVER do this math in your head — call this tool. Accepts a list of activity entries (so a session with strength + cardio can be computed in one call). For each entry, pass EITHER an `activity` name from the built-in MET table OR an explicit `met` value (explicit wins). If you need a MET value that's not in the table and the user doesn't know it, use web_search for 'MET value for <activity>' (Compendium of Physical Activities is the standard reference). Results are ±15-25% individual variance — state that. Result is INFORMATIONAL: do NOT subtract from the user's daily macro target (their activity_level already accounts for typical training). After estimating, ask the user if they want the value saved on the training log via log_training's `kcal_burned` field.",
    schema: {
      type: "object",
      properties: {
        weight_kg: {
          type: "number",
          description:
            "Body weight. OMIT it to use the user's most recent weigh-in (the normal case) — pass a value only for a hypothetical the user gave you. Never guess or recall a weight.",
        },
        entries: {
          type: "array",
          description: "One entry per activity in the session.",
          items: {
            type: "object",
            properties: {
              activity: {
                type: "string",
                description:
                  "snake_case name from the MET table (running_easy, weight_training_moderate, cycling_fast, hiit, yoga, etc.). Required unless `met` is given.",
              },
              met: {
                type: "number",
                description:
                  "Explicit MET value (wins over `activity`). Use for activities not in the table.",
              },
              duration_min: { type: "number" },
              intensity_modifier: {
                type: "number",
                description:
                  "Optional multiplier on the resolved MET (e.g. 1.1 for 'kept HR high', 0.9 for 'mostly rest').",
              },
            },
            required: ["duration_min"],
          },
        },
      },
      required: ["entries"],
    },
  },
  {
    name: "search_exercises",
    description:
      "Search the static workout catalog (exercises + machines, shipped with the app — same list as the Workout page). Use to translate a natural-language description ('chest barbell', 'lat pulldown', 'overhead press dumbbell') into a canonical exercise_id BEFORE calling log_workout_session, save_workout_plan, or last_sets_for_exercise. All filters are AND. Each result includes the catalog id, label, equipment, primary/secondary muscle ids, and machine_id when relevant. When BUILDING A PLAN, pass available_only:true so suggestions only use equipment the user actually has — it's a no-op for users who haven't curated their gym machines. The result's gym_machines array reports the machines the user has saved on file (empty = none saved, so no constraint) — use it to plan around their equipment or to offer to update the list. If nothing matches, broaden the query — the catalog is finite and curated; do NOT invent ids.",
    schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free text matched against exercise name + id (case-insensitive substring).",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            "Look up MULTIPLE exercises in ONE call — pass every exercise name at once when building or resolving a workout (e.g. ['bench press','barbell row','squat']). Strongly preferred over one search_exercises call per exercise: a single batched call keeps the agent from exhausting its per-turn step budget on multi-exercise plans. The shared filters (muscle_group / equipment / machine_id / available_only / limit) apply to every query. Returns a `results` array, one entry per query (each with its own `count`/`exercises`). Use EITHER `queries` (batch) OR `query` (single).",
        },
        muscle_group: {
          type: "string",
          description:
            "Catalog muscle-group id (snake_case). Common: chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, forearms. Filters by primary muscles only.",
        },
        equipment: {
          type: "string",
          enum: [
            "barbell",
            "dumbbell",
            "kettlebell",
            "machine",
            "cable",
            "bodyweight",
            "band",
            "smith_machine",
            "cardio",
          ],
        },
        machine_id: {
          type: "string",
          description: "Catalog machine id (snake_case), e.g. 'lat_pulldown_machine'.",
        },
        available_only: {
          type: "boolean",
          description:
            "When true, drop machine exercises the user's gym can't do — i.e. keep only exercises whose machine_id is in the user's saved profile.gym_machine_ids (free-weight / cable / bodyweight exercises always pass). No effect if the user hasn't saved any gym machines (all exercises pass). Use this when planning a workout. Default false (return the whole catalog). The result's gym_machines array always reports the user's saved machines regardless of this flag.",
        },
        limit: {
          type: "integer",
          description: "Cap results (default 20, max 100).",
        },
      },
    },
  },
  {
    name: "get_workout_plans",
    description:
      "Read workout plans for this user. NOT for judging a plan against the user's proportions / weak points ('is my plan enough') — that's review_training_plan, which reads the plan itself. With no argument → list ALL plans (each fully hydrated with days + prescribed exercises, plus an `active` flag and the top-level `active_plan_id`). With plan_id → load that single plan only. Use BEFORE save_workout_plan when the user wants to edit an existing plan (so you can preserve fields they didn't mention), to find the plan_id before activating / deleting a specific plan, and to answer 'what's my plan' / 'show me Monday's workout'. Returns an empty list when the user has no plans yet — in that case, suggest setting one up via save_workout_plan.",
    schema: {
      type: "object",
      properties: {
        plan_id: {
          type: "integer",
          description:
            "Optional. When set, returns only that plan (or error if not found / not owned).",
        },
      },
    },
  },
  {
    name: "activate_workout_plan",
    description:
      "Make a workout plan the user's ACTIVE plan — the one that drives 'today's workout' and the dashboard's scheduled-day view. Exactly one plan is active at a time. Get plan_id from get_workout_plans.",
    schema: {
      type: "object",
      properties: { plan_id: { type: "integer" } },
      required: ["plan_id"],
    },
  },
  {
    name: "save_workout_plan",
    description:
      "Create a new workout plan OR replace the contents of an existing one. WITHOUT plan_id → create new. WITH plan_id → wholesale replace the plan's days and exercises (this is a destructive replace — to tweak one day, first call get_workout_plans to read the full tree, then re-send everything with your edits applied). Each day is one weekday's session (or unscheduled if weekday is null). Each exercise's exercise_id is a catalog id OR the exercise's plain name (e.g. 'barbell bench press', 'lat pulldown') — names are resolved against the catalog before the form opens, so you can build the whole plan in ONE call without search_exercises first; a name that matches several exercises comes back as unresolved_exercises with candidate ids to pick from (no form is shown). target_sets/target_reps (or target_duration_sec for timed holds and cardio) are prescription hints; the actual lifts go on workout sessions. The form gate lets the user adjust before saving.",
    schema: {
      type: "object",
      properties: {
        plan_id: {
          type: "integer",
          description: "Omit to create a new plan. Set to update an existing one.",
        },
        name: { type: "string", description: "Plan name, e.g. 'PPL 6-day' or 'Upper/Lower'." },
        notes: { type: "string", description: "Optional free-text description." },
        days: {
          type: "array",
          description:
            "One entry per day in the plan. Order is preserved; weekday is optional (null = unscheduled template day).",
          items: {
            type: "object",
            properties: {
              weekdays: {
                type: "array",
                description:
                  "Lowercase weekday names this day runs on. One day can be scheduled on multiple weekdays (e.g. ['monday','thursday']). Omit or pass [] for an unscheduled template day.",
                items: {
                  type: "string",
                  enum: [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                  ],
                },
              },
              name: { type: "string", description: "Short day name e.g. 'Push A', 'Legs'." },
              focus: {
                type: "string",
                description: "Optional free text e.g. 'Chest + Triceps'.",
              },
              exercises: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    exercise_id: {
                      type: "string",
                      description:
                        "Catalog id (snake_case) or the plain exercise name — names resolve to catalog ids before the form opens. Required.",
                    },
                    machine_id: {
                      type: "string",
                      description:
                        "Optional machine id when the exercise is on a specific machine.",
                    },
                    target_sets: { type: "integer", description: "Prescribed set count." },
                    target_reps: {
                      type: "integer",
                      description:
                        "Prescribed rep count per set (lifts; omit for timed holds and cardio).",
                    },
                    target_duration_sec: {
                      type: "integer",
                      description:
                        "Seconds per set for timed holds (plank, side_plank) and cardio (e.g. 60 for a 1-min plank, 1800 for a 30-min run). Use INSTEAD of target_reps for those exercises.",
                    },
                    target_weight_kg: {
                      type: "number",
                      description: "Optional weight hint in kg.",
                    },
                    notes: { type: "string", description: "Optional coaching note." },
                    order: {
                      type: "integer",
                      description: "Optional; defaults to array position if omitted.",
                    },
                  },
                  required: ["exercise_id", "target_sets"],
                },
              },
            },
            required: ["name", "exercises"],
          },
        },
      },
      required: ["name", "days"],
    },
  },
  {
    name: "delete_workout_plan",
    description:
      "Delete a workout plan by id. Cascades to its days + prescribed exercises. Logged sessions that pointed at one of this plan's days keep their data (plan_day_id is nullable on sessions); only the prescription is removed. Confirm with the user before calling — there's no undo.",
    schema: {
      type: "object",
      properties: {
        plan_id: { type: "integer" },
      },
      required: ["plan_id"],
    },
  },
  {
    name: "update_workout_plan_day",
    description:
      "Patch ONE plan day in place: rename it, change its focus, or move it to different weekday(s). Use for natural-language edits like 'move leg day to Friday', 'rename Push A to Chest Day 1', 'also schedule chest day on Thursday'. plan_day_id comes from get_workout_plans (each day in the response has its id). Pass only the fields you want to change — omit a field to leave it untouched. Set weekdays to [] to make the day unscheduled. Use save_workout_plan for wholesale rewrites; this for surgical edits.",
    schema: {
      type: "object",
      properties: {
        plan_day_id: {
          type: "integer",
          description: "ID of the day to patch (from get_workout_plans).",
        },
        name: { type: "string", description: "Optional new name for the day." },
        focus: {
          type: "string",
          description: "Optional new focus, e.g. 'Chest + Triceps'. Pass empty string to clear.",
        },
        weekdays: {
          type: "array",
          description:
            "Optional new weekday set. Replace the day's full schedule with this list. Pass [] for unscheduled.",
          items: {
            type: "string",
            enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
          },
        },
      },
      required: ["plan_day_id"],
    },
  },
  {
    name: "add_exercise_to_plan_day",
    description:
      "Append exercise(s) to a plan day's prescription. Use for 'add cable flyes to my Chest Day 1', 'add this machine to leg day'. plan_day_id comes from get_workout_plans. exercise_id is a catalog id or the plain exercise name (resolved before the form opens; ambiguous names come back with candidates) — never invent ids. Order defaults to the end of the existing list. To add SEVERAL exercises, pass `edits` (an array of these objects) in this ONE call — do NOT call add_exercise_to_plan_day repeatedly. Returns the fully-updated plan.",
    schema: {
      type: "object",
      properties: {
        plan_day_id: { type: "integer" },
        exercise_id: {
          type: "string",
          description:
            "Catalog id (snake_case) or the plain exercise name — names resolve to catalog ids before the form opens.",
        },
        machine_id: {
          type: "string",
          description:
            "Optional catalog machine id when the exercise is performed on a specific machine.",
        },
        target_sets: { type: "integer", description: "Prescribed set count. Default 3." },
        target_reps: {
          type: "integer",
          description: "Prescribed rep count (lifts). Default 8.",
        },
        target_duration_sec: {
          type: "integer",
          description:
            "Seconds per set for timed holds (plank, side_plank) and cardio (e.g. 60 for a 1-min plank, 1800 for a 30-min run). Use INSTEAD of target_reps for those exercises.",
        },
        target_weight_kg: {
          type: "number",
          description: "Optional weight hint in kg.",
        },
        notes: { type: "string", description: "Optional coaching note." },
        order: {
          type: "integer",
          description: "Optional position (0-based). Defaults to end of list.",
        },
        edits: {
          type: "array",
          description:
            "Add several exercises in a single call. Each entry is a full {plan_day_id, exercise_id, …} prescription; when present the flat fields above are ignored.",
          items: {
            type: "object",
            properties: {
              plan_day_id: { type: "integer" },
              exercise_id: {
                type: "string",
                description:
                  "Catalog id (snake_case) or the plain exercise name — names resolve to catalog ids before the form opens.",
              },
              machine_id: { type: "string", description: "Optional catalog machine id." },
              target_sets: { type: "integer", description: "Prescribed set count. Default 3." },
              target_reps: {
                type: "integer",
                description: "Prescribed rep count (lifts). Default 8.",
              },
              target_duration_sec: {
                type: "integer",
                description:
                  "Seconds per set for timed holds (plank, side_plank) and cardio (e.g. 60 for a 1-min plank, 1800 for a 30-min run). Use INSTEAD of target_reps for those exercises.",
              },
              target_weight_kg: { type: "number", description: "Optional weight hint in kg." },
              notes: { type: "string", description: "Optional coaching note." },
              order: { type: "integer", description: "Optional position (0-based)." },
            },
            required: ["plan_day_id", "exercise_id"],
          },
        },
      },
      anyOf: [{ required: ["plan_day_id", "exercise_id"] }, { required: ["edits"] }],
    },
  },
  {
    name: "remove_exercise_from_plan_day",
    description:
      "Drop ONE exercise from a plan day's prescription. plan_day_id and exercise_row_id both come from get_workout_plans — exercise_row_id is the id field on each entry inside day.exercises[]. Use for 'drop pec deck from my chest day'. Confirm with the user before calling. Returns the updated plan.",
    schema: {
      type: "object",
      properties: {
        plan_day_id: { type: "integer" },
        exercise_row_id: {
          type: "integer",
          description: "The id of the WorkoutPlanExercise entry (NOT the catalog exercise_id).",
        },
      },
      required: ["plan_day_id", "exercise_row_id"],
    },
  },
  {
    name: "update_plan_exercise",
    description:
      "Patch prescribed exercise(s) in a plan day: change machine, bump target sets/reps/weight, edit notes, or swap to a different exercise. For natural-language edits like 'bump bench press target to 70kg', 'add this machine to the lat pulldown entry'. plan_day_id + exercise_row_id come from get_workout_plans. Use replace_plan_exercise instead when swapping one exercise for another while preserving sets/reps. To change SEVERAL exercises (e.g. 'bump every lift 5kg', 'make everything 4 sets'), pass `edits` (an array of these objects) in this ONE call — do NOT call update_plan_exercise once per exercise. Returns the updated plan.",
    schema: {
      type: "object",
      properties: {
        plan_day_id: { type: "integer" },
        exercise_row_id: { type: "integer" },
        exercise_id: {
          type: "string",
          description: "Optional. Replace with a different catalog exercise_id.",
        },
        machine_id: {
          type: "string",
          description: "Optional catalog machine id. Pass empty string to clear.",
        },
        target_sets: { type: "integer" },
        target_reps: { type: "integer" },
        target_duration_sec: {
          type: "integer",
          description:
            "Seconds per set for timed holds (plank, side_plank) and cardio (e.g. 60 for a 1-min plank, 1800 for a 30-min run). Use INSTEAD of target_reps for those exercises.",
        },
        target_weight_kg: { type: "number" },
        notes: { type: "string" },
        order: { type: "integer" },
        edits: {
          type: "array",
          description:
            "Patch several exercises in a single call. Each entry is a full {plan_day_id, exercise_row_id, …} patch; when present the flat fields above are ignored.",
          items: {
            type: "object",
            properties: {
              plan_day_id: { type: "integer" },
              exercise_row_id: { type: "integer" },
              exercise_id: {
                type: "string",
                description: "Optional. Replace with a different catalog exercise_id.",
              },
              machine_id: {
                type: "string",
                description: "Optional catalog machine id. Pass empty string to clear.",
              },
              target_sets: { type: "integer" },
              target_reps: { type: "integer" },
              target_duration_sec: {
                type: "integer",
                description:
                  "Seconds per set for timed holds (plank, side_plank) and cardio (e.g. 60 for a 1-min plank, 1800 for a 30-min run). Use INSTEAD of target_reps for those exercises.",
              },
              target_weight_kg: { type: "number" },
              notes: { type: "string" },
              order: { type: "integer" },
            },
            required: ["plan_day_id", "exercise_row_id"],
          },
        },
      },
      anyOf: [{ required: ["plan_day_id", "exercise_row_id"] }, { required: ["edits"] }],
    },
  },
  {
    name: "replace_plan_exercise",
    description:
      "Swap ONE prescribed exercise for another while preserving its position, target sets, target reps, target weight, and notes. Use for 'replace bench press with incline press', 'switch leg curls for romanian deadlifts'. plan_day_id + exercise_row_id locate the existing entry (from get_workout_plans); new_exercise_id is the replacement's catalog id or plain name (resolved before the form opens). machine_id auto-updates to the new exercise's default machine if any — pass null to force-clear. Returns the updated plan.",
    schema: {
      type: "object",
      properties: {
        plan_day_id: { type: "integer" },
        exercise_row_id: { type: "integer" },
        new_exercise_id: {
          type: "string",
          description:
            "Catalog id of the replacement exercise. Resolve via search_exercises first.",
        },
      },
      required: ["plan_day_id", "exercise_row_id", "new_exercise_id"],
    },
  },
  {
    name: "log_workout_session",
    description:
      "One-shot: create a workout session AND log every set in a single call. Use when the user describes a workout after the fact ('today I did bench 60×8×3, then 4 sets of pullups bw×10'). Each `exercises[]` entry carries an exercise_id — a catalog id or the plain exercise name (resolved before the form opens; ambiguous names come back with candidates, so no search_exercises call is needed first) and lists every set's reps + weight_kg (+ optional rpe 1-10). Sets are appended in order; set_index is auto-assigned per (exercise, session). Optional `duration_min` and `kcal_burned` describe the whole session — if the user wants kcal_burned computed, call estimate_training_kcal first and pass the result. The form gate lets the user adjust everything (date defaults to today, sets are editable) before saving.",
    schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD; defaults to today.",
        },
        plan_day_id: {
          type: "integer",
          description:
            "Optional. Link the session back to a prescribed plan day (from get_workout_plans). Lets the dashboard mark the day as completed.",
        },
        name: {
          type: "string",
          description:
            "Optional session name, e.g. 'Push A' or 'Quick legs'. Falls back to a derived name otherwise.",
        },
        duration_min: { type: "number" },
        kcal_burned: { type: "number" },
        notes: { type: "string" },
        started_at: {
          type: "string",
          description: "Optional ISO timestamp for session start; defaults to now.",
        },
        exercises: {
          type: "array",
          description:
            "One entry per exercise performed (in the order performed). At least one exercise is required.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              exercise_id: {
                type: "string",
                description:
                  "Catalog id (snake_case) or the plain exercise name — names resolve to catalog ids before the form opens.",
              },
              machine_id: {
                type: "string",
                description: "Optional. Catalog machine id when relevant.",
              },
              sets: {
                type: "array",
                minItems: 1,
                description: "Every working set the user did for this exercise.",
                items: {
                  type: "object",
                  properties: {
                    reps: {
                      type: "integer",
                      description:
                        "Reps completed (> 0 for strength sets). For a CARDIO exercise or a timed hold (plank, side_plank), pass 0 and use duration_sec instead.",
                    },
                    weight_kg: {
                      type: "number",
                      description:
                        "Working weight in kg. Pass 0 for bodyweight, unweighted, or cardio sets.",
                    },
                    rpe: {
                      type: "number",
                      description: "Optional 1-10 Rate of Perceived Exertion.",
                    },
                    duration_sec: {
                      type: "number",
                      description:
                        "Elapsed time in SECONDS for cardio (e.g. a 30-min run = 1800) and timed holds (plank, side_plank; e.g. 60, with optional weight_kg). Required for those exercises; their calories are estimated from duration × MET. Omit for lifted sets.",
                    },
                    distance_m: {
                      type: "number",
                      description:
                        "Cardio only: optional distance covered in METRES (e.g. 5 km = 5000).",
                    },
                    completed_at: {
                      type: "string",
                      description:
                        "Optional ISO timestamp; defaults to now (server-assigned per set).",
                    },
                  },
                  required: ["reps", "weight_kg"],
                },
              },
            },
            required: ["exercise_id", "sets"],
          },
        },
      },
      required: ["exercises"],
    },
  },
  {
    name: "list_workout_sessions",
    description:
      "List workout sessions for this user in a date range (inclusive, newest-first). Includes every set on each session. Defaults to the last 14 days through today when from/to are omitted. Use for 'what did I train this week', 'show my last gym session', 'how many times did I train in March'.",
    schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "YYYY-MM-DD start (inclusive). Default: today − 14 days.",
        },
        to: { type: "string", description: "YYYY-MM-DD end (inclusive). Default: today." },
      },
    },
  },
  {
    name: "delete_workout_session",
    description:
      "Delete a workout session by id. Cascades to all of its sets. Use for 'undo that workout I logged by mistake'. Confirm with the user before calling — there's no undo.",
    schema: {
      type: "object",
      properties: {
        session_id: { type: "integer" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "last_sets_for_exercise",
    description:
      "Recent sets of a single exercise across ALL of the user's past sessions (newest-first). Use to answer 'how much did I do last time on bench', 'what's my best on squats', or to suggest a working weight before a session. Includes an Epley 1RM estimate per set and (when enough history exists) a hint for next session's weight using a naive linear-progression rule (hit target reps at RPE ≤ 7 → +2.5 kg, else hold). Pass exercise_id from search_exercises — do NOT invent ids. Optional target_reps lets the suggestion know what rep count the user is aiming for.",
    schema: {
      type: "object",
      properties: {
        exercise_id: {
          type: "string",
          description:
            "Catalog id (snake_case) or the plain exercise name (resolved against the catalog; an ambiguous name returns candidates).",
        },
        limit: {
          type: "integer",
          description: "Cap returned sets (default 10, max 50).",
        },
        target_reps: {
          type: "integer",
          description: "Optional. Used by suggest_next_weight to decide whether to bump.",
        },
      },
      required: ["exercise_id"],
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
