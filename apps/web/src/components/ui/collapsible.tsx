import * as React from "react";
import { cn } from "@/lib/utils";

// Height-animating disclosure region. Animates open/closed via the CSS
// grid-template-rows 0fr↔1fr trick instead of measuring the content height
// in JS — so content that grows while open (e.g. streaming thinking/text)
// stays smooth: `1fr` resolves to the live auto height with no re-measure,
// and only the open/close toggle transitions.
//
// The caller owns the `open` state (this is a controlled, header-less
// primitive); pair it with your own toggle button. Put any padding / border
// / margin on a wrapper *inside* `children` so it's clipped while collapsed.
function Collapsible({
  open,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { open: boolean }) {
  return (
    <div
      data-state={open ? "open" : "closed"}
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      {...props}
    >
      {/* `relative` makes this the containing block for absolutely positioned
          descendants (e.g. sr-only checkboxes), so overflow-hidden clips them
          too — otherwise they escape the collapsed row and stretch the
          surrounding scroll area (the profile modal's gym-machine list). */}
      <div className="relative min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

export { Collapsible };
