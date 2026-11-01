/**
 * Tool definitions — Core · session, profile & navigation.
 */

export const CORE_DEFS = [
  {
    name: "ask_user",
    description:
      "Ask the user a multiple-choice clarifying question with button options — they click one option to answer (no typing). Use ONLY when (a) you genuinely need their input before continuing AND (b) the answer fits a short closed set of 2-6 choices. Good cases: 'which of these 3 OpenFoodFacts hits did you mean?', 'log this or just preview?', 'was that today or yesterday?', 'is this a supplement or a food?'. Bad cases: anything the user will see in a form gate anyway (slot, grams, date, time — those are already editable in the tool's form), open-ended questions, numeric inputs, anything where 'just type it' is faster. The tool returns {choice: '<picked value>'} so you can branch on it. If the user dismisses without choosing, you get {canceled: true} — fall back to asking in plain chat.",
    schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Short one-sentence question shown above the buttons.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          description: "2-6 button options. Order matters — list the most likely answer first.",
          items: {
            type: "object",
            properties: {
              value: {
                type: "string",
                description:
                  "Stable identifier returned to you when picked (snake_case or short token, e.g. 'lunch', 'preview_only', 'opt_1').",
              },
              label: {
                type: "string",
                description: "Button text shown to the user (e.g. 'Lunch', 'Just preview').",
              },
              emoji: {
                type: "string",
                description: "Optional single emoji prefixing the label.",
              },
            },
            required: ["value", "label"],
          },
        },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "ask_user_multi",
    description:
      "Like ask_user, but the user can pick MORE THAN ONE option — a multi-select clarifying question with checkboxes. They tick any number of options, then confirm. Use ONLY when (a) you genuinely need their input before continuing AND (b) the answer is a set drawn from a short closed list of 2-8 choices where several can be true at once. Good cases: 'which of these foods should I add to the pantry?', 'which days do you train?', 'which restrictions apply (vegetarian, dairy-free, …)?', 'which of these hits matched?'. Bad cases: single-answer questions (use ask_user — one tap is faster), open-ended questions, numeric inputs, anything the user will see in a form gate anyway. The tool returns {choices: ['<value>', …]} (the picked values, in option order) so you can branch on them. If the user confirms with nothing ticked you get {choices: []}; if they dismiss without confirming you get {canceled: true} — fall back to asking in plain chat.",
    schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Short one-sentence question shown above the checkboxes.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          description:
            "2-8 selectable options. Order matters — list the most likely answers first.",
          items: {
            type: "object",
            properties: {
              value: {
                type: "string",
                description:
                  "Stable identifier returned to you when picked (snake_case or short token, e.g. 'monday', 'dairy_free', 'opt_1').",
              },
              label: {
                type: "string",
                description: "Text shown to the user (e.g. 'Monday', 'Dairy-free').",
              },
              emoji: {
                type: "string",
                description: "Optional single emoji prefixing the label.",
              },
            },
            required: ["value", "label"],
          },
        },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "show_screen",
    description:
      "Navigate the app UI to a specific screen (and optionally a sub-tab) on the user's device. Use when the user asks to see/open a part of the app ('show me my workout plans', 'open the dashboard', 'let me see my weight history') or when pointing them at data you just changed is clearly helpful ('I logged it — here's your food log'). Screens: dashboard (daily overview: targets, eaten/remaining macros, planned training), nutrition (food log / meals), workout (workout plans & logged sessions), body (weigh-ins & body composition, tape measurements). Sub-tabs via `tab`: nutrition → summary | pantry | diet; workout → plans | training | progress; body → composition | measurements. dashboard has no sub-tabs. The screen opens immediately; returns {ok, screen, tab?}. Don't call it speculatively on every turn — only when the user asked to see something or just confirmed an action worth showing.",
    schema: {
      type: "object",
      properties: {
        screen: {
          type: "string",
          enum: ["dashboard", "nutrition", "workout", "body"],
          description: "Which app screen to show.",
        },
        tab: {
          type: "string",
          enum: [
            "summary",
            "pantry",
            "diet",
            "plans",
            "training",
            "progress",
            "composition",
            "measurements",
          ],
          description:
            "Optional sub-tab within the screen. nutrition: summary | pantry | diet. workout: plans | training | progress. body: composition | measurements. dashboard has no sub-tabs — omit it there.",
        },
      },
      required: ["screen"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a web page and return its text content. Use this AFTER web_search when you need the full body of a specific result (e.g. extracting per-100g macros from a USDA / manufacturer page, reading a supplement-research abstract, getting a recipe's ingredient list). The handler strips HTML/scripts/styles and returns plain text capped at ~8000 chars by default. Returns {url, status, title, content, truncated}. Don't use this for arbitrary browsing — pick URLs from a prior web_search result. Cite the URL when you use anything from the response.",
    schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full https:// URL. http is auto-upgraded.",
        },
        max_chars: {
          type: "integer",
          description: "Cap on returned text length. Default 8000, max 32000.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "get_todays_macros",
    description:
      "Snapshot of a single day: date, planned diet day target (if a plan exists), planned training session, latest body-comp entry, eaten/remaining macros for that day. With no argument → today (and you must call this at the start of a session to greet the user). With `date` → that specific day (use for any question about a past or future day's eaten total, target, remaining, planned training, or diet-day name). `eaten_today` and `remaining_today` are derived from the day's logged meals. This is the ONLY way to get authoritative eaten/remaining macros — never re-sum meals yourself from memory or from earlier tool outputs. The `meals` array lists each logged meal for that day (slot, time, and per-item food/grams/macros) — read it when the user asks what they ate item-by-item, or references a past meal you need to reconstruct ('the same as lunch', 'add another of my breakfast wrap'). Use `meals` only to read the items; use `eaten_today`/`remaining_today` for any total. Reports profile_missing=true if the user has no profile yet — in that case, onboard them by collecting profile fields conversationally and calling update_profile.",
    schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description:
            "YYYY-MM-DD. Optional — defaults to today. Pass when the user asks about a specific day ('yesterday', 'Monday', 'last Friday', '2026-03-04', 'two days ago'). Always resolve relative day names to ISO before calling.",
        },
      },
    },
  },
  {
    name: "update_profile",
    description:
      "Create or update the user's profile (sex, age/birth year, height, activity level, goal, dietary restrictions, target weight). Use this to onboard a new user when get_todays_macros reports profile_missing=true, or to update fields the user wants to change (e.g. switched goal from cut to maintain). Partial updates are supported when a profile already exists — only the fields you pass are changed. For a brand-new profile, sex + (age or birth_year) + height_cm + activity_level + goal are all required. Always confirm the values with the user before calling (read them back: 'so that's male, 32, 178cm, moderately active, goal: cut — save?'). Storage is metric — convert imperial inputs at the boundary (in×2.54=cm) and state the conversion. WEIGHT and BODY FAT are NOT profile fields — they live on body_comp_entry (time-series). Use log_body_comp for those, never update_profile.",
    schema: {
      type: "object",
      properties: {
        sex: { type: "string", enum: ["male", "female"] },
        age: {
          type: "integer",
          description:
            "Age in years. Converted to a birth year (current year minus age). Pass birth_year directly if the user gave you their birth year.",
        },
        birth_year: {
          type: "integer",
          description:
            "Year of birth, e.g. 1990. Takes precedence over age if both are given. Exact birthday isn't stored — only the year.",
        },
        height_cm: { type: "number" },
        activity_level: {
          type: "string",
          enum: ["sedentary", "light", "moderate", "very", "extreme"],
          description:
            "sedentary=desk job, no exercise; light=1-3x/wk light; moderate=3-5x/wk moderate; very=6-7x/wk hard; extreme=physical job + daily training",
        },
        goal: {
          type: "string",
          enum: ["cut", "maintain", "recomp", "lean_bulk"],
          description:
            "cut=fat loss (~20% deficit), maintain=eat at TDEE, recomp=slight deficit (~5%) with high protein, lean_bulk=slow gain (~10% surplus)",
        },
        target_weight_kg: { type: "number" },
        restrictions: {
          type: "array",
          items: { type: "string" },
          description:
            "Hard dietary constraints (allergies, religious, ethical). Free text e.g. ['lactose_intolerant', 'no_pork'].",
        },
        notes: { type: "string" },
        units: {
          type: "string",
          enum: ["metric", "imperial"],
          description:
            "The user's preferred unit system for measurements. Display-only — storage is always metric. Set wrist/ankle/height via the matching *_cm (metric) or *_in (imperial) field.",
        },
        language: {
          type: "string",
          enum: ["en", "el", "ar", "sq", "fa", "ur", "nl", "it"],
          description:
            "The user's preferred product language: 'en' (English), 'el' (Greek), 'ar' (Arabic), 'sq' (Albanian), 'fa' (Persian), 'ur' (Urdu), 'nl' (Dutch) or 'it' (Italian). Sets the app UI language AND the language you must author stored content in (recipe/meal names, notes, descriptions). Set this when the user asks to switch languages (e.g. 'switch to Greek' / 'άλλαξε σε ελληνικά' / 'غيّر اللغة إلى العربية' / 'kalo në shqip' / 'zet de app in het Nederlands' / 'metti in italiano').",
        },
        water_goal_ml: {
          type: "integer",
          description:
            "The user's everyday hydration target in ml (e.g. 3000 for a 3L goal). Persistent — applies to every day. Pass 0 to clear it (revert to the app default). This is the single source of truth for the daily water goal; log_water's goal_ml writes here too.",
        },
        wrist_cm: {
          type: "number",
          description:
            "Optional. Wrist circumference at the narrowest point distal to the styloid. A stable skeletal-frame proxy used for the drug-free muscular-potential estimate. Pass wrist_in when units=imperial.",
        },
        wrist_in: { type: "number", description: "Use with units=imperial." },
        ankle_cm: {
          type: "number",
          description:
            "Optional. Ankle circumference at the narrowest point above the lateral malleolus. Stable frame proxy for the muscular-potential estimate. Pass ankle_in when units=imperial.",
        },
        ankle_in: { type: "number", description: "Use with units=imperial." },
        gym_machine_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Catalog machine ids (snake_case) the user's gym has, e.g. ['lat_pulldown_machine','leg_press_machine']. Resolve names to ids via search_exercises first — never invent them. When set, you should PREFER these machines when planning workouts; an empty array or omitting it means no equipment constraint (plan with any machine). Pass the FULL desired list (it replaces the stored one).",
        },
      },
    },
  },
  {
    name: "request_tools",
    description:
      "Unlock an additional tool domain. Your tool list is a per-message subset of the full toolkit: a core set plus zero or more domains picked by a keyword router. FIRST check your tool list: if the tool you want is already there, call it directly — requesting a domain for a tool you already have wastes a whole round-trip. Only if a tool this prompt tells you to call is NOT in your current tool list, call this with the domain that owns it, then call the intended tool — it becomes available immediately. NEVER substitute a similarly-named tool for a missing one. Domains: nutrition (lookup_food, lookup_product, add_food, update_food, log_meal, update_meal, delete_meal, preview_meal, substitute_food, log_water), training (search_exercises, workout plans, log_workout_session, sessions, last_sets_for_exercise, estimate_training_kcal, get_steps, log_steps, delete_steps), progress (delete_body_comp_entry, update_body_comp_entry, progress_report), pantry (update_pantry, import_pantry, shopping_list, get_diet_plan, save_diet_plan and the granular diet day/meal/portion tools, log_planned_meal). web_search is NOT a domain you can request here — it unlocks automatically only after you have searched our food index with lookup_product.",
    schema: {
      type: "object",
      properties: {
        group: {
          type: "string",
          // Keep in sync with REQUESTABLE_GROUPS below ("all" is internal).
          enum: ["nutrition", "training", "progress", "pantry"],
          description: "Domain to unlock.",
        },
        reason: {
          type: "string",
          description:
            "The tool you were trying to call, or what you need the domain for. Logged for routing diagnostics.",
        },
      },
      required: ["group"],
    },
  },
  {
    name: "submit_feature_request",
    description:
      "File a feature request with the team when the user asks for a capability the app doesn't have yet, or want an existing one improved ('I wish I could export my data', 'can you add a sleep tracker', 'the shopping list should group by aisle'). Use this ONLY when the request is about the APP itself — not for logging food/workouts or anything an existing tool already does. Like every other mutating tool, this opens a pre-execution form gate the user Accepts or Declines — so DON'T re-ask 'want me to pass that along?' in chat; just pre-fill a short `title` and the user's reasoning/detail in `details` and call the tool, letting the gate be the confirmation. Returns {ok, id}. After it succeeds, briefly acknowledge it was recorded — don't promise a timeline.",
    schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Short one-line summary of the requested feature (e.g. 'Export food log to CSV', 'Group shopping list by aisle').",
        },
        details: {
          type: "string",
          description:
            "Optional fuller description — the user's reasoning, use case, or specifics in their words.",
        },
      },
      required: ["title"],
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
