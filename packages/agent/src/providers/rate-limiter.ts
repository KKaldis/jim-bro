/**
 * In-process token-bucket rate limiter, keyed by (provider, model).
 *
 * Real enforcement lives on the provider's edge — they'll return a 429 with
 * `retry-after` regardless of what we do here. This bucket exists so we can
 * (a) shape outbound traffic to avoid trivial bursts, (b) refuse a request
 * before sending when we KNOW it will fail (cheaper than burning a round-trip),
 * and (c) honor an observed `retry-after` from a previous 429 by pausing the
 * bucket.
 *
 * Buckets are process-wide. In a multi-process deployment (e.g. autoscaled
 * server), each process tracks its own counts; the provider's limit is shared
 * so we run more conservative than necessary. Good — it just means we hit the
 * provider's 429 less often.
 *
 * We track three buckets per key: RPM, input-TPM (or TPM if the provider
 * doesn't split), and OTPM. The limiter is consult-only for tokens (we don't
 * know how many input tokens a request will consume before it runs — we
 * record the actual count after the response and stall the next request if
 * the bucket would go negative).
 */
import type { ApiLimits } from "./types.ts";

type Bucket = {
  // Tokens currently available.
  available: number;
  // Maximum the bucket holds.
  capacity: number;
  // Refill rate per ms.
  refillPerMs: number;
  // Timestamp of the last refill (ms since epoch).
  updated: number;
};

function newBucket(perMinute: number): Bucket {
  return {
    available: perMinute,
    capacity: perMinute,
    refillPerMs: perMinute / 60_000,
    updated: Date.now(),
  };
}

function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = now - b.updated;
  if (elapsed <= 0) return;
  b.available = Math.min(b.capacity, b.available + elapsed * b.refillPerMs);
  b.updated = now;
}

function take(b: Bucket, n: number): { ok: boolean; waitMs: number } {
  refill(b);
  if (b.available >= n) {
    b.available -= n;
    return { ok: true, waitMs: 0 };
  }
  const deficit = n - b.available;
  const waitMs = Math.ceil(deficit / b.refillPerMs);
  return { ok: false, waitMs };
}

export type LimiterKey = `${string}:${string}`;

// Hard ceiling on how long reserveRequest will block waiting for RPM
// headroom before giving up. On a very low limit (e.g. Kimi Tier 0 RPM 3)
// under contention the bucket may never free up within a reasonable window;
// rather than hang the request forever we return false and let the caller
// proceed — the downstream retry layer (retry.ts) handles the resulting 429.
const RESERVE_MAX_WAIT_MS = 60_000;

export type RateLimiter = {
  // Reserve a request slot. Blocks (via wait) until RPM has headroom, bounded
  // by RESERVE_MAX_WAIT_MS. Returns true if a slot was reserved, false if it
  // gave up waiting (caller should log and proceed; the request will likely
  // 429 and be retried).
  reserveRequest: () => Promise<boolean>;
  // Record actual tokens consumed by the response (after the call returns)
  // so the bucket reflects real usage rather than the request-time guess.
  recordUsage: (inputTokens: number, outputTokens: number) => void;
  // Honor a `retry-after` header from the provider — pauses the request
  // bucket until the deadline.
  pauseUntil: (deadlineMs: number) => void;
  // Snapshot for diagnostics / UI.
  snapshot: () => {
    rpm: { available: number; capacity: number } | null;
    itpm: { available: number; capacity: number } | null;
    otpm: { available: number; capacity: number } | null;
  };
};

const STATE = new Map<
  LimiterKey,
  {
    req: Bucket | null;
    input: Bucket | null;
    output: Bucket | null;
    pausedUntil: number;
  }
>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getRateLimiter(provider: string, model: string, limits: ApiLimits): RateLimiter {
  const key = `${provider}:${model}` as LimiterKey;
  let state = STATE.get(key);
  if (!state) {
    // Prefer a split itpm/otpm view when the provider exposes both, else
    // fall back to combined TPM as the input bucket (output bucket null).
    const inputBudget = limits.itpm ?? limits.tpm ?? null;
    const outputBudget = limits.otpm ?? null;
    state = {
      req: limits.rpm ? newBucket(limits.rpm) : null,
      input: inputBudget ? newBucket(inputBudget) : null,
      output: outputBudget ? newBucket(outputBudget) : null,
      pausedUntil: 0,
    };
    STATE.set(key, state);
  }

  return {
    async reserveRequest() {
      if (!state.req) return true;
      // Bound the total wait by a wall-clock deadline rather than a fixed
      // iteration count, so we don't fall through prematurely (sending a
      // doomed request) and don't hang indefinitely on a near-zero RPM.
      const deadline = Date.now() + RESERVE_MAX_WAIT_MS;
      for (;;) {
        // Honor a provider-issued pause (set by an observed retry-after on a
        // concurrent request) before consulting the bucket.
        const pauseLeft = state.pausedUntil - Date.now();
        if (pauseLeft > 0) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return false;
          await sleep(Math.min(pauseLeft, remaining));
          continue;
        }
        const res = take(state.req, 1);
        if (res.ok) return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        // Wait the computed deficit, capped by the remaining budget and a 30s
        // slice (so a freshly-set pause is observed promptly).
        await sleep(Math.min(res.waitMs, remaining, 30_000));
      }
    },
    recordUsage(inputTokens: number, outputTokens: number) {
      if (state.input) take(state.input, inputTokens);
      if (state.output) take(state.output, outputTokens);
    },
    pauseUntil(deadlineMs: number) {
      if (deadlineMs > state.pausedUntil) state.pausedUntil = deadlineMs;
    },
    snapshot() {
      const snap = (b: Bucket | null) => {
        if (!b) return null;
        refill(b);
        return {
          available: Math.floor(b.available),
          capacity: Math.floor(b.capacity),
        };
      };
      return {
        rpm: snap(state.req),
        itpm: snap(state.input),
        otpm: snap(state.output),
      };
    },
  };
}

// Test/dev helper — wipes all in-process limiter state.
export function _resetLimitersForTest(): void {
  STATE.clear();
}
