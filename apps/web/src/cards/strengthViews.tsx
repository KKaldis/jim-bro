// Shared presentational pieces for the strength calculators — used by the chat
// result cards (resultCards.tsx) and the Workout screen's live calculators, so
// both surfaces render the identical Beginner→Elite scale. Lives in its own
// module (not Workout.tsx) to avoid an import cycle with resultCards.
import { useTranslation } from "react-i18next";

import type { StrengthLevelName } from "@fa/shared";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";

export type LevelBand = {
  level: StrengthLevelName;
  percentile: number;
  min: number;
  max: number | null;
};

// Per-level color: a low→high ramp (slate → sky → emerald → violet → gold).
export const STRENGTH_LEVEL_META: Record<StrengthLevelName, { bar: string; badge: string }> = {
  beginner: {
    bar: "bg-slate-300 dark:bg-slate-600",
    badge:
      "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
  },
  novice: {
    bar: "bg-sky-300 dark:bg-sky-700",
    badge:
      "border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  },
  intermediate: {
    bar: "bg-emerald-300 dark:bg-emerald-700",
    badge:
      "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  },
  advanced: {
    bar: "bg-violet-300 dark:bg-violet-700",
    badge:
      "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
  },
  elite: {
    bar: "bg-amber-300 dark:bg-amber-600",
    badge:
      "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
};

export function StrengthLevelBadge({ level }: { level: StrengthLevelName }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className={cn("capitalize", STRENGTH_LEVEL_META[level].badge)}>
      {t(`cards.strength.level.${level}`)}
    </Badge>
  );
}

// A segmented Beginner→Elite reference bar with a marker for the user's lift —
// the strength analog of Vo2MaxResultView's category scale.
export function StrengthLevelScale({
  bands,
  performance,
  unit,
}: {
  bands: LevelBand[];
  performance: number;
  unit: "kg" | "reps";
}) {
  const { t } = useTranslation();
  if (bands.length !== 5) return null;
  const first = bands[0].min;
  const last = bands[4].min;
  const beginnerStep = Math.max(1, bands[1].min - first);
  const eliteStep = Math.max(1, last - bands[3].min);
  const lo = first - beginnerStep * 0.5;
  const hi = last + eliteStep;
  const span = hi - lo || 1;
  const posPct = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / span) * 100))}%`;

  return (
    <div className="space-y-1">
      <div dir="ltr" className="relative h-2.5 w-full overflow-hidden rounded-full">
        <div className="flex size-full">
          {bands.map((b) => {
            const segHi = b.max ?? hi;
            const segLo = Math.max(b.min, lo);
            const widthPct = ((segHi - segLo) / span) * 100;
            if (widthPct <= 0) return null;
            return (
              <div
                key={b.level}
                className={STRENGTH_LEVEL_META[b.level].bar}
                style={{ width: `${widthPct}%` }}
                title={`${t(`cards.strength.level.${b.level}`)} · ${b.min}${unit === "kg" ? " kg" : ` ${t("cards.strength.repsShort")}`}`}
              />
            );
          })}
        </div>
        <div
          className="absolute top-1/2 h-4 w-1 -translate-1/2 rounded-full bg-foreground ring-2 ring-background"
          style={{ left: posPct(performance) }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{t("cards.strength.level.beginner")}</span>
        <span>{t("cards.strength.level.elite")}</span>
      </div>
    </div>
  );
}
