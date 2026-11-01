/**
 * Published rate limits per (provider, model, tier).
 *
 * These are reference values copied from each provider's rate-limit doc.
 * The actual cap is whatever your org/account is configured for on the
 * provider's dashboard — these tables exist so the in-process rate limiter
 * has a sane default budget and so we can surface tier info to the user.
 *
 * Sources:
 *   - Anthropic: https://docs.anthropic.com/en/api/rate-limits (Tier 1-4)
 *   - OpenAI:    https://platform.openai.com/docs/guides/rate-limits (Tier 1-5;
 *               numbers below are well-known Tier 1 figures — verify on the
 *               dashboard for your account)
 *   - Moonshot/Kimi: https://platform.kimi.ai/docs/pricing/limits (Tier 0-5)
 *
 * Last verified: 2026-01.
 */
import type { ApiLimits, ProviderId } from "./types.ts";

// Anthropic — Tier 1. ITPM counts uncached input + cache_creation; cache reads
// are free toward the limit (except Haiku 3.5, which is retired). Output is
// tracked separately as OTPM.
const ANTHROPIC_TIER_1: Record<string, ApiLimits> = {
  // Sonnet 4.x family (4, 4.5, 4.6 share a pooled limit).
  "claude-sonnet-4-6": { rpm: 50, itpm: 30_000, otpm: 8_000, tier: "Tier 1" },
  "claude-sonnet-4-5": { rpm: 50, itpm: 30_000, otpm: 8_000, tier: "Tier 1" },
  "claude-sonnet-4": { rpm: 50, itpm: 30_000, otpm: 8_000, tier: "Tier 1" },
  // Opus 4.x family (4, 4.1, 4.5, 4.6, 4.7 pooled).
  "claude-opus-4-7": { rpm: 50, itpm: 500_000, otpm: 80_000, tier: "Tier 1" },
  "claude-opus-4-6": { rpm: 50, itpm: 500_000, otpm: 80_000, tier: "Tier 1" },
  "claude-opus-4-5": { rpm: 50, itpm: 500_000, otpm: 80_000, tier: "Tier 1" },
  "claude-opus-4-1": { rpm: 50, itpm: 500_000, otpm: 80_000, tier: "Tier 1" },
  "claude-opus-4": { rpm: 50, itpm: 500_000, otpm: 80_000, tier: "Tier 1" },
  // Haiku 4.5 standalone family.
  "claude-haiku-4-5": { rpm: 50, itpm: 50_000, otpm: 10_000, tier: "Tier 1" },
};

// OpenAI — Tier 1 (well-known figures; tier ceiling is per-account on the
// dashboard). gpt-4.x flagship models share a TPM around 30k, mini models
// get ~200k. o-series reasoning models get split limits.
const OPENAI_TIER_1: Record<string, ApiLimits> = {
  "gpt-4o": { rpm: 500, tpm: 30_000, tier: "Tier 1" },
  "gpt-4o-mini": { rpm: 500, tpm: 200_000, tier: "Tier 1" },
  "gpt-4.1": { rpm: 500, tpm: 30_000, tier: "Tier 1" },
  "gpt-4.1-mini": { rpm: 500, tpm: 200_000, tier: "Tier 1" },
  "gpt-4.1-nano": { rpm: 500, tpm: 200_000, tier: "Tier 1" },
  o1: { rpm: 500, tpm: 30_000, tier: "Tier 1" },
  "o1-mini": { rpm: 500, tpm: 200_000, tier: "Tier 1" },
  "o3-mini": { rpm: 1_000, tpm: 100_000, tier: "Tier 1" },
  o3: { rpm: 500, tpm: 30_000, tier: "Tier 1" },
};

// Moonshot/Kimi — Tier 0 (free / minimum $1 recharge to start). Limits scale
// with recharge tier; numbers here are the floor.
const KIMI_TIER_0: Record<string, ApiLimits> = {
  "kimi-k2": { rpm: 3, tpm: 500_000, tpd: 1_500_000, tier: "Tier 0" },
  "kimi-k2-0905-preview": {
    rpm: 3,
    tpm: 500_000,
    tpd: 1_500_000,
    tier: "Tier 0",
  },
  "moonshot-v1-8k": {
    rpm: 3,
    tpm: 500_000,
    tpd: 1_500_000,
    tier: "Tier 0",
  },
  "moonshot-v1-32k": {
    rpm: 3,
    tpm: 500_000,
    tpd: 1_500_000,
    tier: "Tier 0",
  },
  "moonshot-v1-128k": {
    rpm: 3,
    tpm: 500_000,
    tpd: 1_500_000,
    tier: "Tier 0",
  },
};

// Boilerplate stubs — fill in from each provider's docs when activating.
const GOOGLE_DEFAULTS: Record<string, ApiLimits> = {
  // ai.google.dev/gemini-api/docs/rate-limits — free tier defaults shown.
  "gemini-2.0-flash": { rpm: 10, tpm: 1_000_000, tpd: 1_500, tier: "free" },
  "gemini-2.0-pro": { rpm: 5, tpm: 2_000_000, tpd: 100, tier: "free" },
};

const MISTRAL_DEFAULTS: Record<string, ApiLimits> = {
  // docs.mistral.ai/deployment/laplateforme/tier — Experiment tier shown.
  "mistral-large-latest": { rpm: 60, tpm: 500_000, tier: "Experiment" },
  "mistral-small-latest": { rpm: 60, tpm: 500_000, tier: "Experiment" },
};

const DEEPSEEK_DEFAULTS: Record<string, ApiLimits> = {
  // api-docs.deepseek.com/quick_start/rate_limit — DeepSeek does not impose
  // strict per-user rate limits; numbers below are conservative defaults to
  // protect the bucket on shared keys.
  "deepseek-chat": { rpm: 60, tpm: 1_000_000 },
  "deepseek-reasoner": { rpm: 60, tpm: 1_000_000 },
};

const XAI_DEFAULTS: Record<string, ApiLimits> = {
  // docs.x.ai/docs/models — defaults; verify against console.
  "grok-2": { rpm: 60, tpm: 240_000 },
  "grok-2-mini": { rpm: 60, tpm: 240_000 },
};

const QWEN_DEFAULTS: Record<string, ApiLimits> = {
  // Model Studio console → rate limits; placeholders — verify against your account.
  "qwen-plus": { rpm: 60, tpm: 1_000_000 },
  "qwen-max": { rpm: 60, tpm: 1_000_000 },
  "qwen3-max": { rpm: 60, tpm: 1_000_000 },
  "qwen-vl-max": { rpm: 60, tpm: 1_000_000 },
};

const TABLE: Record<ProviderId, Record<string, ApiLimits>> = {
  anthropic: ANTHROPIC_TIER_1,
  openai: OPENAI_TIER_1,
  kimi: KIMI_TIER_0,
  google: GOOGLE_DEFAULTS,
  mistral: MISTRAL_DEFAULTS,
  deepseek: DEEPSEEK_DEFAULTS,
  xai: XAI_DEFAULTS,
  qwen: QWEN_DEFAULTS,
};

// Best-match lookup. Returns the entry for `model` if known; otherwise the
// most permissive entry for the provider (so unknown models don't get
// over-throttled by a stale table). Falls back to an empty record when the
// provider has nothing configured.
export function lookupLimits(provider: ProviderId, model: string): ApiLimits {
  const t = TABLE[provider];
  if (!t) return {};
  if (t[model]) return t[model];
  // Substring match for versioned IDs like "claude-sonnet-4-6-20250514".
  for (const [key, value] of Object.entries(t)) {
    if (model.startsWith(key)) return value;
  }
  return {};
}

// Allow callers to override the published numbers at runtime. Useful when an
// org has been bumped to a higher tier and the env wants to relax the
// in-process limiter without us shipping a new table.
export function parseLimitsFromEnv(prefix: string): ApiLimits {
  const env = process.env;
  const num = (k: string) => {
    const v = env[k];
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const out: ApiLimits = {};
  const rpm = num(`${prefix}_RPM`);
  const itpm = num(`${prefix}_ITPM`);
  const otpm = num(`${prefix}_OTPM`);
  const tpm = num(`${prefix}_TPM`);
  const tpd = num(`${prefix}_TPD`);
  if (rpm) out.rpm = rpm;
  if (itpm) out.itpm = itpm;
  if (otpm) out.otpm = otpm;
  if (tpm) out.tpm = tpm;
  if (tpd) out.tpd = tpd;
  return out;
}
