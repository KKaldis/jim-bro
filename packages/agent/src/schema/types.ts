/**
 * Canonical, vendor-neutral conversation + tool schema (`Fa*`).
 *
 * This is THE canonical format the agent loop, tool registry, and storage
 * speak. It is deliberately NOT Anthropic's content-block shape — each
 * provider adapter translates `Fa*` to/from its own wire format at the
 * boundary (see schema/anthropic.ts, providers/openai-convert.ts,
 * providers/google-convert.ts). Nothing here imports a provider SDK.
 *
 * Design notes:
 *   - Discriminant is `kind` (not `type`) so a raw provider block can never be
 *     mistaken for a canonical one.
 *   - Tool calls carry `callId` / `tool` / `args`; results carry `callId` /
 *     `output`. The id links a result back to its call across every provider.
 *   - `thinking` carries the text plus an optional `signature` (Anthropic
 *     requires it back on round-trip) and a `redacted` flag for Anthropic's
 *     encrypted `redacted_thinking` variant (text holds the opaque data) so
 *     the Anthropic translator is lossless.
 *   - No `unknown`: model-generated tool args and JSON-Schema docs are typed
 *     as `JsonObject`.
 */

// Concrete JSON value type — used instead of `unknown` so every field stays
// fully typed end-to-end (storage, wire schema, frontend).
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type FaRole = "user" | "assistant";

// A source backing a claim in an assistant text block. Modeled on Anthropic's
// web-search citations (`web_search_result_location`), which hang off the text
// block they support. `ref` is a provider-opaque round-trip token (Anthropic's
// `encrypted_index`) preserved verbatim so a citation survives a replay; it's
// absent for citations synthesized outside a provider.
export type FaCitation = {
  // Canonical URL of the source, when web-based.
  url?: string;
  // Human-facing source title (article / page title).
  title?: string;
  // The exact snippet from the source that supports the cited text.
  citedText?: string;
  // Provider round-trip token (Anthropic `encrypted_index`). Only citations
  // carrying a `ref` can be sent back to the provider on the request side.
  ref?: string;
};

export type FaTextBlock = {
  kind: "text";
  text: string;
  // Sources grounding this text, when the provider (or a tool) attached any.
  // Absent for ordinary model prose.
  citations?: FaCitation[];
};
export type FaThinkingBlock = {
  kind: "thinking";
  text: string;
  // Anthropic returns an opaque signature on thinking blocks and requires it
  // back verbatim when thinking is enabled. Empty/absent for other providers.
  signature?: string;
  // Anthropic's encrypted `redacted_thinking`: `text` holds the opaque data.
  redacted?: true;
  // Reasoning the provider streams regardless of the user's toggle (Kimi
  // thinking models), captured with the toggle off. Kept in history because
  // the provider needs it back on tool-call turns, but never shown in the UI.
  hidden?: true;
};
export type FaToolCallBlock = {
  kind: "tool_call";
  callId: string;
  tool: string;
  args: JsonObject;
};
export type FaToolResultBlock = {
  kind: "tool_result";
  callId: string;
  output: string;
  isError?: boolean;
  // In-memory only: a synthetic result injected to keep an unresolved gate's
  // conversation valid for the provider (see repairDanglingToolUses). Stripped
  // before persistence so the tool_call stays dangling and the pending card
  // remains savable via the /resolve dead-gate path. Never written to the DB or
  // the provider wire — the wire converters read only callId/output/isError.
  transient?: true;
};
export type FaImageBlock = { kind: "image"; source: FaImageSource };

export type FaImageSource =
  { kind: "url"; url: string } | { kind: "base64"; mediaType: string; data: string };

export type FaBlock =
  FaTextBlock | FaThinkingBlock | FaToolCallBlock | FaToolResultBlock | FaImageBlock;

export type FaMessage = { role: FaRole; content: string | FaBlock[] };

// A client-side tool the agent executes. `schema` is a JSON-Schema object
// describing `args` — already provider-neutral, passed through to each wire
// format (renamed to `input_schema` / `parameters` per provider).
export type FaToolDef = {
  name: string;
  description: string;
  schema: JsonObject;
};

// One system-prompt block. `cache` is an optional prompt-cache hint honored
// only by Anthropic; other providers ignore it.
export type FaSystemBlock = { text: string; cache?: boolean };
