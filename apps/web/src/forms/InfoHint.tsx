import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Small "(i)" affordance shown next to a form field's name. Reveals the field's
// description / extra info on hover (desktop) or tap/click (touch). The popover
// is portaled, so it never gets clipped by the modal's scrollable body.
export function InfoHint({ text, className }: { text: string; className?: string }) {
  const { t: tr } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={tr("formsAdmin.info.moreInfo")}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onClick={(e) => {
            // Keep clicks from bubbling into the surrounding label/form.
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
          className={cn(
            "inline-flex shrink-0 text-primary/80 transition-colors hover:text-primary focus:outline-none focus-visible:text-primary",
            className,
          )}
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-64 text-xs/relaxed font-normal"
        // Don't yank focus into the popover on hover-open.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}
