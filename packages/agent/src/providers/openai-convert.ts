/**
 * Canonical (`Fa*`) <-> OpenAI conversion helpers.
 *
 * The OpenAI adapter (and any OpenAI-compatible adapter — Kimi, DeepSeek, etc.)
 * goes through these helpers at the wire so adapters stay thin. Conversion is
 * lossy in one direction: extended-thinking blocks are dropped on the way out
 * (OpenAI chat completions has no equivalent), and on the way back any OpenAI
 * reasoning summary (`message.reasoning_content` on some deployments) is folded
 * into a synthetic `thinking` block so it persists.
 */
import type { FaBlock, FaMessage, FaSystemBlock, FaToolDef, JsonObject } from "../schema/index.ts";

// Loosely-typed structural shapes. We import the openai SDK lazily inside
// the adapter so the type-only import here doesn't pull in the package for
// consumers that never instantiate it.
export type OpenAIChatMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content: string | Array<OpenAIUserContent>;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<OpenAIToolCall>;
      // Kimi thinking-class models require this on assistant messages that
      // carry tool_calls in history. Other providers ignore the field.
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIConvertOptions = {
  // Re-attach `reasoning_content` (sourced from canonical `thinking` blocks)
  // onto assistant messages that include tool_calls. Required for Kimi
  // thinking-class models, ignored elsewhere.
  preserveReasoning?: boolean;
};

export type OpenAIUserContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

// Concat all system text blocks into a single OpenAI system message.
// The prompt-cache hint is dropped — OpenAI auto-caches >1024-token prefixes
// without an explicit breakpoint.
export function systemBlocksToOpenAI(system: FaSystemBlock[]): string {
  return system.map((b) => b.text).join("\n\n");
}

// Convert the canonical tool registry to OpenAI function tools.
export function toolsToOpenAI(tools: FaToolDef[]): OpenAIFunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      // `schema` is already a JSON Schema; OpenAI expects the same.
      parameters: t.schema as unknown as Record<string, unknown>,
    },
  }));
}

// Convert the canonical conversation to OpenAI's `messages` array. One
// canonical message may produce multiple OpenAI messages:
//   - assistant message with text + tool_call blocks → one assistant message
//   - user message with mixed text + tool_result blocks → multiple tool
//     messages plus an optional follow-up user message
export function messagesToOpenAI(
  messages: FaMessage[],
  opts: OpenAIConvertOptions = {},
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") pushUser(out, m);
    else pushAssistant(out, m, opts);
  }
  return out;
}

function pushUser(out: OpenAIChatMessage[], m: FaMessage): void {
  if (typeof m.content === "string") {
    out.push({ role: "user", content: m.content });
    return;
  }
  // Tool results are role: 'tool' on OpenAI. Anything else stays as a user
  // message. Emit tool messages first (they refer to the prior assistant's
  // tool_calls and must come before any free-form follow-up), then a single
  // user message bundling the remaining text/image blocks.
  const toolResults: Array<{ callId: string; output: string }> = [];
  const userBlocks: OpenAIUserContent[] = [];
  for (const block of m.content) {
    if (block.kind === "tool_result") {
      toolResults.push({ callId: block.callId, output: block.output });
    } else if (block.kind === "text") {
      userBlocks.push({ type: "text", text: block.text });
    } else if (block.kind === "image") {
      const url = faImageToDataUrl(block);
      if (url) userBlocks.push({ type: "image_url", image_url: { url } });
    }
    // Other block kinds silently dropped — most OpenAI-compatible servers
    // don't accept them on user messages.
  }
  for (const tr of toolResults) {
    out.push({ role: "tool", tool_call_id: tr.callId, content: tr.output });
  }
  if (userBlocks.length === 1 && userBlocks[0].type === "text") {
    out.push({ role: "user", content: userBlocks[0].text });
  } else if (userBlocks.length > 0) {
    out.push({ role: "user", content: userBlocks });
  }
}

function pushAssistant(out: OpenAIChatMessage[], m: FaMessage, opts: OpenAIConvertOptions): void {
  if (typeof m.content === "string") {
    out.push({ role: "assistant", content: m.content });
    return;
  }
  let text = "";
  let reasoning = "";
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of m.content) {
    if (block.kind === "text") {
      text += block.text;
    } else if (block.kind === "tool_call") {
      toolCalls.push({
        id: block.callId,
        type: "function",
        function: {
          name: block.tool,
          arguments: JSON.stringify(block.args ?? {}),
        },
      });
    } else if (opts.preserveReasoning && block.kind === "thinking") {
      // Kimi thinking-class models require this back on the assistant message
      // alongside tool_calls in history; other providers ignore it.
      reasoning += block.text;
    }
    // thinking (when preserveReasoning is off) and images dropped — no OpenAI
    // equivalent on an assistant message.
  }
  const msg: OpenAIChatMessage & {
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
  } = {
    role: "assistant",
    content: text === "" ? null : text,
  };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (opts.preserveReasoning && toolCalls.length) {
    // Kimi-thinking 400s on any tool-call assistant message that omits this
    // field outright ("thinking is enabled but reasoning_content is missing").
    // The validator checks presence, not content — empty string is fine and
    // is the only sane value when:
    //   - the server didn't emit reasoning_content deltas for the turn
    //     (happens on $web_search round-trips and short tool-only turns),
    //   - or the message is legacy data persisted before preserveReasoning
    //     existed, so no thinking block was ever captured.
    msg.reasoning_content = reasoning;
  }
  out.push(msg);
}

function faImageToDataUrl(block: Extract<FaBlock, { kind: "image" }>): string | null {
  const s = block.source;
  if (s.kind === "url") return s.url;
  return `data:${s.mediaType};base64,${s.data}`;
}

// ---------- response → canonical ----------

// Build a canonical `Fa*` content[] from an OpenAI assistant message. Tool
// calls become tool_call blocks (args parsed from JSON), text becomes a text
// block, and any reasoning summary becomes a thinking block.
export function openAIMessageToContent(
  msg: {
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
    reasoning_content?: string;
  },
  opts: { hideReasoning?: boolean } = {},
): FaBlock[] {
  const out: FaBlock[] = [];
  // Reasoning first so the persisted block ordering matches the wire stream
  // (reasoning streams before content on Kimi thinking models).
  if (msg.reasoning_content) {
    out.push({
      kind: "thinking",
      text: msg.reasoning_content,
      ...(opts.hideReasoning ? { hidden: true as const } : {}),
    });
  }
  if (msg.content != null && msg.content !== "") {
    out.push({ kind: "text", text: msg.content });
  }
  for (const tc of msg.tool_calls ?? []) {
    let args: JsonObject = {};
    try {
      const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      args =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as JsonObject)
          : { _value: parsed };
    } catch {
      // Malformed JSON args from the model — pass through as a string field
      // so the tool handler can decide how to fail gracefully.
      args = { _raw_arguments: tc.function.arguments };
    }
    out.push({
      kind: "tool_call",
      callId: tc.id,
      tool: tc.function.name,
      args,
    });
  }
  return out;
}

// Map OpenAI finish_reason to the canonical (Anthropic-compatible) set.
export function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    case "content_filter":
      return "refusal";
    default:
      return reason ?? "end_turn";
  }
}
