/**
 * Zod schemas + OpenAPI registry. Single source of truth, shared by both apps:
 *   1. runtime request/response validation (server handlers in apps/server)
 *   2. the OpenAPI 3.1 doc emitted at /openapi.json (apps/server/src/openapi.ts
 *      registers the HTTP paths onto `registry` and generates the document; the
 *      web app's React Query hooks + TS models are then code-generated from it)
 *   3. the SAME runtime validators on the web (import from "@fa/shared/schemas")
 *      — e.g. validating form input against the exact request schema the server
 *      enforces, instead of regenerating a lossy copy from the OpenAPI spec.
 *
 * Exposed as the "@fa/shared/schemas" subpath (NOT the package barrel) so server
 * logic / agent code that only needs the plain types in @fa/shared don't pull in
 * zod-to-openapi.
 */
import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { USAGE_KINDS, USAGE_SOURCES } from "./usage.ts";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ---------- shared limits (also enforced at request parse time) ----------

export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const MAX_IMAGE_B64_LEN = 10_000_000;
export const MAX_IMAGES_PER_TURN = 6;

// ---------- primitive schemas ----------

const Macros = registry.register(
  "Macros",
  z
    .object({
      kcal: z.number(),
      p: z.number(),
      f: z.number(),
      c: z.number(),
      fiber: z.number().optional(),
    })
    .openapi({
      description:
        "kcal + macros (protein/fat/carbs/fiber in grams). Fiber is optional — absent when source data didn't carry it.",
    }),
);

const ImageBase64 = z
  .object({
    media_type: z.enum(ALLOWED_IMAGE_MIME),
    data: z.string().max(MAX_IMAGE_B64_LEN, { message: "image too large (~7.5MB max)" }),
  })
  .openapi({ description: "Base64-encoded image with explicit media type" });

const ImageUrl = z
  .object({
    url: z.string().url(),
  })
  .openapi({ description: "Public URL pointing to a fetchable image" });

export const ImageInput = registry.register("ImageInput", z.union([ImageBase64, ImageUrl]));

// ---------- chat request ----------

export const ChatRequest = registry.register(
  "ChatRequest",
  z
    .object({
      message: z.string().openapi({
        description:
          "User text. May be empty when images[] is non-empty (e.g. 'just look at this label').",
      }),
      images: z.array(ImageInput).max(MAX_IMAGES_PER_TURN).optional().openapi({
        description: "Optional images attached to this turn (label / plate / materials).",
      }),
      context_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .openapi({
          description:
            "YYYY-MM-DD of the day the user is currently viewing in the UI. Shared across Dashboard, Nutrition, Workout, and Body screens via the frontend's DayContext. When set AND not today, the server prepends a `[Selected date: ...]` tag to the user's message so the agent resolves relative-day references against that day. The server always prepends `[Today: ...]` regardless. Omit when the user is on today's view.",
        }),
      context_screen: z.enum(["dashboard", "nutrition", "workout", "body"]).optional().openapi({
        description:
          'Which data screen the user is actually looking at right now. The left data panel is always on screen at desktop widths (device-width driven, not a toggle) and, on mobile, only while the data drawer covers the chat. When present, the server prepends a `[Viewing: ...]` tag so the agent can ground deictic references ("add it here", "log this") to the on-screen context. Omitted when the user is on the bare chat (mobile, data drawer closed) — that turn stays tag-free, like a today-view chat.',
      }),
      context_section: z
        .enum(["summary", "pantry", "diet", "recipes", "training", "progress", "plans"])
        .optional()
        .openapi({
          description:
            "Active sub-tab within context_screen, when it has one (nutrition → 'summary' | 'pantry' | 'diet' | 'recipes'; workout → 'training' | 'progress' | 'plans'). Stable machine key; the human-readable text goes in context_view_label. Omit for screens without sub-tabs (dashboard, body) and whenever context_screen is omitted.",
        }),
      context_view_label: z.string().max(80).optional().openapi({
        description:
          "The exact on-screen label for context_screen (and its sub-tab, as 'Screen/Tab'), in the user's current UI language — sourced from the SAME i18n strings as the nav buttons, so it always matches what the user sees (e.g. 'Food/Nutrition' in English, 'Φαγητό/Διατροφή' in Greek). The server puts this verbatim into the `[Viewing: ...]` tag so the agent names the screen the way the user does. Send alongside context_screen; when omitted the server falls back to the English label of context_screen.",
      }),
      thinking: z.boolean().optional().openapi({
        description:
          "Enable extended thinking for this turn. Defaults to true; set to false to skip the thinking budget on routine turns (UI exposes this as a toggle).",
      }),
      locale: z.string().min(2).max(20).optional().openapi({
        description:
          "BCP 47 locale of the user's browser (e.g. 'en-US', 'el-GR'). The server tags non-English locales with `[Locale: X]` so the agent replies in the user's language.",
      }),
    })
    .refine((v) => v.message.trim().length > 0 || (v.images?.length ?? 0) > 0, {
      message: "message or images required",
      path: ["message"],
    }),
);

// ---------- receipt scan (TODO #3) ----------

export const ReceiptScanRequest = registry.register(
  "ReceiptScanRequest",
  z.object({
    image: ImageInput.openapi({
      description: "A photo of a grocery receipt (base64 or public URL).",
    }),
  }),
);

const ReceiptItem = registry.register(
  "ReceiptItem",
  z
    .object({
      raw_text: z.string(),
      food: z.string(),
      display_name: z.string(),
      grams_available: z.number(),
      category: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
    })
    .openapi({
      description:
        "One extracted grocery line mapped to a pantry entry. Read-only — the " +
        "client confirms/edits before writing via update_pantry.",
    }),
);

export const ReceiptScanResponse = registry.register(
  "ReceiptScanResponse",
  z.object({
    items: z.array(ReceiptItem),
    note: z.string().optional(),
  }),
);

export type ReceiptScanRequest = z.infer<typeof ReceiptScanRequest>;
export type PantryQuery = z.infer<typeof PantryQuery>;

// ---------- pantry list (search / filter / sort / paginate) ----------

const PantryItemSchema = registry.register(
  "PantryItem",
  z
    .object({
      name: z.string(),
      quantity: z.number(),
      unit: z.enum(["g", "ml", "pcs"]),
      to_buy: z.boolean(),
      grams_per_serving: z.number().optional(),
      category: z.string().optional(),
      barcode: z.string().optional(),
      macros: Macros.optional(),
    })
    .openapi({
      description: "A single pantry/catalog entry: quantity on hand + per-100 macros.",
    }),
);

const FoodView = registry.register(
  "FoodView",
  Macros.extend({
    category: z.string().optional(),
    barcode: z.string().optional(),
  }).openapi({
    description:
      "Flattened per-100 macros view of a macro-bearing pantry item, keyed by " +
      "name in PantryResponse.foods (the add-food dialog's catalog).",
  }),
);

// Query params for GET /pantry. All optional; `limit` absent → no pagination
// (returns the full filtered set, used by the food-autocomplete consumers).
export const PantryQuery = z.object({
  q: z.string().optional().openapi({ description: "Case-insensitive name substring search." }),
  category: z.string().optional().openapi({ description: "Filter by exact category." }),
  sort: z.enum(["name", "quantity", "kcal", "protein", "carbs", "fat"]).optional().openapi({
    description: "Sort key (default name). Macro/quantity sorts put unknown values last.",
  }),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .openapi({ description: "Sort direction (default asc)." }),
  limit: z.coerce.number().int().min(1).max(200).optional().openapi({
    description: "Page size. Omit for the full filtered set (no pagination).",
  }),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({ description: "Page offset (default 0)." }),
});

export const PantryResponse = registry.register(
  "PantryResponse",
  z.object({
    items: z.array(PantryItemSchema).openapi({
      description: "The matching page (or full set when limit is omitted), ordered per sort.",
    }),
    total: z
      .number()
      .int()
      .openapi({ description: "Total items matching the filters (ignoring limit/offset)." }),
    categories: z.array(z.string()).openapi({
      description: "The user's distinct categories (ignoring filters) for the filter dropdown.",
    }),
    foods: z.record(z.string(), FoodView).openapi({
      description: "Per-100 macros for the returned macro-bearing items, keyed by name.",
    }),
  }),
);

// ---------- barcode lookup (on-device scan → deterministic resolution) ----------
//
// GET /foods/barcode/{code} backs the on-device barcode scanner. The client
// decodes the barcode locally (native BarcodeDetector / wasm fallback) and
// looks the digits up here in a pantry-first → food-index cascade — no LLM,
// no tokens. `found:false` is the signal for the client to fall back to the
// AI vision path (POST /foods/scan).

const BarcodeProduct = registry.register(
  "BarcodeProduct",
  z
    .object({
      name: z.string(),
      brand: z.string().nullable(),
      source: z.enum(["pantry", "off", "usda"]),
      barcode: z.string(),
      per_100g: Macros,
      serving_size: z.string().nullable(),
      grams_per_serving: z.number().nullable(),
      image_url: z.string().nullable(),
      suggested_snake_name: z.string(),
      in_pantry: z.boolean(),
      on_hand: z
        .object({ quantity: z.number(), unit: z.enum(["g", "ml", "pcs"]) })
        .nullable()
        .openapi({
          description: "Quantity the user has on hand, when the item is in their pantry.",
        }),
    })
    .openapi({
      description:
        "A product resolved from a scanned barcode. `source` records the tier " +
        "that resolved it: 'pantry' (the user's own item — an instant re-scan), " +
        "'off' (OpenFoodFacts branded), or 'usda' (USDA generic).",
    }),
);

export const BarcodeLookupResponse = registry.register(
  "BarcodeLookupResponse",
  z
    .object({
      found: z.boolean(),
      barcode: z
        .string()
        .openapi({ description: "The normalized (digits-only) barcode that was looked up." }),
      source: z.enum(["pantry", "off", "usda"]).nullable().openapi({
        description: "Which tier resolved the code; null when nothing matched.",
      }),
      product: BarcodeProduct.nullable(),
    })
    .openapi({
      description:
        "Deterministic barcode resolution. found:false (product + source null) " +
        "means neither the pantry nor the food index knew the code — the client " +
        "should fall back to the AI vision path (POST /foods/scan).",
    }),
);

export type BarcodeLookupResponse = z.infer<typeof BarcodeLookupResponse>;

// ---------- food recognition (add-food photo flow) ----------

export const FoodScanRequest = registry.register(
  "FoodScanRequest",
  z.object({
    image: ImageInput.openapi({
      description: "A photo of a meal, food, product, or nutrition label.",
    }),
  }),
);

const RecognizedFood = registry.register(
  "RecognizedFood",
  z
    .object({
      food: z.string(),
      display_name: z.string(),
      per_100g: Macros.nullable(),
      category: z.string().nullable(),
      estimated_grams: z.number().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
    })
    .openapi({
      description:
        "One recognized food with per-100g macros and an estimated portion. " +
        "Read-only — the client confirms macros/grams before logging via log_meal.",
    }),
);

export const FoodScanResponse = registry.register(
  "FoodScanResponse",
  z.object({
    items: z.array(RecognizedFood),
    note: z.string().optional(),
  }),
);

export type FoodScanRequest = z.infer<typeof FoodScanRequest>;

// ---------- chat response ----------

const ChatUsage = registry.register(
  "ChatUsage",
  z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cache_read_input_tokens: z.number().int(),
    cache_creation_input_tokens: z.number().int(),
  }),
);

const StopReason = z
  .enum([
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
    "model_context_window_exceeded",
  ])
  .nullable();

export const ChatResult = registry.register(
  "ChatResult",
  z.object({
    assistant: z.string(),
    iterations: z.number().int(),
    stop_reason: StopReason,
    usage: ChatUsage,
  }),
);

// ---------- /chat/stream SSE event union ----------
// Documented for humans + future codegen; SSE itself isn't auto-codegen-able
// but consumers can hand-write a parser against these shapes.

const ev = (type: string, fields: Record<string, z.ZodTypeAny>) =>
  z.object({ type: z.literal(type), ...fields });

// Presentation category for a tool call — drives the per-tool icon + badge
// color in chat. Keep in sync with ToolCategory in packages/agent/src/tools/registry.ts.
const ToolCategory = z.enum([
  "body-comp",
  "nutrition",
  "pantry",
  "training",
  "progress",
  "navigation",
  "macros",
  "info",
]);

export const StreamEvent = registry.register(
  "StreamEvent",
  z.discriminatedUnion("type", [
    ev("iteration_start", { iteration: z.number().int() }),
    ev("thinking_delta", { delta: z.string() }),
    ev("text_delta", { delta: z.string() }),
    // Web-search sources the model grounded this turn in (see FaCitation /
    // collectCitations in packages/agent). Arrives after an iteration completes
    // because citations live on the final content, not the text deltas.
    ev("citations", {
      citations: z.array(
        z.object({
          url: z.string().optional(),
          title: z.string().optional(),
          citedText: z.string().optional(),
        }),
      ),
    }),
    ev("tool_started", {
      name: z.string(),
      tool_use_id: z.string(),
      label: z.string(),
      category: ToolCategory,
    }),
    ev("tool_finished", {
      name: z.string(),
      tool_use_id: z.string(),
      ms: z.number().int(),
      ok: z.boolean(),
      category: ToolCategory,
      // Structured tool result, present only for tools that have a chat result
      // card (RESULT_CARD_TOOLS in packages/agent/src/tools/registry.ts) and only on
      // success. The UI renders it as a rich card (calorie ring / macro bars /
      // metric gauges) instead of relying on the model's prose.
      result: z.unknown().optional(),
    }),
    // Pre-execution gate: emitted for every MUTATING tool the model wants to
    // call. The UI renders an editable form from `schema` populated with
    // `input`, then the user confirms (POST /chat/tool/:id/confirm) or cancels.
    ev("tool_proposed", {
      name: z.string(),
      tool_use_id: z.string(),
      label: z.string(),
      input: z.record(z.string(), z.unknown()),
      schema: z.unknown(),
      category: ToolCategory,
    }),
    ev("iteration_usage", {
      usage: ChatUsage.partial(),
      provider: z.string(),
      model: z.string(),
    }),
    ev("view_date_hint", { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    // Agent asked the UI to navigate (show_screen tool). Keep the enum in
    // sync with APP_SCREENS in packages/agent/src/tools/handlers/core.ts.
    ev("show_screen", {
      screen: z.enum(["dashboard", "nutrition", "workout", "body"]),
      // Optional sub-tab within the screen (nutrition: summary|pantry|diet,
      // workout: plans|training|progress). Kept loose here; the agent only
      // emits values valid for the screen (SCREEN_TABS in agent/src/tools/handlers/core.ts).
      tab: z.string().optional(),
    }),
    ev("done", {
      iterations: z.number().int(),
      stop_reason: StopReason,
      usage: ChatUsage,
      provider: z.string(),
      model: z.string(),
    }),
    ev("error", { message: z.string() }),
  ]),
);

// ---------- history / reset / delete ----------

// Canonical (`Fa*`) content block — the vendor-neutral conversation schema
// (see packages/agent/src/schema/types.ts). Mirrored here as Zod so the
// /history payload is a fully-typed contract the web app reads via api-types.
const FaContentBlock = registry.register(
  "FaContentBlock",
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text"),
      text: z.string(),
      // Sources grounding this text (mirrors FaCitation in
      // packages/agent/src/schema/types.ts). Absent for ordinary model prose.
      citations: z
        .array(
          z.object({
            url: z.string().optional(),
            title: z.string().optional(),
            citedText: z.string().optional(),
            ref: z.string().optional(),
          }),
        )
        .optional(),
    }),
    z.object({
      kind: z.literal("thinking"),
      text: z.string(),
      signature: z.string().optional(),
      redacted: z.literal(true).optional(),
      hidden: z.literal(true).optional(),
    }),
    z.object({
      kind: z.literal("tool_call"),
      callId: z.string(),
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
    }),
    z.object({
      kind: z.literal("tool_result"),
      callId: z.string(),
      output: z.string(),
      isError: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("image"),
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("url"), url: z.string() }),
        z.object({
          kind: z.literal("base64"),
          mediaType: z.string(),
          data: z.string(),
        }),
      ]),
    }),
  ]),
);

const ConversationMessage = registry.register(
  "ConversationMessage",
  z.object({
    role: z.enum(["user", "assistant"]),
    // Either a plain string or a canonical content-block array. Image blocks
    // are stripped on persistence and replaced with a `[image: …]` text block,
    // so served history won't carry them.
    content: z.union([z.string(), z.array(FaContentBlock)]),
  }),
);

export const HistoryResponse = registry.register(
  "HistoryResponse",
  z.object({
    userId: z.string(),
    messages: z.array(ConversationMessage),
    // Cursor (message id) to pass as `?before=` to fetch the next, older page.
    // null when this page reaches the start of the conversation (or for the
    // legacy, un-paginated full-history response).
    nextCursor: z.number().nullable(),
  }),
);

export const ResetResponse = registry.register(
  "ResetResponse",
  z.object({
    userId: z.string(),
    reset: z.literal(true),
  }),
);

export const DeleteMeResponse = registry.register(
  "DeleteMeResponse",
  z.object({
    deleted: z.literal(true),
  }),
);

export const ErrorResponse = registry.register(
  "ErrorResponse",
  z.object({
    error: z.string(),
  }),
);

// ===================================================================
// Data-screen schemas (dashboard / progress / profile / body / diet /
// workout). These mirror the ad-hoc JSON the handlers in index.ts return
// today, lifted into the registry so Orval can generate typed hooks. The
// shapes are grounded in the shared types (@fa/shared) the handlers build
// from — keep them in sync when a handler's response changes.
// ===================================================================

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// 24h HH:MM wall-clock time.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const Source = z.enum(["db", "estimated", "manual"]);
const Weekday = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

// ---------- profile ----------

const Sex = z.enum(["male", "female"]);
const ActivityLevel = z.enum(["sedentary", "light", "moderate", "very", "extreme"]);
const Goal = z.enum(["cut", "maintain", "recomp", "lean_bulk"]);
const BodyFatMethod = z.enum(["dexa", "bia_scale", "caliper", "visual_estimate", "navy", "other"]);
const Language = z.enum(["en", "el", "ar", "sq", "fa", "ur", "nl", "it"]);

const Profile = registry.register(
  "Profile",
  z
    .object({
      sex: Sex,
      birth_year: z.number().int().openapi({ description: "Year of birth, e.g. 1990" }),
      height_cm: z.number(),
      activity_level: ActivityLevel,
      goal: Goal,
      restrictions: z.array(z.string()).optional(),
      target_weight_kg: z.number().nullable().optional(),
      notes: z.string().optional(),
      wrist_cm: z.number().nullable().optional(),
      ankle_cm: z.number().nullable().optional(),
      units: z.enum(["metric", "imperial"]).optional(),
      language: Language.optional().openapi({
        description: "Product language (BCP-47 base subtag). Drives UI + agent-authored content.",
      }),
      water_goal_ml: z.number().int().nullable().optional().openapi({
        description:
          "Everyday hydration target in ml, applied to every day. Null/absent = app default. Single source of truth for the daily water goal.",
      }),
      gym_machine_ids: z.array(z.string()).nullable().optional().openapi({
        description:
          "Catalog machine ids (snake_case) the user's gym has. Optional equipment filter the agent prefers when planning; empty/absent = no constraint.",
      }),
    })
    .openapi({
      description: "Stable identity + targets. Weight / body-fat live on BodyCompEntry.",
    }),
);

export const ProfileResponse = registry.register(
  "ProfileResponse",
  z.object({ profile: Profile.nullable() }),
);

// PATCH /me/profile — partial profile patch. `age` is an alternative to
// `birth_year` (server derives birth_year = current year − age). weight/body-fat
// are intentionally NOT here — they live on body_comp_entry (POST /body).
export const ProfileUpdateRequest = registry.register(
  "ProfileUpdateRequest",
  z.object({
    sex: Sex.optional(),
    birth_year: z.number().int().optional(),
    age: z.number().optional(),
    height_cm: z.number().optional(),
    activity_level: ActivityLevel.optional(),
    goal: Goal.optional(),
    target_weight_kg: z.number().nullable().optional(),
    restrictions: z.array(z.string()).optional(),
    notes: z.string().optional(),
    wrist_cm: z.number().nullable().optional(),
    wrist_in: z.number().optional(),
    ankle_cm: z.number().nullable().optional(),
    ankle_in: z.number().optional(),
    units: z.enum(["metric", "imperial"]).optional(),
    language: Language.optional(),
    water_goal_ml: z.number().int().nullable().optional(),
    gym_machine_ids: z.array(z.string()).nullable().optional(),
  }),
);

export const ProfileUpdateResponse = registry.register(
  "ProfileUpdateResponse",
  z.object({
    saved: z.boolean(),
    created: z.boolean(),
    profile: Profile,
    hint: z.string(),
  }),
);

// ---------- entitlements (GET /me/entitlements) ----------

// The feature-access map the web app gates on, plus why each disabled feature
// is off. Core reasons: "no_llm" / "no_vision" (the server has no provider
// configured for it); server extensions may add their own codes. Keys mirror
// FEATURE_KEYS in ./entitlements.ts — keep them in sync when adding a gate.
const FeatureLock = z.string().nullable();
export const EntitlementsResponse = registry.register(
  "EntitlementsResponse",
  z
    .object({
      features: z.object({
        ai_chat: z.boolean(),
        ai_image: z.boolean(),
        silhouette_scan: z.boolean(),
      }),
      locks: z.object({
        ai_chat: FeatureLock,
        ai_image: FeatureLock,
        silhouette_scan: FeatureLock,
      }),
    })
    .openapi({
      description:
        "Resolved per-feature access flags. `locks` gives the reason code for each feature that's off (null when on).",
    }),
);
export type EntitlementsResponse = z.infer<typeof EntitlementsResponse>;

// ---------- AI usage (GET /me/usage) ----------

// What the user's AI calls cost in one UTC month (see @fa/shared/usage). Token
// counts are raw provider tokens; costs are estimates at list price and null
// when no call in the group has a priced model.
const UsageTotals = z.object({
  events: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cached_tokens: z.number().int(),
  cost_usd: z.number().nullable(),
});

export const UsageResponse = registry.register(
  "UsageResponse",
  z.object({
    month: z.string().openapi({ description: "Reported UTC month, YYYY-MM" }),
    // Months with any usage, newest first (always includes the current month).
    months: z.array(z.string()),
    // The configured chat model; null when no LLM is configured.
    llm: z.object({ provider: z.string(), model: z.string() }).nullable(),
    totals: UsageTotals,
    by_source: z.array(
      UsageTotals.extend({
        source: z.enum(USAGE_SOURCES),
        kind: z.enum(USAGE_KINDS),
      }),
    ),
    by_model: z.array(
      UsageTotals.extend({
        provider: z.string(),
        model: z.string(),
      }),
    ),
    daily: z.array(
      z.object({
        date: z.string().openapi({ description: "UTC day, YYYY-MM-DD" }),
        kind: z.enum(USAGE_KINDS),
        input_tokens: z.number().int(),
        output_tokens: z.number().int(),
        cost_usd: z.number().nullable(),
      }),
    ),
  }),
);
export type UsageResponse = z.infer<typeof UsageResponse>;

// ---------- macros / meals (display views) ----------

// A logged meal item: frozen absolute macros + the food ref, plus two
// display-only fields the server fills in on the wire (category/display_name
// from the pantry, fiber back-filled when the historical row lacked it).
const MealItem = registry.register(
  "MealItem",
  Macros.extend({
    food: z.string(),
    grams: z.number(),
    source: Source.optional(),
    category: z.string().optional(),
    display_name: z.string().optional(),
    // Presentation-only grouping tag set by log_recipe: items expanded from one
    // recipe share this tag so the day list can fold them under a recipe header.
    recipe: z.object({ slug: z.string(), name: z.string(), servings: z.number() }).optional(),
  }),
);

const Meal = registry.register(
  "Meal",
  z.object({
    slot: z.string(),
    time: z.string().optional(),
    items: z.array(MealItem),
  }),
);

// dayTotals() shape (shared/macros.ts) — eaten vs target with remaining.
const DayTotals = z.object({
  date: z.string(),
  eaten: Macros,
  target: Macros.nullable(),
  remaining: Macros.nullable(),
  meal_count: z.number().int(),
});

// ---------- body composition ----------

const BodyCompEntry = registry.register(
  "BodyCompEntry",
  z.object({
    id: z.number().int().optional(),
    date: z.string(),
    weight_kg: z.number().nullable(),
    body_fat_pct: z.number().nullable(),
    body_fat_method: BodyFatMethod.nullable().optional(),
    waist_cm: z.number().nullable(),
    neck_cm: z.number().nullable().optional(),
    hip_cm: z.number().nullable().optional(),
    notes: z.string().optional(),
    time: z.string().nullable().optional(),
    body_fat_pct_navy: z.number().nullable().optional(),
    bmi: z.number().nullable().optional(),
    ffmi: z.number().nullable().optional(),
    ffmi_normalized: z.number().nullable().optional(),
    fat_free_mass_kg: z.number().nullable().optional(),
    fat_mass_kg: z.number().nullable().optional(),
    logged_at: z.string().optional(),
  }),
);

export const BodyLogRequest = registry.register(
  "BodyLogRequest",
  z.object({
    date: z.string().regex(DATE).optional(),
    weight_kg: z.number(),
    body_fat_pct: z.number().nullable().optional(),
    body_fat_method: BodyFatMethod.nullable().optional(),
    waist_cm: z.number().nullable().optional(),
    neck_cm: z.number().nullable().optional(),
    hip_cm: z.number().nullable().optional(),
    notes: z.string().optional(),
    time: z.string().regex(HHMM).nullable().optional(),
  }),
);

// PATCH /body/{date} — partial edit of one weigh-in. `entry_id` pins the exact
// row; without it the route locates the entry by the {date} in the path.
export const BodyUpdateRequest = registry.register(
  "BodyUpdateRequest",
  BodyLogRequest.partial().extend({ entry_id: z.number().int().optional() }),
);

const BodyComputed = z.object({
  bmi: z.number().nullable(),
  body_fat_pct_navy: z.number().nullable(),
  effective_body_fat_pct: z.number().nullable(),
  fat_free_mass_kg: z.number().nullable(),
  fat_mass_kg: z.number().nullable(),
  ffmi: z.number().nullable(),
  ffmi_normalized: z.number().nullable(),
});

export const BodyLogResponse = registry.register(
  "BodyLogResponse",
  z.object({
    logged: BodyCompEntry,
    computed: BodyComputed,
    trend: z
      .object({ previous_date: z.string(), weight_delta_kg: z.number().nullable() })
      .nullable(),
    total_entries: z.number().int(),
  }),
);

// ---------- dashboard ----------

export const DashboardResponse = registry.register(
  "DashboardResponse",
  z.object({
    date: z.string(),
    is_today: z.boolean(),
    today_iso: z.string(),
    weekday: z.string(),
    profile: Profile.nullable(),
    today: z.object({
      meals: z.array(Meal),
      eaten: Macros,
      eaten_from_meals: Macros,
      target: Macros.nullable(),
      remaining: Macros.nullable(),
      meal_count: z.number().int(),
    }),
    bodyComp: z.array(BodyCompEntry),
  }),
);

// ---------- progress ----------

export const ProgressNutritionResponse = registry.register(
  "ProgressNutritionResponse",
  z.object({
    from: z.string(),
    to: z.string(),
    days: z.array(
      z.object({
        date: z.string(),
        meals: z.array(Meal),
        eaten: Macros,
        target: Macros.nullable(),
        remaining: Macros.nullable(),
        meal_count: z.number().int(),
      }),
    ),
    totals: z.object({
      eaten: Macros,
      target: Macros.nullable(),
      days_with_logs: z.number().int(),
    }),
    averages: z.object({
      eaten: Macros.nullable(),
      target: Macros.nullable(),
    }),
  }),
);

const BodyStatSummary = z
  .object({
    first: z.number(),
    last: z.number(),
    min: z.number(),
    max: z.number(),
    change: z.number(),
    count: z.number().int(),
  })
  .nullable();

export const ProgressBodyResponse = registry.register(
  "ProgressBodyResponse",
  z.object({
    from: z.string(),
    to: z.string(),
    entries: z.array(BodyCompEntry),
    stats: z.object({
      weight_kg: BodyStatSummary,
      body_fat_pct: BodyStatSummary,
      waist_cm: BodyStatSummary,
      bmi: BodyStatSummary,
      ffmi: BodyStatSummary,
    }),
    sex: Sex.nullable(),
  }),
);

// ---------- body measurements (tape girths) ----------

const Girth = z.number().min(5).max(300).nullable().optional();

// One day's measuring session. Omitted fields keep their value, null clears.
// waist / neck / hip are written onto that day's weigh-in (they feed Navy
// BF%); weight_kg is only needed to create that weigh-in when there isn't one.
export const MeasurementLogRequest = registry.register(
  "MeasurementLogRequest",
  z.object({
    shoulders_cm: Girth,
    chest_cm: Girth,
    arm_cm: Girth,
    forearm_cm: Girth,
    thigh_cm: Girth,
    calf_cm: Girth,
    waist_cm: Girth,
    neck_cm: Girth,
    hip_cm: Girth,
    weight_kg: z.number().positive().nullable().optional(),
    notes: z.string().optional(),
    time: z.string().regex(HHMM).nullable().optional(),
  }),
);

// A day's girths merged from both sources: the measuring session (muscle
// girths) and the day's newest weigh-in (waist / neck / hip).
const MeasurementDay = registry.register(
  "MeasurementDay",
  z.object({
    date: z.string(),
    shoulders_cm: z.number().nullable(),
    chest_cm: z.number().nullable(),
    arm_cm: z.number().nullable(),
    forearm_cm: z.number().nullable(),
    thigh_cm: z.number().nullable(),
    calf_cm: z.number().nullable(),
    waist_cm: z.number().nullable(),
    neck_cm: z.number().nullable(),
    hip_cm: z.number().nullable(),
    notes: z.string().optional(),
    // Whether a measuring session exists (deletable); weigh-in girths alone
    // belong to the weigh-in and are removed from Composition.
    has_session: z.boolean(),
    weigh_in_id: z.number().int().nullable(),
    // User-picked HH:MM: the session's, else the weigh-in's.
    time: z.string().nullable(),
    // When the day was measured (ISO timestamp): the session's, else the
    // weigh-in's. Null when neither carries one.
    logged_at: z.string().nullable(),
  }),
);

export const ProgressMeasurementsResponse = registry.register(
  "ProgressMeasurementsResponse",
  z.object({
    from: z.string(),
    to: z.string(),
    entries: z.array(MeasurementDay),
    // Newest value of each part on or before `to`, each part independently —
    // what the proportions are computed from.
    latest: z.record(z.string(), z.number()),
    // compute_ideal_proportions over `latest`; null without sex + wrist.
    proportions: z.record(z.string(), z.unknown()).nullable(),
    sex: Sex.nullable(),
    wrist_cm: z.number().nullable(),
  }),
);

// ---------- cardio fitness (VO₂max time-series) ----------

const Vo2MaxCategory = z.enum(["poor", "fair", "good", "excellent", "superior"]);

const CardioEntry = registry.register(
  "CardioEntry",
  z.object({
    id: z.number().int().optional(),
    date: z.string(),
    resting_heart_rate: z.number().nullable(),
    max_heart_rate: z.number().nullable().optional(),
    notes: z.string().optional(),
    vo2_max: z.number().nullable().optional(),
    vo2_max_category: Vo2MaxCategory.nullable().optional(),
    max_heart_rate_estimated: z.boolean().nullable().optional(),
  }),
);

export const CardioLogRequest = registry.register(
  "CardioLogRequest",
  z.object({
    date: z.string().regex(DATE).optional(),
    resting_heart_rate: z.number(),
    max_heart_rate: z.number().nullable().optional(),
    notes: z.string().optional(),
  }),
);

export const CardioLogResponse = registry.register(
  "CardioLogResponse",
  z.object({
    logged: CardioEntry,
    vo2_max: z.number(),
    category: Vo2MaxCategory,
    max_heart_rate: z.number(),
    max_heart_rate_estimated: z.boolean(),
    total_entries: z.number().int(),
    notes: z.array(z.string()),
  }),
);

export const ProgressCardioResponse = registry.register(
  "ProgressCardioResponse",
  z.object({
    from: z.string(),
    to: z.string(),
    entries: z.array(CardioEntry),
    stats: z.object({
      resting_heart_rate: BodyStatSummary,
      vo2_max: BodyStatSummary,
    }),
    sex: Sex.nullable(),
  }),
);

// ---------- steps (daily pedometer aggregate) ----------

// One day's step total + the goal in force for that day. `goal` is nullable —
// null means "no per-day goal set; the UI applies its default".
const StepsDay = z.object({
  date: z.string(),
  steps: z.number().int(),
  goal: z.number().int().nullable(),
});

export const StepsResponse = registry.register("StepsResponse", StepsDay);

// POST /steps upserts the day's total. `steps` is the ABSOLUTE count for the
// day (the client owns today's running total from the accelerometer and writes
// the whole number), not a delta. `date` defaults to today; `goal` is optional
// (omit to leave the existing goal untouched).
export const StepsLogRequest = registry.register(
  "StepsLogRequest",
  z.object({
    date: z.string().regex(DATE).optional(),
    steps: z.number().int().min(0).max(500_000),
    goal: z.number().int().min(0).max(500_000).nullable().optional(),
  }),
);

// ---------- water (daily intake aggregate) ----------

// One day's water total (ml). The daily goal is not per-day — it's
// profile.water_goal_ml (GET /me/profile).
const WaterDay = z.object({
  date: z.string(),
  ml: z.number().int(),
});

export const WaterResponse = registry.register("WaterResponse", WaterDay);

// POST /water upserts the day's total. `ml` is the ABSOLUTE intake for the day
// (the client owns the running total and writes the whole number), not a delta.
// `date` defaults to today. 20 L/day caps any fat-fingered entry.
export const WaterLogRequest = registry.register(
  "WaterLogRequest",
  z.object({
    date: z.string().regex(DATE).optional(),
    ml: z.number().int().min(0).max(20_000),
  }),
);

// ---------- diet plan (resolved template tree) ----------

const Portion = z.object({
  food: z.string(),
  grams: z.number().positive(),
  macros: Macros.optional(),
  source: Source.optional(),
});

const ResolvedDietPortion = Portion.extend({
  id: z.number().int(),
  resolved: Macros.nullable(),
  override: z.boolean(),
});

const ResolvedDietMeal = z.object({
  id: z.number().int(),
  slot: z.string(),
  time: z.string().optional(),
  items: z.array(ResolvedDietPortion),
  totals: Macros,
  unresolved: z.number().int(),
});

const ResolvedDietDay = z.object({
  id: z.number().int(),
  name: z.string(),
  weekdays: z.array(Weekday),
  target: Macros.optional(),
  meals: z.array(ResolvedDietMeal),
  totals: Macros,
  unresolved: z.number().int(),
});

const ResolvedDietPlan = registry.register(
  "ResolvedDietPlan",
  z.object({
    id: z.number().int(),
    name: z.string(),
    start_date: z.string().optional(),
    default_target: Macros.optional(),
    rotation: z.array(ResolvedDietDay),
  }),
);

export const DietPlanResponse = registry.register(
  "DietPlanResponse",
  z.object({
    plan: ResolvedDietPlan.nullable(),
    today_day_id: z.number().int().nullable(),
  }),
);

// Lightweight per-plan summary for the plan picker (no resolved tree).
const DietPlanSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  active: z.boolean(),
  day_count: z.number().int(),
});

export const DietPlanListResponse = registry.register(
  "DietPlanListResponse",
  z.object({
    plans: z.array(DietPlanSummary),
    active_plan_id: z.number().int().nullable(),
  }),
);

const DietMealWrite = z.object({
  slot: z.string(),
  time: z.string().nullable().optional(),
  items: z.array(Portion),
});

export const DietPlanWriteRequest = registry.register(
  "DietPlanWriteRequest",
  z.object({
    name: z.string().nullable().optional(),
    start_date: z.string().regex(DATE).nullable().optional(),
    default_target: Macros.nullable().optional(),
    days: z.array(
      z.object({
        name: z.string().optional(),
        weekdays: z.array(Weekday).optional(),
        target: Macros.nullable().optional(),
        meals: z.array(DietMealWrite),
      }),
    ),
  }),
);

export const DietDayPatchRequest = z.object({
  name: z.string().optional(),
  weekdays: z.array(Weekday).optional(),
  target: Macros.nullable().optional(),
});

export const DietMealAddRequest = DietMealWrite;

export const DietMealPatchRequest = z.object({
  slot: z.string().optional(),
  time: z.string().nullable().optional(),
});

export const DietPortionAddRequest = Portion;

export const DietPortionPatchRequest = z.object({
  food: z.string().optional(),
  grams: z.number().positive().optional(),
  macros: Macros.nullable().optional(),
});

export const LogPlannedRequest = z.object({
  meal_id: z.number().int(),
  date: z.string().regex(DATE).optional(),
});

export const LogPlannedResponse = registry.register(
  "LogPlannedResponse",
  z.object({
    logged: z.object({
      date: z.string(),
      slot: z.string(),
      item_count: z.number().int(),
    }),
    day_totals: DayTotals,
  }),
);

// ---------- recipes (named, reusable ingredient bundles) ----------

const ResolvedRecipePortion = Portion.extend({
  id: z.number().int(),
  resolved: Macros.nullable(),
  override: z.boolean(),
});

const ResolvedRecipe = registry.register(
  "ResolvedRecipe",
  z.object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    servings: z.number(),
    favorite: z.boolean(),
    notes: z.string().optional(),
    instructions: z.string().optional(),
    source_url: z.string().optional(),
    ingredients: z.array(ResolvedRecipePortion),
    totals: Macros,
    per_serving: Macros,
    unresolved: z.number().int(),
  }),
);

export const RecipeResponse = registry.register(
  "RecipeResponse",
  z.object({ recipe: ResolvedRecipe.nullable() }),
);

// Lightweight per-recipe summary for the recipe list (no resolved tree, but a
// live kcal_per_serving so the card shows a number without fetching the tree).
const RecipeSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  servings: z.number(),
  favorite: z.boolean(),
  ingredient_count: z.number().int(),
  kcal_per_serving: z.number(),
  unresolved: z.number().int(),
});

export const RecipeListResponse = registry.register(
  "RecipeListResponse",
  z.object({ recipes: z.array(RecipeSummary) }),
);

// ---------- workout catalog ----------

const Equipment = z.enum([
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "bodyweight",
  "band",
  "smith_machine",
  "cardio",
]);
const ExerciseType = z.enum(["compound", "isolation", "cardio"]);
const WorkoutMetricKind = z.enum(["reps_weight", "duration_distance", "duration_weight"]);

export const WorkoutCatalog = registry.register(
  "WorkoutCatalog",
  z.object({
    muscle_groups: z.array(
      z.object({ id: z.string(), label: z.string(), muscles: z.array(z.string()) }),
    ),
    muscles: z.array(z.object({ id: z.string(), label: z.string(), group: z.string() })),
    exercises: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: ExerciseType,
        equipment: Equipment,
        primary_muscles: z.array(z.string()),
        secondary_muscles: z.array(z.string()),
        machine_id: z.string().optional(),
        tracks: z.array(WorkoutMetricKind).optional(),
        notes: z.string().optional(),
        // Optional reference media + how-to content. Reserved — not populated
        // in the catalog yet (see ExerciseMetadata in workout-types.ts).
        metadata: z
          .object({
            image_urls: z.array(z.string()).optional(),
            video_url: z.string().optional(),
            description: z.string().optional(),
          })
          .optional(),
      }),
    ),
    machines: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        muscle_groups: z.array(z.string()),
        notes: z.string().optional(),
      }),
    ),
  }),
);

// ---------- workout plans ----------

const WorkoutPlanExercise = z.object({
  id: z.number().int(),
  exercise_id: z.string(),
  machine_id: z.string().nullable().optional(),
  order: z.number().int(),
  target_sets: z.number().int(),
  target_reps: z.number().nullable().optional(),
  target_weight_kg: z.number().nullable().optional(),
  target_duration_sec: z.number().nullable().optional(),
  target_distance_m: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const WorkoutPlan = registry.register(
  "WorkoutPlan",
  z.object({
    id: z.number().int(),
    name: z.string(),
    notes: z.string().nullable().optional(),
    days: z.array(
      z.object({
        id: z.number().int(),
        weekdays: z.array(Weekday),
        name: z.string(),
        focus: z.string().nullable().optional(),
        exercises: z.array(WorkoutPlanExercise),
      }),
    ),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  }),
);

const WorkoutPlanExerciseWrite = z.object({
  exercise_id: z.string(),
  machine_id: z.string().nullable().optional(),
  order: z.number().int().optional(),
  target_sets: z.number().int().optional(),
  target_reps: z.number().nullable().optional(),
  target_weight_kg: z.number().nullable().optional(),
  target_duration_sec: z.number().nullable().optional(),
  target_distance_m: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const WorkoutPlanWriteRequest = registry.register(
  "WorkoutPlanWriteRequest",
  z.object({
    name: z.string(),
    notes: z.string().nullable().optional(),
    days: z.array(
      z.object({
        // canonical weekdays[] or legacy single `weekday` (server normalizes)
        weekdays: z.array(Weekday).optional(),
        weekday: z.string().optional(),
        name: z.string().optional(),
        focus: z.string().nullable().optional(),
        exercises: z.array(WorkoutPlanExerciseWrite).optional(),
      }),
    ),
  }),
);

export const WorkoutPlansResponse = registry.register(
  "WorkoutPlansResponse",
  z.object({
    plans: z.array(WorkoutPlan),
    active_plan_id: z.number().int().nullable(),
  }),
);

export const WorkoutPlanResponse = registry.register(
  "WorkoutPlanResponse",
  z.object({ plan: WorkoutPlan }),
);

// ---------- workout sessions + sets ----------

const WorkoutSet = registry.register(
  "WorkoutSet",
  z.object({
    id: z.number().int(),
    session_id: z.number().int(),
    exercise_id: z.string(),
    machine_id: z.string().nullable().optional(),
    set_index: z.number().int(),
    reps: z.number(),
    weight_kg: z.number(),
    rpe: z.number().nullable().optional(),
    duration_sec: z.number().nullable().optional(),
    distance_m: z.number().nullable().optional(),
    completed_at: z.string().nullable().optional(),
  }),
);

const WorkoutSession = registry.register(
  "WorkoutSession",
  z.object({
    id: z.number().int(),
    date: z.string(),
    plan_day_id: z.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
    duration_min: z.number().nullable().optional(),
    kcal_burned: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
    sets: z.array(WorkoutSet),
    started_at: z.string().nullable().optional(),
    updated_at: z.string().optional(),
  }),
);

export const WorkoutSessionStartRequest = z.object({
  date: z.string().regex(DATE).optional(),
  plan_day_id: z.number().int().nullable().optional(),
  name: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const WorkoutSessionPatchRequest = z.object({
  name: z.string().nullable().optional(),
  duration_min: z.number().nullable().optional(),
  kcal_burned: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const WorkoutSetRequest = z.object({
  exercise_id: z.string(),
  machine_id: z.string().nullable().optional(),
  reps: z.number(),
  weight_kg: z.number().optional(),
  rpe: z.number().nullable().optional(),
  duration_sec: z.number().nullable().optional(),
  distance_m: z.number().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});

export const WorkoutSessionsResponse = registry.register(
  "WorkoutSessionsResponse",
  z.object({
    from: z.string(),
    to: z.string(),
    sessions: z.array(WorkoutSession),
  }),
);

export const WorkoutSessionResponse = registry.register(
  "WorkoutSessionResponse",
  z.object({ session: WorkoutSession }),
);

export const WorkoutSetResponse = registry.register(
  "WorkoutSetResponse",
  z.object({ set: WorkoutSet }),
);

// ---------- workout progress ----------

export const LastSetsResponse = registry.register(
  "LastSetsResponse",
  z.object({
    exercise_id: z.string(),
    sets: z.array(
      z.object({
        set_id: z.number().int(),
        session_id: z.number().int(),
        date: z.string(),
        reps: z.number(),
        weight_kg: z.number(),
        rpe: z.number().nullable(),
        duration_sec: z.number().nullable(),
        completed_at: z.string().nullable(),
      }),
    ),
  }),
);

export const ExerciseProgressResponse = registry.register(
  "ExerciseProgressResponse",
  z.object({
    exercise_id: z.string(),
    from: z.string(),
    to: z.string(),
    points: z.array(
      z.object({
        date: z.string(),
        top_weight_kg: z.number(),
        top_reps_at_top_weight: z.number(),
        est_1rm_kg: z.number(),
        total_volume_kg: z.number(),
      }),
    ),
  }),
);

export const MuscleGroupVolumeResponse = registry.register(
  "MuscleGroupVolumeResponse",
  z.object({
    from: z.string(),
    to: z.string(),
    points: z.array(
      z.object({
        week_start: z.string(),
        group_id: z.string(),
        total_volume_kg: z.number(),
        set_count: z.number().int(),
      }),
    ),
  }),
);

export const RecentPRsResponse = registry.register(
  "RecentPRsResponse",
  z.object({
    prs: z.array(
      z.object({
        exercise_id: z.string(),
        date: z.string(),
        kind: z.enum(["top_weight", "est_1rm"]),
        reps: z.number(),
        weight_kg: z.number(),
        est_1rm_kg: z.number(),
      }),
    ),
  }),
);

// ---------- foods ----------

// GET /foods → a per-100 macro map keyed by food name (the add-food dialog's
// catalog). Reuses the FoodView shape registered above.
export const FoodsResponse = registry.register("FoodsResponse", z.record(z.string(), FoodView));

// ---------- inferred TS types (used by handlers) ----------

export type ChatRequest = z.infer<typeof ChatRequest>;
export type ChatResult = z.infer<typeof ChatResult>;
export type ImageInput = z.infer<typeof ImageInput>;
