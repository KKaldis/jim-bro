/**
 * Tool definitions — Steps · daily pedometer aggregate.
 */
export const STEPS_DEFS = [
  {
    name: "get_steps",
    description:
      "Read the user's step counts over a date range (the PWA's accelerometer step counter — one aggregate total per day, plus the daily goal). For a SINGLE day, today's count is already in get_todays_macros (steps_today) — use this for history / trends ('how many steps last week', 'am I hitting my 10k goal'). Returns a per-day list and the range total/average. Steps are counted only while the app is open and moving, so treat them as a rough lower bound, not a precise all-day tally.",
    schema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "YYYY-MM-DD start of range (inclusive). Defaults to `to`.",
        },
        to: {
          type: "string",
          description: "YYYY-MM-DD end of range (inclusive). Defaults to today.",
        },
      },
    },
  },
  {
    name: "log_steps",
    description:
      "Set the user's step count for a day (and optionally their daily step goal). `steps` is the ABSOLUTE total for that day — it OVERWRITES any existing count, it is not added on top. Use this to record a manual count ('I walked 8000 steps today', 'log 5k steps for yesterday') or to fix a wrong number; the in-app counter writes here automatically as the user walks. To change only the goal, pass the current step count alongside the new goal. To set or change the daily goal, pass `goal` (e.g. 12000).",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today." },
        steps: {
          type: "integer",
          description: "Absolute step total for the day (overwrites). Required.",
        },
        goal: {
          type: "integer",
          description: "Optional daily step goal to set (e.g. 10000). Omit to leave it unchanged.",
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "delete_steps",
    description:
      "Delete the step count for a day entirely (removes the row, so the day reads as 0 / no goal). Use to undo a wrong manual log. To set a different number instead of clearing, use log_steps.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; required." },
      },
      required: ["date"],
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
