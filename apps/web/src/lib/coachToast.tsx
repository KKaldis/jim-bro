// Coach toasts — the second, visually-distinct class of toast that shares the
// one top-center Sonner stack with the CRUD notifications (lib/toast.ts).
//
// When the user talks to the coach from a data screen (via the mobile chat
// dock), the reply transcript is hidden behind the data overlay, so we mirror it
// here: a live-updating chat-bubble toast that fills in as the reply streams,
// then auto-dismisses shortly after the turn ends. A separate "needs your
// confirmation" variant is raised when the agent proposes a gate, since those
// cards can only be completed on the full chat screen.
//
// Styling deliberately reuses the assistant bubble look (avatar + rounded
// bubble) so a coach toast reads as a message, not a CRUD confirmation. Both
// classes coexist in the same stack, so Sonner spaces them and they never
// overlap.
import { toast } from "sonner";
import { MessageSquareText, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BroAvatar } from "../avatars.tsx";
import { brand } from "./brand";
import { cn } from "./utils";
import i18n from "../i18n";

// How long a finished reply lingers before auto-dismiss. Streaming replies and
// gate prompts stay up (duration Infinity) until they finish / the user acts.
const FINISHED_DURATION_MS = 6000;

const replyId = (turnId: string) => `coach:${turnId}`;
const gateId = (turnId: string) => `coach-gate:${turnId}`;

type ReplyState = {
  text: string;
  onOpenChat: () => void;
};

// Latest reply text + callback per active turn, so finishCoachToast can
// re-render the same toast (streaming → done) without the caller re-threading
// the accumulated text.
const replies = new Map<string, ReplyState>();
// Turns the user dismissed while still streaming — later deltas must NOT
// re-create the toast they just swiped away.
const dismissed = new Set<string>();

// Dismiss a reply toast and remember it, so in-flight updates stop reviving it.
function dismissReply(turnId: string): void {
  dismissed.add(turnId);
  replies.delete(turnId);
  toast.dismiss(replyId(turnId));
}

function CoachBubble({
  turnId,
  text,
  onOpenChat,
}: {
  turnId: string;
  text: string;
  onOpenChat: () => void;
}) {
  return (
    <div className="pointer-events-auto flex w-full items-start gap-2">
      <div
        className={cn(
          "relative min-w-0 flex-1 rounded-2xl rounded-ss-sm border border-primary bg-popover px-3 py-2 text-sm text-popover-foreground shadow-overlay",
        )}
      >
        {/* Close button, inside the bubble (top-right). */}
        <button
          type="button"
          onClick={() => dismissReply(turnId)}
          aria-label={i18n.t("common.close")}
          className="absolute inset-e-1 top-1 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
        <div className="mb-0.5 flex items-center gap-1.5 pe-6">
          <BroAvatar size={32} className="shrink-0" />
          <span className="text-xs font-semibold text-primary">{brand.agentName}</span>
        </div>
        {/* Answer text only — the model's thinking is never mirrored here, and we
            deliberately show no "typing/thinking" placeholder while it streams.
            Rendered as markdown (same pipeline as the full chat bubble). We cap
            the height instead of line-clamping since markdown emits block
            children that -webkit-line-clamp can't clamp reliably. */}
        <div className="md max-h-40 overflow-hidden wrap-break-word">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
        <button
          type="button"
          onClick={() => {
            onOpenChat();
            dismissReply(turnId);
          }}
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          <MessageSquareText className="size-3.5" />
          {i18n.t("chat.dock.openChat")}
        </button>
      </div>
    </div>
  );
}

function GateBubble({
  toastId,
  label,
  onOpenChat,
}: {
  toastId: string | number;
  label: string;
  onOpenChat: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onOpenChat();
        toast.dismiss(toastId);
      }}
      className="pointer-events-auto flex w-full max-w-88 items-center gap-2 rounded-2xl border border-warning bg-popover px-3 py-2 text-start shadow-overlay"
    >
      <BroAvatar size={32} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-warning">
          {i18n.t("chat.dock.gateTitle", { name: brand.agentName })}
        </div>
        <div className="truncate text-sm text-popover-foreground">{label}</div>
        <div className="text-xs text-primary">{i18n.t("chat.dock.gateAction")}</div>
      </div>
    </button>
  );
}

// Create-or-update the streaming reply toast for a turn. Called on every text
// delta (lazy create on the first one) with the full accumulated text. Skipped
// once the user has swiped this turn's toast away.
export function updateCoachToast(turnId: string, text: string, onOpenChat: () => void): void {
  if (dismissed.has(turnId)) return;
  replies.set(turnId, { text, onOpenChat });
  toast.custom(() => <CoachBubble turnId={turnId} text={text} onOpenChat={onOpenChat} />, {
    id: replyId(turnId),
    duration: Infinity,
  });
}

// The turn ended: re-render without the streaming indicator and let it
// auto-dismiss. No-op if this turn never produced text (e.g. a gate-only turn)
// or the user already dismissed it.
export function finishCoachToast(turnId: string): void {
  dismissed.delete(turnId);
  const state = replies.get(turnId);
  if (!state) return;
  replies.delete(turnId);
  toast.custom(
    () => <CoachBubble turnId={turnId} text={state.text} onOpenChat={state.onOpenChat} />,
    { id: replyId(turnId), duration: FINISHED_DURATION_MS },
  );
}

// Raise the distinct "confirm to continue" toast for a proposed gate. Stays up
// until tapped (opens chat) or dismissed.
export function coachGateToast(turnId: string, label: string, onOpenChat: () => void): void {
  toast.custom((id) => <GateBubble toastId={id} label={label} onOpenChat={onOpenChat} />, {
    id: gateId(turnId),
    duration: Infinity,
  });
}
