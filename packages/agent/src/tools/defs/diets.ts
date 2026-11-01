/**
 * Tool definitions — Diets · the recurring meal template.
 */
export const DIETS_DEFS = [
  {
    name: "get_diet_plan",
    description:
      "Read a diet plan (the recurring meal template). Defaults to the ACTIVE plan; pass plan_id (from list_diet_plans) to read a specific one. Returns the full tree — days (with row ids, weekdays, targets), meals (ids, slot, time), portions (ids, food, grams) — with each portion's macros LIVE-resolved from the pantry. Portions that can't resolve (food missing from pantry / no macros) come back with resolved=null and are listed in needs_enrichment. ALWAYS call this before any granular diet edit — the day_id / meal_id / portion_id args come from here.",
    schema: {
      type: "object",
      properties: {
        plan_id: {
          type: "integer",
          description: "Which plan to read. Omit = the active plan.",
        },
      },
    },
  },
  {
    name: "list_diet_plans",
    description:
      "List all of the user's diet plans (id, name, whether each is the active one, day count). Use to answer 'which diets do I have' or to find the plan_id before activating / editing / deleting a specific plan.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "activate_diet_plan",
    description:
      "Make a diet plan the user's ACTIVE plan — the one that drives today's target, the shopping list, and 'ate as planned'. Exactly one plan is active at a time. Get plan_id from list_diet_plans.",
    schema: {
      type: "object",
      properties: { plan_id: { type: "integer" } },
      required: ["plan_id"],
    },
  },
  {
    name: "save_diet_plan",
    description:
      "Create a NEW diet plan, or REPLACE an existing one (rotation of days → meals → portions). Omit plan_id to create a new plan (the user's first plan becomes active automatically); pass plan_id (from list_diet_plans) to fully replace that plan. Use for onboarding ('plan my week') or a full redo ('redo my diet') — for single-item edits use the granular update_diet_day / add_diet_portion / update_diet_portion / remove_diet_portion tools instead. Portions carry {food, grams} only; macros resolve LIVE from the pantry, so DO NOT pass kcal/p/f/c for pantry foods — pass them only as an absolute override for a food that isn't in the pantry (estimated/inline). Each day may run on one or more weekdays; set start_date when the rotation cycles by day-index instead.",
    schema: {
      type: "object",
      properties: {
        plan_id: {
          type: "integer",
          description: "Replace this existing plan. Omit to create a new plan.",
        },
        name: {
          type: "string",
          description:
            "Plan name (e.g. 'Cutting', 'Maintenance'). Defaults to 'My diet plan' on create.",
        },
        start_date: {
          type: "string",
          description: "YYYY-MM-DD anchor for index-based rotation (omit for weekday-based plans).",
        },
        default_target: {
          type: "object",
          description: "Fallback daily target when a day has none.",
          properties: {
            kcal: { type: "number" },
            p: { type: "number" },
            f: { type: "number" },
            c: { type: "number" },
            fiber: { type: "number" },
          },
        },
        days: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              weekdays: {
                type: "array",
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
                description:
                  "Weekdays this day runs on (one day can run Mon AND Thu). Empty/omitted = index-rotation only.",
              },
              target: {
                type: "object",
                properties: {
                  kcal: { type: "number" },
                  p: { type: "number" },
                  f: { type: "number" },
                  c: { type: "number" },
                  fiber: { type: "number" },
                },
              },
              meals: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    slot: {
                      type: "string",
                      description: "breakfast | lunch | dinner | snack | free text",
                    },
                    time: { type: "string", description: "HH:MM, optional" },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          food: { type: "string", description: "Pantry food name (snake_case)." },
                          grams: { type: "number" },
                          kcal: {
                            type: "number",
                            description:
                              "OVERRIDE only — absolute for this portion (NOT per-100g). Pass only when the food isn't in the pantry.",
                          },
                          p: { type: "number" },
                          f: { type: "number" },
                          c: { type: "number" },
                          fiber: { type: "number" },
                        },
                        required: ["food", "grams"],
                      },
                    },
                  },
                  required: ["slot", "items"],
                },
              },
            },
            required: ["name", "meals"],
          },
        },
      },
      required: ["days"],
    },
  },
  {
    name: "delete_diet_plan",
    description:
      "Delete an ENTIRE diet plan — all its rotation days, planned meals, and portions. Pass plan_id (from list_diet_plans). Use only when the user explicitly wants to scrap a whole plan ('delete my cutting plan', 'start over from scratch'). If the deleted plan was active, the user is left with no active plan until they activate another. For removing a single meal or portion use remove_diet_meal / remove_diet_portion instead. Confirm with the user before calling — there's no undo. Logged meals (the food log) are NOT affected; only the recurring template is removed.",
    schema: {
      type: "object",
      properties: { plan_id: { type: "integer" } },
      required: ["plan_id"],
    },
  },
  {
    name: "update_diet_day",
    description:
      "Patch one diet-plan day: rename it, change which weekdays it runs on, or change its macro target. Get day_id from get_diet_plan. Pass only the fields that change; pass clear_target=true to remove the per-day target (falls back to the plan default).",
    schema: {
      type: "object",
      properties: {
        day_id: { type: "integer" },
        name: { type: "string" },
        weekdays: {
          type: "array",
          items: {
            type: "string",
            enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
          },
          description: "Full replacement set; pass [] to unschedule.",
        },
        target: {
          type: "object",
          properties: {
            kcal: { type: "number" },
            p: { type: "number" },
            f: { type: "number" },
            c: { type: "number" },
            fiber: { type: "number" },
          },
        },
        clear_target: { type: "boolean", description: "Remove the per-day target override." },
      },
      required: ["day_id"],
    },
  },
  {
    name: "add_diet_meal",
    description:
      "Add a planned meal (slot + optional time + portions) to a diet-plan day. Get day_id from get_diet_plan. Portion macros resolve live from the pantry — pass inline kcal/p/f/c only as an override for non-pantry foods. Use this for 'add a snack to day 2' or the preview_meal 'save as planned' follow-up.",
    schema: {
      type: "object",
      properties: {
        day_id: { type: "integer" },
        slot: { type: "string", description: "breakfast | lunch | dinner | snack | free text" },
        time: { type: "string", description: "HH:MM, optional" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              food: { type: "string" },
              grams: { type: "number" },
              kcal: { type: "number", description: "OVERRIDE only — absolute for this portion." },
              p: { type: "number" },
              f: { type: "number" },
              c: { type: "number" },
              fiber: { type: "number" },
            },
            required: ["food", "grams"],
          },
        },
      },
      required: ["day_id", "slot", "items"],
    },
  },
  {
    name: "update_diet_meal",
    description:
      "Change a planned meal's slot or time ('move dinner to 19:00', 'that planned snack is actually lunch'). Get meal_id from get_diet_plan. Pass new_time='' to clear the pinned time. To change the meal's foods, use the portion tools.",
    schema: {
      type: "object",
      properties: {
        meal_id: { type: "integer" },
        slot: { type: "string" },
        time: { type: "string", description: "HH:MM; empty string clears" },
      },
      required: ["meal_id"],
    },
  },
  {
    name: "remove_diet_meal",
    description:
      "Remove a planned meal (and its portions) from a diet-plan day. Get meal_id from get_diet_plan.",
    schema: {
      type: "object",
      properties: {
        meal_id: { type: "integer" },
      },
      required: ["meal_id"],
    },
  },
  {
    name: "add_diet_portion",
    description:
      "Add portion(s) (food + grams) to planned meal(s). Get meal_id from get_diet_plan. Macros resolve live from the pantry — pass inline kcal/p/f/c only as an override for non-pantry foods. To add SEVERAL portions, pass `edits` (an array of these objects) and do it in this ONE call — do NOT call add_diet_portion repeatedly.",
    schema: {
      type: "object",
      properties: {
        meal_id: { type: "integer" },
        food: { type: "string" },
        grams: { type: "number" },
        kcal: {
          type: "number",
          description: "OVERRIDE only — absolute for this portion (NOT per-100g).",
        },
        p: { type: "number" },
        f: { type: "number" },
        c: { type: "number" },
        fiber: { type: "number" },
        edits: {
          type: "array",
          description:
            "Add several portions in a single call. Each entry is a full {meal_id, food, grams, …} portion; when present the flat fields above are ignored.",
          items: {
            type: "object",
            properties: {
              meal_id: { type: "integer" },
              food: { type: "string" },
              grams: { type: "number" },
              kcal: { type: "number", description: "OVERRIDE only — absolute for this portion." },
              p: { type: "number" },
              f: { type: "number" },
              c: { type: "number" },
              fiber: { type: "number" },
            },
            required: ["meal_id", "food", "grams"],
          },
        },
      },
      anyOf: [{ required: ["meal_id", "food", "grams"] }, { required: ["edits"] }],
    },
  },
  {
    name: "update_diet_portion",
    description:
      "Patch planned portion(s) — the 'swap rice for potatoes on day 2' / 'make it 150g' tool. Get portion_id from get_diet_plan. Pass only the fields that change. Passing kcal/p/f/c sets an absolute macro override; pass clear_override=true to drop an override and resolve live from the pantry again (do this when swapping to a pantry food). To change SEVERAL portions, pass `edits` (an array of these objects) in this ONE call — do NOT call update_diet_portion once per portion.",
    schema: {
      type: "object",
      properties: {
        portion_id: { type: "integer" },
        food: { type: "string" },
        grams: { type: "number" },
        kcal: { type: "number", description: "OVERRIDE only — absolute for this portion." },
        p: { type: "number" },
        f: { type: "number" },
        c: { type: "number" },
        fiber: { type: "number" },
        clear_override: {
          type: "boolean",
          description: "Remove the macro override (resolve live from pantry).",
        },
        edits: {
          type: "array",
          description:
            "Patch several portions in a single call. Each entry is a full {portion_id, …} patch; when present the flat fields above are ignored.",
          items: {
            type: "object",
            properties: {
              portion_id: { type: "integer" },
              food: { type: "string" },
              grams: { type: "number" },
              kcal: { type: "number", description: "OVERRIDE only — absolute for this portion." },
              p: { type: "number" },
              f: { type: "number" },
              c: { type: "number" },
              fiber: { type: "number" },
              clear_override: {
                type: "boolean",
                description: "Remove the macro override (resolve live from pantry).",
              },
            },
            required: ["portion_id"],
          },
        },
      },
      anyOf: [{ required: ["portion_id"] }, { required: ["edits"] }],
    },
  },
  {
    name: "remove_diet_portion",
    description: "Remove one portion from a planned meal. Get portion_id from get_diet_plan.",
    schema: {
      type: "object",
      properties: {
        portion_id: { type: "integer" },
      },
      required: ["portion_id"],
    },
  },
  {
    name: "log_planned_meal",
    description:
      "'I ate as planned' — resolve a planned meal's portions against the pantry NOW and freeze the result into the meal log for a date. Finds the template day for the date (weekday match → rotation index → first day), then the meal by slot (or meal_id from get_diet_plan when slots are ambiguous). Errors with needs_enrichment if any portion can't resolve — fix those foods first instead of logging zeros. For a day the user ate differently, just use log_meal with what they actually ate.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        slot: {
          type: "string",
          description: "Which planned meal to log (breakfast | lunch | ...).",
        },
        meal_id: { type: "integer", description: "Exact planned meal id — overrides slot." },
      },
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
