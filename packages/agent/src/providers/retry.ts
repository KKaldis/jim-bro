/**
 * Shared retry policy for provider requests.
 *
 * Why centralized: every adapter — Anthropic, Google, and OpenAI (plus its
 * Kimi / DeepSeek / Mistral / xAI subclasses) — hits the same transient
 * failures: 429 rate limits and 5xx/connection blips. This module is the
 * single source of truth for (a) what counts as retryable, (b) how long to
 * back off, and (c) how a provider's `retry-after` header is parsed.
 *
 * Adapters retry ONLY the request-initiation step — the point before any
 * stream events have been emitted — so a retry can never double-emit partial
 * output. OpenAI/Google await a stream object and wrap it in withRetry();
 * Anthropic's `.stream()` defers errors to first iteration, so it uses
 * planRetry() directly in an inline loop guarded by a "have we yielded yet?"
 * flag. Either way the policy below is the same.
 *
 * The provider SDKs' own auto-retry is disabled (maxRetries: 0) so this is the
 * one and only retry layer — no nested/doubled backoff.
 *
 * Env:
 *   LLM_MAX_RETRIES      retries after the first attempt (default 4, 0 disables)
 *   LLM_RETRY_BASE_MS    base for exponential backoff (default 500)
 *   LLM_RETRY_MAX_MS     per-attempt backoff/retry-after ceiling (default 30000).
 *                        A provider asking us to wait longer than this is
 *                        treated as non-retryable — we fail fast rather than
 *                        hang a user-facing request.
 */
import type { Logger } from "@fa/logger";

export type RetryConfig = {
  maxRetries: number;
  baseMs: number;
  maxMs: number;
};

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function retryConfig(): RetryConfig {
  return {
    maxRetries: num("LLM_MAX_RETRIES", 4),
    baseMs: num("LLM_RETRY_BASE_MS", 500),
    maxMs: num("LLM_RETRY_MAX_MS", 30_000),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Duck-typed status extraction — works for OpenAI/Anthropic/Google SDK errors
// (all expose `.status`) without importing each SDK's error classes.
export function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

// Retryable: 429 (rate limited), any 5xx (server-side blip), or a connection/
// timeout error with no HTTP status (network drop before a response).
export function isRetryableError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 429) return true;
  if (typeof status === "number") return status >= 500;
  // No status — inspect name/code for connection-class failures.
  const e = err as { name?: string; code?: string };
  const probe = `${e?.name ?? ""} ${e?.code ?? ""}`;
  return /connection|timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|fetch failed/i.test(probe);
}

// Parse a Retry-After header value (delta-seconds or an HTTP date) to ms.
export function parseRetryAfterHeader(headers: Record<string, string> | undefined): number | null {
  if (!headers) return null;
  const v = headers["retry-after"] ?? headers["Retry-After"];
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n) * 1000;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

// Pull a retry-after delay (ms) off any provider error that carries headers.
export function retryAfterMsFromError(err: unknown): number | null {
  const headers = (err as { headers?: Record<string, string> })?.headers;
  return parseRetryAfterHeader(headers);
}

// Decide whether to retry and how long to wait. Returns null when we should
// give up (not retryable, out of attempts, or the requested wait exceeds our
// ceiling). `attempt` is 0-based: 0 = the wait before the first retry.
export function planRetry(
  err: unknown,
  attempt: number,
  cfg: RetryConfig = retryConfig(),
): { delayMs: number } | null {
  if (attempt >= cfg.maxRetries) return null;
  if (!isRetryableError(err)) return null;
  const retryAfter = retryAfterMsFromError(err);
  if (retryAfter != null) {
    // Honor the provider's instruction, but don't hang a user request.
    return retryAfter > cfg.maxMs ? null : { delayMs: retryAfter };
  }
  // Exponential backoff with full jitter on the upper half.
  const backoff = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * (backoff / 2));
  return { delayMs: backoff + jitter };
}

export type WithRetryOpts = {
  log?: Logger;
  label?: string;
  // Pausing the shared bucket on a 429 keeps concurrent callers from piling
  // on while we wait. Optional — pass the provider's limiter.
  limiter?: { pauseUntil: (deadlineMs: number) => void };
  maxRetries?: number;
};

// Retry an async operation that establishes a request (and, for streaming
// providers, returns the not-yet-consumed stream). MUST NOT be used to wrap
// stream consumption — a retry there would re-emit already-yielded output.
export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOpts = {}): Promise<T> {
  const cfg = {
    ...retryConfig(),
    ...(opts.maxRetries != null ? { maxRetries: opts.maxRetries } : {}),
  };
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const plan = planRetry(err, attempt, cfg);
      if (!plan) throw err;
      opts.limiter?.pauseUntil(Date.now() + plan.delayMs);
      attempt += 1;
      opts.log?.warn("retrying provider request", {
        label: opts.label,
        attempt,
        delay_ms: plan.delayMs,
        status: statusOf(err),
      });
      await sleep(plan.delayMs);
    }
  }
}
