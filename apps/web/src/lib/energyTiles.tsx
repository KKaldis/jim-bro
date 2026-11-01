// A row of energy/target tiles (BMR / maintenance / daily target). Shared by
// the dashboard "Targets & energy" panel (Dashboard → ProfileTargets) and the
// compute_bmr / compute_targets chat result cards (cards/resultCards.tsx) so
// the energy numbers read identically everywhere — the highlighted tile is the
// number the user is actually steering toward.
import { Activity, Zap, type LucideIcon } from "lucide-react";

import i18n from "../i18n";
import { cn } from "./utils";

export type EnergyTile = {
  key: string;
  icon: LucideIcon;
  label: string;
  value: number;
  sub?: string;
  // The goal-adjusted target the user steers toward — outlined + tinted.
  highlight?: boolean;
  // Derived/reference numbers (BMR, target) get a dashed border.
  dashed?: boolean;
  // De-emphasised context (BMR floor).
  muted?: boolean;
};

const COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
};

// Build the canonical BMR / maintenance / daily-target tile row shared by the
// dashboard "Targets & energy" panel and the compute_bmr / compute_targets chat
// result cards, so the energy numbers read identically everywhere. BMR is the
// floor and stays pinned first; maintenance + target are sorted by kcal so a cut
// lands the target below maintenance and a bulk above it.
//
// When maintaining, the daily target IS maintenance (0% delta) — both tiles
// carry the same kcal, so highlight maintenance too rather than leaving the
// identical number looking like un-steered context next to its highlighted twin.
// Each call site supplies its own sub-lines (BMR method, activity multiplier,
// goal delta) and the goal icon for the target tile.
export function buildEnergyTiles({
  bmr,
  tdee,
  targetKcal,
  targetIcon,
  bmrSub,
  maintenanceSub,
  targetSub,
}: {
  bmr: number | null;
  tdee: number | null;
  targetKcal: number | null;
  targetIcon: LucideIcon;
  bmrSub?: string;
  maintenanceSub?: string;
  targetSub?: string;
}): EnergyTile[] {
  const targetIsMaintenance =
    tdee != null && targetKcal != null && Math.round(tdee) === Math.round(targetKcal);

  const rest: EnergyTile[] = [];
  if (tdee != null)
    rest.push({
      key: "maintenance",
      icon: Zap,
      label: i18n.t("lib.energy.maintenance"),
      value: Math.round(tdee),
      sub: maintenanceSub,
      highlight: targetIsMaintenance,
    });
  if (targetKcal != null)
    rest.push({
      key: "target",
      icon: targetIcon,
      label: i18n.t("lib.energy.dailyTarget"),
      value: Math.round(targetKcal),
      sub: targetSub,
      highlight: true,
      dashed: true,
    });
  rest.sort((a, b) => a.value - b.value);

  const tiles: EnergyTile[] = [];
  if (bmr != null)
    tiles.push({
      key: "bmr",
      icon: Activity,
      label: i18n.t("lib.energy.bmr"),
      value: Math.round(bmr),
      sub: bmrSub,
      dashed: true,
      muted: true,
    });
  tiles.push(...rest);
  return tiles;
}

export function EnergyTiles({ tiles, className }: { tiles: EnergyTile[]; className?: string }) {
  if (tiles.length === 0) return null;
  return (
    <div className={cn("grid gap-2 sm:gap-2.5", COLS[tiles.length] ?? "grid-cols-3", className)}>
      {tiles.map((c) => (
        <div
          key={c.key}
          className={cn(
            "flex flex-col items-center gap-0.5 rounded-xl border border-edge bg-card px-1.5 py-2.5 text-center shadow-tile sm:px-3",
            c.highlight && "border-primary bg-primary/5 ring-1 ring-primary/40",
            c.dashed && "border-dashed",
            c.muted && "opacity-60",
          )}
        >
          <div className="flex items-center gap-1 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase sm:text-[10px]">
            <c.icon className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{c.label}</span>
          </div>
          <div className="text-base/tight font-bold tabular-nums sm:text-lg">
            {c.value}
            <span className="text-[10px] font-normal text-muted-foreground"> kcal</span>
          </div>
          {c.sub && (
            <div className="truncate text-[9px] leading-snug text-muted-foreground sm:text-[10px]">
              {c.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
