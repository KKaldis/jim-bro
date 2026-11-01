/**
 * AI usage accounting: what each AI call cost, for the usage page. Pure data +
 * helpers (no DB) — the recorder lives in @fa/agent/usage and writes the
 * `ai_usage_event` table.
 *
 * Every AI call (chat turn, food photo, receipt) is one usage event: the raw
 * provider token counts plus an estimated cost at the provider's list price
 * (MODEL_PRICES below). Nothing is charged — it's a preview of what the
 * configured models cost to run.
 */

/** What kind of spend a usage event is — the two lines on the usage page. */
export const USAGE_KINDS = ["llm", "image_recognition"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** Which product surface triggered the spend. */
export const USAGE_SOURCES = [
  "chat", // a coach chat turn (all agent-loop iterations)
  "chat_image", // describing a photo attached to a chat message
  "food_scan", // add-food dialog photo recognition
  "receipt_scan", // receipt → pantry
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const SOURCE_KIND: Record<UsageSource, UsageKind> = {
  chat: "llm",
  chat_image: "image_recognition",
  food_scan: "image_recognition",
  receipt_scan: "image_recognition",
};

export type ModelPrice = {
  /** Provider list prices, USD per 1M raw tokens. */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Provider fee per web search (USD); 0 if the model never searches. */
  web_search: number;
};

// Keyed by `${provider}/${model}` (provider ids as in @fa/agent providers).
// Verify against the provider's pricing page when adding or updating a row.
// A model missing here still records its token counts, just without a cost.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic list price, checked Oct 2026. web_search = $10 / 1k searches.
  "anthropic/claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
    web_search: 0.01,
  },
  // Moonshot list price, checked Oct 2026. Caching is automatic: there's no
  // write surcharge, so a cache write costs the same as plain input.
  "kimi/kimi-k2.6": {
    input: 0.95,
    output: 4,
    cache_read: 0.16,
    cache_write: 0.95,
    web_search: 0.005,
  },
  // Kimi K2.7 Code (the only K2.7 model; there is no plain kimi-k2.7). Same
  // list price as K2.6 except the cache hit (aggregator figures, Oct 2026).
  "kimi/kimi-k2.7-code": {
    input: 0.95,
    output: 4,
    cache_read: 0.19,
    cache_write: 0.95,
    web_search: 0.005,
  },
  // Kimi K3, aggregator figures (Oct 2026). Reasoning tokens bill as output.
  "kimi/kimi-k3": {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3,
    web_search: 0,
  },
  // Alibaba Model Studio, International (Singapore), ≤256K-input tier,
  // checked Oct 2026. Non-thinking output price — our qwen adapter keeps
  // hybrid thinking off. No context-cache price listed, so cached input is
  // priced as plain input.
  "qwen/qwen-plus": {
    input: 0.4,
    output: 1.2,
    cache_read: 0.4,
    cache_write: 0.4,
    web_search: 0,
  },
  // Same source, ≤32K-input tier (vision prompts are small).
  "qwen/qwen3-vl-plus": {
    input: 0.2,
    output: 1.6,
    cache_read: 0.2,
    cache_write: 0.2,
    web_search: 0,
  },
};

export function priceForModel(provider: string, model: string): ModelPrice | null {
  return MODEL_PRICES[`${provider}/${model}`] ?? null;
}

export type RawTokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests?: number;
};

/** What the provider charges for this usage, in USD. */
export function providerCostUsd(u: RawTokenUsage, price: ModelPrice): number {
  return (
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      u.cache_read_input_tokens * price.cache_read +
      u.cache_creation_input_tokens * price.cache_write) /
      1_000_000 +
    (u.web_search_requests ?? 0) * price.web_search
  );
}

/** Estimated USD cost of one call; null when the model has no price row. */
export function estimateCostUsd(u: RawTokenUsage, provider: string, model: string): number | null {
  const price = priceForModel(provider, model);
  return price ? providerCostUsd(u, price) : null;
}

/** `YYYY-MM` for a date's UTC month — the usage page's period key. */
export function utcMonthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** [start, end) of the UTC month `YYYY-MM`; null if malformed. */
export function utcMonthRange(key: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return null;
  return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
}
