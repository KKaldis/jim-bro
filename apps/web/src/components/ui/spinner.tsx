import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Primary-colored spinning loader. Use for inline/section "fetching" states
// where a skeleton block doesn't fit (buttons, small panels, centered waits).
function Spinner({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      className={cn("size-7 animate-spin text-primary", className)}
      {...props}
    />
  );
}

export { Spinner };
