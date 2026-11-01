import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { HeartPulse, Layers, Target } from "lucide-react";
import type { ExerciseType } from "@fa/shared";
import { cn } from "@/lib/utils";

// Small pill marking an exercise as compound / isolation / cardio, all in the
// theme's primary color: compound solid, isolation outlined, cardio dashed
// outline — plus a per-type icon. A span (not the div-based <Badge>) so it can
// sit inside buttons.
const STYLE: Record<ExerciseType, { Icon: ComponentType<{ className?: string }>; tone: string }> = {
  // Multi-joint: solid fill, the "heaviest" look.
  compound: {
    Icon: Layers,
    tone: "border-primary bg-primary text-primary-foreground",
  },
  // Single-joint: outlined.
  isolation: {
    Icon: Target,
    tone: "border-primary bg-transparent text-primary",
  },
  // Conditioning: dashed outline.
  cardio: {
    Icon: HeartPulse,
    tone: "border-dashed border-primary bg-transparent text-primary",
  },
};

// `count` prefixes the label (e.g. "2 Compound") for tallies.
export function ExerciseTypeBadge({
  type,
  count,
  className,
}: {
  type: ExerciseType;
  count?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const { Icon, tone } = STYLE[type];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-tight font-semibold",
        tone,
        className,
      )}
    >
      <Icon className="size-3" />
      {count !== undefined && <span className="tabular-nums">{count}</span>}
      {t(`workout.exerciseType.${type}`)}
    </span>
  );
}
