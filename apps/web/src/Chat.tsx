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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cacheSentImages, clearImageCache, loadCachedImageUrls } from "@/lib/imageCache";
import { useMinLoading } from "@/lib/useMinLoading";
import { useStickToBottom } from "@/lib/useStickToBottom";
import { cn } from "@/lib/utils";
import { MUTATING_TOOL_NAMES } from "@fa/shared";
import { Brain, ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DayContextBadge } from "./DayContextBadge.tsx";
import type { HistoryResponse } from "./api/model";
import { type CardNav, CardNavContext } from "./cards/cardNav.ts";
import { getResultCard } from "./cards/resultCards.tsx";
import { TurnView } from "./chat/TurnView";
import { messagesToTurns, withSources } from "./chat/messages";
import {
  type Block,
  type Citation,
  MUTATING_TOOLS,
  type StreamListener,
  type StreamState,
  type Turn,
  type User,
} from "./chat/types";
import { ChatComposer } from "./components/ChatComposer.tsx";
import { ChatOptionsDrawer } from "./components/ChatOptionsDrawer.tsx";
import type { JsonSchema } from "./forms/ToolForm.tsx";
import type { ToolCardStatus } from "./forms/ToolFormCard.tsx";
import { invalidateFormContext } from "./forms/formContext.ts";
import { getSavedIdentity, getUpdateToolName } from "./forms/overrides.tsx";
import { toBcp47 } from "./i18n";
import { useChatBridge } from "./lib/chatBridge.ts";
import {
  type ChatRequest,
  type ChatServerMessage,
  chatSocket,
  type ChatStreamEvent,
  type RunInfo,
} from "./lib/chatSocket.ts";
import { coachGateToast, finishCoachToast, updateCoachToast } from "./lib/coachToast.tsx";
import type { OutgoingImage } from "./lib/composerImages";
import { useFeature } from "./lib/features";
import { toastSuccess, toolCrudMessage } from "./lib/toast.ts";
import type { ToolCategory } from "./lib/toolCategory.tsx";
import { useUiStore, type View } from "./lib/uiStore.ts";
import { useChatComposer } from "./lib/useChatComposer";

// Server contract types, generated from the OpenAPI spec (apps/server/src/
// schemas.ts). Regenerate with `npm run gen:api` after backend changes.

type LiveRun = {
  runId: string;
  turnId: string;
  local: boolean;
  acked: boolean;
  seq: number;
  mutated: boolean;
  request: ChatRequest | null;
};

// How many messages to fetch per /history page. The first page loads the most
// recent N; each scroll-to-top fetches the next N older messages. We re-convert
// the accumulated (contiguous, newest-anchored) range each page so
// messagesToTurns keeps correct image-cache and tool_result alignment.
const HISTORY_PAGE_SIZE = 20;

// Tools that should raise a CRUD toast when the agent runs them in chat. This
// is MUTATING_TOOLS plus the non-gated writes that still change data —
// activating a plan flips the active-plan pointer — so agent-driven activations
// confirm the same way the data-screen /activate endpoints do. toolCrudMessage
// already renders these ("Diet plan activated").
const CHAT_TOAST_TOOLS: ReadonlySet<string> = new Set([
  ...MUTATING_TOOL_NAMES,
  "activate_diet_plan",
  "activate_workout_plan",
]);

// Writes that change the shared gate-form context (formContext.ts) — the
// profile (sex/height/age/…) or the latest body-comp weight. After these run we
// drop the cache so already-open gate forms re-read it: e.g. an onboarding
// log_body_comp card proposed alongside update_profile only learns the user is
// female once the profile save lands, and that's what unhides the Navy hip
// input for women.
const FORM_CONTEXT_TOOLS: ReadonlySet<string> = new Set([
  "update_profile",
  "log_body_comp",
  "update_body_comp_entry",
  "delete_body_comp_entry",
]);

// i18n key for each screen's primary-nav label — mirrors App's VIEWS so the
// screen-context tag ([Viewing: ...]) reads with the exact button title the
// user sees (note: the "nutrition" view's button is labelled "Food").
const SCREEN_LABEL_KEY: Record<View, string> = {
  dashboard: "nav.dashboard",
  nutrition: "nav.food",
  workout: "nav.workout",
  body: "nav.body",
  calculators: "nav.calculators",
  usage: "nav.usage",
};

export function Chat({
  user: _user,
  onTurnComplete,
  contextDate,
  selectedDateIso,
  onSelectDate,
  onAgentViewDate,
  onShowScreen,
  dockActive = false,
  onOpenChat,
}: {
  user: User;
  onTurnComplete?: () => void;
  contextDate?: string | null;
  selectedDateIso?: string;
  onSelectDate?: (iso: string) => void;
  onAgentViewDate?: (date: string) => void;
  onShowScreen?: (screen: string, tab?: string) => void;
  // True when a data screen covers the chat (mobile): replies are mirrored to
  // coach toasts instead of the hidden transcript. `onOpenChat` reveals the
  // transcript (App closes the data drawer) — used by those toasts.
  dockActive?: boolean;
  onOpenChat?: () => void;
}) {
  const { t } = useTranslation();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const showHistoryLoader = useMinLoading(historyLoading);
  const [busy, setBusy] = useState(false);
  // Whether the mobile coach bar's input is open (from the bridge) — when it is,
  // the transcript gets extra bottom padding and scrolls to the bottom so the
  // last messages clear the opened input overlay.
  const dockOpen = useChatBridge((s) => s.dockOpen);
  // Tier gating: chat sending is feature-gated. Gated controls render disabled
  // with an upgrade badge rather than disappearing.
  const canChat = useFeature("ai_chat");
  // Extended-thinking toggle now lives in the shared UI store (persisted) so the
  // thinking/reset drawer can also float over the data screens on mobile.
  const thinking = useUiStore((s) => s.thinking);
  const setThinking = useUiStore((s) => s.setThinking);
  // The product language (profile → UI store, en/el) seeds the per-message reply
  // locale — the server tags the message [Locale: <bcp47>] from it, so a
  // Greek-selected user is greeted and answered in Greek. The locale lives in the
  // shared chatBridge so the desktop composer and the mobile coach bar drive one
  // value; either language picker overrides it for the session, and switching the
  // app language re-syncs it here.
  const productLanguage = useUiStore((s) => s.language);
  useEffect(() => {
    useChatBridge.getState().setLocale(toBcp47(productLanguage));
  }, [productLanguage]);
  // Scroll-up pagination. `turns` holds the currently-loaded conversation:
  // a leading block of restored history (the first `historyTurnCountRef` turns)
  // followed by any turns created live this session. Scrolling to the top
  // fetches the next older page from /history and prepends it.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  // Accumulated raw history messages (oldest-first) for the range loaded so
  // far, and the count of leading `turns` they convert to. We re-convert the
  // whole accumulated range on each page (cheap string work) so messagesToTurns
  // keeps a contiguous suffix — its image-cache and tool_result alignment both
  // depend on seeing messages through to the newest end.
  const historyMsgsRef = useRef<unknown[]>([]);
  const historyTurnCountRef = useRef(0);
  // Tool schemas + locally-cached image URLs, captured at first load and reused
  // when re-converting older pages.
  const schemasRef = useRef<Record<string, JsonSchema>>({});
  const cachedImagesRef = useRef<string[]>([]);
  // Pagination cursor: the id to pass as `?before=` for the next older page,
  // null once we reach the start of the conversation.
  const cursorRef = useRef<number | null>(null);
  const hasMoreRef = useRef(false);
  // Scroll height captured just before a prepend, so we can offset scrollTop
  // afterward and keep the previously-top message visually anchored.
  const restoreScrollHeightRef = useRef<number | null>(null);
  // Set just before a load-older prepend so the follow-to-bottom effect skips
  // the resulting `turns` change. A prepend grows the list at the TOP — the
  // restore layout effect repositions us — so following to the bottom there
  // would wrongly yank the reader down to the latest message.
  const skipFollowRef = useRef(false);
  // Indirection so the (stable) onReachTop handler can call the latest
  // loadMore without re-subscribing the scroll listener every render.
  const loadMoreRef = useRef<() => void>(() => {});

  const {
    ref: logRef,
    atBottom,
    scrollToBottom,
    followIfPinned,
  } = useStickToBottom<HTMLDivElement>({
    onReachTop: () => loadMoreRef.current(),
  });

  // When the mobile coach bar OPENS and the user was already pinned to the
  // bottom, lift the latest messages above the opened input. If they've scrolled
  // up to read history, leave their position untouched — and never scroll on
  // close (this only fires when dockOpen flips true). rAF defers past the padding
  // change so the new scroll height is in place.
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  useEffect(() => {
    if (dockOpen && atBottomRef.current) requestAnimationFrame(() => scrollToBottom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockOpen]);

  // Convert accumulated history messages to turns, tagging each with an
  // end-relative id (`h<distance-from-newest>`) so a re-convert after a prepend
  // reuses ids for the turns already on screen — React reconciles them in place
  // instead of remounting (which would reset collapse state and flicker).
  const convertHistory = useCallback((msgs: unknown[]): Turn[] => {
    const t = messagesToTurns(msgs, schemasRef.current, cachedImagesRef.current);
    const n = t.length;
    return t.map((turn, i) => ({ ...turn, id: `h${n - 1 - i}` }));
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (!hasMoreRef.current || cursorRef.current == null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await fetch(`/history?before=${cursorRef.current}&limit=${HISTORY_PAGE_SIZE}`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const body = (await res.json()) as HistoryResponse;
      const older = Array.isArray(body.messages) ? body.messages : [];
      cursorRef.current = body.nextCursor ?? null;
      hasMoreRef.current = body.nextCursor != null;
      if (older.length === 0) return;
      const accumulated = [...older, ...historyMsgsRef.current];
      historyMsgsRef.current = accumulated;
      const newHistory = convertHistory(accumulated);
      const prevHistoryCount = historyTurnCountRef.current;
      historyTurnCountRef.current = newHistory.length;
      // Capture height immediately before the prepend (the loader is an overlay
      // and doesn't affect layout) so the post-render offset is exact.
      restoreScrollHeightRef.current = logRef.current?.scrollHeight ?? null;
      // Suppress the follow-to-bottom effect for this prepend: the slack zones
      // can still count us as "pinned" on the first load-older, which would
      // otherwise jump the reader to the latest message.
      skipFollowRef.current = true;
      setTurns((prev) => [...newHistory, ...prev.slice(prevHistoryCount)]);
    } catch {
      // Best-effort: leave the cursor so a later scroll-to-top retries.
    } finally {
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  }, [convertHistory, logRef]);
  loadMoreRef.current = loadMore;

  // After older turns mount, offset scrollTop by the height they added so the
  // message the user was reading stays put instead of jumping down.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && restoreScrollHeightRef.current != null) {
      const delta = el.scrollHeight - restoreScrollHeightRef.current;
      if (delta > 0) el.scrollTop += delta;
      restoreScrollHeightRef.current = null;
    }
  }, [turns, logRef]);
  // Set by reset() so a late first history load can't resurrect wiped turns.
  const interactedRef = useRef(false);
  // Whether a history page has been applied (first load or reloadHistory).
  const historyAppliedRef = useRef(false);
  const [resetOpen, setResetOpen] = useState(false);
  // When a data screen covers the chat (mobile), mirror the streaming reply into
  // a coach toast. Refs so the mid-stream SSE handler reads the latest values.
  const dockActiveRef = useRef(dockActive);
  dockActiveRef.current = dockActive;
  const onOpenChatRef = useRef(onOpenChat);
  onOpenChatRef.current = onOpenChat;
  // Accumulated reply text for the active docked turn (drives the toast body).
  const dockTextRef = useRef("");
  const openChatFromToast = useCallback(() => onOpenChatRef.current?.(), []);

  useEffect(() => {
    let cancelled = false;
    let cachedMsgs: unknown[] | null = null;
    let cachedCursor: number | null = null;
    let cachedSchemas: Record<string, JsonSchema> | null = null;
    let cachedImageUrls: string[] | null = null;

    // The first /history page, /tools/schemas, and the locally-cached images
    // all need to arrive before we render the restored turns — without schemas,
    // mutating tools would briefly flash as pills before rerendering as cards;
    // without the cached images, previously-sent photos would flash as
    // placeholders before re-hydrating. We hold off setTurns until all three
    // resolve (or fail) so the user sees a single, correct first paint.
    const applyIfReady = () => {
      if (cancelled || interactedRef.current || historyAppliedRef.current) return;
      if (cachedMsgs == null || cachedSchemas == null || cachedImageUrls == null) {
        return;
      }
      schemasRef.current = cachedSchemas;
      cachedImagesRef.current = cachedImageUrls;
      historyMsgsRef.current = cachedMsgs;
      cursorRef.current = cachedCursor;
      hasMoreRef.current = cachedCursor != null;
      const restored = convertHistory(cachedMsgs);
      historyTurnCountRef.current = restored.length;
      historyAppliedRef.current = true;
      // Turns created before history arrived (a fast first send, or a run
      // attached on connect) stay after the restored block.
      if (restored.length > 0) setTurns((live) => [...restored, ...live]);
      setHistoryLoading(false);
    };

    (async () => {
      try {
        const res = await fetch(`/history?limit=${HISTORY_PAGE_SIZE}`, {
          credentials: "include",
        });
        if (!res.ok) {
          cachedMsgs = [];
        } else {
          const body = (await res.json()) as HistoryResponse;
          cachedMsgs = Array.isArray(body.messages) ? body.messages : [];
          cachedCursor = body.nextCursor ?? null;
        }
      } catch {
        cachedMsgs = [];
      }
      applyIfReady();
    })();

    (async () => {
      try {
        const res = await fetch("/tools/schemas", { credentials: "include" });
        if (!res.ok) {
          cachedSchemas = {};
        } else {
          const body = (await res.json()) as Record<string, JsonSchema>;
          cachedSchemas = body && typeof body === "object" ? body : {};
        }
      } catch {
        cachedSchemas = {};
      }
      applyIfReady();
    })();

    (async () => {
      cachedImageUrls = await loadCachedImageUrls(_user.id);
      applyIfReady();
    })();

    return () => {
      cancelled = true;
    };
  }, [_user.id, convertHistory]);

  // In-flight stream buffer lives outside React state so each chunk only
  // re-renders the active StreamingBlock — not Chat, not other TurnViews,
  // and not the committed blocks within the streaming turn. The buffer is
  // committed to `turns` only when the stream ends or a non-text block
  // (tool, image) needs to be appended.
  const streamBufRef = useRef<StreamState | null>(null);
  const streamListenersRef = useRef<Set<StreamListener>>(new Set());
  const rafRef = useRef<number | null>(null);
  // The run this tab is rendering — started here (`local`) or attached from
  // the server (another tab, or this page reloaded mid-reply). `seq` is the
  // last event applied (resume point + de-dupe); `acked` flips once the server
  // announces the run, and until then `request` is re-sent on every reconnect
  // (the server ignores a duplicate run_id), so a message sent right before the
  // phone locks isn't lost.
  const liveRunRef = useRef<LiveRun | null>(null);
  // A Stop issued while the socket was down — delivered on the next `ready`.
  const pendingStopRef = useRef<string | null>(null);

  // Re-fetch the newest history page and replace the transcript with it. Used
  // when a run's live events can't be (fully) replayed — the server persisted
  // the turn, so history is the source of truth.
  const reloadHistory = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/history?limit=${HISTORY_PAGE_SIZE}`, { credentials: "include" });
      if (!res.ok) return false;
      const body = (await res.json()) as HistoryResponse;
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      if (Object.keys(schemasRef.current).length === 0) {
        try {
          const s = await fetch("/tools/schemas", { credentials: "include" });
          if (s.ok) schemasRef.current = (await s.json()) as Record<string, JsonSchema>;
        } catch {
          /* cards fall back to pills */
        }
      }
      cachedImagesRef.current = await loadCachedImageUrls(_user.id);
      // Keep a still-pending first load from prepending an older copy.
      historyAppliedRef.current = true;
      historyMsgsRef.current = msgs;
      cursorRef.current = body.nextCursor ?? null;
      hasMoreRef.current = body.nextCursor != null;
      const restored = convertHistory(msgs);
      historyTurnCountRef.current = restored.length;
      setTurns(restored);
      setHistoryLoading(false);
      requestAnimationFrame(() => scrollToBottom());
      return true;
    } catch {
      return false;
    }
  }, [_user.id, convertHistory, scrollToBottom]);

  const registerStreamListener = useCallback((cb: StreamListener) => {
    streamListenersRef.current.add(cb);
    cb(streamBufRef.current);
    return () => {
      streamListenersRef.current.delete(cb);
    };
  }, []);

  useEffect(() => {
    // A load-older prepend changes `turns` too, but it grows the list at the
    // top — the restore layout effect handles positioning, so skip the follow.
    if (skipFollowRef.current) {
      skipFollowRef.current = false;
      return;
    }
    followIfPinned();
  }, [turns, followIfPinned]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const reset = async () => {
    interactedRef.current = true;
    await fetch("/reset", { method: "POST", credentials: "include" });
    await clearImageCache(_user.id);
    setTurns([]);
    // Tear down pagination state so a fresh chat doesn't try to page into the
    // wiped history (or re-hydrate stale cached images).
    historyMsgsRef.current = [];
    historyTurnCountRef.current = 0;
    cursorRef.current = null;
    hasMoreRef.current = false;
    cachedImagesRef.current = [];
  };

  // `override.text` sends a message that didn't come from the textarea — the
  // mobile dock feeds text through here so it reuses the whole streaming
  // pipeline. Override sends are text-only: they ignore any images/draft staged
  // in the (hidden) chat composer and leave it untouched.
  // Send a message (text and/or images). Takes explicit args — the composer
  // (desktop <ChatComposer> or the mobile coach bar, both via useChatComposer)
  // owns the draft and hands over `{ text, images }`, then clears itself. Reached
  // directly on desktop and through chatBridge.send on mobile.
  const sendMessage = async (text: string, images: OutgoingImage[]) => {
    if (busy) return;
    if (!canChat) return; // no AI chat (no model configured) — sending is disabled
    if (!text && images.length === 0) return;
    setBusy(true);

    const userBlocks: Block[] = [];
    for (const img of images) {
      userBlocks.push({
        kind: "image",
        src: `data:${img.media_type};base64,${img.data}`,
      });
    }
    if (text) userBlocks.push({ kind: "text", text });
    const userTurn: Turn = {
      id: crypto.randomUUID(),
      who: "you",
      blocks: userBlocks,
    };
    const aTurn: Turn = {
      id: crypto.randomUUID(),
      who: "assistant",
      blocks: [],
    };
    const aTurnId = aTurn.id;
    // Fresh accumulator for this turn's coach-toast body (docked sends only).
    dockTextRef.current = "";
    // New turns are appended after the restored-history block; they live in the
    // session suffix and are preserved across older-page prepends.
    setTurns((t) => [...t, userTurn, aTurn]);
    // Sending is an explicit "bring me to the conversation" action — re-pin
    // and jump to the bottom even if the user had scrolled up reading history.
    // rAF defers past the commit so the new turns are in the DOM to scroll to.
    requestAnimationFrame(() => scrollToBottom());

    // Cache the originals locally (best-effort) so they survive a refresh —
    // the server strips images from persisted history. Matched back to history
    // positionally on reload (see messagesToTurns).
    if (images.length) void cacheSentImages(_user.id, images);

    // What data screen the user can actually see as they send, so the agent can
    // ground on-screen references ("add it here", "log this"). The left data
    // panel is always on screen at desktop widths (md+, device-width driven);
    // on mobile it's only up while the data drawer covers the chat (dockActive).
    // When neither holds the user is on the bare chat — send nothing, keeping
    // the turn tag-free. Read the store at send-time so it reflects the live
    // view/sub-tab without subscribing this component to every nav change.
    const screenVisible = window.matchMedia("(min-width: 768px)").matches || dockActiveRef.current;
    const ui = useUiStore.getState();
    // The calculators and usage pages have no agent-facing screen data (and
    // aren't in the ChatRequest screen enum), so treat them like the bare chat
    // — send no screen tag.
    const visibleView = screenVisible ? ui.view : undefined;
    const contextScreen =
      visibleView && visibleView !== "calculators" && visibleView !== "usage"
        ? visibleView
        : undefined;
    const contextSection = !contextScreen
      ? undefined
      : contextScreen === "nutrition"
        ? ui.nutritionSection
        : contextScreen === "workout"
          ? ui.workoutSection
          : undefined;
    // Resolve the screen + sub-tab to the SAME localized labels the nav buttons
    // render (t() uses the live UI language), so the agent's `[Viewing: ...]`
    // tag names the screen exactly as the user sees it — in English or Greek.
    // These label keys mirror App's VIEWS (nav.*) and each page's sub-nav.
    let contextViewLabel: string | undefined;
    if (contextScreen) {
      const screenLabel = t(SCREEN_LABEL_KEY[contextScreen]);
      const sectionLabelKey =
        contextScreen === "nutrition" && contextSection
          ? `nutrition.tabs.${contextSection}`
          : contextScreen === "workout" && contextSection
            ? `workout.sections.${contextSection}`
            : null;
      contextViewLabel = sectionLabelKey ? `${screenLabel}/${t(sectionLabelKey)}` : screenLabel;
    }

    const request: ChatRequest = {
      message: text,
      ...(images.length ? { images } : {}),
      ...(contextDate ? { context_date: contextDate } : {}),
      ...(contextScreen ? { context_screen: contextScreen } : {}),
      ...(contextSection ? { context_section: contextSection } : {}),
      ...(contextViewLabel ? { context_view_label: contextViewLabel } : {}),
      thinking,
      locale: useChatBridge.getState().locale,
    };
    const run: LiveRun = {
      runId: crypto.randomUUID(),
      turnId: aTurnId,
      local: true,
      acked: false,
      seq: 0,
      mutated: false,
      request,
    };
    liveRunRef.current = run;
    // If the socket is down this is a no-op; the next `ready` sends it.
    chatSocket.send({ type: "start", run_id: run.runId, request });
  };

  // Close out the live run. Remote (attached) and lost runs re-sync from
  // history, since this tab only saw part of them.
  const finishRun = (
    run: LiveRun,
    outcome: "completed" | "error" | "stopped" | "lost" | "rejected",
  ) => {
    if (liveRunRef.current !== run) return;
    liveRunRef.current = null;
    flushPendingDelta();
    if (outcome === "stopped") updateTurn(run.turnId, (turn) => ({ ...turn, interrupted: true }));
    setBusy(false);
    useChatBridge.getState().setActiveTool(null);
    // Settle the reply toast (streaming → done, then auto-dismiss). No-op if
    // this turn never surfaced one (not docked, or no text).
    finishCoachToast(run.turnId);
    if (outcome === "lost" || (!run.local && outcome !== "stopped")) {
      void reloadHistory().then((ok) => {
        if (!ok && outcome === "lost") {
          appendBlock(run.turnId, { kind: "text", text: `\n[error] ${t("chat.connectionLost")}` });
        }
      });
    }
    if (run.mutated || !run.local || outcome === "lost") onTurnComplete?.();
  };

  // Stop the live run. Finishes locally right away (the server's own `end`
  // for it is then ignored); the stop itself is delivered now or on reconnect.
  const stopReply = () => {
    const run = liveRunRef.current;
    if (!run) return;
    if (!chatSocket.send({ type: "stop", run_id: run.runId })) pendingStopRef.current = run.runId;
    finishRun(run, "stopped");
  };

  // A run this tab didn't start (another tab, or this page reloaded while a
  // reply was in flight): render it live from the server's replay.
  const attachRun = (info: RunInfo) => {
    const userTurn: Turn | null = info.user_text
      ? { id: crypto.randomUUID(), who: "you", blocks: [{ kind: "text", text: info.user_text }] }
      : null;
    const aTurn: Turn = { id: crypto.randomUUID(), who: "assistant", blocks: [] };
    dockTextRef.current = "";
    setTurns((t) => [...t, ...(userTurn ? [userTurn] : []), aTurn]);
    liveRunRef.current = {
      runId: info.run_id,
      turnId: aTurn.id,
      local: false,
      acked: true,
      seq: 0,
      mutated: false,
      request: null,
    };
    setBusy(true);
    requestAnimationFrame(() => scrollToBottom());
  };

  const onSocketMessage = (msg: ChatServerMessage) => {
    const run = liveRunRef.current;
    switch (msg.type) {
      case "ready": {
        // (Re)connected. Deliver a Stop that couldn't be sent, then reconcile
        // our live run with what the server has.
        const pendingStop = pendingStopRef.current;
        pendingStopRef.current = null;
        if (pendingStop && msg.run?.run_id === pendingStop && msg.run.running) {
          chatSocket.send({ type: "stop", run_id: pendingStop });
        }
        if (!run || msg.run?.run_id === run.runId) return;
        if (run.acked) {
          // The server no longer has it (restarted, or finished long ago).
          finishRun(run, "lost");
        } else if (run.request) {
          // Never confirmed — (re)send. A duplicate of one that did arrive is
          // ignored server-side.
          chatSocket.send({ type: "start", run_id: run.runId, request: run.request });
        }
        return;
      }
      case "run":
        if (run?.runId === msg.run_id) {
          run.acked = true;
          run.request = null;
        } else if (!run && msg.running && msg.run_id !== pendingStopRef.current) {
          attachRun(msg);
        }
        return;
      case "event":
        if (!run || run.runId !== msg.run_id || msg.seq <= run.seq) return;
        run.seq = msg.seq;
        handleEvent(run.turnId, msg.event, () => {
          run.mutated = true;
        });
        return;
      case "end":
        if (run?.runId === msg.run_id) finishRun(run, msg.reason);
        return;
      case "rejected":
        if (run?.runId === msg.run_id) {
          appendBlock(run.turnId, {
            kind: "text",
            text: t("chat.errorPrefix", { error: msg.error }),
          });
          finishRun(run, "rejected");
        }
        return;
    }
  };
  const onSocketMessageRef = useRef(onSocketMessage);
  onSocketMessageRef.current = onSocketMessage;

  // One chat socket per signed-in user. The resume point lets a reconnect
  // replay exactly the events this tab missed.
  useEffect(() => {
    chatSocket.setResumeProvider(() => {
      const run = liveRunRef.current;
      return run ? { run_id: run.runId, after_seq: run.seq } : null;
    });
    const unsubscribe = chatSocket.subscribe((m) => onSocketMessageRef.current(m));
    const release = chatSocket.acquire(_user.id);
    return () => {
      unsubscribe();
      release();
    };
  }, [_user.id]);

  // The desktop composer's input state. Shares its implementation with the mobile
  // coach bar via useChatComposer; here it routes straight to sendMessage.
  const composer = useChatComposer({
    onSend: ({ text, images }) => void sendMessage(text, images),
  });

  const updateTurn = (turnId: string, update: (t: Turn) => Turn) => {
    setTurns((turns) => turns.map((t) => (t.id === turnId ? update(t) : t)));
  };

  const appendBlock = (turnId: string, b: Block) => {
    flushPendingDelta();
    updateTurn(turnId, (t) => ({ ...t, blocks: [...t.blocks, b] }));
  };

  // Merge incoming citations into the turn's single sources block, de-duped by
  // URL, and keep it pinned to the end so it renders as a footer even when more
  // text or tool calls follow in a later iteration.
  const addSources = (turnId: string, incoming: Citation[]) => {
    if (incoming.length === 0) return;
    flushPendingDelta();
    updateTurn(turnId, (t) => ({ ...t, blocks: withSources(t.blocks, incoming) }));
  };

  const appendToLastText = (turnId: string, kind: "text" | "thinking", delta: string) => {
    updateTurn(turnId, (t) => {
      const lastIdx = t.blocks.length - 1;
      const last = t.blocks[lastIdx];
      if (last && last.kind === kind) {
        const merged: Block = {
          kind,
          text: (last as { text: string }).text + delta,
        };
        return { ...t, blocks: [...t.blocks.slice(0, lastIdx), merged] };
      }
      return { ...t, blocks: [...t.blocks, { kind, text: delta }] };
    });
  };

  const updateTool = (
    turnId: string,
    toolId: string,
    patch: Partial<Extract<Block, { kind: "tool" }>>,
  ) => {
    flushPendingDelta();
    updateTurn(turnId, (t) => ({
      ...t,
      blocks: t.blocks.map((b) => (b.kind === "tool" && b.id === toolId ? { ...b, ...patch } : b)),
    }));
  };

  // Replace the in-progress tool pill (kind: "tool") with a form card
  // (kind: "tool_form"). If no pill exists yet (defensive — provider should
  // have emitted tool_started first), append a new card.
  const upgradeToolToForm = (
    turnId: string,
    toolId: string,
    init: {
      toolName: string;
      label: string;
      category: ToolCategory;
      schema: JsonSchema | null;
      proposedInput: Record<string, unknown>;
    },
  ) => {
    flushPendingDelta();
    updateTurn(turnId, (t) => {
      const idx = t.blocks.findIndex(
        (b) => (b.kind === "tool" || b.kind === "tool_form") && b.id === toolId,
      );
      const formBlock: Block = {
        kind: "tool_form",
        id: toolId,
        toolName: init.toolName,
        label: init.label,
        category: init.category,
        schema: init.schema,
        proposedInput: init.proposedInput,
        status: "proposed",
      };
      if (idx === -1) {
        return { ...t, blocks: [...t.blocks, formBlock] };
      }
      const next = [...t.blocks];
      next[idx] = formBlock;
      return { ...t, blocks: next };
    });
  };

  // Update a form card's status after tool_finished or after a direct
  // POST. ok=true → saved, ok=false → canceled (the agent loop already
  // synthesizes a cancel result, so this is the most user-friendly framing).
  const finalizeToolForm = (turnId: string, toolId: string, ok: boolean) => {
    updateTurn(turnId, (t) => ({
      ...t,
      blocks: t.blocks.map((b) =>
        b.kind === "tool_form" && b.id === toolId ? { ...b, status: ok ? "saved" : "canceled" } : b,
      ),
    }));
  };

  // Fold a create-or-replace tool's returned identity (e.g. {recipe_id}) onto
  // its saved card, so reopening it edits that row instead of creating a dupe.
  const setToolFormIdentity = (toolId: string, identityPatch: Record<string, unknown>) => {
    setTurns((turns) =>
      turns.map((t) => ({
        ...t,
        blocks: t.blocks.map((b) =>
          b.kind === "tool_form" && b.id === toolId ? { ...b, identityPatch } : b,
        ),
      })),
    );
  };

  const setToolFormStatus = (toolId: string, status: ToolCardStatus, errorMessage?: string) => {
    setTurns((turns) =>
      turns.map((t) => ({
        ...t,
        blocks: t.blocks.map((b) =>
          b.kind === "tool_form" && b.id === toolId ? { ...b, status, errorMessage } : b,
        ),
      })),
    );
  };

  // First-time gate confirmation — resolves the server's awaiting promise.
  // If the gate is gone (404: turn timed out, server restarted, or the chat
  // was reopened from history after the live turn ended), the in-memory
  // confirmation no longer exists. Rather than stranding a rehydrated card on
  // a confusing error, fall back to executing the tool directly via /tools/run
  // — the same path edit-after-save uses. The entry still saves; only agent
  // follow-up (impossible on a dead turn) is lost.
  const onConfirmTool = useCallback(
    async (toolUseId: string, toolName: string, input: Record<string, unknown>) => {
      setToolFormStatus(toolUseId, "submitting");
      try {
        const res = await fetch(`/chat/tool/${toolUseId}/confirm`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input }),
        });
        if (res.status === 404) {
          // Gate expired/gone — run the tool and record its result against the
          // dangling tool_use so the card resolves to saved and can't be saved
          // twice on reload.
          const run = await fetch(`/chat/tool/${toolUseId}/resolve`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: toolName, input }),
          });
          if (!run.ok) {
            const msg = await run.text();
            setToolFormStatus(toolUseId, "error", msg || `HTTP ${run.status}`);
            return;
          }
          setToolFormStatus(toolUseId, "saved");
          // Same create→edit fold as the SSE path: capture the new row's id from
          // the resolve result so a resubmit updates that entry, not a dupe.
          try {
            const identity = getSavedIdentity(toolName, await run.clone().json());
            if (identity) setToolFormIdentity(toolUseId, identity);
          } catch {
            // Non-JSON result — nothing to fold; resubmit stays create-shaped.
          }
          if (MUTATING_TOOLS.has(toolName)) toastSuccess(toolCrudMessage(toolName));
          onTurnComplete?.();
          return;
        }
        if (!res.ok) {
          const msg = await res.text();
          setToolFormStatus(toolUseId, "error", msg || `HTTP ${res.status}`);
          return;
        }
        // tool_finished arrives via SSE and flips us to "saved" (and toasts).
      } catch (err) {
        setToolFormStatus(toolUseId, "error", err instanceof Error ? err.message : String(err));
      }
    },
    [onTurnComplete],
  );

  const onCancelTool = useCallback(async (toolUseId: string) => {
    setToolFormStatus(toolUseId, "submitting");
    try {
      await fetch(`/chat/tool/${toolUseId}/confirm`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ canceled: true }),
      });
      // Server resolves with canceled → agent loop emits tool_finished
      // with ok=false → finalizeToolForm transitions to "canceled".
    } catch (err) {
      setToolFormStatus(toolUseId, "error", err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Edit-after-save resubmit. Calls the tool's update_* counterpart (see
  // overrides.ts UPDATE_TOOL) directly without going through the agent —
  // the original turn is long since closed.
  const onUpdateTool = useCallback(
    async (toolUseId: string, toolName: string, input: Record<string, unknown>) => {
      setToolFormStatus(toolUseId, "submitting");
      try {
        const res = await fetch(`/tools/run`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: toolName, input }),
        });
        if (!res.ok) {
          const msg = await res.text();
          setToolFormStatus(toolUseId, "error", msg || `HTTP ${res.status}`);
          return;
        }
        setToolFormStatus(toolUseId, "saved");
        // Edit-after-save is always an update, so message it as one even when the
        // card's original tool was a create (e.g. a logged-meal card resubmits via
        // update_meal → "Meal updated", not "Meal logged").
        const updateName = getUpdateToolName(toolName) ?? toolName;
        if (MUTATING_TOOLS.has(updateName)) toastSuccess(toolCrudMessage(updateName));
        onTurnComplete?.();
      } catch (err) {
        setToolFormStatus(toolUseId, "error", err instanceof Error ? err.message : String(err));
      }
    },
    [onTurnComplete],
  );

  const notifyStream = () => {
    const s = streamBufRef.current;
    streamListenersRef.current.forEach((l) => l(s));
  };

  const flushPendingDelta = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const p = streamBufRef.current;
    if (!p) return;
    streamBufRef.current = null;
    appendToLastText(p.turnId, p.kind, p.text);
    notifyStream();
  };

  const queueDelta = (turnId: string, kind: "text" | "thinking", delta: string) => {
    const prev = streamBufRef.current;
    if (prev && prev.turnId === turnId && prev.kind === kind) {
      prev.text += delta;
    } else {
      flushPendingDelta();
      streamBufRef.current = { turnId, kind, text: delta };
    }
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        notifyStream();
      });
    }
  };

  const handleEvent = (turnId: string, payload: ChatStreamEvent, onMutatingTool: () => void) => {
    switch (payload.type) {
      case "thinking_delta":
        queueDelta(turnId, "thinking", payload.delta);
        break;
      case "text_delta":
        queueDelta(turnId, "text", payload.delta);
        // Docked (chat covered by a data screen): mirror the running reply into
        // a live coach toast, since the transcript is hidden.
        if (dockActiveRef.current) {
          dockTextRef.current += payload.delta;
          updateCoachToast(turnId, dockTextRef.current, openChatFromToast);
        }
        break;
      case "citations":
        addSources(turnId, payload.citations);
        break;
      case "tool_started":
        // Surface the running tool to the mobile dock (it can't see the
        // transcript pill from behind a data screen) — label + category so the
        // dock badge colours itself like the transcript pills.
        useChatBridge.getState().setActiveTool({
          label: payload.label,
          category: payload.category,
        });
        appendBlock(turnId, {
          kind: "tool",
          id: payload.tool_use_id,
          label: payload.label,
          category: payload.category,
        });
        break;
      case "tool_proposed":
        // Server has paused before executing a mutating tool. Replace the
        // pill we just added (or insert a new block if tool_started never
        // fired for some provider) with an editable form card.
        // Docked: the gate card lands in the hidden transcript, so raise a
        // distinct "tap to confirm" toast that opens the chat to complete it.
        if (dockActiveRef.current) {
          coachGateToast(turnId, payload.label, openChatFromToast);
        }
        upgradeToolToForm(turnId, payload.tool_use_id, {
          toolName: payload.name,
          label: payload.label,
          category: payload.category,
          schema: (payload.schema as JsonSchema | null) ?? null,
          proposedInput: payload.input ?? {},
        });
        break;
      case "tool_finished":
        // Tool done — drop the dock's tool label so it falls back to the
        // generic "<name> is …" streaming loader until the next tool or the
        // turn ends.
        useChatBridge.getState().setActiveTool(null);
        // Patch both representations — the tool pill (if it's still a pill)
        // and the form card (if it was upgraded). For form cards, ok=true
        // transitions to "saved"; ok=false to "canceled" or "error".
        updateTool(turnId, payload.tool_use_id, {
          ms: payload.ms,
          ok: payload.ok,
        });
        finalizeToolForm(turnId, payload.tool_use_id, payload.ok !== false);
        // Create-or-replace tools hand back the new row's id on first save; fold
        // it onto the card so any later resubmit updates that entry in place
        // rather than inserting a duplicate ("from create turn to edit").
        if (payload.ok !== false && payload.result !== undefined) {
          const identity = getSavedIdentity(payload.name, payload.result);
          if (identity) setToolFormIdentity(payload.tool_use_id, identity);
        }
        // Read/compute tools that finished successfully ship their structured
        // result inline — render it as a rich card below the tool pill. The card
        // component degrades to null if the data isn't card-able, so the agent's
        // text stays the fallback.
        if (payload.ok !== false && payload.result !== undefined && getResultCard(payload.name)) {
          appendBlock(turnId, {
            kind: "tool_result_card",
            id: payload.tool_use_id,
            toolName: payload.name,
            category: payload.category,
            data: payload.result,
          });
        }
        // Refresh the data screens after ANY tool that ran successfully —
        // not just the gated MUTATING_TOOLS. Several non-gated tools still
        // write (activate_diet_plan flips the active-plan pointer;
        // compute_targets with save_as_default rewrites the plan target), and
        // gating the refresh on a hand-maintained allowlist silently went
        // stale every time such a tool was added. invalidateQueries only
        // refetches mounted queries and keeps stale data on screen meanwhile,
        // so a redundant refetch after a pure-read tool is cheap and flash-free.
        if (payload.ok !== false) {
          onMutatingTool();
        }
        // Toast the writes the agent makes on its own (and user-confirmed gate
        // writes, which also resolve into a tool_finished here) so chat-driven
        // CRUD surfaces the same top-center confirmation as data-screen edits.
        // Only successful mutating tools — reads/computes and cancels stay quiet.
        if (payload.ok !== false && CHAT_TOAST_TOOLS.has(payload.name)) {
          toastSuccess(toolCrudMessage(payload.name));
        }
        if (payload.ok !== false && FORM_CONTEXT_TOOLS.has(payload.name)) {
          invalidateFormContext();
        }
        break;
      case "view_date_hint":
        if (typeof payload.date === "string") onAgentViewDate?.(payload.date);
        break;
      case "show_screen":
        if (typeof payload.screen === "string")
          onShowScreen?.(payload.screen, typeof payload.tab === "string" ? payload.tab : undefined);
        break;
      case "error":
        appendBlock(turnId, {
          kind: "text",
          text: `\n[error] ${payload.message}`,
        });
        break;
    }
  };

  // Expose an imperative handle to this (always-mounted) Chat so the App-level
  // dock and thinking/reset drawer can drive it from over the data screens.
  // send/reset are fresh closures each render; register stable wrappers once and
  // read the latest via refs.
  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;
  const resetRef = useRef(reset);
  resetRef.current = reset;
  const stopRef = useRef(stopReply);
  stopRef.current = stopReply;
  useEffect(() => {
    useChatBridge.getState().register({
      send: (text, images) => void sendRef.current(text, images ?? []),
      stop: () => stopRef.current(),
      reset: () => resetRef.current(),
      openChat: () => onOpenChatRef.current?.(),
    });
    return () => useChatBridge.getState().clear();
  }, []);
  useEffect(() => {
    useChatBridge.getState().setBusy(busy);
  }, [busy]);

  // Lets a day-scoped result card (macros / hydration / body comp) jump to the
  // day it reports on. Always retargets the shared selected date; on desktop it
  // also navigates the (already-visible) data screen to that day, reusing the
  // same handlers the agent's view_date_hint / show_screen events drive. On
  // mobile we deliberately skip the screen jump: there the data panel only
  // exists in the slide-out drawer, so navigating would yank the user out of
  // the chat — when they tap a card's day chip they just want to retarget it.
  const cardNav = useMemo<CardNav>(
    () => ({
      navigateToDate: (iso: string, screen: View, tab?: string) => {
        onSelectDate?.(iso);
        if (window.matchMedia("(min-width: 768px)").matches) onShowScreen?.(screen, tab);
      },
    }),
    [onSelectDate, onShowScreen],
  );

  return (
    <CardNavContext.Provider value={cardNav}>
      <div className="relative flex h-full min-h-0 flex-col bg-background">
        {/* Header — desktop only. On mobile the same controls live in the
          right-edge slide-out drawer below, freeing vertical space. */}
        <div className="relative hidden items-center justify-between gap-2 border-b px-3 py-2 sm:flex sm:px-4">
          <strong className="text-sm">{t("chat.title")}</strong>
          {/* Day context — centered in the header between the title and the
            thinking/reset controls. Reminds the user which day their messages
            log to (the agent's context_date follows the selected day) and, on
            click, opens a calendar to change it. md+ only: below md the same
            badge lives next to the brand name in the app header (see App.tsx)
            to reclaim chat space. */}
          {selectedDateIso && (
            <DayContextBadge
              selectedDateIso={selectedDateIso}
              onSelectDate={onSelectDate}
              size="md"
              className="absolute top-1/2 left-1/2 z-10 hidden -translate-1/2 md:block"
            />
          )}
          <div className="flex items-center gap-1">
            <Button
              variant={thinking ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setThinking(!thinking)}
              title={thinking ? t("chat.thinking.onTitle") : t("chat.thinking.offTitle")}
              className="gap-1.5 text-xs"
            >
              <Brain className={`size-3.5 ${+thinking && "animate-spin"}`} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setResetOpen(true)}
              aria-label={t("chat.resetConversation")}
            >
              <RotateCcw className="size-4" />
            </Button>
          </div>
        </div>

        {/* Mobile thinking/reset drawer (also floated over the data screens by
          App — same component, driven by the store + chat bridge). */}
        <ChatOptionsDrawer />

        <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("chat.resetDialog.title")}</AlertDialogTitle>
              <AlertDialogDescription>{t("chat.resetDialog.description")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={reset}>{t("chat.reset")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* Older-history loader — overlays the top of the scroll area while a
            page is fetched, so it never shifts the message layout (keeps the
            scroll-position restore exact). */}
          {loadingMore && (
            <div
              className="absolute top-8 left-1/2 z-10 flex size-11 -translate-x-1/2 items-center justify-center rounded-full bg-background shadow-[0_0_18px_color-mix(in_srgb,var(--primary)_60%,transparent)]"
              aria-label={t("chat.loadingOlder")}
              role="status"
            >
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          )}
          <div
            ref={logRef}
            // Extra bottom scroll room on mobile so the last messages can scroll
            // clear of the always-present coach bar — and a larger pad while its
            // input is open so they separate from (and clear) the opened overlay.
            // Desktop keeps tight padding — its composer sits inline.
            className={cn(
              "flex-1 space-y-3 overflow-x-hidden overflow-y-auto p-3 sm:px-4 md:pb-3",
              dockOpen ? "pb-12" : "pb-12",
            )}
          >
            {showHistoryLoader && turns.length === 0 ? (
              <ChatSkeleton />
            ) : (
              turns.map((t, i) => (
                <TurnView
                  key={t.id}
                  turn={t}
                  busy={busy}
                  isLast={i === turns.length - 1}
                  onConfirmTool={onConfirmTool}
                  onCancelTool={onCancelTool}
                  onUpdateTool={onUpdateTool}
                  registerStreamListener={registerStreamListener}
                  onStreamGrow={followIfPinned}
                />
              ))
            )}
          </div>

          {/* Jump-to-latest — shown only when the user has scrolled up off the
            bottom (follow-lock released). Tapping re-pins and follows again. */}
          {!atBottom && (
            <Button
              type="button"
              size="sm"
              onClick={() => scrollToBottom("smooth")}
              aria-label={t("chat.scrollToLatestAria")}
              className="scroll-latest-pill group absolute bottom-12 left-1/2 z-10 h-7 -translate-x-1/2 cursor-pointer gap-1 overflow-hidden rounded-full border border-primary bg-background px-3 text-xs text-foreground shadow-[0_0_14px_color-mix(in_srgb,var(--background)_55%,transparent)] hover:bg-background"
            >
              <span className="scroll-arrow-window">
                <span className="scroll-arrow-reel">
                  <ChevronDown className="size-3.5" />
                  <ChevronDown className="size-3.5" />
                  <ChevronDown className="size-3.5" />
                  <ChevronDown className="size-3.5" />
                </span>
              </span>
              {t("chat.scrollToLatest")}
            </Button>
          )}
        </div>

        {/* Desktop composer only — on mobile the coach bar (ChatDock) is the
            single input. Both are the same <ChatComposer> driven by
            useChatComposer, so they share every capability. */}
        <div className="hidden md:block" data-tour="composer">
          <ChatComposer composer={composer} variant="panel" />
        </div>
      </div>
    </CardNavContext.Provider>
  );
}

function ChatSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex justify-start">
        <Skeleton className="h-16 w-[70%] rounded-2xl rounded-ss-sm" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-[55%] rounded-2xl rounded-se-sm" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-20 w-[78%] rounded-2xl rounded-ss-sm" />
      </div>
    </div>
  );
}
