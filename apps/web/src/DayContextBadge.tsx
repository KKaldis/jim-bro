import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CalendarPopover } from "@/components/ui/date-picker";
import { dayDiffFromToday, relativeDay } from "./dateRange.ts";
import { cn } from "./lib/utils";

// Localize the relative-day label. dateRange.relativeDay returns the immediate
// neighbours as English words ("Today"/"Yesterday"/"Tomorrow") and everything
// else as an already-formatted short date, which stays as-is. We re-derive the
// day offset here so the words come from the translation catalog.
function useRelativeDayLabel() {
  const { t } = useTranslation();
  return (iso: string) => {
    const diff = dayDiffFromToday(iso);
    if (diff === 0) return t("widgets.todayBadge");
    if (diff === -1) return t("widgets.yesterday");
    if (diff === 1) return t("widgets.tomorrow");
    return relativeDay(iso);
  };
}

// The day-context chip: shows the currently selected day as a relative label
// (Today/Yesterday/Tomorrow, falling back to a short "27 Jan" for further-out
// days — see relativeDay), with Today given a solid primary fill so a
// non-today context stands out. On click, opens the shared calendar popover to
// move it. The selected day
// drives the agent's context_date and the data screens' day. Used both as a
// floating overlay over the chat log (desktop) and inline next to the brand
// name in the app header (mobile) — positioning is controlled by `className`.
export function DayContextBadge({
  selectedDateIso,
  onSelectDate,
  className,
  align = "left",
  size = "sm",
}: {
  selectedDateIso: string;
  onSelectDate?: (iso: string) => void;
  className?: string;
  align?: "left" | "right";
  size?: "sm" | "md";
}) {
  const { t } = useTranslation();
  const relLabel = useRelativeDayLabel();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const iconSize = size === "md" ? "h-4 w-4" : "h-3 w-3";
  const isToday = dayDiffFromToday(selectedDateIso) === 0;

  return (
    <div ref={rootRef} className={cn("relative", className)} data-tour="day">
      <button
        type="button"
        onClick={() => onSelectDate && setOpen((v) => !v)}
        aria-label={t("widgets.changeChatDay")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!onSelectDate}
        className="cursor-pointer disabled:cursor-default"
      >
        <Badge
          variant="outline"
          className={cn(
            "gap-1.5 border-primary/40 bg-background/85 text-foreground shadow-control backdrop-blur-sm transition-colors hover:bg-accent soft:border-transparent soft:bg-background",
            size === "md" && "gap-2 px-3 py-1 text-sm",
            // Today is the default/expected context — make it pop with a solid
            // primary fill so a non-today (past/future) day reads as the
            // exception worth noticing.
            isToday &&
              "border-primary bg-primary font-semibold text-primary-foreground hover:bg-primary/90 soft:bg-primary",
          )}
        >
          <CalendarDays
            className={cn(iconSize, isToday ? "text-primary-foreground" : "text-primary")}
          />
          {relLabel(selectedDateIso)}
          {onSelectDate && (
            <ChevronDown
              className={cn(
                iconSize,
                isToday ? "text-primary-foreground/80" : "text-muted-foreground",
              )}
            />
          )}
        </Badge>
      </button>
      {open && onSelectDate && (
        <CalendarPopover
          value={selectedDateIso}
          align={align}
          onPick={(iso) => {
            onSelectDate(iso);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
