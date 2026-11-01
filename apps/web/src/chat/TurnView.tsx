// Chat transcript rendering: a turn's text, tool pills, activity groups, sources and the streaming loader.
import { Badge } from "@/components/ui/badge";
import { Collapsible } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Brain, ChevronRight, CircleSlash, Image as ImageIcon, Link2, Wrench } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { BroAvatar, UserAvatar } from "../avatars";
import { getResultCard } from "../cards/resultCards";
import { extractUrls, LinkifiedText, LinkPreviewCard } from "../components/LinkPreviewCard";
import { ReplyingLoader } from "../components/ReplyingLoader";
import { ToolFormCard } from "../forms/ToolFormCard";
import { brand } from "../lib/brand";
import { CATEGORY_META } from "../lib/toolCategory";
import { stripThinkingTags } from "./messages";
import type { Block, Citation, StreamListener, StreamState, Turn } from "./types";

type ToolBlock = Extract<Block, { kind: "tool" }>;

// One step of the assistant's "work" — a chunk of thinking or a tool call.
// Interleaved thinking + tool blocks fold into a single activity group so the
// whole reason→act→reason→act cycle reads as one collapsible unit.
type ActivityItem = { kind: "thinking"; text: string } | { kind: "tool"; tool: ToolBlock };

// Consecutive thinking + tool blocks are folded into one collapsible activity
// group so the bubble stays compact and a tool call stays visually tied to the
// reasoning that produced it. Other blocks (text, images, tool_form gate
// cards) render standalone — the gate card must stay visible because it's
// awaiting user input. `start` is the index of the group's first block, used
// as a stable render key while blocks append.
type BlockGroup =
  | { kind: "single"; start: number; block: Block }
  | { kind: "activity-group"; start: number; items: ActivityItem[] };

function groupBlocks(blocks: Block[]): BlockGroup[] {
  const out: BlockGroup[] = [];
  blocks.forEach((b, i) => {
    const last = out[out.length - 1];
    if (b.kind === "thinking" || b.kind === "tool") {
      const item: ActivityItem =
        b.kind === "thinking" ? { kind: "thinking", text: b.text } : { kind: "tool", tool: b };
      if (last?.kind === "activity-group") last.items.push(item);
      else out.push({ kind: "activity-group", start: i, items: [item] });
    } else {
      out.push({ kind: "single", start: i, block: b });
    }
  });
  return out;
}

// Render an activity group's interleaved items in order: each thinking chunk
// as a dim line, and runs of consecutive tool pills wrapped together.
function renderActivityItems(items: ActivityItem[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let toolRun: ToolBlock[] = [];
  const flushTools = (key: string | number) => {
    if (!toolRun.length) return;
    const run = toolRun;
    toolRun = [];
    out.push(
      <div key={`tools-${key}`} className="flex flex-wrap gap-1">
        {run.map((t) => (
          <ToolPill key={t.id} tool={t} />
        ))}
      </div>,
    );
  };
  items.forEach((it, i) => {
    if (it.kind === "tool") {
      toolRun.push(it.tool);
    } else {
      flushTools(i);
      out.push(
        <div key={`think-${i}`} className="thinking-dim text-xs">
          {it.text}
        </div>,
      );
    }
  });
  flushTools("end");
  return out;
}

// How long a group lingers open after streaming finishes before it auto-
// collapses, so the user catches the final state before it tucks away.
const COLLAPSE_LINGER_MS = 900;

// Live elapsed-seconds counter that accumulates only *active* time. The clock
// runs while `running` is true and freezes when it flips false; if it later
// resumes (e.g. after a gate card is confirmed) it continues from where it
// paused rather than counting the idle wait. Returns null until the first run
// begins, so history-loaded groups (which never run) render no timer at all.
function useElapsed(running: boolean): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  const baseRef = useRef(0); // seconds banked from earlier active stretches
  useEffect(() => {
    if (!running) return;
    startRef.current = Date.now();
    const tick = () =>
      setElapsed(baseRef.current + (Date.now() - (startRef.current ?? Date.now())) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => {
      clearInterval(id);
      // Bank this stretch so a later resume picks up where we left off.
      baseRef.current += (Date.now() - (startRef.current ?? Date.now())) / 1000;
      startRef.current = null;
    };
  }, [running]);
  return elapsed;
}

// Inline "3.4s" timer for thinking / tool activity headers. Counts up while
// `running`, then holds the final duration once work stops. Sub-10s shows a
// decimal so it visibly ticks; past that, whole seconds keep it calm.
function ElapsedTimer({ running }: { running: boolean }) {
  const elapsed = useElapsed(running);
  if (elapsed == null) return null;
  const label = elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed);
  return <span className="tabular-nums opacity-70">{label}s</span>;
}

// Disclosure section for thinking / tool groups. Forced open while
// `streaming` is true; when streaming flips off it lingers briefly then
// collapses, after which the user can toggle it freely.
function CollapsibleGroup({
  streaming,
  header,
  children,
}: {
  streaming: boolean;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(streaming);
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    if (prevStreaming.current === streaming) return;
    const wasStreaming = prevStreaming.current;
    prevStreaming.current = streaming;
    if (streaming) {
      setOpen(true);
    } else if (wasStreaming) {
      // Closing *from* streaming: hold the finished state on screen for a
      // beat, then collapse. (A clean mount in the finished state never
      // entered this branch, so it stays collapsed with no delay.)
      const t = setTimeout(() => setOpen(false), COLLAPSE_LINGER_MS);
      return () => clearTimeout(t);
    }
  }, [streaming]);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        {header}
      </button>
      <Collapsible open={open}>
        {/* Margin/border live inside the clipped region so they collapse
            away with the content instead of leaving a stray gap. */}
        <div className="mt-1 space-y-1 border-s border-border/60 ps-3">{children}</div>
      </Collapsible>
    </div>
  );
}

function ThinkingGroupHeader({ streaming }: { streaming: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1">
      <Brain className="size-3" aria-hidden />
      {streaming ? t("chat.activity.thinking") : t("chat.activity.thoughtProcess")}
      <ElapsedTimer running={streaming} />
    </span>
  );
}

function ToolPill({ tool }: { tool: ToolBlock }) {
  const isFail = tool.ok === false;
  const isDone = tool.ms != null || tool.ok != null;
  const meta = CATEGORY_META[tool.category];
  const Icon = meta.Icon;
  const mark = isFail ? "✗" : isDone ? "✓" : "…";
  const ms = tool.ms != null ? ` (${tool.ms}ms)` : "";
  // Failures override the category tint with destructive red so errors stay
  // unmistakable; otherwise the chip is colored by its tool category.
  return (
    <Badge
      variant={isFail ? "destructive" : "outline"}
      className={cn("gap-1 font-normal", !isFail && meta.badgeClass)}
      title={`${meta.label} · ${tool.label}`}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span>
        {tool.label}
        {ms}
      </span>
      <span aria-hidden>{mark}</span>
    </Badge>
  );
}

export const TurnView = memo(function TurnView({
  turn,
  busy,
  isLast,
  onConfirmTool,
  onCancelTool,
  onUpdateTool,
  registerStreamListener,
  onStreamGrow,
}: {
  turn: Turn;
  busy: boolean;
  isLast: boolean;
  onConfirmTool: (
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => void | Promise<void>;
  onCancelTool: (toolUseId: string) => void | Promise<void>;
  onUpdateTool: (
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => void | Promise<void>;
  registerStreamListener: (cb: StreamListener) => () => void;
  onStreamGrow: () => void;
}) {
  const { t } = useTranslation();
  const isBro = turn.who === "assistant";
  // A proposed (un-confirmed) gate card pauses the turn on the user — the
  // stream stays open with busy=true while we wait, so the work timer must
  // freeze until the user acts instead of timing their decision.
  const awaitingInput = turn.blocks.some((b) => b.kind === "tool_form" && b.status === "proposed");
  // Result/form cards are self-contained widgets that should fill the bubble's
  // full available width rather than shrink-wrap to their content — otherwise a
  // card's narrowest row dictates the bubble width and the card looks cramped.
  // When the turn carries one, stretch the column + bubble to their max-w cap.
  const hasWideCard = turn.blocks.some(
    (b) => b.kind === "tool_result_card" || b.kind === "tool_form",
  );
  return (
    <div className={cn("flex w-full", isBro ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "flex max-w-full min-w-0 flex-col gap-1 sm:max-w-[80%]",
          hasWideCard && "w-full",
          isBro ? "items-start" : "items-end",
        )}
      >
        <div
          className={cn(
            "max-w-full min-w-0 rounded-2xl border px-3 py-2 text-sm shadow-control",
            hasWideCard && "w-full",
            isBro
              ? "rounded-ss-sm bg-card text-card-foreground"
              : "rounded-se-sm border-primary/40 bg-primary text-primary-foreground",
          )}
        >
          <div
            className={cn(
              "mb-1.5 flex items-center gap-1.5 border-b pb-1.5 text-xs",
              isBro
                ? "border-border text-muted-foreground"
                : "flex-row-reverse border-primary-foreground/20 text-primary-foreground/80",
            )}
          >
            <span aria-hidden className="inline-flex shrink-0">
              {isBro ? <BroAvatar size={28} /> : <UserAvatar size={28} />}
            </span>
            <span className="font-semibold tracking-wide">
              {isBro ? brand.agentName : t("chat.user")}
            </span>
          </div>
          <div className="min-w-0 space-y-1.5">
            {groupBlocks(turn.blocks).map((g, gi, groups) => {
              if (g.kind === "activity-group") {
                const tools = g.items
                  .filter((it) => it.kind === "tool")
                  .map((it) => (it as { tool: ToolBlock }).tool);
                // A pill with neither ms nor ok is still executing. Also keep
                // the group open for the whole in-flight turn (busy && isLast)
                // so it doesn't flicker shut between tool calls — it collapses,
                // after a short linger, only once the turn finishes.
                const running = tools.some((t) => t.ms == null && t.ok == null);
                const turnActive = busy && isLast;
                // This group is still being produced only while it's the last
                // thing in the turn. Once anything appends after it (a gate
                // card, the final text, or the next activity group) it's done,
                // so its clock must freeze rather than resume when the turn
                // streams again — a turn can hold several groups.
                const isTail = gi === groups.length - 1;
                const hasThinking = g.items.some((it) => it.kind === "thinking");
                const n = tools.length;
                const doneLabel =
                  hasThinking && n
                    ? t("chat.activity.thoughtWithTools", { count: n })
                    : n
                      ? t("chat.activity.usedTools", { count: n })
                      : t("chat.activity.thoughtProcess");
                return (
                  <CollapsibleGroup
                    key={`g-${g.start}`}
                    streaming={running || turnActive}
                    header={
                      <span className="inline-flex items-center gap-1">
                        {hasThinking ? (
                          <Brain className="size-3" aria-hidden />
                        ) : (
                          <Wrench className="size-3" aria-hidden />
                        )}
                        {running || turnActive ? t("chat.activity.working") : doneLabel}
                        {/* Tie the clock to the turn being in flight, not to
                            per-tool ms/ok state: a turn that errors or is
                            stopped mid-tool leaves a pill un-finalized, which
                            would otherwise keep `running` true and tick
                            forever. turnActive freezes when busy clears; isTail
                            keeps only the group still being produced ticking
                            (earlier groups stay frozen when the turn resumes);
                            awaitingInput pauses it on a pending gate card. */}
                        <ElapsedTimer running={turnActive && isTail && !awaitingInput} />
                      </span>
                    }
                  >
                    {renderActivityItems(g.items)}
                  </CollapsibleGroup>
                );
              }
              const b = g.block;
              const j = g.start;
              if (b.kind === "text") {
                if (turn.who === "you") {
                  // Render any pasted URLs as rich link-preview cards under the
                  // message text (capped so a link-dump doesn't flood the
                  // bubble). Cards lazily fetch OG metadata and self-hide when
                  // none is available, so the plain link in the text remains.
                  const urls = extractUrls(b.text).slice(0, 3);
                  return (
                    <div key={j} className="flex flex-col gap-1">
                      <LinkifiedText text={b.text} />
                      {urls.map((u) => (
                        <LinkPreviewCard key={u} url={u} onSurface />
                      ))}
                    </div>
                  );
                }
                const cleaned = stripThinkingTags(b.text);
                if (!cleaned) return null;
                return (
                  <div key={j} className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
                  </div>
                );
              }
              if (b.kind === "image") {
                return (
                  <img
                    key={j}
                    className="my-1 block max-h-60 max-w-full rounded-md border object-contain"
                    src={b.src}
                    alt={t("chat.attachedImageAlt")}
                    loading="lazy"
                  />
                );
              }
              if (b.kind === "image_note") {
                return (
                  <div
                    key={j}
                    className="my-1 flex items-start gap-1.5 rounded-md border border-primary-foreground/25 bg-primary-foreground/10 px-2 py-1.5 text-xs"
                  >
                    <ImageIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="italic opacity-80">{t("chat.imageUnavailable")}</span>
                      {b.description && <span className="opacity-95">{b.description}</span>}
                    </div>
                  </div>
                );
              }
              if (b.kind === "tool_result_card") {
                const Card = getResultCard(b.toolName);
                if (!Card) return null;
                return (
                  <div key={j} className="text-foreground">
                    <Card data={b.data} category={b.category} />
                  </div>
                );
              }
              if (b.kind === "tool_form") {
                return (
                  <div key={j} className="my-1 text-foreground">
                    <ToolFormCard
                      toolUseId={b.id}
                      toolName={b.toolName}
                      label={b.label}
                      category={b.category}
                      schema={b.schema}
                      proposedInput={b.proposedInput}
                      identityPatch={b.identityPatch}
                      state={{ status: b.status, errorMessage: b.errorMessage }}
                      onConfirm={(input) => onConfirmTool(b.id, b.toolName, input)}
                      onCancel={() => onCancelTool(b.id)}
                      onUpdate={(input) => onUpdateTool(b.id, b.toolName, input)}
                    />
                  </div>
                );
              }
              if (b.kind === "sources") {
                return <SourcesBlock key={j} items={b.items} />;
              }
              return null;
            })}
            {isBro && (
              <StreamingBlock
                turnId={turn.id}
                showLoaderWhenIdle={busy && isLast}
                registerStreamListener={registerStreamListener}
                onGrow={onStreamGrow}
              />
            )}
            {isBro && turn.interrupted && (
              <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <CircleSlash aria-hidden className="size-3" />
                <span>{t("chat.stopped")}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// "Sources" footer under an assistant turn — the numbered, clickable web-search
// citations the model grounded its answer in. Entries without a URL (rare) fall
// back to plain text so nothing silently vanishes.
function SourcesBlock({ items }: { items: Citation[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const label = (c: Citation) =>
    c.title || hostOf(c.url) || c.url || c.citedText || t("chat.sourceFallback");
  return (
    <div className="mt-2 border-t border-primary-foreground/15 pt-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium opacity-70">
        <Link2 aria-hidden className="size-3.5" />
        <span>{t("chat.sources")}</span>
      </div>
      <ol className="flex flex-col gap-1">
        {items.map((c, i) => (
          <li key={i} className="flex gap-1.5 text-xs">
            <span className="tabular-nums opacity-50">{i + 1}.</span>
            {c.url ? (
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                title={c.citedText || c.url}
                className="min-w-0 truncate underline decoration-primary-foreground/30 underline-offset-2 hover:decoration-primary-foreground"
              >
                {label(c)}
              </a>
            ) : (
              <span className="min-w-0 truncate opacity-80" title={c.citedText}>
                {label(c)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// Bare hostname for a citation URL (e.g. "pubmed.ncbi.nlm.nih.gov"), used as a
// label fallback when a source has no title. Returns "" on an unparseable URL.
function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Animated "<agent> is …" placeholder shown inside the assistant bubble before
// any text / thinking / tool block arrives. Disappears on the first delta.
function JimLoader() {
  return <ReplyingLoader className="flex text-sm" />;
}

// Subscribes to the parent's stream buffer and renders the in-flight text /
// thinking for whichever turn is currently streaming. Mounted once per
// assistant TurnView — non-matching turns receive notifications but skip
// the state update, so only the active streaming turn re-renders.
const StreamingBlock = memo(function StreamingBlock({
  turnId,
  showLoaderWhenIdle,
  registerStreamListener,
  onGrow,
}: {
  turnId: string;
  showLoaderWhenIdle: boolean;
  registerStreamListener: (cb: StreamListener) => () => void;
  onGrow: () => void;
}) {
  const [state, setState] = useState<StreamState | null>(null);
  useEffect(() => {
    return registerStreamListener((s) => {
      if (s && s.turnId === turnId) {
        setState({ ...s });
      } else {
        setState((prev) => (prev === null ? prev : null));
      }
    });
  }, [turnId, registerStreamListener]);

  // Keep the log pinned to the bottom while deltas stream in. The committed
  // `turns` scroll effect in Chat doesn't fire for these — the stream buffer
  // bypasses `turns` by design — so the growth has to trigger it from here,
  // after the new text is in the DOM.
  useEffect(() => {
    if (state) onGrow();
  }, [state, onGrow]);

  // No active stream buffer for this turn — either we're waiting on the first
  // token, or the stream stalled mid-turn (e.g. between tool calls, after the
  // last text chunk committed to `turns`). While the turn is still in flight
  // show the animated "Jim is …" typewriter so the bubble never sits silent;
  // it's replaced by real content the moment the next delta arrives.
  if (!state) return showLoaderWhenIdle ? <JimLoader /> : null;
  if (state.kind === "thinking") {
    // Open while the thinking deltas stream in; when the buffer commits this
    // block unmounts and the text re-renders as a collapsed thinking group.
    return (
      <CollapsibleGroup streaming header={<ThinkingGroupHeader streaming />}>
        <div className="thinking-dim text-xs">{state.text}</div>
      </CollapsibleGroup>
    );
  }
  const cleaned = stripThinkingTags(state.text);
  if (!cleaned) return null;
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleaned}</ReactMarkdown>
    </div>
  );
});
