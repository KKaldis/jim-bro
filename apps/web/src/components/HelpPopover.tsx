import { type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// A small "?" that opens an explanation, for keeping how-it-works text out of
// the layout: chart controls, how training burn is estimated. Same popover look
// as the page help next to PageTitle.
export function HelpPopover({
  label,
  heading,
  align = "end",
  className,
  children,
}: {
  // Accessible name of the "?" button.
  label: string;
  heading?: string;
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          className,
        )}
      >
        <CircleHelp className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-sm font-normal tracking-normal"
      >
        {heading && <p className="font-semibold">{heading}</p>}
        <div className="space-y-1.5 text-muted-foreground">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
