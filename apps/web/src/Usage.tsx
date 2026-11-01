import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { intlLocale } from "./i18n";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  Bot,
  Camera,
  Cpu,
  DollarSign,
  Gauge,
  MessageSquare,
  ReceiptText,
  ScanLine,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { useGetMeUsage } from "./api/endpoints/default/default";
import type { UsageResponse } from "./api/model";
import {
  CHART_W,
  ChartGrid,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
  axisTicks,
  type ChartPoint,
} from "./components/chart";
import { EmptyState } from "./components/EmptyState";
import { Card, CardContent } from "./components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Skeleton } from "./components/ui/skeleton";
import { apiErr } from "./lib/apiErr";
import { CardHero, PageTitle } from "./lib/pageChrome";
import { cn } from "./lib/utils";

// AI usage — reached from the user menu. A read-only preview of what the AI
// features cost to run: raw provider tokens and an estimated cost at the
// provider's list price (see @fa/shared/usage), per month, per feature, per
// model and per day. Nothing here is charged.

type Kind = "llm" | "image_recognition";

// Series colors: fixed by kind (never by rank), from the app's chart tokens.
const KIND_STYLE: Record<Kind, { fill: string; swatch: string }> = {
  llm: { fill: "fill-chart-1", swatch: "bg-chart-1" },
  image_recognition: { fill: "fill-chart-2", swatch: "bg-chart-2" },
};
const KINDS: Kind[] = ["llm", "image_recognition"];

const SOURCE_ICON: Record<string, LucideIcon> = {
  chat: MessageSquare,
  chat_image: Camera,
  food_scan: ScanLine,
  receipt_scan: ReceiptText,
};

const DAY_MS = 86_400_000;

type Fmt = {
  n: Intl.NumberFormat;
  /** Estimated USD; small amounts keep more decimals so cents don't round to 0. */
  usd: (v: number | null | undefined) => string;
};

function useFormatters(lang: string): Fmt {
  return useMemo(() => {
    const locale = intlLocale();
    const n = new Intl.NumberFormat(locale);
    const big = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
    const small = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 2,
    });
    return {
      n,
      usd: (v) => (v == null ? "—" : v > 0 && v < 0.1 ? small.format(v) : big.format(v)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run on language change
  }, [lang]);
}

export function Usage() {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, error } = useGetMeUsage(month ? { month } : undefined);
  const fmt = useFormatters(i18n.language);
  const current = data?.months[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-3 py-4 sm:px-5 sm:py-6">
          <div className="flex flex-wrap items-end justify-between gap-3 pe-10 md:pe-0">
            <div className="space-y-1">
              <PageTitle Icon={Gauge} help="usage">
                {t("usage.title")}
              </PageTitle>
              <p className="text-sm text-muted-foreground">{t("usage.subtitle")}</p>
            </div>
            {data && data.months.length > 1 && (
              <Select value={data.month} onValueChange={setMonth}>
                <SelectTrigger className="w-full sm:w-52" aria-label={t("usage.month")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.months.map((m) => (
                    <SelectItem key={m} value={m}>
                      {monthLabel(m)}
                      {m === current ? ` · ${t("usage.current")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {isLoading && (
            <div className="space-y-4">
              <Skeleton className="h-32 w-full rounded-xl" />
              <Skeleton className="h-72 w-full rounded-xl" />
            </div>
          )}
          {isError && <p className="text-sm text-destructive">{apiErr(error)}</p>}
          {data && (
            <>
              {!data.llm && (
                <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <p>{t("usage.noLlm")}</p>
                </div>
              )}
              <TotalsGrid data={data} fmt={fmt} />
              <BySourceCard data={data} fmt={fmt} />
              {data.by_model.length > 0 && <ByModelCard data={data} fmt={fmt} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(intlLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

// Small labelled stat, styled like the dashboard's tiles. On mobile it's a full
// row (label + hint left, value right); from sm up a stacked tile.
function StatTile({
  label,
  value,
  hint,
  Icon,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  Icon: LucideIcon;
  tone?: "primary" | "muted";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-row items-center justify-between gap-3 rounded-xl border p-3",
        "sm:flex-col sm:items-stretch sm:justify-start sm:gap-1",
        tone === "primary" ? "border-primary/30 bg-primary/5" : "bg-card",
      )}
    >
      {/* sm:contents dissolves this wrapper so label / value / hint stack in order. */}
      <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
        <div
          className={cn(
            "flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase sm:order-1",
            tone === "primary" ? "text-primary" : "text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          <span className="truncate">{label}</span>
        </div>
        {hint && (
          <div className="min-w-0 truncate text-[11px] text-muted-foreground sm:order-3">
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0 truncate text-xl/tight font-bold tabular-nums sm:order-2">
        {value}
      </div>
    </div>
  );
}

function TotalsGrid({ data, fmt }: { data: UsageResponse; fmt: Fmt }) {
  const { t } = useTranslation();
  const { totals } = data;
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
      <StatTile
        tone="primary"
        Icon={DollarSign}
        label={t("usage.estCost")}
        value={fmt.usd(totals.cost_usd)}
        hint={data.llm ? data.llm.model : t("usage.estCostHint")}
      />
      <StatTile Icon={Bot} label={t("usage.requests")} value={fmt.n.format(totals.events)} />
      <StatTile
        Icon={ArrowDownToLine}
        label={t("usage.inputTokens")}
        value={compact(totals.input_tokens)}
        hint={
          totals.cached_tokens > 0
            ? t("usage.cachedHint", { n: compact(totals.cached_tokens) })
            : undefined
        }
      />
      <StatTile
        Icon={ArrowUpFromLine}
        label={t("usage.outputTokens")}
        value={compact(totals.output_tokens)}
      />
    </div>
  );
}

function compact(n: number): string {
  return new Intl.NumberFormat(intlLocale(), { notation: "compact" }).format(n);
}

function BySourceCard({ data, fmt }: { data: UsageResponse; fmt: Fmt }) {
  const { t } = useTranslation();
  const tokens = (s: { input_tokens: number; output_tokens: number }) =>
    s.input_tokens + s.output_tokens;
  const total = data.by_source.reduce((a, s) => a + tokens(s), 0);
  const rows = [...data.by_source].sort(
    (a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0) || tokens(b) - tokens(a),
  );

  return (
    <Card className="overflow-hidden">
      <CardHero
        icon={BarChart3}
        title={t("usage.bySource")}
        subtitle={t("usage.tokensCount", { n: fmt.n.format(total) })}
      />
      <CardContent className="space-y-5 pt-4 sm:pt-5">
        {data.totals.events === 0 ? (
          <EmptyState icon={BarChart3} compact>
            {t("usage.noUsage")}
          </EmptyState>
        ) : (
          <>
            <DailyUsageChart data={data} />

            <div className="space-y-2">
              <div className="flex justify-between text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                <span>{t("usage.feature")}</span>
                <span>{t("usage.cost")}</span>
              </div>
              <ul className="space-y-2.5">
                {rows.map((s) => {
                  const Icon = SOURCE_ICON[s.source] ?? MessageSquare;
                  const share = total > 0 ? (tokens(s) / total) * 100 : 0;
                  return (
                    <li key={s.source} className="flex items-center gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="truncate font-medium">
                            {t(`usage.source.${s.source}`)}
                          </span>
                          <span className="shrink-0 font-semibold tabular-nums">
                            {fmt.usd(s.cost_usd)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                "h-full rounded-full",
                                KIND_STYLE[s.kind as Kind]?.swatch ?? "bg-primary",
                              )}
                              style={{ width: `${share}%` }}
                            />
                          </div>
                          <span className="w-40 shrink-0 text-end text-[11px] text-muted-foreground tabular-nums">
                            {t("usage.requestsCount", { count: s.events })} ·{" "}
                            {t("usage.tokensCount", { n: compact(tokens(s)) })}
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ByModelCard({ data, fmt }: { data: UsageResponse; fmt: Fmt }) {
  const { t } = useTranslation();
  const rows = [...data.by_model].sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0));
  return (
    <Card className="overflow-hidden">
      <CardHero icon={Cpu} title={t("usage.byModel")} />
      <CardContent className="pt-4 sm:pt-5">
        <ul className="divide-y">
          {rows.map((m) => (
            <li
              key={`${m.provider}/${m.model}`}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{m.model}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {m.provider} · {t("usage.requestsCount", { count: m.events })} ·{" "}
                  {t("usage.inOut", {
                    input: compact(m.input_tokens),
                    output: compact(m.output_tokens),
                  })}
                </div>
              </div>
              <span
                className="shrink-0 text-sm font-semibold tabular-nums"
                title={m.cost_usd == null ? t("usage.unpriced") : undefined}
              >
                {fmt.usd(m.cost_usd)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// Stacked daily bars of tokens (LLM under image recognition), one slot per day
// of the month up to today. Tap a bar for the day's split.
function DailyUsageChart({ data }: { data: UsageResponse }) {
  const { t } = useTranslation();
  const [active, setActive] = useState<number | null>(null);

  const days = useMemo(() => {
    const byDay = new Map<string, Record<Kind, number>>();
    for (const d of data.daily) {
      const row = byDay.get(d.date) ?? { llm: 0, image_recognition: 0 };
      row[d.kind as Kind] += d.input_tokens + d.output_tokens;
      byDay.set(d.date, row);
    }
    const start = new Date(`${data.month}-01T00:00:00Z`);
    const nextMonth = new Date(start);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const endMs = Math.min(nextMonth.getTime() - 1, Date.now());
    const out: Array<{ date: string } & Record<Kind, number>> = [];
    for (let d = start; d.getTime() <= endMs; d = new Date(d.getTime() + DAY_MS)) {
      const date = d.toISOString().slice(0, 10);
      out.push({ date, ...(byDay.get(date) ?? { llm: 0, image_recognition: 0 }) });
    }
    return out;
  }, [data]);

  if (days.length === 0) return null;
  const h = 150;
  const pad = 8;
  const max = Math.max(1, ...days.map((d) => d.llm + d.image_recognition));
  const ticks = axisTicks(0, max);
  const yAt = (v: number) => h - pad - (v / max) * (h - 2 * pad);
  const slot = CHART_W / days.length;
  const barW = Math.max(2, Math.min(18, slot * 0.7));
  const xAt = (i: number) => i * slot + slot / 2;

  const points: ChartPoint[] = days.map((d) => ({
    date: d.date,
    value: d.llm + d.image_recognition,
    detail: KINDS.map((k) => ({
      label: t(`usage.kind.${k}`),
      value: d[k].toLocaleString(),
    })),
  }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("usage.dailyChart")}
        </div>
        <div className="flex gap-3 text-[11px] text-muted-foreground">
          {KINDS.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", KIND_STYLE[k].swatch)} />
              {t(`usage.kind.${k}`)}
            </span>
          ))}
        </div>
      </div>
      <div dir="ltr" className="flex gap-2">
        <ChartYAxis ticks={ticks} yAt={yAt} height={h} />
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: h }}>
            <svg
              viewBox={`0 0 ${CHART_W} ${h}`}
              preserveAspectRatio="none"
              width="100%"
              height={h}
              role="img"
              aria-label={t("usage.dailyChart")}
            >
              <ChartGrid ticks={ticks} yAt={yAt} />
              {days.map((d, i) => {
                let base = h - pad;
                const x = xAt(i) - barW / 2;
                return (
                  <g key={d.date} opacity={active == null || active === i ? 1 : 0.4}>
                    {KINDS.map((k) => {
                      const segH = (d[k] / max) * (h - 2 * pad);
                      if (segH <= 0) return null;
                      const y = base - segH;
                      // 2px surface gap above the segment below it.
                      const gap = base < h - pad ? 2 : 0;
                      const rect = (
                        <rect
                          key={k}
                          x={x}
                          y={y}
                          width={barW}
                          height={Math.max(1, segH - gap)}
                          className={KIND_STYLE[k].fill}
                          rx={2}
                        />
                      );
                      base = y;
                      return rect;
                    })}
                    <rect
                      x={i * slot}
                      y={0}
                      width={slot}
                      height={h}
                      fill="transparent"
                      className="cursor-pointer"
                      onClick={() => setActive(active === i ? null : i)}
                    />
                  </g>
                );
              })}
            </svg>
            {active != null && (
              <ChartTooltip
                point={points[active]}
                unit=""
                leftPct={(xAt(active) / CHART_W) * 100}
                top={yAt(points[active].value)}
              />
            )}
          </div>
          <ChartXAxis points={points} />
        </div>
      </div>
    </div>
  );
}
