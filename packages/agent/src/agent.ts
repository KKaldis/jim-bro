/**
 * Multi-turn tool-use loop, provider-agnostic.
 *
 * Wire-level streaming, conversion, and rate-limiting live behind the
 * `LLMProvider` interface (see providers/). The agent loop here owns:
 *   - per-user conversation persistence (loaded at the start of each chat()
 *     call, saved at the end)
 *   - tool-use loop (model → executeTool → tool_result → model)
 *   - normalized StreamEvents for frontends
 *   - tool-group routing (progressive disclosure to keep the prompt cache hot)
 *   - the view_date_hint UX wire-up
 *   - usage ledger writes
 *
 * Canonical conversation format is our neutral `Fa*` schema (preserved across
 * provider switches; see schema/ and providers/types.ts for rationale).
 */
import { logger } from "@fa/logger";

import { SYSTEM_PROMPT } from "./prompts.ts";
import { getFastProvider, getProvider, type LLMProvider } from "./providers/index.ts";
import type {
  FaBlock,
  FaCitation,
  FaImageBlock,
  FaMessage,
  FaSystemBlock,
  FaTextBlock,
  FaToolCallBlock,
  FaToolDef,
  FaToolResultBlock,
} from "./schema/index.ts";
import { recordUsage } from "./usage.ts";
import { UserStorage } from "./storage.ts";
import { visionComplete } from "./vision.ts";
import {
  APP_SCREENS,
  SCREEN_TABS,
  buildStateTag,
  executeTool,
  getToolCategory,
  getToolLabel,
  getToolSchema,
  hasResultCard,
  isMutatingTool,
  modelFacingToolResult,
  prepareToolInput,
  DUPLICATE_READ_PREFIX,
  REQUESTABLE_GROUPS,
  SERVER_TOOLS,
  TOOL_GROUPS,
  toolsForGroups,
  type AppScreen,
  type ToolCategory,
  type ToolGroup,
} from "./tools.ts";

const log = logger.child({ pkg: "agent" });

const MAX_TOKENS = 16_000;
const MAX_ITERATIONS = 10;

// Create-or-replace mutations whose result carries the new row's id (recipe /
// diet plan). The gate card needs that id echoed back on tool_finished so a
// resubmit updates the row it just created instead of inserting a duplicate —
// these aren't carded, so they'd otherwise ship no structured result. Kept in
// sync with the client's SAVED_IDENTITY extractor (apps/web forms/overrides).
const SAVE_IDENTITY_TOOLS: ReadonlySet<string> = new Set(["save_recipe", "save_diet_plan"]);

// The system block is stable across requests so it can be prompt-cached.
// Anthropic honors the `cache` hint as a cache breakpoint (and ignores it
// elsewhere); other providers ignore the field entirely. Built once so the
// same object (and cache key) is reused.
const SYSTEM_BLOCKS: FaSystemBlock[] = [{ text: SYSTEM_PROMPT, cache: true }];

// UUID v4 generated from Math.random — fine for grouping ledger rows
// (we don't rely on it being unguessable). Avoids depending on
// crypto.randomUUID's runtime availability (see logger/http.ts).
function newChatId(): string {
  const hex = (n: number, len: number) =>
    Math.floor(Math.random() * n)
      .toString(16)
      .padStart(len, "0");
  const r = (len: number) => hex(16 ** len, len);
  // Set version (4) and variant (8/9/a/b) bits per RFC 4122.
  const v = (8 + Math.floor(Math.random() * 4)).toString(16); // 8|9|a|b
  return `${r(8)}-${r(4)}-4${r(3)}-${v}${r(3)}-${r(12)}`;
}

export type UserMessage = string | Array<FaTextBlock | FaImageBlock>;

export type ChatUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests?: number;
};

export type ChatResult = {
  assistant: string;
  iterations: number;
  stop_reason: string;
  usage: ChatUsage;
  provider: string;
  model: string;
};

// Streamed event channel. Frontends render text_delta/thinking_delta in real
// time, surface tool_started/finished as status pills, and treat `done` as
// the terminal event.
export type StreamEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "thinking_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  // Sources the model grounded this turn in — collected from the citations
  // Anthropic attaches to text blocks (web_search). Text streams live via
  // text_delta; citations only exist on the final content, so they arrive as a
  // separate event once an iteration completes. The UI renders a "Sources"
  // footer. `ref` (round-trip token) is dropped — the UI never needs it.
  | { type: "citations"; citations: Array<Omit<FaCitation, "ref">> }
  | {
      type: "tool_started";
      name: string;
      tool_use_id: string;
      label: string;
      category: ToolCategory;
    }
  | {
      type: "tool_finished";
      name: string;
      tool_use_id: string;
      ms: number;
      ok: boolean;
      category: ToolCategory;
      // The tool's structured result, attached only for tools that have a chat
      // result card (hasResultCard) and only on success. Lets the UI render the
      // calorie ring / macro bars / metric gauges live instead of waiting for the
      // model to describe the numbers. Omitted for everything else.
      result?: unknown;
    }
  // Pre-execution gate: emitted for every MUTATING tool the model wants to
  // call. The UI renders an editable form populated with `input`; the user
  // confirms (optionally with edits) or cancels. The agent then resumes with
  // the user's final input. Non-mutating tools skip this and run immediately.
  | {
      type: "tool_proposed";
      name: string;
      tool_use_id: string;
      label: string;
      input: Record<string, unknown>;
      schema: unknown;
      category: ToolCategory;
    }
  | { type: "iteration_usage"; usage: Partial<ChatUsage>; provider: string; model: string }
  // Hint to the UI that the agent's frame of reference is a specific day —
  // fires when get_todays_macros is called with an explicit `date` argument.
  // The frontend can sync the dashboard's selected day to follow along.
  | { type: "view_date_hint"; date: string }
  // Navigation request from the agent — fires when the show_screen tool runs
  // successfully. The frontend switches its data view to the named screen.
  | { type: "show_screen"; screen: AppScreen; tab?: string }
  | {
      type: "done";
      iterations: number;
      stop_reason: string;
      usage: ChatUsage;
      provider: string;
      model: string;
    }
  | { type: "error"; message: string };

export type ChatOptions = {
  // Extended thinking. Defaults to true to preserve the prior behavior of
  // every chat turn. Setting false omits the thinking param entirely, so
  // we don't pay the budget for routine turns where the user has toggled it
  // off (a frontend setting). Ignored by providers that don't support it.
  thinking?: boolean;
  // YYYY-MM-DD of the day the user is currently viewing in the UI. Used as
  // a default `date` for any `get_todays_macros` call the agent makes without
  // an explicit date — keeps the dashboard in sync even when the model is
  // sloppy about passing args.
  contextDate?: string;
};

// Resolution of a pre-execution gate. `input` is whatever the user actually
// confirmed (edits applied). `canceled` short-circuits the tool — we feed a
// synthetic "canceled by user" tool_result back to the model so it can react
// gracefully (e.g. "ok, didn't log that — anything else?").
export type ToolConfirmation =
  { canceled: false; input: Record<string, unknown> } | { canceled: true; reason?: string };

// Server passes this in so the agent loop can pause on each mutating tool.
// Caller is responsible for any timeout / persistence behaviour around the
// returned promise; the loop just `await`s and consumes the result. The promise
// may REJECT to signal that the gate was abandoned — the SSE stream was torn
// down (client disconnected/refreshed) while the card sat open. See GateAbandoned.
export type ConfirmToolFn = (args: {
  name: string;
  tool_use_id: string;
  input: Record<string, unknown>;
}) => Promise<ToolConfirmation>;

// Thrown when a confirm-gate's promise rejects. The only cause is the SSE
// stream being closed (client disconnect) while the gate was open. Handled
// specially in the chat() catch: we leave the assistant tool_call dangling
// (it was already flushed at gate-open) so the pending card rehydrates as
// still-proposed and stays savable via the /chat/tool/:id/resolve dead-gate
// path. Writing a synthetic "not executed" result here instead would strand
// the card as canceled/saved and block that path — the exact bug this avoids.
class GateAbandoned extends Error {
  constructor(readonly toolUseId: string) {
    super(`gate abandoned (stream closed): ${toolUseId}`);
    this.name = "GateAbandoned";
  }
}

export async function* chatStream(
  userId: string,
  userMessage: UserMessage,
  options: ChatOptions = {},
  confirmTool?: ConfirmToolFn,
): AsyncGenerator<StreamEvent, void, void> {
  // Per-turn tier (see pickTurnTier): "fast" turns — logging, lookups, quick
  // reads — run on the fast provider with thinking off; "deep" turns (advice,
  // judgement, planning) run on the chat provider with thinking per the user's
  // toggle. Both resolve through the provider registry, so swapping vendors is
  // env-only (LLM_PROVIDER / LLM_FAST_PROVIDER).
  const tier = pickTurnTier(userMessage);
  const provider = tier === "fast" ? getFastProvider() : getProvider();
  // The user's toggle is a ceiling: off means off on every turn; on means on
  // for deep turns. Adapters without a thinking knob ignore the flag; ones that
  // reason regardless (kimi-thinking-preview) read `false` to suppress UI
  // emission only.
  const thinkingOn = (options.thinking ?? true) && tier === "deep";
  const contextDate = options.contextDate;
  const system = SYSTEM_BLOCKS;
  const clog = log.child({
    user_id: userId,
    provider: provider.id,
    model: provider.model,
  });
  const storage = new UserStorage(userId);
  const [loaded, stateTag] = await Promise.all([
    storage.loadConversation(),
    buildStateTag(storage, contextDate),
  ]);
  let messages = loaded as FaMessage[];
  if (stateTag) userMessage = withLeadingTag(userMessage, stateTag);
  // Persistence is append-only: anything past this index is generated this
  // turn and gets inserted with the current provider/model tag. Mutable
  // because a mutating-tool gate may flush the in-flight turn partway through
  // (see flushTurn) so a refresh can show the pending card — that advances the
  // boundary mid-turn.
  let persistedLen = messages.length;
  // Index the incoming user message will occupy once pushed below — used to
  // apply image descriptions to it on whichever flush first crosses it.
  const incomingUserIndex = persistedLen;
  // When the user has toggled extended thinking off, strip ALL historical
  // thinking blocks. The API doesn't require preservation in this case
  // (thinking-disabled requests), and leaving them in history was making
  // the model mimic the pattern in plain text as `<thinking>` tags.
  //
  // Gated on capabilities.thinking — providers without a thinking knob
  // (Kimi-thinking always reasons server-side) reject requests that omit
  // reasoning_content on tool-call turns, so the strip would break them.
  // The OpenAI adapter handles the UI-display suppression for those.
  if (!thinkingOn && provider.capabilities.thinking) {
    messages = messages.map(stripAllThinkingBlocks);
  }
  messages.push({ role: "user", content: userMessage });

  // History may end with a `tool_use` whose gate was never resolved — e.g. the
  // user closed the tab on a pending entry-tool card. That card is persisted the
  // moment the gate opens (see flushTurn) so a refresh can show it, which leaves
  // a tool_use with no following tool_result. The provider rejects that, so
  // merge a synthetic "not completed" result into this turn's user message. The
  // raw tool_use stays in the DB, so the UI keeps rendering the pending card
  // until it's saved or explicitly resolved.
  repairDanglingToolUses(messages);
  // Symmetric repair: drop any tool_result whose tool_use was lost, so a single
  // orphan can't brick the conversation on every subsequent turn (see fn doc).
  repairOrphanToolResults(messages);

  // Images are stripped from the persisted history (see storage.ts), which
  // loses what the photo showed — both for the restored chat UI and for the
  // model on later turns. Kick off a concise description of each attached
  // image now, in parallel with the agent loop, and swap the descriptions in
  // for the image blocks right before persisting. Failures fall back to the
  // generic placeholder in storage.ts.
  const imageDescriptions = describeImagesForHistory(userId, userMessage, clog);

  // Pick a stable tool subset once per chat() call. The same group is reused
  // for every iteration in the tool-use loop so the prompt cache stays warm
  // across follow-up calls in the same turn (model → tool_result → model).
  // The model can widen the set mid-turn via request_tools (handled below)
  // when the router's pick turns out to be missing a tool it needs.
  const toolGroup = pickToolGroup(messages);
  const activeGroups = new Set<ToolGroup>([toolGroup]);
  let activeTools = TOOL_GROUPS[toolGroup];
  // web_search (a provider server tool) is hidden until our OWN data has been
  // consulted — so the model can't reach for the internet before the pantry
  // (lookup_food) and our self-hosted food index (lookup_product). It unlocks
  // mid-turn once either DB lookup runs, or when the model explicitly requests
  // the "web" group for a general-info / supplement-science question that needs
  // no food lookup. See the unlock points in the tool-use loop below. Starting
  // hidden also keeps the cached tools prefix identical at the top of every
  // turn (no trailing server tool), so the common first iteration stays warm.
  const canUseServerTools = provider.capabilities.serverTools && SERVER_TOOLS.length > 0;
  let webUnlocked = false;
  const currentServerTools = (): ReadonlyArray<Record<string, unknown>> =>
    canUseServerTools && webUnlocked ? SERVER_TOOLS : [];
  clog.info("chat start", {
    history_len: messages.length - 1,
    tier,
    thinking: thinkingOn,
    tool_group: toolGroup,
    tool_count: activeTools.length,
    server_tools_available: canUseServerTools,
  });

  const usageTotal: ChatUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let iterations = 0;
  let stopReason = "end_turn";

  // Anti-thrash guard. Signatures (`name:stableJSON(input)`) of mutating tools
  // already applied this turn. The model sometimes re-proposes a write it just
  // made — most often update_meal, whose `items` replaces the whole list, so a
  // single-item edit can leave the model "correcting" the same meal over and
  // over (each re-proposal opens another form gate). If the exact same write
  // recurs we short-circuit it instead of looping. See the guard in the loop.
  const executedMutations = new Set<string>();
  // Same idea for reads/computes: signatures of read calls made since the last
  // successful write. Kimi has looped on a carded read (compute_ideal_proportions
  // seven times in one turn, never answering), so a repeat with identical input
  // returns a "you already have this" note instead of re-running and re-carding.
  // Cleared after every write so "re-read after a write" (get_todays_macros
  // after log_meal) still runs for real.
  const executedReads = new Set<string>();
  // Calls made this turn per capped tool (see TOOL_TURN_CAPS).
  const capCounts = new Map<string, number>();

  // Per-iteration usage records, finalized into ledger rows after persistence
  // hands back the inserted message IDs. `assistantMsgIndex` is the absolute
  // index of this iteration's assistant message in `messages`, mapped to its
  // DB row id via insertedIdByIndex (see flushTurn).
  const chatId = newChatId();
  const iterationUsages: Array<{
    iterationIndex: number;
    assistantMsgIndex: number;
    usage: ChatUsage;
    stopReason: string;
  }> = [];

  // Absolute message index → inserted DB row id. Persistence can now happen in
  // two stages (a partial flush when the first mutating-tool gate opens, then
  // the remainder at end-of-turn), so ledger attribution can't assume a single
  // slice offset.
  const insertedIdByIndex = new Map<number, number>();

  // Persist everything generated since the last flush, advancing persistedLen so
  // each row is written exactly once. Called when a gate opens (durability for
  // the pending card across a refresh) and again at end-of-turn.
  const flushTurn = async (): Promise<void> => {
    if (persistedLen >= messages.length) return;
    // Image descriptions only matter for the incoming user message; apply them
    // on whichever flush first crosses it.
    if (persistedLen <= incomingUserIndex && messages.length > incomingUserIndex) {
      await applyImageDescriptions(messages[incomingUserIndex], imageDescriptions);
    }
    const base = persistedLen;
    const ids = await storage.appendConversation(messages, persistedLen, {
      provider: provider.id,
      model: provider.model,
    });
    ids.forEach((id, i) => insertedIdByIndex.set(base + i, id));
    persistedLen = messages.length;
  };

  try {
    // MAX_ITERATIONS tool-using steps, then one forced answer step: if the
    // model is still calling tools when the budget runs out, it gets a final
    // iteration told to answer with what it has, so a confused run degrades to
    // a short reply instead of ending silently. Tools stay on the wire for
    // that step (some providers reject tool history without tool definitions);
    // any call it still makes is closed out as "[not executed]" below.
    while (iterations <= MAX_ITERATIONS) {
      iterations++;
      const budgetSpent = iterations > MAX_ITERATIONS;
      if (budgetSpent) clog.warn("step budget spent; forcing a final answer", { iterations });
      clog.debug("iteration start", {
        iteration: iterations,
        history_len: messages.length,
      });
      yield { type: "iteration_start", iteration: iterations };

      const iterStart = Date.now();
      // `yield*` forwards provider stream events live to the SSE consumer
      // (so text/thinking deltas render token-by-token) and binds the inner
      // generator's `return` value to `iteration` here.
      const iteration = yield* runIteration({
        provider,
        system,
        messages: budgetSpent ? withBudgetNote(messages) : messages,
        tools: activeTools,
        serverTools: currentServerTools(),
        allowWebSearch: webUnlocked,
        thinking: thinkingOn,
      });
      const iterMs = Date.now() - iterStart;

      clog.debug("iteration done", {
        iteration: iterations,
        ms: iterMs,
        stop_reason: iteration.stopReason,
        text_chunks: iteration.streamStats.textChunks,
        text_chars: iteration.streamStats.textChars,
        thinking_chunks: iteration.streamStats.thinkingChunks,
        thinking_chars: iteration.streamStats.thinkingChars,
        tool_calls: iteration.streamStats.toolCalls,
        server_tool_calls: iteration.streamStats.serverToolCalls,
        blocks: iteration.blockCounts,
        usage: iteration.usage,
      });

      stopReason = iteration.stopReason;
      accumulateUsage(usageTotal, iteration.usage);
      yield {
        type: "iteration_usage",
        usage: { ...iteration.usage },
        provider: provider.id,
        model: provider.model,
      };

      // Surface any web-search citations the model attached to its text blocks
      // this iteration, so the UI can render a Sources footer. Deltas can't
      // carry them — citations only exist on the final content.
      const citations = collectCitations(iteration.content);
      if (citations.length) yield { type: "citations", citations };

      // Persist the full assistant content (text + tool_use + thinking).
      // Capture the absolute index BEFORE the push so ledger attribution
      // survives a mid-turn partial flush (see flushTurn / insertedIdByIndex).
      const assistantMsgIndex = messages.length;
      messages.push({ role: "assistant", content: iteration.content });
      iterationUsages.push({
        iterationIndex: iterations,
        assistantMsgIndex,
        usage: { ...iteration.usage },
        stopReason: iteration.stopReason,
      });

      if (stopReason === "tool_use" && !budgetSpent) {
        const toolUses = iteration.content.filter(
          (b): b is FaToolCallBlock => b.kind === "tool_call",
        );
        const toolResults: FaToolResultBlock[] = [];
        // Start this step's plain reads concurrently (food-index search, web
        // fetch and friends add up when run one by one). Only reads listed
        // BEFORE the step's first mutating call start early, so a read after a
        // write still sees the write. Repeats are left to the duplicate guard
        // below, which never awaits a prefetch.
        const prefetched = new Map<string, Promise<string>>();
        const launched = new Set<string>();
        const launchedPerTool = new Map<string, number>();
        for (const tu of toolUses) {
          if (isMutatingTool(tu.tool)) break;
          if (tu.tool === "request_tools") continue;
          const input = resolveToolInput(tu.tool, tu.args, contextDate);
          const sig = `${tu.tool}:${stableStringify(input)}`;
          if (executedReads.has(sig) || launched.has(sig)) continue;
          // Don't start calls the per-turn cap will refuse.
          const n = launchedPerTool.get(tu.tool) ?? 0;
          const cap = TOOL_TURN_CAPS[tu.tool];
          if (cap != null && (capCounts.get(tu.tool) ?? 0) + n >= cap) continue;
          launchedPerTool.set(tu.tool, n + 1);
          launched.add(sig);
          // Same preparation the loop applies (e.g. exercise names → ids); a
          // failed prepare is reported by the loop, so this result goes unused.
          const p = prepareToolInput(tu.tool, input, storage).then((r) =>
            r.ok ? executeTool(tu.tool, r.input, storage) : JSON.stringify(r.error),
          );
          // Awaited (and its error handled) in the loop below; this only keeps
          // a rejection from surfacing as unhandled before we get there.
          p.catch(() => {});
          prefetched.set(tu.callId, p);
        }
        for (const tu of toolUses) {
          const start = Date.now();
          // Canonical tool calls carry `tool` (name) and `callId`; alias them
          // so the loop reads naturally and the StreamEvents keep their stable
          // field names (name / tool_use_id).
          const toolName = tu.tool;
          const toolUseId = tu.callId;
          let ok = true;
          let out = "";
          // Searching our self-hosted food index (lookup_product) unlocks
          // web_search for the rest of the turn — the DB-first gate. We key the
          // unlock on lookup_product (not lookup_food) because that's the
          // "extensive DB" search: lookup_food only checks the user's own
          // pantry, so a pantry miss must still fall through to the index before
          // the web becomes reachable. Set on the call itself (even a miss), so
          // once the index has been exhausted the model can fall back to the web
          // on the next iteration. There is deliberately NO manual override —
          // the only way to reach web_search is through the index. See
          // currentServerTools() above.
          if (toolName === "lookup_product") {
            webUnlocked = true;
          }
          let toolInput = resolveToolInput(toolName, tu.args, contextDate);
          // Normalize before any gate (e.g. exercise names → catalog ids). An
          // input that can't be made usable fails here, without opening a form.
          const prepared = await prepareToolInput(toolName, toolInput, storage);
          if (!prepared.ok) {
            toolResults.push({
              kind: "tool_result",
              callId: toolUseId,
              output: JSON.stringify(prepared.error),
              isError: true,
            });
            yield {
              type: "tool_finished",
              name: toolName,
              tool_use_id: toolUseId,
              ms: Date.now() - start,
              ok: false,
              category: getToolCategory(toolName),
            };
            continue;
          }
          if (prepared.input !== toolInput) {
            toolInput = prepared.input;
            // Persist what will run, so history (and the gate's form) carries
            // the resolved ids rather than the names the model wrote.
            (tu as { args: Record<string, unknown> }).args = toolInput;
          }

          // request_tools is loop-level, not a storage tool: it widens the
          // active tool set for the remaining iterations of this turn so the
          // model can reach a domain the keyword router didn't predict.
          // Handled here (not in runTool) because only the loop owns the
          // tool list; skips the mutating gate since nothing is written.
          if (toolName === "request_tools") {
            const g = REQUESTABLE_GROUPS.find((x) => x === toolInput.group);
            if (g) {
              const before = new Set(activeTools.map((t) => t.name));
              activeGroups.add(g);
              activeTools = toolsForGroups(activeGroups);
              const added = activeTools.map((t) => t.name).filter((n) => !before.has(n));
              out = JSON.stringify(
                added.length
                  ? { ok: true, group: g, tools_added: added }
                  : {
                      ok: true,
                      group: g,
                      tools_added: [],
                      note: "Every tool in this domain was already in your tool list. Call the tool you need directly — don't request domains for tools you already have.",
                    },
              );
              clog.info("tool group unlocked", {
                group: g,
                reason: toolInput.reason,
                added,
              });
            } else {
              ok = false;
              out = JSON.stringify({
                error: "unknown group — pass one of: nutrition, training, progress, pantry",
              });
            }
            toolResults.push({
              kind: "tool_result",
              callId: toolUseId,
              output: out,
              ...(ok ? {} : { isError: true }),
            });
            yield {
              type: "tool_finished",
              name: toolName,
              tool_use_id: toolUseId,
              ms: Date.now() - start,
              ok,
              category: getToolCategory(toolName),
            };
            continue;
          }

          // Anti-thrash guard. If this exact mutating write already ran this
          // turn, don't open another form gate / touch storage again — feed
          // back an "already applied" result so the model stops re-proposing
          // it. Catches the update_meal oscillation (and any duplicate write).
          if (isMutatingTool(toolName)) {
            const sig = `${toolName}:${stableStringify(toolInput)}`;
            if (executedMutations.has(sig)) {
              out = JSON.stringify({
                noop: true,
                message:
                  "This exact change was already applied earlier in this turn — it is saved. Do NOT call this tool again; just confirm the result to the user.",
              });
              clog.info("duplicate mutating call suppressed", {
                tool: toolName,
                tool_use_id: toolUseId,
              });
              toolResults.push({
                kind: "tool_result",
                callId: toolUseId,
                output: out,
              });
              yield {
                type: "tool_finished",
                name: toolName,
                tool_use_id: toolUseId,
                ms: Date.now() - start,
                ok: true,
                category: getToolCategory(toolName),
              };
              continue;
            }
          } else {
            const sig = `${toolName}:${stableStringify(toolInput)}`;
            if (executedReads.has(sig)) {
              out = `${DUPLICATE_READ_PREFIX} You already called ${toolName} with this exact input this turn and its result is above (the user already sees its card). Do NOT call it again — answer the user's question now with what you have.`;
              clog.info("duplicate read call suppressed", {
                tool: toolName,
                tool_use_id: toolUseId,
              });
              toolResults.push({
                kind: "tool_result",
                callId: toolUseId,
                output: out,
              });
              yield {
                type: "tool_finished",
                name: toolName,
                tool_use_id: toolUseId,
                ms: Date.now() - start,
                ok: true,
                category: getToolCategory(toolName),
              };
              continue;
            }
          }

          // Per-turn budget for slow / billed tools. Past the cap the call is
          // answered with a "stop and use what you have" note instead of run.
          const cap = TOOL_TURN_CAPS[toolName];
          if (cap != null) {
            const used = capCounts.get(toolName) ?? 0;
            if (used >= cap) {
              out = JSON.stringify({
                skipped: true,
                message: `${toolName} limit for this turn reached (${cap} calls). Do NOT call it again — answer with the best figures you already have, say which numbers are estimates, or ask the user.`,
              });
              clog.info("tool turn cap reached", { tool: toolName, cap });
              toolResults.push({ kind: "tool_result", callId: toolUseId, output: out });
              yield {
                type: "tool_finished",
                name: toolName,
                tool_use_id: toolUseId,
                ms: Date.now() - start,
                ok: true,
                category: getToolCategory(toolName),
              };
              continue;
            }
            capCounts.set(toolName, used + 1);
          }

          // Pre-execution gate. For mutating tools, ask the UI to confirm
          // (or edit) the proposed input before we touch storage. On cancel,
          // skip execution and feed a synthetic tool_result back to the model.
          // If no confirmTool is wired (e.g. headless /chat call), the loop
          // runs as before.
          let canceled = false;
          let cancelReason: string | undefined;
          let userEdits: UserEdit[] = [];
          if (confirmTool && isMutatingTool(toolName)) {
            const proposedInput = toolInput;
            yield {
              type: "tool_proposed",
              name: toolName,
              tool_use_id: toolUseId,
              label: getToolLabel(toolName),
              input: toolInput,
              schema: getToolSchema(toolName) ?? null,
              category: getToolCategory(toolName),
            };
            // Persist the in-flight turn (this user message + the assistant
            // message carrying the proposed tool_call) before blocking on the
            // user. If they refresh while the gate is open, history now shows
            // their message and the pending card instead of losing the turn.
            try {
              await flushTurn();
            } catch (e) {
              clog.warn("partial flush before gate failed", {
                err: e instanceof Error ? e.message : String(e),
              });
            }
            let decision: ToolConfirmation;
            try {
              decision = await confirmTool({
                name: toolName,
                tool_use_id: toolUseId,
                input: toolInput,
              });
            } catch {
              // The confirm promise only rejects when the SSE stream was torn
              // down (client disconnected/refreshed) while this gate was open.
              // Abort the turn WITHOUT recording a tool_result: the assistant
              // tool_call was already flushed at gate-open, so leaving it
              // dangling lets the card rehydrate as still-proposed and be saved
              // on return via the /chat/tool/:id/resolve dead-gate path.
              throw new GateAbandoned(toolUseId);
            }
            if (decision.canceled) {
              canceled = true;
              cancelReason = decision.reason;
            } else {
              userEdits = diffUserEdits(proposedInput, decision.input);
              toolInput = decision.input;
              // Rewrite the persisted tool_call args so the model's history
              // reflects what was actually executed, not what it proposed.
              (tu as { args: Record<string, unknown> }).args = toolInput;
            }
          }

          if (canceled) {
            ok = false;
            out = JSON.stringify({
              canceled: true,
              reason: cancelReason ?? "user canceled before execution",
            });
            clog.info("tool canceled by user", {
              tool: toolName,
              tool_use_id: toolUseId,
            });
            toolResults.push({
              kind: "tool_result",
              callId: toolUseId,
              output: out,
              isError: true,
            });
            yield {
              type: "tool_finished",
              name: toolName,
              tool_use_id: toolUseId,
              ms: Date.now() - start,
              ok,
              category: getToolCategory(toolName),
            };
            continue;
          }

          clog.debug("tool start", {
            tool: toolName,
            tool_use_id: toolUseId,
            input: toolInput,
          });
          try {
            out = await (prefetched.get(toolUseId) ?? executeTool(toolName, toolInput, storage));
          } catch (err) {
            ok = false;
            out = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
            clog.error("tool threw", err instanceof Error ? err : new Error(String(err)), {
              tool: toolName,
              tool_use_id: toolUseId,
              ms: Date.now() - start,
            });
          }
          const ms = Date.now() - start;
          // lookup_food searches the food index too on a pantry miss, so a miss
          // with no index matches has already exhausted our own data: unlock
          // web search now rather than forcing a lookup_product round-trip
          // that would search the same index again.
          if (ok && toolName === "lookup_food" && !webUnlocked && indexMissed(out)) {
            webUnlocked = true;
          }
          if (ok) {
            // Record the final (post-edit) write so a re-proposal of the same
            // input is caught by the anti-thrash guard above.
            if (isMutatingTool(toolName)) {
              executedMutations.add(`${toolName}:${stableStringify(toolInput)}`);
              executedReads.clear();
            } else {
              executedReads.add(`${toolName}:${stableStringify(toolInput)}`);
            }
            clog.info("tool done", {
              tool: toolName,
              ms,
              user_edited_fields: userEdits.map((e) => e.field),
            });
            clog.debug("tool result", {
              tool: toolName,
              tool_use_id: toolUseId,
              ms,
              result: tryParseJson(out),
            });
          }
          // Prepend an explicit user-edited-fields notice to the tool_result
          // so the model can't mistake the user's form edits for its own
          // miscall and "fix" them by deleting + re-logging. The notice fires
          // only when the tool actually ran (cancel path returns earlier) and
          // the user changed at least one field in the form gate.
          const resultOutput = userEdits.length > 0 ? formatUserEditNotice(userEdits) + out : out;
          toolResults.push({
            kind: "tool_result",
            callId: toolUseId,
            output: resultOutput,
            ...(ok ? {} : { isError: true }),
          });
          yield {
            type: "tool_finished",
            name: toolName,
            tool_use_id: toolUseId,
            ms,
            ok,
            category: getToolCategory(toolName),
            // Attach the structured result for carded read/compute tools (rich
            // card) and for create-or-replace mutations (the UI folds the new
            // row's id back so a resubmit updates instead of duplicating).
            // Parsed from the same JSON the model sees; omitted on failure.
            ...(ok && (hasResultCard(toolName) || SAVE_IDENTITY_TOOLS.has(toolName))
              ? { result: tryParseJson(out) }
              : {}),
          };
          // Surface the agent's frame-of-reference day to the UI so the
          // dashboard can sync. Fires for every successful get_todays_macros
          // call, using the resolved date — the model's arg, the context
          // date we injected above, or today (handler default).
          if (ok && toolName === "get_todays_macros") {
            const d = (toolInput as { date?: unknown })?.date;
            let resolved: string | null = null;
            if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
              resolved = d;
            } else if (d == null) {
              const now = new Date();
              const y = now.getFullYear();
              const m = String(now.getMonth() + 1).padStart(2, "0");
              const day = String(now.getDate()).padStart(2, "0");
              resolved = `${y}-${m}-${day}`;
            }
            if (resolved) yield { type: "view_date_hint", date: resolved };
          }
          // Tell the UI to navigate. Validate the screen here too: executeTool
          // reports ok=true even when the handler returned {error}, so gate on
          // the same enum the handler checks.
          if (ok && toolName === "show_screen") {
            const inp = toolInput as { screen?: unknown; tab?: unknown };
            const s = inp?.screen;
            if (typeof s === "string" && (APP_SCREENS as readonly string[]).includes(s)) {
              const t = inp?.tab;
              const tab =
                typeof t === "string" && SCREEN_TABS[s as AppScreen].includes(t) ? t : undefined;
              yield {
                type: "show_screen",
                screen: s as AppScreen,
                ...(tab ? { tab } : {}),
              };
            }
          }
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // end_turn | max_tokens | stop_sequence | refusal | pause_turn
      break;
    }

    sanitizeOrphanToolUses(messages);
    await flushTurn();
    // Best-effort per-iteration usage attribution. One ledger row per
    // provider API call, linked to the assistant message it produced.
    // Don't block the response on a ledger failure (e.g. transient DB error).
    storage
      .logUsage(
        iterationUsages.map((u) => ({
          chatId,
          iterationIndex: u.iterationIndex,
          messageId: insertedIdByIndex.get(u.assistantMsgIndex) ?? null,
          provider: provider.id,
          model: provider.model,
          inputTokens: u.usage.input_tokens,
          outputTokens: u.usage.output_tokens,
          cacheReadInputTokens: u.usage.cache_read_input_tokens,
          cacheCreationInputTokens: u.usage.cache_creation_input_tokens,
          stopReason: u.stopReason,
        })),
      )
      .catch((e: unknown) => {
        clog.error("ledger write failed", e instanceof Error ? e : new Error(String(e)));
      });
    clog.info("chat finished", {
      iterations,
      stop_reason: stopReason,
      in_tokens: usageTotal.input_tokens,
      out_tokens: usageTotal.output_tokens,
      cache_read: usageTotal.cache_read_input_tokens,
      cache_create: usageTotal.cache_creation_input_tokens,
    });
    yield {
      type: "done",
      iterations,
      stop_reason: stopReason,
      usage: usageTotal,
      provider: provider.id,
      model: provider.model,
    };
  } catch (err) {
    // A client disconnect mid-gate is a clean abandonment, not a crash: keep
    // the dangling tool_call untouched so the pending card stays savable on
    // return, and don't surface an error on the (already gone) stream.
    const abandoned = err instanceof GateAbandoned;
    if (abandoned) {
      clog.info("gate abandoned on disconnect", { tool_use_id: err.toolUseId });
    } else {
      clog.error("chat aborted", err instanceof Error ? err : new Error(String(err)), {
        iterations,
      });
    }
    // Best-effort save before bailing out. Iterations that completed before
    // the crash still cost tokens — persist those ledger rows too. Only fill
    // orphan tool_uses for genuine errors; an abandoned gate must stay dangling.
    try {
      if (!abandoned) sanitizeOrphanToolUses(messages);
      await flushTurn();
      if (iterationUsages.length) {
        await storage.logUsage(
          iterationUsages.map((u) => ({
            chatId,
            iterationIndex: u.iterationIndex,
            messageId: insertedIdByIndex.get(u.assistantMsgIndex) ?? null,
            provider: provider.id,
            model: provider.model,
            inputTokens: u.usage.input_tokens,
            outputTokens: u.usage.output_tokens,
            cacheReadInputTokens: u.usage.cache_read_input_tokens,
            cacheCreationInputTokens: u.usage.cache_creation_input_tokens,
            stopReason: u.stopReason,
          })),
        );
      }
    } catch (saveErr) {
      clog.warn("save-on-error failed", {
        err: saveErr instanceof Error ? saveErr.message : String(saveErr),
      });
    }
    if (!abandoned) {
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  } finally {
    // Record the turn as one usage event — on success, error, AND a user stop (the
    // consumer breaking out of this generator runs only this block). Covers
    // every completed provider call; an iteration cut off mid-stream has no
    // usage yet and isn't recorded.
    if (iterationUsages.length) {
      await recordUsage(userId, {
        source: "chat",
        provider: provider.id,
        model: provider.model,
        usage: iterationUsages.reduce<ChatUsage>(
          (acc, u) => {
            accumulateUsage(acc, u.usage);
            return acc;
          },
          {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ),
        chatId,
      }).catch((e: unknown) => {
        clog.error("usage record failed", e instanceof Error ? e : new Error(String(e)));
      });
    }
  }
}

// Run one provider iteration, yielding agent stream events live as they
// arrive from the provider so the SSE consumer can render text/thinking
// deltas token-by-token. The generator's `return` value carries the final
// content/usage/stats — the caller binds it via `yield*`.
async function* runIteration(args: {
  provider: LLMProvider;
  system: FaSystemBlock[];
  messages: FaMessage[];
  tools: FaToolDef[];
  serverTools: ReadonlyArray<Record<string, unknown>>;
  allowWebSearch: boolean;
  thinking: boolean;
}): AsyncGenerator<
  StreamEvent,
  {
    content: FaBlock[];
    stopReason: string;
    usage: ChatUsage;
    streamStats: {
      textChunks: number;
      textChars: number;
      thinkingChunks: number;
      thinkingChars: number;
      toolCalls: number;
      serverToolCalls: number;
    };
    blockCounts: { text: number; tool_use: number; thinking: number; other: number };
  },
  void
> {
  let content: FaBlock[] = [];
  let stopReason = "end_turn";
  let usage: ChatUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const streamStats = {
    textChunks: 0,
    textChars: 0,
    thinkingChunks: 0,
    thinkingChars: 0,
    toolCalls: 0,
    serverToolCalls: 0,
  };

  const stream = args.provider.streamIteration({
    system: args.system,
    messages: withModelFacingResults(args.messages),
    tools: args.tools,
    serverTools: args.serverTools,
    allowWebSearch: args.allowWebSearch,
    thinking: args.thinking,
    maxTokens: MAX_TOKENS,
  });

  for await (const ev of stream) {
    switch (ev.type) {
      case "text_delta":
        streamStats.textChunks++;
        streamStats.textChars += ev.delta.length;
        yield { type: "text_delta", delta: ev.delta };
        break;
      case "thinking_delta":
        streamStats.thinkingChunks++;
        streamStats.thinkingChars += ev.delta.length;
        yield { type: "thinking_delta", delta: ev.delta };
        break;
      case "tool_use_start":
        streamStats.toolCalls++;
        yield {
          type: "tool_started",
          name: ev.name,
          tool_use_id: ev.tool_use_id,
          label: getToolLabel(ev.name),
          category: getToolCategory(ev.name),
        };
        break;
      case "server_tool_call":
        streamStats.serverToolCalls++;
        // Anthropic ran the tool on its end. Render start+finish back-to-back.
        yield {
          type: "tool_started",
          name: ev.name,
          tool_use_id: ev.tool_use_id,
          label: getToolLabel(ev.name),
          category: getToolCategory(ev.name),
        };
        yield {
          type: "tool_finished",
          name: ev.name,
          tool_use_id: ev.tool_use_id,
          ms: 0,
          ok: true,
          category: getToolCategory(ev.name),
        };
        break;
      case "done":
        content = ev.content;
        stopReason = ev.stop_reason;
        usage = ev.usage;
        break;
    }
  }

  const blockCounts = { text: 0, tool_use: 0, thinking: 0, other: 0 };
  for (const b of content) {
    if (b.kind === "text") blockCounts.text++;
    else if (b.kind === "tool_call") blockCounts.tool_use++;
    else if (b.kind === "thinking") blockCounts.thinking++;
    else blockCounts.other++;
  }

  return { content, stopReason, usage, streamStats, blockCounts };
}

export async function chat(
  userId: string,
  userMessage: UserMessage,
  options: ChatOptions = {},
): Promise<ChatResult> {
  let assistant = "";
  let iterations = 0;
  let stopReason = "end_turn";
  let usage: ChatUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let provider: string = getProvider().id;
  let model: string = getProvider().model;
  let errored: string | null = null;

  for await (const ev of chatStream(userId, userMessage, options)) {
    if (ev.type === "text_delta") assistant += ev.delta;
    else if (ev.type === "done") {
      iterations = ev.iterations;
      stopReason = ev.stop_reason;
      usage = ev.usage;
      provider = ev.provider;
      model = ev.model;
    } else if (ev.type === "error") {
      errored = ev.message;
    }
  }

  if (errored) throw new Error(errored);
  return { assistant, iterations, stop_reason: stopReason, usage, provider, model };
}

// --- image descriptions for persisted history ---
//
// The conversation save path strips image blocks (cost + GDPR + row size; see
// storage.ts). Instead of losing the photo entirely, we run a one-off vision
// pass per image and persist `[image: <description>]` in its place — the
// restored chat UI renders it as an attachment note, and the model keeps
// enough context to reference the photo on later turns.

const IMAGE_DESCRIBE_SYSTEM =
  "You write one-line descriptions of photos attached to a fitness-coach " +
  "chat, so the conversation keeps a record of each photo after the image " +
  "itself is discarded.";
const IMAGE_DESCRIBE_INSTRUCTION =
  "Describe this image in 1-2 sentences. Focus on what matters for nutrition " +
  "and fitness: foods and rough portions, packaging or nutrition labels " +
  "(include readable numbers), gym equipment, or physique. Plain text only, " +
  "no preamble.";

// How long the persist path will wait on a straggling description after the
// agent loop has already finished. Descriptions run concurrently with the
// loop, so this rarely comes into play.
const IMAGE_DESCRIBE_GRACE_MS = 15_000;

// Start one vision pass per image block, in block order. Returns null when
// the message has no images. Each entry resolves to the description or null
// on failure — never rejects.
function describeImagesForHistory(
  userId: string,
  userMessage: UserMessage,
  clog: typeof log,
): Promise<Array<string | null>> | null {
  if (typeof userMessage === "string") return null;
  const images = userMessage.filter((b): b is FaImageBlock => b.kind === "image");
  if (!images.length) return null;
  return Promise.all(
    images.map(async (img, i) => {
      const start = Date.now();
      try {
        const text = await visionComplete({
          image:
            img.source.kind === "url"
              ? { kind: "url", url: img.source.url }
              : {
                  kind: "base64",
                  media_type: img.source.mediaType,
                  data: img.source.data,
                },
          system: IMAGE_DESCRIBE_SYSTEM,
          instruction: IMAGE_DESCRIBE_INSTRUCTION,
          maxTokens: 300,
          bill: { userId, source: "chat_image" },
        });
        const cleaned = text.trim().replace(/\s+/g, " ");
        clog.debug("image described for history", {
          index: i,
          ms: Date.now() - start,
          chars: cleaned.length,
        });
        return cleaned || null;
      } catch (err) {
        clog.warn("image description failed — using generic placeholder", {
          index: i,
          ms: Date.now() - start,
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );
}

// Swap the image blocks in the just-sent user message for their text
// descriptions. Mutates the message in place — only safe after the agent
// loop is done with it, immediately before persistence. Images whose
// description failed (null) are left alone; storage.ts strips them to the
// generic placeholder.
async function applyImageDescriptions(
  msg: FaMessage | undefined,
  descriptions: Promise<Array<string | null>> | null,
): Promise<void> {
  if (!msg || !descriptions || !Array.isArray(msg.content)) return;
  const descs = await Promise.race([
    descriptions,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), IMAGE_DESCRIBE_GRACE_MS)),
  ]);
  if (!descs) return;
  let i = 0;
  msg.content = msg.content.map((b) => {
    if (b.kind !== "image") return b;
    const d = descs[i++];
    if (!d) return b;
    const note: FaTextBlock = {
      kind: "text",
      text: `[image: ${d}]`,
    };
    return note;
  });
}

// If the final assistant message contains `tool_call` blocks that never got
// a corresponding `tool_result` (e.g. the model emitted a tool call but
// `stop_reason` came back as `max_tokens` / `refusal` rather than
// `tool_use`, so the agent loop never executed them), inject synthetic
// tool_results. Anthropic tolerates the orphan; OpenAI-compat providers
// (Kimi/Mistral/DeepSeek/xAI) reject any subsequent request with
// "tool_calls must be followed by tool messages". The synthetic response
// keeps the conversation well-formed for every provider.
// Rewrite carded read/compute tool_result outputs to their MODEL-FACING form
// before sending to the LLM: display-only cards (compute_targets, compute_bmi,
// progress_report, ...) collapse to a "card shown, say nothing" sentinel so the
// model can't recite numbers the user already sees; chaining cards (lookup_food,
// get_todays_macros, preview_meal, ...) keep their data but gain a leading
// "don't restate" directive. Returns a COPY — the persisted `messages` keep the
// original full JSON, so the UI's history-reload card reconstruction is
// untouched. The tool name (results carry only `callId`) comes from the matching
// tool_call block earlier in the conversation.
function withModelFacingResults(messages: FaMessage[]): FaMessage[] {
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.kind === "tool_call") toolNameById.set(b.callId, b.tool);
    }
  }
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.kind !== "tool_result") return b;
      const name = toolNameById.get(b.callId);
      if (!name || !hasResultCard(name)) return b;
      const next = modelFacingToolResult(name, b.output);
      if (next === b.output) return b;
      changed = true;
      return { ...b, output: next };
    });
    return changed ? { ...m, content } : m;
  });
}

// Resolve a date-aware tool's date arg: model's explicit value wins, else fall
// back to the dashboard's currently-viewed day (if set), else today (handler
// default). This keeps the agent reading/previewing against the day the user
// is looking at, even when the model omits `date` on a non-today view.
function resolveToolInput(
  toolName: string,
  args: unknown,
  contextDate: string | undefined,
): Record<string, unknown> {
  const input = args as Record<string, unknown>;
  if (
    (toolName === "get_todays_macros" || toolName === "preview_meal") &&
    contextDate &&
    (input.date == null || input.date === "")
  ) {
    return { ...input, date: contextDate };
  }
  return input;
}

// True when a lookup_food result has at least one food that is in neither the
// pantry nor the food index (single or batch shape).
function indexMissed(output: string): boolean {
  const r = tryParseJson(output) as
    | {
        found?: boolean;
        products?: unknown[];
        results?: Array<{ found?: boolean; products?: unknown[] }>;
      }
    | null
    | undefined;
  if (!r || typeof r !== "object") return false;
  const rows = Array.isArray(r.results) ? r.results : [r];
  return rows.some(
    (x) => x.found === false && Array.isArray(x.products) && x.products.length === 0,
  );
}

// Max calls per turn for tools that are slow (network) or billed per call.
// A food lookup once chained seven web_fetch calls for "pasta cooked" in one
// turn; three is plenty to read a source and a fallback.
const TOOL_TURN_CAPS: Record<string, number> = {
  web_fetch: 3,
  $web_search: 3,
};

const BUDGET_NOTE =
  "[Step budget reached — do NOT call any more tools. Answer the user now in a few lines with what you already have; if something is still missing, say what.]";

// The forced-answer step's view of the conversation: the last message (this
// step's tool results) gains a budget note. A copy — the note is never
// persisted, so history stays a plain tool_result → assistant reply.
function withBudgetNote(messages: FaMessage[]): FaMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  const content: FaBlock[] =
    typeof last.content === "string" ? [{ kind: "text", text: last.content }] : [...last.content];
  content.push({ kind: "text", text: BUDGET_NOTE });
  return [...messages.slice(0, -1), { ...last, content } as FaMessage];
}

function sanitizeOrphanToolUses(messages: FaMessage[]): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return;
  if (typeof last.content === "string" || !Array.isArray(last.content)) return;
  const orphanIds = last.content
    .filter((b): b is FaToolCallBlock => b.kind === "tool_call")
    .map((b) => b.callId);
  if (orphanIds.length === 0) return;
  messages.push({
    role: "user",
    content: orphanIds.map((id): FaToolResultBlock => ({
      kind: "tool_result",
      callId: id,
      output: "[not executed]",
    })),
  });
}

// Repair loaded history that ends with (or contains) an assistant `tool_call`
// whose gate was never resolved — the user closed the tab on a pending
// entry-tool card, which we persist the moment the gate opens. Every `tool_call`
// must be followed by a matching `tool_result` or the provider rejects the
// request, so merge a synthetic "not completed" result into the user message
// that follows. Merging (rather than inserting a standalone message) keeps the
// user/assistant alternation valid when that next message is the new prompt.
// The original `tool_call` is left intact so the UI still renders the card.
//
// The fill is marked `transient` so it is NEVER persisted (stripTransientToolResults
// in appendConversation drops it). This is what lets a user save a pending card
// even after sending another message first: without the marker the fill would be
// flushed into that next user message, recording a (canceled) result that strands
// the card and blocks the /resolve dead-gate path. It's re-derived on every load,
// so provider validity holds without persisting it.
function repairDanglingToolUses(messages: FaMessage[]): void {
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ids = m.content
      .filter((b): b is FaToolCallBlock => b.kind === "tool_call")
      .map((b) => b.callId);
    if (ids.length === 0) continue;
    const next = messages[i + 1];
    if (next.role !== "user") continue;
    const satisfied = new Set<string>();
    if (Array.isArray(next.content)) {
      for (const b of next.content) {
        if (b.kind === "tool_result") satisfied.add(b.callId);
      }
    }
    const missing = ids.filter((id) => !satisfied.has(id));
    if (missing.length === 0) continue;
    const fill: FaToolResultBlock[] = missing.map((id) => ({
      kind: "tool_result",
      callId: id,
      output: JSON.stringify({
        canceled: true,
        reason: "not completed before the next message",
      }),
      transient: true,
    }));
    const nextContent: FaBlock[] = Array.isArray(next.content)
      ? next.content
      : [{ kind: "text", text: next.content }];
    messages[i + 1] = { role: "user", content: [...fill, ...nextContent] };
  }
}

// Symmetric counterpart to repairDanglingToolUses: strip any `tool_result`
// block whose `callId` was never introduced by an earlier `tool_call`.
// On the wire such an orphan becomes a `tool` message with an unknown
// tool_call_id — Kimi/OpenAI-compat providers reject the whole request with
// "400 Invalid request: tool_call_id is not found", and Anthropic rejects it
// too — so one orphan bricks every subsequent turn until it's removed.
//
// Orphans arise when the assistant message carrying the tool_call is lost or
// reordered relative to its result: a malformed assistant row coerced to an
// empty content array on save (stripImagesFromMessage), a row dropped on load
// (loadConversation), or interleaved concurrent turns for the same user whose
// append-only rows land out of tool_call→tool_result order.
//
// Length-preserving (mutates each affected message's content in place) so the
// caller's persistedLen / ledger-index bookkeeping stays valid. Like the other
// repairs it only fixes the in-memory copy sent to the provider — the dormant
// orphan row stays in the DB and is re-stripped on every load.
function repairOrphanToolResults(messages: FaMessage[]): void {
  const seenToolUseIds = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.kind === "tool_call") seenToolUseIds.add(b.callId);
      }
      continue;
    }
    if (m.role !== "user") continue;
    const hasOrphan = m.content.some(
      (b) => b.kind === "tool_result" && !seenToolUseIds.has(b.callId),
    );
    if (!hasOrphan) continue;
    m.content = m.content.filter((b) => b.kind !== "tool_result" || seenToolUseIds.has(b.callId));
  }
}

// Drop `thinking` blocks from all assistant messages. Used when the request
// has thinking off so the model doesn't see the pattern in history and mimic
// it in plain text. The API only requires preserving thinking blocks when the
// *current* request also has thinking enabled — since we're disabling for this
// request, we can strip freely.
function stripAllThinkingBlocks(msg: FaMessage): FaMessage {
  if (msg.role !== "assistant") return msg;
  if (typeof msg.content === "string") return msg;
  if (!Array.isArray(msg.content)) return msg;
  const cleaned = msg.content.filter((b) => {
    return b.kind !== "thinking";
  });
  return { ...msg, content: cleaned };
}

// Try to parse a tool's JSON-string result back into an object so structured
// log shippers can index its fields. Falls back to the raw string when the
// tool returned a non-JSON payload (or, defensively, malformed JSON).
function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Deterministic JSON for the anti-thrash signature: object keys are sorted at
// every depth so two semantically-identical tool inputs that differ only in
// key order produce the same string (and thus collide in executedMutations).
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

// Shallow diff between what the model proposed and what the user saved via
// the form gate. Used to prepend an explicit "the user edited this" notice
// to the tool_result so the model doesn't mistake the edits for its own
// miscall and try to "fix" them by deleting + re-logging.
type UserEdit = { field: string; from: unknown; to: unknown };
function diffUserEdits(
  proposed: Record<string, unknown>,
  saved: Record<string, unknown>,
): UserEdit[] {
  const edits: UserEdit[] = [];
  const keys = new Set([...Object.keys(proposed), ...Object.keys(saved)]);
  for (const k of keys) {
    const a = proposed[k];
    const b = saved[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      edits.push({ field: k, from: a, to: b });
    }
  }
  return edits;
}

function formatUserEditNotice(edits: UserEdit[]): string {
  const fmt = (v: unknown) => (v === undefined ? "(unset)" : JSON.stringify(v));
  const lines = edits.map((e) => `- ${e.field}: ${fmt(e.from)} → ${fmt(e.to)}`).join("\n");
  return (
    "[USER EDITED THE FORM BEFORE SAVE] The user changed these fields in " +
    "the form gate. The saved values below are the USER'S INTENT — NOT a " +
    "mistake on your end. Acknowledge the saved values factually and move " +
    "on. Do NOT call delete_meal / delete_body_comp_entry / " +
    "delete_workout_session / update_meal / " +
    "update_food (or any other delete/update tool) to revert these edits " +
    "back to what you originally proposed unless the user EXPLICITLY asks " +
    "for that correction.\n" +
    lines +
    "\n\n"
  );
}

function accumulateUsage(total: ChatUsage, u: ChatUsage): void {
  total.input_tokens += u.input_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? 0;
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  total.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  if (u.web_search_requests) {
    total.web_search_requests = (total.web_search_requests ?? 0) + u.web_search_requests;
  }
}

// Tool status-pill labels now live with their category in TOOL_META (tools/registry.ts),
// a single source of truth the agent reads via getToolLabel / getToolCategory.

// --- intent router (progressive disclosure of tools) ---
// Cheap, deterministic keyword classifier. Maps the last few user messages
// to one of the stable TOOL_GROUPS so each domain has its own cached prefix.
//
// "all" is the safe fallback — returned when intent is ambiguous (multiple
// domains hit), when no domain hits, or when the messages have no
// extractable text. False positives just widen the cache (which is fine);
// only false confidence in a wrong narrow group hurts UX, so the matching is
// intentionally conservative: a unique domain signal narrows down, anything
// else falls back to "all".
//
// The router scans the latest ROUTER_LOOKBACK user messages, not just the
// newest one, so mid-flow context survives a terse follow-up: "71.5 kg, 15%
// bf" two messages before "i train 4x a week" keeps the progress domain in
// scope (two domains hit → "all"). Even with the lookback the router can
// still guess wrong — that's what the request_tools escape hatch in the
// chat() loop is for.
//
// We do NOT call an LLM for routing. A per-request Haiku classifier would
// add ~$0.001 and ~150-300ms before the main turn, AND would itself be a
// cache miss most of the time. Keywords cover the obvious cases for free.
const ROUTER_LOOKBACK = 3;

function pickToolGroup(messages: FaMessage[]): ToolGroup {
  // Walk backwards collecting the last few user messages that carry actual
  // text. Tool-result-only user messages yield "" and don't use up a slot.
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < ROUTER_LOOKBACK; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const t = extractText(m.content);
    if (t) texts.push(t);
  }
  const text = texts.join(" ").toLowerCase();
  if (!text) return "all";
  const scores = {
    nutrition: matchCount(text, NUTRITION_RX),
    training: matchCount(text, TRAINING_RX),
    progress: matchCount(text, PROGRESS_RX),
    pantry: matchCount(text, PANTRY_RX),
  } as const;
  const hits = (Object.entries(scores) as Array<[Exclude<ToolGroup, "all">, number]>).filter(
    ([, n]) => n > 0,
  );
  if (hits.length === 1) return hits[0][0];
  return "all";
}

function matchCount(text: string, rx: RegExp): number {
  const m = text.match(rx);
  return m ? m.length : 0;
}

function extractText(content: FaMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is FaTextBlock => b.kind === "text")
    .map((b) => b.text)
    .join(" ");
}

// Gather the citations attached to an iteration's text blocks, de-duped by URL
// (a source cited for several sentences shows once), with the round-trip `ref`
// stripped — the UI only needs url/title/citedText.
function collectCitations(content: FaBlock[]): Array<Omit<FaCitation, "ref">> {
  const byUrl = new Map<string, Omit<FaCitation, "ref">>();
  for (const b of content) {
    if (b.kind !== "text" || !b.citations) continue;
    for (const c of b.citations) {
      const key = c.url ?? c.title ?? c.citedText ?? "";
      if (!key || byUrl.has(key)) continue;
      byUrl.set(key, { url: c.url, title: c.title, citedText: c.citedText });
    }
  }
  return [...byUrl.values()];
}

// Word-boundary patterns, case-insensitive, /g for hit counting. Keep these
// narrow enough that a generic message ("hi", "what's my BMR") doesn't match
// any of them — that's how the router falls back to "all" for queries that
// only need CORE tools.
// Supplements are pantry foods now, so their keywords (whey, creatine,
// vitamin…) route to the nutrition group, which carries add_food/lookup_food.
const NUTRITION_RX =
  /\b(ate|eat|eaten|eating|breakfast|lunch|dinner|snack|meal|meals|food|foods|protein|kcal|calorie|calories|macro|macros|carb|carbs|fiber|chicken|rice|oats|banana|apple|eggs?|pasta|bread|yogurt|milk|substitute|substitution|swap|barcode|supplement|supplements|vitamin|vitamins|d3|b12|creatine|whey|magnesium|zinc|multivitamin|water|hydration|hydrate|hydrated|drink|drank|thirsty|glass|bottle)\b/gi;
const TRAINING_RX =
  /\b(train|trained|training|workout|workouts|exercise|exercised|gym|lift|lifted|lifting|squat|deadlift|bench|press|row|cardio|ran|running|jog|jogged|pushup|pullup|reps?|sets?)\b/gi;
const PROGRESS_RX =
  /\b(weigh|weighed|weighing|weight|kg|lbs?|pounds?|bodyfat|bf%|composition|waist|progress)\b/gi;
const PANTRY_RX =
  /\b(pantry|fridge|shopping|bought|purchased?|tub|sack|restock|to.buy|receipts?|grocer(?:y|ies)|haul|costco|supermarket|csv|diet|rotation|planned)\b/gi;

// Turn tier for this message: "deep" when the user wants judgement, advice or
// a plan built (worth a reasoning pass), "fast" for everything else — logging,
// lookups, "what's left today", greetings — where thinking only adds latency.
// Keyword-based like pickToolGroup, English + Greek (the product languages),
// read from THIS message only so a past advice question doesn't keep later
// "log 200g rice" turns slow. Long messages and photos go deep. LLM_TIERING=off
// sends every turn deep.
export type TurnTier = "fast" | "deep";

const DEEP_RX =
  /\b(should|shall|enough|why|recommend\w*|suggest\w*|advi[cs]e|compare|comparison|review|analy[sz]e|assess|evaluate|improve|optimi[sz]e|better|worth|feel like|what do you think|thoughts|explain|strategy|plateau\w*|stuck|design|program(me)?|routine|split|periodi[sz]\w*|build me|make me|create (a|me)|plan for|help me (decide|choose|figure))\b|\b(is|am|are) (it|i|this|that|my \w+) (ok|okay|good|bad|right|enough|on track)\b|γιατί|πρέπει|αρκετ|σύγκρ|συγκρ|πρότειν|προτειν|συμβουλ|αξιολ|βελτ|πρόγραμμα|προγραμμα|ανάλυσ|αναλυσ|εξήγ|εξηγ|τι λες|τι πιστεύ|τι πιστευ|καλύτερ|καλυτερ|στρατηγ/i;
const DEEP_MIN_CHARS = 280;

export function pickTurnTier(userMessage: UserMessage): TurnTier {
  if (process.env.LLM_TIERING === "off") return "deep";
  if (typeof userMessage !== "string" && userMessage.some((b) => b.kind === "image")) {
    return "deep";
  }
  // Drop the server's leading `[Today: …]`-style context tags before matching.
  const text = extractText(userMessage)
    .replace(/^(?:\[[^\]\n]*\]\n?)+/, "")
    .trim();
  if (text.length >= DEEP_MIN_CHARS) return "deep";
  return DEEP_RX.test(text) ? "deep" : "fast";
}

// Prepend one context tag line to the user message, joining the server's tag
// block (apps/server buildUserMessage) so the UI's tag-strip removes it too.
function withLeadingTag(msg: UserMessage, tag: string): UserMessage {
  if (typeof msg === "string") return `${tag}\n${msg}`;
  const [first, ...rest] = msg;
  if (first?.kind === "text") return [{ ...first, text: `${tag}\n${first.text}` }, ...rest];
  return [{ kind: "text", text: tag }, ...msg];
}

export async function resetConversation(userId: string): Promise<void> {
  await new UserStorage(userId).resetConversation();
}

export async function getConversation(userId: string): Promise<unknown[]> {
  return new UserStorage(userId).loadConversation();
}

export async function getConversationPage(
  userId: string,
  opts: { before?: number; limit: number },
): Promise<{ messages: unknown[]; nextCursor: number | null }> {
  return new UserStorage(userId).loadConversationPage(opts);
}
