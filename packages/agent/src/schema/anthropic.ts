/**
 * Canonical (`Fa*`) <-> Anthropic SDK translation.
 *
 * The ONLY module that maps the canonical schema to/from `@anthropic-ai/sdk`
 * message/tool shapes. The Anthropic adapter uses it at the wire; the DB
 * backfill reuses `anthropicContentToFa()` so the inbound conversion lives in
 * exactly one place.
 *
 * Anthropic was the historical canonical format, so most of this is a
 * straightforward field rename (`kind`<->`type`, `callId`<->`id`/`tool_use_id`,
 * `args`<->`input`, `output`<->`content`). Thinking blocks round-trip via
 * `signature` / the `redacted` flag.
 */
import type Anthropic from "@anthropic-ai/sdk";

import type {
  FaBlock,
  FaCitation,
  FaImageSource,
  FaMessage,
  FaSystemBlock,
  FaToolDef,
  JsonObject,
} from "./types.ts";

// ---------- Fa -> Anthropic (request side) ----------

export function faSystemToAnthropic(system: FaSystemBlock[]): Anthropic.TextBlockParam[] {
  return system.map((b) => ({
    type: "text",
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

export function faToolsToAnthropic(tools: FaToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema as unknown as Anthropic.Tool["input_schema"],
  }));
}

export function faMessagesToAnthropic(messages: FaMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map(faBlockToAnthropic),
  }));
}

function faBlockToAnthropic(b: FaBlock): Anthropic.ContentBlockParam {
  switch (b.kind) {
    case "text": {
      // Only citations with a `ref` (Anthropic `encrypted_index`) form a valid
      // web-search citation param; drop the rest so we never send a malformed
      // block back to the provider.
      const citations = (b.citations ?? []).filter((c) => c.ref != null).map(faCitationToAnthropic);
      return {
        type: "text",
        text: b.text,
        ...(citations.length ? { citations } : {}),
      };
    }
    case "thinking":
      return b.redacted
        ? ({ type: "redacted_thinking", data: b.text } as unknown as Anthropic.ContentBlockParam)
        : ({
            type: "thinking",
            thinking: b.text,
            signature: b.signature ?? "",
          } as unknown as Anthropic.ContentBlockParam);
    case "tool_call":
      return { type: "tool_use", id: b.callId, name: b.tool, input: b.args };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.callId,
        content: b.output,
        ...(b.isError ? { is_error: true } : {}),
      };
    case "image":
      return { type: "image", source: faImageSourceToAnthropic(b.source) };
  }
}

// Fa citation -> Anthropic web-search citation param. Callers pass only
// citations carrying a `ref`, so `encrypted_index` is always present. Cast
// through `unknown` because the pinned SDK doesn't yet type the
// `web_search_result_location` variant (same reason the web_search tool is
// widened in tools.ts).
function faCitationToAnthropic(c: FaCitation): Anthropic.TextCitationParam {
  return {
    type: "web_search_result_location",
    url: c.url ?? "",
    title: c.title ?? null,
    cited_text: c.citedText ?? "",
    encrypted_index: c.ref ?? "",
  } as unknown as Anthropic.TextCitationParam;
}

function faImageSourceToAnthropic(s: FaImageSource): Anthropic.ImageBlockParam["source"] {
  if (s.kind === "url") return { type: "url", url: s.url };
  return {
    type: "base64",
    media_type: s.mediaType as Anthropic.Base64ImageSource["media_type"],
    data: s.data,
  };
}

// ---------- Anthropic -> Fa (response + backfill side) ----------

// Convert an Anthropic message `content` (string or content-block array) to
// canonical form. Mirrors the message shape: a string stays a string.
export function anthropicContentToFa(
  content: Anthropic.MessageParam["content"] | Anthropic.ContentBlock[],
): string | FaBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return [];
  const out: FaBlock[] = [];
  for (const raw of content) {
    const block = anthropicBlockToFa(raw);
    if (block) out.push(block);
  }
  return out;
}

function anthropicBlockToFa(raw: unknown): FaBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  switch (b.type) {
    case "text": {
      const citations = anthropicCitationsToFa(b.citations);
      return {
        kind: "text",
        text: typeof b.text === "string" ? b.text : "",
        ...(citations.length ? { citations } : {}),
      };
    }
    case "thinking":
      return {
        kind: "thinking",
        text: typeof b.thinking === "string" ? b.thinking : "",
        ...(typeof b.signature === "string" && b.signature ? { signature: b.signature } : {}),
      };
    case "redacted_thinking":
      return {
        kind: "thinking",
        text: typeof b.data === "string" ? b.data : "",
        redacted: true,
      };
    // Anthropic-managed server tools (e.g. web_search) are normalized to a
    // plain call/result pair so history stays replayable across providers.
    case "tool_use":
    case "server_tool_use":
      return {
        kind: "tool_call",
        callId: typeof b.id === "string" ? b.id : "",
        tool: typeof b.name === "string" ? b.name : "",
        args:
          b.input && typeof b.input === "object" && !Array.isArray(b.input)
            ? (b.input as JsonObject)
            : {},
      };
    case "tool_result":
    case "web_search_tool_result":
      return {
        kind: "tool_result",
        callId: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
        output: toolResultContentToString(b.content),
        ...(b.is_error === true ? { isError: true } : {}),
      };
    case "image":
      return imageBlockToFa(b);
    default:
      // Unknown / unsupported block — drop it rather than persist a shape no
      // provider can consume.
      return null;
  }
}

// Anthropic attaches a `citations` array to text blocks (web_search_result_location
// and document-location variants). Keep the fields we surface plus the opaque
// `encrypted_index` so the citation can round-trip back to the provider.
function anthropicCitationsToFa(raw: unknown): FaCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: FaCitation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const citation: FaCitation = {};
    if (typeof c.url === "string" && c.url) citation.url = c.url;
    if (typeof c.title === "string" && c.title) citation.title = c.title;
    if (typeof c.cited_text === "string" && c.cited_text) citation.citedText = c.cited_text;
    if (typeof c.encrypted_index === "string" && c.encrypted_index)
      citation.ref = c.encrypted_index;
    if (Object.keys(citation).length) out.push(citation);
  }
  return out;
}

function imageBlockToFa(b: Record<string, unknown>): FaBlock | null {
  const src = b.source;
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if (s.type === "url" && typeof s.url === "string") {
    return { kind: "image", source: { kind: "url", url: s.url } };
  }
  if (s.type === "base64" && typeof s.data === "string" && typeof s.media_type === "string") {
    return {
      kind: "image",
      source: { kind: "base64", mediaType: s.media_type, data: s.data },
    };
  }
  return null;
}

// Anthropic tool_result content is `string | Array<text|image|...>`. Canonical
// `output` is a plain string — concat text parts, drop the rest.
function toolResultContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      const part = p as { type?: string; text?: string };
      return part.type === "text" ? (part.text ?? "") : "";
    })
    .filter(Boolean)
    .join("\n");
}
