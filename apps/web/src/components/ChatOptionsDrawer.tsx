import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useUiStore } from "../lib/uiStore";
import { useChatBridge } from "../lib/chatBridge";
import { cn } from "../lib/utils";

// Mobile thinking/reset controls in a slide-down drawer, centered under the top
// edge — closed, only the chevron handle peeks below. Extracted from Chat so the
// same drawer can float over the data screens (App wires it into the mobile data
// overlay); `thinking` lives in the UI store and `reset` comes through the chat
// bridge, so it works identically in both mounts. Renders on mobile only.
export function ChatOptionsDrawer({ className }: { className?: string }) {
  const { t } = useTranslation();
  const thinking = useUiStore((s) => s.thinking);
  const setThinking = useUiStore((s) => s.setThinking);
  const reset = useChatBridge((s) => s.reset);
  const [open, setOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close when tapping/clicking anywhere outside the drawer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <>
      <div
        ref={ref}
        className={cn(
          "absolute top-0 left-1/2 z-30 flex -translate-x-1/2 flex-col items-stretch transition-transform duration-200 sm:hidden",
          open ? "translate-y-0" : "-translate-y-[calc(100%-1.25rem)]",
          className,
        )}
      >
        <div className="flex flex-row gap-1 rounded-b-2xl border border-t-0 border-primary bg-background/95 px-1.5 py-1 shadow-overlay backdrop-blur-sm">
          <Button
            variant={thinking ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setThinking(!thinking)}
            className="h-7 justify-start gap-1.5 px-2 text-[11px]"
          >
            <Brain className={`size-3 ${+thinking && "animate-spin"}`} />
            {t("chat.thinking.label")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setResetOpen(true);
              setOpen(false);
            }}
            className="h-7 justify-start gap-1.5 px-2 text-[11px]"
          >
            <RotateCcw className="size-3" />
            {t("chat.reset")}
          </Button>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? t("chat.hideOptions") : t("chat.showOptions")}
          aria-expanded={open}
          className="flex h-5 items-center justify-center self-center rounded-b-2xl border border-t-0 border-primary bg-background/90 px-4 opacity-70 shadow-overlay backdrop-blur-sm"
        >
          <ChevronDown
            aria-hidden
            className={cn("size-4 text-primary transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat.resetDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("chat.resetDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reset()}>{t("chat.reset")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
