/**
 * Provider-agnostic LLM interface.
 *
 * The agent loop is provider-aware only at the boundary: it talks to a
 * `LLMProvider` instance, hands it the canonical conversation (our neutral
 * `Fa*` schema — see ../schema) and a tool registry, and consumes normalized
 * stream events. Each adapter converts the `Fa*` shape to/from its own wire
 * format and produces a final `content[]` back in `Fa*` shape, so persistence
 * stays uniform and vendor-neutral. Anthropic is just one such adapter.
 */
import type { FaBlock, FaMessage, FaSystemBlock, FaToolDef } from "../schema/index.ts";

export type ProviderId =
  "anthropic" | "openai" | "kimi" | "google" | "mistral" | "deepseek" | "xai" | "qwen";

// Published API limits per (provider, model). These come from each provider's
// rate-limit page and are static reference values — the actual cap is set by
// the org's tier on the dashboard. See providers/limits.ts.
export type ApiLimits = {
  // Requests per minute.
  rpm?: number;
  // Tokens per minute — input side (some providers split, some combine).
  itpm?: number;
  // Tokens per minute — output side.
  otpm?: number;
  // Combined input+output tokens per minute, when the provider doesn't split.
  tpm?: number;
  // Tokens per day, if published.
  tpd?: number;
  // Free-form: the tier these numbers correspond to (e.g. "Tier 1", "free").
  tier?: string;
};

export type ProviderCapabilities = {
  vision: boolean;
  // Native extended-thinking / reasoning mode the agent can request.
  thinking: boolean;
  // Provider-managed server tools (e.g. Anthropic's `web_search_20250305`).
  serverTools: boolean;
  // Explicit prompt-cache breakpoints honored by the API (Anthropic).
  promptCache: boolean;
};

// Normalized per-iteration usage. Cache fields are 0 on providers that don't
// surface them. `model` is echoed back so we can attribute each call.
export type NormalizedUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  // Provider-run web searches this call. Billed per search on top of tokens
  // (Anthropic web_search, Kimi $web_search) — see MODEL_PRICES.web_search.
  web_search_requests?: number;
};

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "pause_turn"
  | "error"
  | (string & {});

// Input to one iteration of the tool-use loop. The agent passes the full
// running conversation (already includes any tool_result blocks from the
// previous iteration's tool execution).
export type StreamIterationArgs = {
  // Pre-built system blocks. Anthropic honors the `cache` hint as a prompt-
  // cache breakpoint; other adapters concat the text and ignore it.
  system: FaSystemBlock[];
  messages: FaMessage[];
  // Client-side tools the agent will execute. Adapters convert the schema.
  tools: FaToolDef[];
  // Provider-managed tools (currently only Anthropic's web_search). Each
  // adapter decides what to do with these — Anthropic forwards them, others
  // ignore.
  serverTools: ReadonlyArray<Record<string, unknown>>;
  // Whether web search may be offered to the model THIS iteration. The agent
  // gates it behind a prior food-index lookup (DB-first; see chat()). Adapters
  // that expose a web-search builtin NOT carried in `serverTools` — notably
  // Kimi's `$web_search` — must honor this flag and withhold the tool when it
  // is false. (The Anthropic `serverTools` array is already gated by the agent,
  // so its adapter can ignore this flag.)
  allowWebSearch: boolean;
  // Whether to enable extended thinking / reasoning for THIS iteration.
  // Adapters that don't support it ignore the flag.
  thinking: boolean;
  maxTokens: number;
};

// Provider-emitted stream events. A normalized superset of what each wire
// protocol provides — adapters that don't have a concept (e.g. thinking on
// OpenAI chat completions) simply never emit those event types.
export type ProviderEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | {
      type: "tool_use_start";
      name: string;
      tool_use_id: string;
    }
  // Server-side tool already executed by the provider (e.g. web_search).
  // Adapters that run server tools yield this once for the call.
  | {
      type: "server_tool_call";
      name: string;
      tool_use_id: string;
    }
  | {
      type: "done";
      // Full assistant content in canonical (`Fa*`) shape, ready to append to
      // history.
      content: FaBlock[];
      stop_reason: StopReason;
      usage: NormalizedUsage;
    };

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly limits: ApiLimits;
  readonly capabilities: ProviderCapabilities;

  // One iteration of the tool-use loop. Streams events; ends with a `done`
  // event carrying the full assistant content and final usage.
  streamIteration(args: StreamIterationArgs): AsyncGenerator<ProviderEvent, void, void>;
}
