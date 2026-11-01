import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared "nothing here yet" panel: a dashed, softly tinted box with an icon
// badge and a one-line message. Use it wherever a card, list or chart has no
// data to show, so empty states read the same across the app. `compact` is
// for tight spots (inside a list item or a small chart slot).
export function EmptyState({
  icon: Icon = Inbox,
  children,
  compact = false,
  className,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 text-center",
        compact ? "gap-1.5 px-3 py-4" : "gap-2.5 px-4 py-8",
        className,
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15 ring-inset",
          compact ? "size-8" : "size-11",
        )}
      >
        <Icon className={compact ? "size-4" : "size-5"} />
      </span>
      <p
        className={cn(
          "max-w-sm text-balance text-muted-foreground",
          compact ? "text-xs" : "text-sm",
        )}
      >
        {children}
      </p>
    </div>
  );
}
