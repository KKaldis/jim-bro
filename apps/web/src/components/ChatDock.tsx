import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, X } from "lucide-react";
import { BroAvatar } from "../avatars.tsx";
import { useChatBridge, type ActiveTool } from "../lib/chatBridge";
import { useChatComposer } from "../lib/useChatComposer";
import { ChatComposer, LangMicGroup } from "./ChatComposer.tsx";
import { CATEGORY_META } from "../lib/toolCategory";
import { brand } from "../lib/brand";
import { ReplyingLoader } from "./ReplyingLoader.tsx";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";

// The mobile coach bar: the single chat input on phones (the Chat screen's own
// composer is desktop-only). App pins it below the primary nav at the very
// bottom. It's one element; opening reveals the composer below the always-visible
// handle by animating a grid row 0fr → 1fr (grows UP over the nav, z-50), so open
// AND close ease over the real content height. The handle carries the language
// picker + mic so they stay reachable collapsed or open; the body is the shared
// <ChatComposer> — full desktop parity (image upload + camera + send).
export function ChatDock() {
  const { t } = useTranslation();
  const busy = useChatBridge((s) => s.busy);
  const activeTool = useChatBridge((s) => s.activeTool);
  const [expanded, setExpanded] = useState(false);

  // Shared input engine. onSend routes through the bridge to Chat's sendMessage,
  // then collapses so the streaming reply toast (top-center) isn't hidden.
  const composer = useChatComposer({
    onSend: ({ text, images }) => {
      useChatBridge.getState().send(text, images);
      setExpanded(false);
    },
  });

  // Focus the composer as the bar opens (it stays mounted — clipped when
  // collapsed — so autoFocus can't be used). Also mirror the open state to the
  // bridge so Chat can pad + scroll its transcript clear of the opened input.
  useEffect(() => {
    if (expanded) composer.textareaRef.current?.focus();
    useChatBridge.getState().setDockOpen(expanded);
  }, [expanded, composer.textareaRef]);

  // Mic in the handle: tapping while collapsed opens the bar and starts
  // dictation; while open it toggles. The composer's textarea is always mounted,
  // so dictation can write to it either way.
  const micToggle = () => {
    if (!expanded) setExpanded(true);
    composer.toggleMic();
  };

  // Tool-use badge (right of the handle): show EACH tool the agent runs for at
  // least MIN_MS — even when tools fire back-to-back they're queued and played
  // out one per MIN_MS, so none blinks past unread. A tool that runs longer than
  // MIN_MS stays up until the next tool or the turn ends. `toolInfo` is the
  // displayed tool (kept mounted through its fade); `toolShown` drives the fade.
  const [toolInfo, setToolInfo] = useState<ActiveTool | null>(null);
  const [toolShown, setToolShown] = useState(false);
  const queueRef = useRef<ActiveTool[]>([]);
  const displayRef = useRef<ActiveTool | null>(null);
  const activeToolRef = useRef<ActiveTool | null>(null);
  const stepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceRef = useRef<() => void>(() => {});

  // Show the next queued tool (for MIN_MS); if the queue is empty, keep the
  // current tool while it's still running, otherwise fade it out.
  const advance = useCallback(() => {
    const MIN_MS = 1000;
    const FADE_MS = 300;
    const next = queueRef.current.shift();
    if (next) {
      if (fadeTimerRef.current) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
      displayRef.current = next;
      setToolInfo(next);
      setToolShown(true);
      stepTimerRef.current = setTimeout(() => {
        stepTimerRef.current = null;
        advanceRef.current();
      }, MIN_MS);
      return;
    }
    if (activeToolRef.current && activeToolRef.current === displayRef.current) return;
    displayRef.current = null;
    setToolShown(false);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => setToolInfo(null), FADE_MS);
  }, []);
  advanceRef.current = advance;

  useEffect(() => {
    activeToolRef.current = activeTool;
    if (activeTool) {
      queueRef.current.push(activeTool);
      // Start immediately if idle, or advance now if the on-screen tool already
      // had its minimum (no step timer pending). Otherwise it waits in the queue.
      if (!displayRef.current || !stepTimerRef.current) advance();
    } else if (displayRef.current && !stepTimerRef.current && queueRef.current.length === 0) {
      // The on-screen tool that just ended already had its minimum — fade it out.
      advance();
    }
  }, [activeTool, advance]);
  useEffect(
    () => () => {
      if (stepTimerRef.current) clearTimeout(stepTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    },
    [],
  );

  const toolMeta = toolInfo ? CATEGORY_META[toolInfo.category] : null;

  return (
    <div
      data-tour="composer"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-t-2xl border-t border-primary bg-background pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_color-mix(in_srgb,var(--background)_65%,transparent)] md:hidden"
    >
      {/* Handle row — always visible whether open or closed. */}
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <BroAvatar size={24} className="shrink-0" />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-start"
        >
          {busy ? (
            <ReplyingLoader className="inline-flex min-w-0 flex-1 text-xs font-medium" />
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-primary">
              {t("chat.dock.ask", { name: brand.agentName })}
            </span>
          )}
        </button>
        {/* Tool-use badge — same category colour + icon as the transcript's tool
            pills. Fades in while a tool runs, holds ~2s, fades out. */}
        {toolInfo && toolMeta && (
          <Badge
            aria-hidden={!toolShown}
            variant="outline"
            className={cn(
              "shrink-0 gap-1 font-normal duration-300",
              toolMeta.badgeClass,
              toolShown ? "animate-in fade-in-0" : "animate-out fade-out-0 fill-mode-forwards",
            )}
          >
            <toolMeta.Icon aria-hidden className="size-3 shrink-0" />
            <span className="max-w-20 truncate">{toolInfo.label}</span>
          </Badge>
        )}
        {/* Language picker + mic (compact) — kept here so they stay reachable
            collapsed or open. */}
        <LangMicGroup
          listening={composer.listening}
          onToggle={micToggle}
          dense
          disabled={!composer.canChat}
        />
        {expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label={t("common.close")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label={t("chat.dock.ask", { name: brand.agentName })}
            className="flex size-8 shrink-0 items-center justify-center text-primary"
          >
            <ChevronUp aria-hidden className="size-4" />
          </button>
        )}
      </div>

      {/* Composer body — revealed by animating the grid row 0fr → 1fr, which eases
          the real content height both ways (a max-height guess made opening snap).
          The inner overflow-hidden clips it while collapsed. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <ChatComposer composer={composer} variant="dock" />
        </div>
      </div>
    </div>
  );
}
