/**
 * OpenAPI 3.1 document: HTTP route registration + document generation.
 *
 * The data-model schemas live in ./schemas.ts (also imported by the web app via
 * "@fa/shared/schemas"). This module owns the *route catalog* — the
 * registerPath() calls and path-only query/param schemas — plus the generator,
 * so the web bundle (which imports only @fa/shared/schemas) doesn't carry the
 * server's route definitions. Server-only; exposed via "@fa/shared/openapi".
 *
 * Co-located with schemas.ts in @fa/shared so schema registration and document
 * generation resolve the SAME @asteasolutions/zod-to-openapi instance: zod 4 +
 * zod-to-openapi don't hoist to one root copy (better-auth pins zod 3), so a
 * split across packages would make components.schemas generate empty.
 */
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  registry,
  BarcodeLookupResponse,
  BodyLogRequest,
  BodyLogResponse,
  BodyUpdateRequest,
  CardioLogRequest,
  CardioLogResponse,
  ChatRequest,
  ChatResult,
  DashboardResponse,
  DeleteMeResponse,
  DietDayPatchRequest,
  DietMealAddRequest,
  DietMealPatchRequest,
  DietPlanListResponse,
  DietPlanResponse,
  DietPlanWriteRequest,
  DietPortionAddRequest,
  DietPortionPatchRequest,
  EntitlementsResponse,
  UsageResponse,
  ErrorResponse,
  ExerciseProgressResponse,
  FoodScanRequest,
  FoodScanResponse,
  FoodsResponse,
  HistoryResponse,
  LastSetsResponse,
  LogPlannedRequest,
  LogPlannedResponse,
  MuscleGroupVolumeResponse,
  PantryQuery,
  PantryResponse,
  ProfileResponse,
  ProfileUpdateRequest,
  ProfileUpdateResponse,
  ProgressBodyResponse,
  ProgressCardioResponse,
  ProgressMeasurementsResponse,
  MeasurementLogRequest,
  ProgressNutritionResponse,
  ReceiptScanRequest,
  ReceiptScanResponse,
  RecentPRsResponse,
  RecipeListResponse,
  RecipeResponse,
  ResetResponse,
  StepsLogRequest,
  StepsResponse,
  StreamEvent,
  WaterLogRequest,
  WaterResponse,
  WorkoutCatalog,
  WorkoutPlanResponse,
  WorkoutPlanWriteRequest,
  WorkoutPlansResponse,
  WorkoutSessionPatchRequest,
  WorkoutSessionResponse,
  WorkoutSessionStartRequest,
  WorkoutSessionsResponse,
  WorkoutSetRequest,
  WorkoutSetResponse,
} from "./schemas.ts";

// YYYY-MM-DD path/query param guard (mirrors the one in schemas.ts).
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- shared query-param schemas ----------

const DateQuery = z.object({
  date: z
    .string()
    .regex(DATE)
    .optional()
    .openapi({ description: "YYYY-MM-DD; defaults to today." }),
});
const RangeQuery = z.object({
  from: z.string().regex(DATE).optional(),
  to: z.string().regex(DATE).optional(),
});
const LimitQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
});
const FoodsQuery = z.object({
  query: z
    .string()
    .optional()
    .openapi({ description: "Name substring; omit for the whole catalog." }),
});
const FoodLookupQuery = z.object({
  barcode: z.string().optional(),
  query: z.string().optional(),
  top: z.coerce.number().int().min(1).optional(),
});

// ---------- path registration ----------

const json = (schema: z.ZodTypeAny) => ({
  "application/json": { schema },
});

const errorResponses = {
  400: { description: "Bad request", content: json(ErrorResponse) },
  401: { description: "Not signed in", content: json(ErrorResponse) },
  429: { description: "Rate limit exceeded", content: json(ErrorResponse) },
  500: { description: "Internal error", content: json(ErrorResponse) },
};

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Liveness probe",
  responses: {
    200: { description: "ok", content: { "text/plain": { schema: z.literal("ok") } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/chat",
  summary: "Send a turn, get the full response (non-streaming)",
  description:
    "Wraps the Anthropic tool-use loop. Returns once `stop_reason !== 'tool_use'` " +
    "or after MAX_ITERATIONS. Use /chat/stream for incremental output.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(ChatRequest), required: true } },
  responses: {
    200: { description: "Final assistant message + usage", content: json(ChatResult) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/chat/stream",
  summary: "Send a turn, stream events as SSE",
  description:
    "Server-Sent Events. Each event has a `type` matching the StreamEvent schema. " +
    "Terminal events: `done` (success) or `error`. Frontends should parse `event:` " +
    "and `data:` lines and dispatch on `event` name.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(ChatRequest), required: true } },
  responses: {
    200: {
      description: "SSE stream of StreamEvent",
      content: {
        "text/event-stream": {
          schema: StreamEvent,
        },
      },
    },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/foods/scan",
  summary: "Recognize food from a photo (read-only)",
  description:
    "Runs a one-off vision pass over a photo of a meal / food / product / " +
    "nutrition label and returns the recognized item(s) with estimated " +
    "per-100g macros and portion grams. Does NOT log anything — the client " +
    "confirms macros/grams and then logs via POST /tools/run with log_meal.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(FoodScanRequest), required: true } },
  responses: {
    200: { description: "Recognized foods", content: json(FoodScanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/pantry",
  summary: "List the pantry with search / filter / sort / pagination",
  description:
    "Returns the user's pantry items. Supports a name search (q), category " +
    "filters, sort + order, and limit/offset pagination. Omit limit to get the " +
    "full filtered set (used for food autocomplete). `total` is the filtered " +
    "count for the pager; `categories` is the full distinct category list.",
  security: [{ cookieAuth: [] }],
  request: { query: PantryQuery },
  responses: {
    200: { description: "Pantry items", content: json(PantryResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/pantry/scan-receipt",
  summary: "Extract grocery items from a receipt photo (read-only)",
  description:
    "Runs a one-off vision pass over a receipt image and returns the edible " +
    "line items mapped to pantry entries (snake_case name + estimated grams). " +
    "Does NOT write the pantry — the client confirms/edits the items and then " +
    "writes them via POST /tools/run with the update_pantry tool.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(ReceiptScanRequest), required: true } },
  responses: {
    200: { description: "Extracted items", content: json(ReceiptScanResponse) },
    ...errorResponses,
  },
});

const HistoryQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .openapi({
      description:
        "Page size for scroll-up pagination (default 20). Omit both params for " +
        "the legacy full-history response.",
    }),
  before: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .openapi({
      description:
        "Return the page of messages just older than this message id (the " +
        "`nextCursor` from the previous page).",
    }),
});

registry.registerPath({
  method: "get",
  path: "/history",
  summary: "Fetch the current user's conversation history",
  description:
    "Paginated for the chat scroll-up: `?limit=N` returns the most recent N " +
    "messages; `?before=<id>&limit=N` returns the N just-older messages " +
    "(oldest-first within the page). `nextCursor` is the next `before` to use, " +
    "or null at the start. With no params the full history is returned.",
  security: [{ cookieAuth: [] }],
  request: { query: HistoryQuery },
  responses: {
    200: { description: "Conversation messages", content: json(HistoryResponse) },
    400: errorResponses[400],
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "post",
  path: "/reset",
  summary: "Wipe the current user's conversation history",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Reset confirmation", content: json(ResetResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "delete",
  path: "/me",
  summary: "Delete the current user and all their data (GDPR)",
  description: "Cascades through every app table via ON DELETE CASCADE on user.id.",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Account deleted", content: json(DeleteMeResponse) },
    401: errorResponses[401],
  },
});

// ---- profile ----

registry.registerPath({
  method: "get",
  path: "/me/profile",
  summary: "Get the current user's profile",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Profile (or null if not set up)", content: json(ProfileResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/me/entitlements",
  summary: "Current user's resolved feature-access map",
  description:
    "Returns the per-feature flags the web app gates on (ai_chat, ai_image, " +
    "silhouette_scan) and, for each disabled one, a reason code in `locks` — " +
    '"no_llm" / "no_vision" when the server has no provider configured, or a ' +
    "code added by a server extension.",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Feature flags + lock reasons", content: json(EntitlementsResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/me/usage",
  summary: "AI usage and estimated cost for a month",
  description:
    "Current UTC month by default; pass month=YYYY-MM (from `months`) for an " +
    "earlier one. Costs are estimates at the provider's list price.",
  security: [{ cookieAuth: [] }],
  request: {
    query: z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
  },
  responses: {
    200: { description: "Usage breakdown", content: json(UsageResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/me/profile",
  summary: "Update the current user's profile (partial merge)",
  description:
    "Reuses the agent's update_profile tool. weight / body-fat are NOT profile " +
    "fields — log them via POST /body.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(ProfileUpdateRequest), required: true } },
  responses: {
    200: { description: "Saved profile", content: json(ProfileUpdateResponse) },
    ...errorResponses,
  },
});

// ---- body composition ----

registry.registerPath({
  method: "post",
  path: "/body",
  summary: "Log a body-composition entry",
  description:
    "Reuses the agent's log_body_comp tool so derived metrics (BMI, FFMI, Navy " +
    "BF%) are computed and persisted identically to the chat path.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(BodyLogRequest), required: true } },
  responses: {
    201: { description: "Logged entry + computed metrics", content: json(BodyLogResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/body/{date}",
  summary: "Delete all body-composition entries for a date",
  description:
    "Removes every weigh-in logged on the given date. Mirrors the agent's " +
    "delete_body_comp_entry tool (delete-by-date). The food log is untouched.",
  security: [{ cookieAuth: [] }],
  request: { params: z.object({ date: z.string().regex(DATE) }) },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/body/entry/{id}",
  summary: "Delete a single body-composition entry by id",
  description:
    "Removes exactly one weigh-in by its row id, leaving any other entries on " +
    "the same date intact. Used by the Body page's per-row delete.",
  security: [{ cookieAuth: [] }],
  request: { params: z.object({ id: z.coerce.number().int() }) },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/body/{date}",
  summary: "Edit the body-composition entry logged on a date",
  description:
    "Reuses the agent's update_body_comp_entry tool: merges the provided " +
    "fields over the existing entry and recomputes derived metrics (BMI, " +
    "FFMI, Navy BF%). {date} locates the entry; the body may include a new " +
    "`date` to move it to a different day.",
  security: [{ cookieAuth: [] }],
  request: {
    params: z.object({ date: z.string().regex(DATE) }),
    body: { content: json(BodyUpdateRequest), required: true },
  },
  responses: {
    200: {
      description: "Updated entry + computed metrics",
      content: json(z.record(z.string(), z.unknown())),
    },
    ...errorResponses,
  },
});

// ---- dashboard / progress ----

registry.registerPath({
  method: "get",
  path: "/dashboard",
  summary: "Day snapshot: profile + today's meals/totals + body comp",
  security: [{ cookieAuth: [] }],
  request: { query: DateQuery },
  responses: {
    200: { description: "Dashboard snapshot", content: json(DashboardResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/progress/nutrition",
  summary: "Nutrition over a date range (per-day + totals + averages)",
  security: [{ cookieAuth: [] }],
  request: { query: RangeQuery },
  responses: {
    200: { description: "Nutrition progress", content: json(ProgressNutritionResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/progress/body",
  summary: "Body-composition entries + stats over a date range",
  security: [{ cookieAuth: [] }],
  request: { query: RangeQuery },
  responses: {
    200: { description: "Body progress", content: json(ProgressBodyResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/progress/cardio",
  summary: "Cardio-fitness (VO₂max) entries + stats over a date range",
  security: [{ cookieAuth: [] }],
  request: { query: RangeQuery },
  responses: {
    200: { description: "Cardio progress", content: json(ProgressCardioResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/cardio",
  summary: "Log a cardio-fitness reading (resting HR → VO₂max)",
  description:
    "Saves a dated resting-heart-rate reading and snapshots the derived VO₂max " +
    "+ category (read from the profile's age + sex). Shares the agent's " +
    "log_cardio path so chat and UI write identically.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(CardioLogRequest), required: true } },
  responses: {
    201: { description: "Saved cardio reading", content: json(CardioLogResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/cardio/entry/{id}",
  summary: "Delete a single cardio reading by id",
  security: [{ cookieAuth: [] }],
  request: {
    params: z.object({ id: z.coerce.number().int() }),
  },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

// ---- body measurements ----

registry.registerPath({
  method: "get",
  path: "/progress/measurements",
  summary: "Tape girths per day over a date range + current proportions",
  description:
    "Muscle girths from the measuring sessions merged with waist / neck / hip " +
    "from each day's weigh-in, plus the latest value of every part and the " +
    "ideal-proportions comparison computed from them.",
  security: [{ cookieAuth: [] }],
  request: { query: RangeQuery },
  responses: {
    200: { description: "Measurements", content: json(ProgressMeasurementsResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "put",
  path: "/measurements/{date}",
  summary: "Save the measuring session for a date",
  description:
    "Shares the agent's log_measurements path: merges into the day's session " +
    "(null clears a field) and writes waist / neck / hip onto the day's " +
    "weigh-in, creating one when weight_kg is given and none exists.",
  security: [{ cookieAuth: [] }],
  request: {
    params: z.object({ date: z.string().regex(DATE) }),
    body: { content: json(MeasurementLogRequest), required: true },
  },
  responses: {
    200: { description: "Saved", content: json(z.record(z.string(), z.unknown())) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/measurements/{date}",
  summary: "Delete the measuring session for a date",
  description: "Removes the muscle girths only; waist / neck / hip stay on the weigh-in.",
  security: [{ cookieAuth: [] }],
  request: { params: z.object({ date: z.string().regex(DATE) }) },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

// ---- steps ----

registry.registerPath({
  method: "get",
  path: "/steps",
  summary: "Get a day's step total (defaults to today)",
  description:
    "Returns the aggregate step count + goal for the given day. Missing rows " +
    "read as 0 steps / null goal rather than 404 — the pedometer simply hasn't " +
    "written for that day yet.",
  security: [{ cookieAuth: [] }],
  request: { query: DateQuery },
  responses: {
    200: { description: "Day step total", content: json(StepsResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "post",
  path: "/steps",
  summary: "Upsert a day's step total (absolute count)",
  description:
    "Sets the absolute step count for a day (the PWA accelerometer owns today's " +
    "running total and writes the whole number). Optionally sets the daily goal.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(StepsLogRequest), required: true } },
  responses: {
    200: { description: "Saved day step total", content: json(StepsResponse) },
    ...errorResponses,
  },
});

// ---- water ----

registry.registerPath({
  method: "get",
  path: "/water",
  summary: "Get a day's water intake (defaults to today)",
  description:
    "Returns the aggregate water intake (ml) for the given day. Missing rows " +
    "read as 0 ml rather than 404. The daily goal is profile.water_goal_ml.",
  security: [{ cookieAuth: [] }],
  request: { query: DateQuery },
  responses: {
    200: { description: "Day water total", content: json(WaterResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "post",
  path: "/water",
  summary: "Upsert a day's water intake (absolute ml)",
  description:
    "Sets the absolute water intake (ml) for a day; the client owns the running " +
    "total and writes the whole number.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(WaterLogRequest), required: true } },
  responses: {
    200: { description: "Saved day water total", content: json(WaterResponse) },
    ...errorResponses,
  },
});

// ---- foods ----

registry.registerPath({
  method: "get",
  path: "/foods",
  summary: "Per-100 macro catalog (the user's macro-bearing pantry items)",
  security: [{ cookieAuth: [] }],
  request: { query: FoodsQuery },
  responses: {
    200: { description: "Food → per-100 macros map", content: json(FoodsResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/foods/lookup",
  summary: "OpenFoodFacts product lookup (by barcode or free text)",
  description:
    "Thin wrapper over the read-only lookup_product tool. Payload is dynamic " +
    "(per-tool shape) — not modeled here beyond a free-form object.",
  security: [{ cookieAuth: [] }],
  request: { query: FoodLookupQuery },
  responses: {
    200: { description: "Lookup result", content: json(z.record(z.string(), z.unknown())) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/foods/barcode/{code}",
  summary: "Resolve a scanned barcode (deterministic, no LLM)",
  description:
    "Backs the on-device barcode scanner. The client decodes the barcode " +
    "locally and looks the digits up here in a pantry-first → food-index " +
    "cascade. A hit returns the product with its `source` tier; a miss " +
    "(found:false) tells the client to fall back to the AI vision path " +
    "(POST /foods/scan).",
  security: [{ cookieAuth: [] }],
  request: {
    params: z.object({
      code: z.string().openapi({ description: "UPC/EAN/GTIN digits; non-digits are stripped." }),
    }),
  },
  responses: {
    200: { description: "Barcode resolution", content: json(BarcodeLookupResponse) },
    ...errorResponses,
  },
});

// ---- diet plan ----

registry.registerPath({
  method: "get",
  path: "/diet/plan",
  summary: "Get the ACTIVE diet plan (resolved template tree)",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/diet/plans",
  summary: "List all diet plans (summaries) + which is active",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Diet plan list", content: json(DietPlanListResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "post",
  path: "/diet/plans",
  summary: "Create a new diet plan (first plan becomes active)",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(DietPlanWriteRequest), required: true } },
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

const dietPlanId = { params: z.object({ id: z.coerce.number().int() }) };

registry.registerPath({
  method: "get",
  path: "/diet/plans/{id}",
  summary: "Get one diet plan (resolved template tree)",
  security: [{ cookieAuth: [] }],
  request: dietPlanId,
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "put",
  path: "/diet/plans/{id}",
  summary: "Replace one diet plan",
  security: [{ cookieAuth: [] }],
  request: { ...dietPlanId, body: { content: json(DietPlanWriteRequest), required: true } },
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/diet/plans/{id}",
  summary: "Delete one diet plan",
  security: [{ cookieAuth: [] }],
  request: dietPlanId,
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/diet/plans/{id}/activate",
  summary: "Make a diet plan the active one",
  security: [{ cookieAuth: [] }],
  request: dietPlanId,
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

const dietDayId = { params: z.object({ id: z.coerce.number().int() }) };
const dietMealId = { params: z.object({ id: z.coerce.number().int() }) };
const dietPortionId = { params: z.object({ id: z.coerce.number().int() }) };

registry.registerPath({
  method: "patch",
  path: "/diet/days/{id}",
  summary: "Patch a template day (name / weekdays / target)",
  security: [{ cookieAuth: [] }],
  request: { ...dietDayId, body: { content: json(DietDayPatchRequest), required: true } },
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/diet/days/{id}/meals",
  summary: "Add a meal to a template day",
  security: [{ cookieAuth: [] }],
  request: { ...dietDayId, body: { content: json(DietMealAddRequest), required: true } },
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/diet/meals/{id}",
  summary: "Patch a planned meal (slot / time)",
  security: [{ cookieAuth: [] }],
  request: { ...dietMealId, body: { content: json(DietMealPatchRequest), required: true } },
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/diet/meals/{id}",
  summary: "Delete a planned meal",
  security: [{ cookieAuth: [] }],
  request: dietMealId,
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/diet/meals/{id}/portions",
  summary: "Add a portion to a planned meal",
  security: [{ cookieAuth: [] }],
  request: { ...dietMealId, body: { content: json(DietPortionAddRequest), required: true } },
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/diet/portions/{id}",
  summary: "Patch a portion (food / grams / macros override)",
  security: [{ cookieAuth: [] }],
  request: { ...dietPortionId, body: { content: json(DietPortionPatchRequest), required: true } },
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/diet/portions/{id}",
  summary: "Delete a portion",
  security: [{ cookieAuth: [] }],
  request: dietPortionId,
  responses: {
    200: { description: "Resolved diet plan", content: json(DietPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/diet/log-planned",
  summary: 'Log a planned meal as eaten ("ate as planned")',
  description:
    "Resolves the planned meal against the pantry now and freezes it into the " +
    "meal log. 409 with needs_enrichment[] when a portion can't resolve macros.",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(LogPlannedRequest), required: true } },
  responses: {
    200: { description: "Logged meal + day totals", content: json(LogPlannedResponse) },
    409: { description: "Some portions can't resolve macros", content: json(ErrorResponse) },
    ...errorResponses,
  },
});

// ---- recipes (named, reusable ingredient bundles) ----
//
// Reads only over REST; writes (save / log / delete) go through POST /tools/run
// (the mutating recipe tools), mirroring how the Pantry screen mutates.

registry.registerPath({
  method: "get",
  path: "/recipes",
  summary: "List the user's recipes (summaries + live kcal/serving)",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Recipe list", content: json(RecipeListResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "get",
  path: "/recipes/{id}",
  summary: "Get one recipe (resolved ingredient list + totals)",
  security: [{ cookieAuth: [] }],
  request: { params: z.object({ id: z.coerce.number().int() }) },
  responses: {
    200: { description: "Resolved recipe", content: json(RecipeResponse) },
    ...errorResponses,
  },
});

// ---- workout catalog / plans ----

registry.registerPath({
  method: "get",
  path: "/workout/catalog",
  summary: "Static workout catalog (muscle groups / exercises / machines)",
  responses: {
    200: { description: "Catalog", content: json(WorkoutCatalog) },
  },
});

registry.registerPath({
  method: "get",
  path: "/workout/plans",
  summary: "List workout plans",
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: "Plans", content: json(WorkoutPlansResponse) },
    401: errorResponses[401],
  },
});

registry.registerPath({
  method: "post",
  path: "/workout/plans",
  summary: "Create a workout plan",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(WorkoutPlanWriteRequest), required: true } },
  responses: {
    201: { description: "Created plan", content: json(WorkoutPlanResponse) },
    ...errorResponses,
  },
});

const workoutPlanId = { params: z.object({ id: z.coerce.number().int() }) };

registry.registerPath({
  method: "get",
  path: "/workout/plans/{id}",
  summary: "Get a workout plan",
  security: [{ cookieAuth: [] }],
  request: workoutPlanId,
  responses: {
    200: { description: "Plan", content: json(WorkoutPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "put",
  path: "/workout/plans/{id}",
  summary: "Update a workout plan",
  security: [{ cookieAuth: [] }],
  request: { ...workoutPlanId, body: { content: json(WorkoutPlanWriteRequest), required: true } },
  responses: {
    200: { description: "Updated plan", content: json(WorkoutPlanResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/workout/plans/{id}",
  summary: "Delete a workout plan",
  security: [{ cookieAuth: [] }],
  request: workoutPlanId,
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/workout/plans/{id}/activate",
  summary: "Make a workout plan the active one",
  security: [{ cookieAuth: [] }],
  request: workoutPlanId,
  responses: {
    200: { description: "Activated plan", content: json(WorkoutPlanResponse) },
    ...errorResponses,
  },
});

// ---- workout sessions + sets ----

registry.registerPath({
  method: "get",
  path: "/workout/sessions",
  summary: "List workout sessions in a date range (default: last 7 days)",
  security: [{ cookieAuth: [] }],
  request: { query: RangeQuery },
  responses: {
    200: { description: "Sessions", content: json(WorkoutSessionsResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/workout/sessions",
  summary: "Start (or backdate) a workout session",
  security: [{ cookieAuth: [] }],
  request: { body: { content: json(WorkoutSessionStartRequest), required: true } },
  responses: {
    201: { description: "Created session", content: json(WorkoutSessionResponse) },
    ...errorResponses,
  },
});

const workoutSessionId = { params: z.object({ id: z.coerce.number().int() }) };

registry.registerPath({
  method: "get",
  path: "/workout/sessions/{id}",
  summary: "Get a workout session (with sets)",
  security: [{ cookieAuth: [] }],
  request: workoutSessionId,
  responses: {
    200: { description: "Session", content: json(WorkoutSessionResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/workout/sessions/{id}",
  summary: "Patch a workout session (name / duration / kcal / notes)",
  security: [{ cookieAuth: [] }],
  request: {
    ...workoutSessionId,
    body: { content: json(WorkoutSessionPatchRequest), required: true },
  },
  responses: {
    200: { description: "Updated session", content: json(WorkoutSessionResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/workout/sessions/{id}",
  summary: "Delete a workout session",
  security: [{ cookieAuth: [] }],
  request: workoutSessionId,
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/workout/sessions/{id}/sets",
  summary: "Append a set to a session",
  security: [{ cookieAuth: [] }],
  request: { ...workoutSessionId, body: { content: json(WorkoutSetRequest), required: true } },
  responses: {
    201: { description: "Created set", content: json(WorkoutSetResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/workout/sessions/{id}/sets/{setId}",
  summary: "Delete a set from a session",
  security: [{ cookieAuth: [] }],
  request: {
    params: z.object({ id: z.coerce.number().int(), setId: z.coerce.number().int() }),
  },
  responses: {
    204: { description: "Deleted" },
    ...errorResponses,
  },
});

// ---- workout progress ----

registry.registerPath({
  method: "get",
  path: "/workout/exercises/{id}/last-sets",
  summary: 'Most-recent sets of an exercise (the "last time" hint)',
  security: [{ cookieAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: LimitQuery,
  },
  responses: {
    200: { description: "Last sets", content: json(LastSetsResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/workout/progress/exercise/{id}",
  summary: "Per-exercise progress (top set / est 1RM / volume by date)",
  security: [{ cookieAuth: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: RangeQuery,
  },
  responses: {
    200: { description: "Exercise progress", content: json(ExerciseProgressResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/workout/progress/muscle-groups",
  summary: "Weekly training volume by muscle group",
  security: [{ cookieAuth: [] }],
  // by=target buckets by the finer MUSCLE_TARGETS (biceps, calves…) instead;
  // group_id then carries the target id.
  request: { query: RangeQuery.extend({ by: z.enum(["group", "target"]).optional() }) },
  responses: {
    200: { description: "Muscle-group volume", content: json(MuscleGroupVolumeResponse) },
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/workout/progress/prs",
  summary: "Recent personal records",
  security: [{ cookieAuth: [] }],
  request: { query: LimitQuery },
  responses: {
    200: { description: "Recent PRs", content: json(RecentPRsResponse) },
    ...errorResponses,
  },
});

// Note: /api/auth/* endpoints are owned by Better Auth and intentionally
// NOT documented here. Use better-auth/react on the client; its types are
// already correct against the deployed Better Auth version.

// Cookie auth scheme — registered on the registry (not via document config)
// because zod-to-openapi derives components from the registry.
registry.registerComponent("securitySchemes", "cookieAuth", {
  type: "apiKey",
  in: "cookie",
  name: "better-auth.session_token",
  description:
    "Better Auth issues an httpOnly session cookie on /api/auth/sign-in/email " +
    "or sign-up/email. All app endpoints require it.",
});

let _doc: object | null = null;

export function openApiDocument(): object {
  if (_doc) return _doc;
  const generator = new OpenApiGeneratorV31(registry.definitions);
  _doc = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Jim-Bro API",
      version: "0.1.0",
      description:
        "App API. Authentication endpoints under /api/auth/* are handled by " +
        "Better Auth and not described here — use better-auth/react on the client.",
    },
    servers: [{ url: "/" }],
  });
  return _doc;
}
