// Stored conversation → chat turns: history parsing, citation normalization and tag stripping.
import { getResultCard } from "../cards/resultCards";
import type { JsonSchema } from "../forms/ToolForm";
import { getSavedIdentity } from "../forms/overrides";
import { categoryOf } from "../lib/toolCategory";
import { type Block, type Citation, MUTATING_TOOLS, type Turn } from "./types";

// Persisted-history image placeholder: the server replaces stripped image
// blocks with an `[image: <description>]` text block (see packages/agent). The
// description is a vision caption, or this exact generic string when no caption
// exists. Must stay byte-identical to the literal in
// packages/agent/src/storage.ts (stripImagesFromMessage).
const STRIPPED_IMAGE_FALLBACK = "stripped from history — re-attach to reference";
const IMAGE_PLACEHOLDER_RE = /^\[image: ([\s\S]+)\]$/;

// Tools that rehydrate as gate-form cards on history reload. This is
// MUTATING_TOOLS plus the non-mutating ask_user / ask_user_multi pickers:
// those write nothing, but the user DID make a choice through their gate, so on
// reload we want the committed selection shown — the picked option(s)
// highlighted and disabled — instead of a bare pill.
const GATE_FORM_TOOLS: ReadonlySet<string> = new Set([
  ...MUTATING_TOOLS,
  "ask_user",
  "ask_user_multi",
]);

// Persisted tool_result output is usually bare JSON, but a save gate the user
// edited before saving prepends a "[USER EDITED THE FORM BEFORE SAVE] … \n\n"
// notice ahead of the JSON (see agent.ts formatUserEditNotice). Parse
// tolerantly so history reload still recovers the structured result — needed
// for result cards AND the create→edit identity fold (a saved recipe/plan can
// only be edited in place once its id is recovered). Returns undefined when the
// output holds no JSON at all.
function parseToolOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    // Fall through: strip a leading human-readable notice, then retry.
  }
  const sep = output.indexOf("\n\n");
  if (sep >= 0) {
    try {
      return JSON.parse(output.slice(sep + 2));
    } catch {
      // Still not JSON after the notice — give up.
    }
  }
  return undefined;
}

// Convert persisted Anthropic MessageParam[] into the Turn[] the UI renders.
// `schemas` is a (toolName → input_schema) map; when present, mutating tool
// calls rehydrate as `tool_form` cards in saved/canceled state instead of
// the bare pills. When the map is empty (cold load) mutating tools fall
// back to pill rendering, which is still readable.
export function messagesToTurns(
  messages: unknown[],
  schemas: Record<string, JsonSchema>,
  cachedImages: string[] = [],
): Turn[] {
  // Locally-cached originals of stripped images (oldest-first). Image
  // placeholders in history appear in the same send order, so we align the
  // cache to placeholders from the most-recent end: the last `cachedImages
  // .length` placeholders re-hydrate to real images, older ones fall back to
  // their caption/placeholder. `imgOffset` is the count of placeholders that
  // precede the cached window.
  const totalImagePlaceholders = countImagePlaceholders(messages);
  const imgOffset = totalImagePlaceholders - cachedImages.length;
  let imgSeq = 0; // global index of the current image placeholder
  // First pass: index tool_result blocks by callId so we can attach
  // ok/canceled status when rendering the matching tool_call. Cancellation
  // isn't marked with isError (semantically not an error), so we sniff for
  // a `canceled: true` field in the JSON output.
  const toolOk = new Map<string, boolean>();
  const toolCanceled = new Map<string, boolean>();
  // Parsed tool_result output per callId, used to rebuild result cards on
  // history reload (carded read/compute tools persist their full result JSON).
  const toolResultData = new Map<string, unknown>();
  for (const m of messages) {
    if (!isMessage(m)) continue;
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (isObj(b) && b.kind === "tool_result" && typeof b.callId === "string") {
        toolOk.set(b.callId, b.isError !== true);
        if (typeof b.output === "string") {
          const parsed = parseToolOutput(b.output);
          if (parsed !== undefined) {
            toolResultData.set(b.callId, parsed);
            if (
              parsed &&
              typeof parsed === "object" &&
              (parsed as { canceled?: unknown }).canceled === true
            ) {
              toolCanceled.set(b.callId, true);
            }
          }
        }
      }
    }
  }

  const out: Turn[] = [];
  let openAssistant: Turn | null = null;
  for (const m of messages) {
    if (!isMessage(m)) continue;
    if (m.role === "user") {
      const blocks: Block[] = [];
      if (typeof m.content === "string") {
        const cleaned = stripUserContextTags(m.content);
        if (cleaned.trim()) blocks.push({ kind: "text", text: cleaned });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!isObj(b)) continue;
          if (b.kind === "text" && typeof b.text === "string" && b.text) {
            const cleaned = stripUserContextTags(b.text).trim();
            if (!cleaned) continue;
            // Stripped-image placeholder persisted in place of the actual
            // image (packages/agent). If we still have the original cached
            // locally, re-hydrate it as a real image; otherwise render the
            // caption (or a generic note) as an attachment stand-in.
            const imageNote = IMAGE_PLACEHOLDER_RE.exec(cleaned);
            if (imageNote) {
              const cachedIdx = imgSeq - imgOffset;
              imgSeq++;
              const cachedSrc = cachedIdx >= 0 ? cachedImages[cachedIdx] : undefined;
              if (cachedSrc) {
                blocks.push({ kind: "image", src: cachedSrc });
              } else {
                blocks.push({
                  kind: "image_note",
                  // The generic placeholder carries no real caption — leave the
                  // description off so only the "no longer available" line shows.
                  ...(imageNote[1] === STRIPPED_IMAGE_FALLBACK
                    ? {}
                    : { description: imageNote[1] }),
                });
              }
            } else {
              blocks.push({ kind: "text", text: cleaned });
            }
          }
        }
      }
      if (blocks.length > 0) {
        out.push({ id: crypto.randomUUID(), who: "you", blocks });
        openAssistant = null;
      }
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      const msgCitations: Citation[] = [];
      if (typeof m.content === "string") {
        if (m.content.trim()) blocks.push({ kind: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!isObj(b)) continue;
          if (b.kind === "text" && typeof b.text === "string" && b.text) {
            blocks.push({ kind: "text", text: b.text });
            if (Array.isArray(b.citations)) msgCitations.push(...normalizeCitations(b.citations));
          } else if (
            b.kind === "thinking" &&
            b.hidden !== true &&
            typeof b.text === "string" &&
            b.text.trim()
          ) {
            blocks.push({ kind: "thinking", text: b.text });
          } else if (
            b.kind === "tool_call" &&
            typeof b.callId === "string" &&
            typeof b.tool === "string"
          ) {
            // A tool_call with no tool_result is a gate that was never
            // resolved — the turn was persisted mid-flight when the gate
            // opened (the user closed the tab on a pending card). Render it as
            // still-proposed so it can be saved; that save routes through the
            // dead-gate fallback in onConfirmTool.
            const callId = b.callId;
            const toolName = b.tool;
            const hasResult = toolOk.has(callId);
            const ok = toolOk.get(callId) ?? true;
            const canceled = toolCanceled.get(callId) === true;
            const schema = schemas[toolName];
            // Mutating tools come back as saved/canceled/proposed form cards
            // when we know their schema, seeded with the persisted
            // tool_call.args (the model's proposed values for a still-pending
            // gate, the confirmed values once it ran). Non-mutating tools, or
            // any tool we don't have a schema for, render as the original pill.
            if (GATE_FORM_TOOLS.has(toolName) && schema) {
              // Persisted args hold the model's ORIGINAL proposed input, which
              // for a create has no row id. Fold the id back out of the saved
              // result so a resubmit after reload edits the row it created
              // instead of inserting a duplicate — same contract as the live path.
              const savedResult = ok && !canceled ? toolResultData.get(callId) : undefined;
              const identity =
                savedResult !== undefined ? getSavedIdentity(toolName, savedResult) : null;
              blocks.push({
                kind: "tool_form",
                id: callId,
                toolName,
                label: toolName.replace(/_/g, " "),
                category: categoryOf(toolName),
                schema,
                proposedInput: (b.args as Record<string, unknown> | undefined) ?? {},
                ...(identity ? { identityPatch: identity } : {}),
                status: !hasResult ? "proposed" : canceled || !ok ? "canceled" : "saved",
              });
            } else {
              blocks.push({
                kind: "tool",
                id: callId,
                label: toolName.replace(/_/g, " "),
                category: categoryOf(toolName),
                ok,
              });
            }
            // Rebuild a result card for carded read/compute tools that ran
            // successfully, from the persisted tool_result JSON. The card
            // component renders null if the data isn't card-able.
            if (ok && !canceled && getResultCard(toolName)) {
              const data = toolResultData.get(callId);
              if (data !== undefined) {
                blocks.push({
                  kind: "tool_result_card",
                  id: callId,
                  toolName,
                  category: categoryOf(toolName),
                  data,
                });
              }
            }
          }
        }
      }
      if (blocks.length === 0 && msgCitations.length === 0) continue;
      if (openAssistant) {
        openAssistant.blocks.push(...blocks);
      } else {
        openAssistant = { id: crypto.randomUUID(), who: "assistant", blocks };
        out.push(openAssistant);
      }
      // Fold this message's citations into one deduped Sources footer, kept
      // last on the turn (mirrors addSources on the live path).
      if (msgCitations.length > 0) {
        openAssistant.blocks = withSources(openAssistant.blocks, msgCitations);
      }
    }
  }
  return out;
}

// Count image placeholders across user messages, in render order. Mirrors the
// detection in messagesToTurns exactly so the cached-image alignment lines up
// with the placeholders that will actually be rendered.
function countImagePlaceholders(messages: unknown[]): number {
  let n = 0;
  for (const m of messages) {
    if (!isMessage(m) || m.role !== "user") continue;
    if (typeof m.content === "string") {
      if (IMAGE_PLACEHOLDER_RE.test(stripUserContextTags(m.content).trim())) {
        n++;
      }
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!isObj(b)) continue;
        if (b.kind === "text" && typeof b.text === "string" && b.text) {
          if (IMAGE_PLACEHOLDER_RE.test(stripUserContextTags(b.text).trim())) {
            n++;
          }
        }
      }
    }
  }
  return n;
}

// Coerce the persisted FaCitation[] (unknown-typed after JSON round-trip) into
// UI Citations, keeping only the fields the Sources footer renders.
function normalizeCitations(raw: unknown[]): Citation[] {
  const out: Citation[] = [];
  for (const c of raw) {
    if (!isObj(c)) continue;
    const cite: Citation = {};
    if (typeof c.url === "string") cite.url = c.url;
    if (typeof c.title === "string") cite.title = c.title;
    if (typeof c.citedText === "string") cite.citedText = c.citedText;
    if (cite.url || cite.title || cite.citedText) out.push(cite);
  }
  return out;
}

// Merge `incoming` citations into a turn's single Sources block (deduped by
// URL/title) and return the blocks with that footer pinned last.
export function withSources(blocks: Block[], incoming: Citation[]): Block[] {
  const rest = blocks.filter((b) => b.kind !== "sources");
  const existing = blocks.find(
    (b): b is Extract<Block, { kind: "sources" }> => b.kind === "sources",
  );
  const merged = [...(existing?.items ?? [])];
  const seen = new Set(merged.map((c) => c.url ?? c.title ?? c.citedText));
  for (const c of incoming) {
    const key = c.url ?? c.title ?? c.citedText;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  return merged.length ? [...rest, { kind: "sources", items: merged }] : rest;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function isMessage(x: unknown): x is { role: string; content: unknown } {
  return isObj(x) && typeof x.role === "string" && "content" in x;
}

// Strip the leading `[Today: ...]` / `[User name: ...]` / `[Selected date: ...]` /
// `[Locale: ...]` / `[Viewing: ...]` tags the server prepends to each user
// message (apps/server/src/index.ts), plus the agent's `[State: ...]` snapshot
// (packages/agent buildStateTag). These are ambient context for the agent;
// they shouldn't appear in the rendered chat history.
function stripUserContextTags(text: string): string {
  return text.replace(
    /^(?:\[(?:State|Today|User name|Selected date|Locale|Viewing):[^\]\n]*\]\n?)+\n*/,
    "",
  );
}

// Strip `<thinking>...</thinking>` tags from assistant text. With extended
// thinking off, the model sometimes emits its chain-of-thought as inline
// tagged text; we hide it on render rather than store-modify.
export function stripThinkingTags(text: string): string {
  let out = text.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "");
  const openIdx = out.search(/<thinking\b[^>]*>/i);
  if (openIdx >= 0) out = out.slice(0, openIdx);
  return out;
}
