/**
 * AI usage recorder (see @fa/shared/usage for the kinds, sources and the
 * per-model price table).
 *
 *   • recordUsage — write one usage event after an AI call finishes, then hand
 *     it to every onUsage listener (server extensions hook in here, e.g. to
 *     charge the user).
 *   • getUsageReport — per-month breakdown for the usage page.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import { db, schema } from "@fa/db_postgres";
import { logger } from "@fa/logger";
import {
  estimateCostUsd,
  SOURCE_KIND,
  utcMonthKey,
  utcMonthRange,
  type RawTokenUsage,
  type UsageKind,
  type UsageSource,
} from "@fa/shared";

const log = logger.child({ pkg: "agent", mod: "usage" });

/** One recorded AI operation, as handed to onUsage listeners. */
export type UsageEvent = {
  id: number;
  userId: string;
  kind: UsageKind;
  source: UsageSource;
  provider: string;
  model: string;
  usage: RawTokenUsage;
  /** Estimated provider cost at list price; null when the model isn't priced. */
  costUsd: number | null;
  chatId: string | null;
};

export type UsageListener = (event: UsageEvent) => void | Promise<void>;

const listeners: UsageListener[] = [];

/** Subscribe to every recorded usage event. Listener errors are logged, not thrown. */
export function onUsage(listener: UsageListener): void {
  listeners.push(listener);
}

/**
 * Record one AI operation. Called after the call completes; a failure here is
 * the caller's to log — the user already has their result.
 */
export async function recordUsage(
  userId: string,
  ev: {
    source: UsageSource;
    provider: string;
    model: string;
    usage: RawTokenUsage;
    chatId?: string | null;
  },
): Promise<void> {
  const kind = SOURCE_KIND[ev.source];
  const costUsd = estimateCostUsd(ev.usage, ev.provider, ev.model);
  if (costUsd == null) {
    log.debug("no price for model — recorded without a cost; add it to MODEL_PRICES", {
      provider: ev.provider,
      model: ev.model,
    });
  }
  const [row] = await db()
    .insert(schema.aiUsageEvent)
    .values({
      userId,
      kind,
      source: ev.source,
      provider: ev.provider,
      model: ev.model,
      inputTokens: ev.usage.input_tokens,
      outputTokens: ev.usage.output_tokens,
      cacheReadInputTokens: ev.usage.cache_read_input_tokens,
      cacheCreationInputTokens: ev.usage.cache_creation_input_tokens,
      webSearches: ev.usage.web_search_requests ?? 0,
      costUsdMicros: costUsd == null ? null : Math.round(costUsd * 1_000_000),
      chatId: ev.chatId ?? null,
    })
    .returning({ id: schema.aiUsageEvent.id });
  if (!row) return;

  const event: UsageEvent = {
    id: row.id,
    userId,
    kind,
    source: ev.source,
    provider: ev.provider,
    model: ev.model,
    usage: ev.usage,
    costUsd,
    chatId: ev.chatId ?? null,
  };
  for (const listener of listeners) {
    try {
      await listener(event);
    } catch (err) {
      log.error("usage listener failed", err instanceof Error ? err : new Error(String(err)), {
        user_id: userId,
        source: ev.source,
      });
    }
  }
}

type Totals = {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number | null;
};

export type UsageReport = {
  month: string;
  months: string[];
  totals: Totals;
  by_source: Array<Totals & { source: string; kind: string }>;
  by_model: Array<Totals & { provider: string; model: string }>;
  /** Per-UTC-day totals for the month, days without usage omitted. */
  daily: Array<{
    date: string;
    kind: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
  }>;
};

/** Usage for one UTC month (`YYYY-MM`, default: the current one). null if malformed. */
export async function getUsageReport(userId: string, month?: string): Promise<UsageReport | null> {
  const current = utcMonthKey(new Date());
  const key = month ?? current;
  const range = utcMonthRange(key);
  if (!range) return null;

  const ev = schema.aiUsageEvent;
  const inMonth = and(
    eq(ev.userId, userId),
    gte(ev.createdAt, range.start),
    lt(ev.createdAt, range.end),
  );
  // SUM over a NULL-only group is NULL, so cost stays null when nothing in it
  // was priced.
  const totals = {
    events: sql<number>`COUNT(*)::int`,
    input_tokens: sql<number>`COALESCE(SUM(${ev.inputTokens}), 0)::int`,
    output_tokens: sql<number>`COALESCE(SUM(${ev.outputTokens}), 0)::int`,
    cached_tokens: sql<number>`COALESCE(SUM(${ev.cacheReadInputTokens}), 0)::int`,
    cost_micros: sql<number | null>`SUM(${ev.costUsdMicros})::float8`,
  };
  const day = sql<string>`to_char(${ev.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const monthCol = sql<string>`to_char(${ev.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM')`;

  const [all, bySource, byModel, daily, months] = await Promise.all([
    db().select(totals).from(ev).where(inMonth),
    db()
      .select({ source: ev.source, kind: ev.kind, ...totals })
      .from(ev)
      .where(inMonth)
      .groupBy(ev.source, ev.kind),
    db()
      .select({ provider: ev.provider, model: ev.model, ...totals })
      .from(ev)
      .where(inMonth)
      .groupBy(ev.provider, ev.model),
    db()
      .select({
        date: day,
        kind: ev.kind,
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        cost_micros: totals.cost_micros,
      })
      .from(ev)
      .where(inMonth)
      .groupBy(day, ev.kind)
      .orderBy(day),
    db()
      .selectDistinct({ month: monthCol })
      .from(ev)
      .where(eq(ev.userId, userId))
      .orderBy(desc(monthCol))
      .limit(24),
  ]);

  const usd = (micros: number | null) => (micros == null ? null : micros / 1_000_000);
  const toTotals = ({ cost_micros, ...t }: Row): Totals => ({
    ...t,
    cost_usd: usd(cost_micros),
  });
  const monthKeys = months.map((m) => m.month);
  if (!monthKeys.includes(current)) monthKeys.unshift(current);

  return {
    month: key,
    months: monthKeys,
    totals: all[0]
      ? toTotals(all[0])
      : { events: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: null },
    by_source: bySource.map(({ source, kind, ...t }) => ({ source, kind, ...toTotals(t) })),
    by_model: byModel.map(({ provider, model, ...t }) => ({ provider, model, ...toTotals(t) })),
    daily: daily.map(({ cost_micros, ...d }) => ({ ...d, cost_usd: usd(cost_micros) })),
  };
}

type Row = {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_micros: number | null;
};
