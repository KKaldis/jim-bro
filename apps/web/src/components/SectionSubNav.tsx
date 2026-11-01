import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { navBarSoftTop, navItemBase, navItemClass } from "@/lib/navItem";

// A page's sub-sections as a slim segmented-pill bar spanning the full content
// width, sitting just below the page's scroll area at the column bottom. On
// mobile it sits just above the primary nav inside the data drawer, so its
// horizontal-pill style reads as the subordinate level; on desktop it pins to
// the column bottom.
export function SectionSubNav<T extends string>({
  sections,
  section,
  onSection,
  label,
  ariaLabel,
  tourPrefix,
}: {
  sections: ReadonlyArray<{ id: T; Icon: LucideIcon }>;
  section: T;
  onSection: (s: T) => void;
  label: (id: T) => string;
  ariaLabel: string;
  // data-tour hook per pill: `${tourPrefix}-${id}`.
  tourPrefix: string;
}) {
  return (
    <nav
      className={cn(
        "mx-auto flex w-full max-w-3xl items-center gap-1.5 border-t bg-background/95 px-2 py-1.5 backdrop-blur-sm supports-backdrop-filter:bg-background/80 soft:gap-3 soft:px-3 soft:py-2.5",
        navBarSoftTop,
      )}
      aria-label={ariaLabel}
    >
      {sections.map((s) => {
        const active = section === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSection(s.id)}
            data-tour={`${tourPrefix}-${s.id}`}
            className={cn(
              "flex h-8 flex-1 items-center justify-center gap-1.5 text-xs",
              navItemBase,
              navItemClass(active),
            )}
            aria-current={active ? "page" : undefined}
          >
            <s.Icon className="size-4" />
            {label(s.id)}
          </button>
        );
      })}
    </nav>
  );
}
