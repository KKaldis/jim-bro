/**
 * Per-user rate limiting for the expensive endpoints (chat, image scans):
 * an in-memory token bucket. Single-process only; replace with Redis when
 * the server scales horizontally.
 */

// ---------- per-user rate limiting (in-memory token bucket) ----------

type Bucket = { tokens: number; lastRefill: number };
export const buckets = new Map<string, Bucket>();
const RATE_CAPACITY = 60; // 60 chat calls per window
const RATE_REFILL_PER_MS = 60 / 60_000; // 60 per minute

export function consumeToken(userId: string): boolean {
  const now = Date.now();
  const b = buckets.get(userId) ?? { tokens: RATE_CAPACITY, lastRefill: now };
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(RATE_CAPACITY, b.tokens + elapsed * RATE_REFILL_PER_MS);
  b.lastRefill = now;
  if (b.tokens < 1) {
    buckets.set(userId, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(userId, b);
  return true;
}
