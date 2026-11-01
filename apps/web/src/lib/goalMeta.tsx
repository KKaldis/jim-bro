// Canonical per-goal visual identity — label, icon, and color tint — shared by
// the dashboard profile (GoalTile) and the compute_targets / compute_bmr chat
// result cards, so a training goal always reads with the SAME icon + color
// wherever it shows up. One source of truth: change a goal's look here and it
// updates on both the dashboard and in chat.
import { Equal, Repeat, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";

import type { Goal } from "@fa/shared";

import i18n from "../i18n";
import { cn } from "./utils";

export type GoalMeta = {
  // Localized, resolved live via a getter so it tracks the active language
  // (GOAL_META is built once at import, before the language settles).
  readonly label: string;
  Icon: LucideIcon;
  // Foreground tint (text/icon) — light + dark.
  accent: string;
  // Pill/tile fill + border tint, paired with `accent`.
  chip: string;
};

// Build a GoalMeta whose `label` resolves through i18n on every read, so
// consumers reading `GOAL_META[goal].label` always get the current language.
function goalMeta(key: Goal, Icon: LucideIcon, accent: string, chip: string): GoalMeta {
  return {
    get label() {
      return i18n.t(`lib.goal.${key}`);
    },
    Icon,
    accent,
    chip,
  };
}

// Icons + colors come from the profile goal picker (the original user-profile
// chrome): cut→TrendingDown/chart-4, maintain→Equal/chart-1, recomp→Repeat/
// chart-5, lean_bulk→TrendingUp/chart-2. One source of truth so the dashboard
// and chat cards match the profile rather than the other way around.
export const GOAL_META: Record<Goal, GoalMeta> = {
  cut: goalMeta("cut", TrendingDown, "text-chart-4", "border-chart-4/30 bg-chart-4/10"),
  recomp: goalMeta("recomp", Repeat, "text-chart-5", "border-chart-5/30 bg-chart-5/10"),
  maintain: goalMeta("maintain", Equal, "text-chart-1", "border-chart-1/30 bg-chart-1/10"),
  lean_bulk: goalMeta("lean_bulk", TrendingUp, "text-chart-2", "border-chart-2/30 bg-chart-2/10"),
};

// Narrow an unknown (e.g. a wire `inputs.goal`) to a Goal we have chrome for.
export function isGoal(v: unknown): v is Goal {
  return typeof v === "string" && v in GOAL_META;
}

// A tinted pill naming the goal/mode with its icon — the compact badge used in
// card headers.
export function GoalBadge({ goal, className }: { goal: Goal; className?: string }) {
  const m = GOAL_META[goal];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
        m.chip,
        m.accent,
        className,
      )}
    >
      <m.Icon className="size-3 shrink-0" aria-hidden />
      {m.label}
    </span>
  );
}
