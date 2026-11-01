import { Lock, PlugZap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useUiStore } from "../lib/uiStore";
import { cn } from "../lib/utils";

// A small pill on a locked feature saying why it's off (see lib/features.tsx).
// `reason` is the lock code from GET /me/entitlements: "no_llm" / "no_vision"
// when the server has no AI model configured for it; any other code comes from
// a server extension and gets the generic "unavailable" badge. Tapping it opens
// the usage page, which explains the AI setup.

const NO_MODEL = new Set(["no_llm", "no_vision"]);

export function LockBadge({ reason, className }: { reason: string; className?: string }) {
  const { t } = useTranslation();
  const requestView = useUiStore((s) => s.requestView);
  const noModel = NO_MODEL.has(reason);
  const Icon = noModel ? PlugZap : Lock;
  const label = t(noModel ? "components.lock.noModel" : "components.lock.locked");
  const title = t(
    noModel
      ? `components.lock.${reason === "no_vision" ? "noVisionTitle" : "noLlmTitle"}`
      : "components.lock.lockedTitle",
  );
  return (
    <button
      type="button"
      // Stay clickable even inside a pointer-events-none locked container, and
      // don't let the click bubble to whatever the badge is overlaid on.
      onClick={(e) => {
        e.stopPropagation();
        requestView("usage");
      }}
      className={cn(
        "pointer-events-auto inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-muted-foreground shadow-sm transition-colors hover:bg-muted/80",
        className,
      )}
      title={title}
      aria-label={title}
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}
