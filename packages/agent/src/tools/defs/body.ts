/**
 * Tool definitions — Body composition & progress.
 */
export const BODY_DEFS = [
  {
    name: "log_body_comp",
    description:
      "Append a body composition entry — this is the SINGLE source of truth for weight / body-fat / circumferences. After logging, derived values (BMI, FFMI, fat-free mass, Navy body-fat estimate from circumferences) are computed and stored alongside the raw inputs using the profile's height + sex. The latest entry is what compute_targets, estimate_training_kcal, and the dashboard all read for 'current' state — there is no profile.weight_kg to keep in sync. Pass body_fat_pct ONLY when the user has a real reading (DEXA/BIA/caliper); if they only have circumferences (waist+neck, plus hip for women), pass those and the tool will compute a Navy estimate. The returned `computed` block carries every derived value so you can read them back to the user.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        weight_kg: { type: "number" },
        body_fat_method: {
          type: "string",
          enum: ["dexa", "bia_scale", "caliper", "visual_estimate", "navy", "other"],
          description:
            "How body fat was measured. For dexa/bia_scale/caliper/visual_estimate/other, also pass body_fat_pct (the reading). For 'navy', pass circumferences (waist+neck, +hip for women) instead and the tool computes the estimate — leave body_fat_pct empty.",
        },
        body_fat_pct: {
          type: "number",
          description:
            "User-entered reading (DEXA / BIA scale / caliper). Don't pass if you only have circumferences (method 'navy') — the tool will compute Navy BF% from waist+neck (+hip for women). User-entered always wins over the estimate.",
        },
        waist_cm: { type: "number" },
        neck_cm: {
          type: "number",
          description: "Below the larynx. Pair with waist_cm for a Navy BF% estimate.",
        },
        hip_cm: {
          type: "number",
          description: "Widest point. Required for the Navy estimate on women.",
        },
        notes: { type: "string" },
        time: {
          type: "string",
          description: "HH:MM (24h, local) when it was measured. Optional; omit if unknown.",
        },
      },
      required: ["weight_kg"],
    },
  },
  {
    name: "update_body_comp_entry",
    description:
      "Edit an EXISTING body-composition entry in place — the 'fix that weigh-in' tool (wrong weight, forgot body fat, corrected a circumference). Identify the entry with original_date (the day it's logged under; defaults to the most recent entry if omitted). Pass only the fields you want to change — the rest are kept from the existing entry, and the derived metrics (BMI, FFMI, fat-free mass, Navy BF%) are recomputed from the merged values + the profile's height/sex, exactly like log_body_comp. To MOVE the entry to a different day, pass a new `date`. To ADD a brand-new weigh-in instead of editing one, use log_body_comp.",
    schema: {
      type: "object",
      properties: {
        entry_id: {
          type: "integer",
          description:
            "Exact row id of the entry to edit. Optional; when given it pins the precise weigh-in (used by the Body page so editing one of two same-day entries is unambiguous) and takes precedence over original_date.",
        },
        original_date: {
          type: "string",
          description:
            "YYYY-MM-DD of the entry to edit. Optional — defaults to the most recent entry. The entry currently logged under this date is the one that changes.",
        },
        date: {
          type: "string",
          description:
            "YYYY-MM-DD — pass ONLY to move the entry to a different day. Omit to keep it on original_date.",
        },
        weight_kg: { type: "number" },
        body_fat_method: {
          type: "string",
          enum: ["dexa", "bia_scale", "caliper", "visual_estimate", "navy", "other"],
          description:
            "How body fat was measured. For 'navy', pass circumferences (waist+neck, +hip for women) instead of body_fat_pct and the tool recomputes the estimate.",
        },
        body_fat_pct: {
          type: "number",
          description:
            "User-entered reading (DEXA/BIA/caliper). Don't pass for method 'navy' — the tool computes Navy BF% from circumferences.",
        },
        waist_cm: { type: "number" },
        neck_cm: { type: "number", description: "Below the larynx." },
        hip_cm: { type: "number", description: "Widest point (women, for Navy)." },
        notes: { type: "string" },
        time: {
          type: "string",
          description: "HH:MM (24h, local) when it was measured. Optional; omit if unknown.",
        },
      },
    },
  },
  {
    name: "delete_body_comp_entry",
    description:
      "Delete all body-composition entries for a given date. Use to undo a wrong weigh-in.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; required" },
      },
      required: ["date"],
    },
  },
  {
    name: "progress_report",
    description:
      "Body composition trend report comparing the current window vs the prior window. For each window: rolling avgs for weight, BF%, BMI, FFMI, normalized FFMI, fat-free mass, fat mass, and waist/neck/hip circumferences, plus deltas and the raw entry-by-entry snapshots within each window (so the agent can show individual readings, not just averages). Default window 14 days.",
    schema: {
      type: "object",
      properties: {
        window_days: { type: "integer", description: "default 14" },
      },
    },
  },
] as const satisfies readonly { name: string; description: string; schema: object }[];
