/**
 * OpenAI adapter (Chat Completions API).
 *
 * Also the base class for OpenAI-compatible providers (Kimi/Moonshot,
 * DeepSeek, etc.) — those just override the baseURL and model defaults.
 *
 * Conversion to/from the canonical `Fa*` schema lives in openai-convert.ts;
 * this file just wires the stream up and emits normalized ProviderEvents.
 *
 * Caveats:
 *   - Extended thinking is not exposed via Chat Completions for the
 *     standard models. o-series reasoning is automatic; we don't get
 *     reasoning_content deltas on most deployments.
 *   - Server tools (web_search) are not supported here — Chat Completions
 *     doesn't have a portable equivalent. The agent gates serverTools
 *     based on capabilities.
 *   - max_tokens is `max_completion_tokens` on o-series — see modelKind().
 */
import OpenAI from "openai";

import { logger, type Logger } from "@fa/logger";

import { lookupLimits, parseLimitsFromEnv } from "./limits.ts";
import {
  mapFinishReason,
  messagesToOpenAI,
  openAIMessageToContent,
  systemBlocksToOpenAI,
  toolsToOpenAI,
  type OpenAIChatMessage,
  type OpenAIFunctionTool,
  type OpenAIToolCall,
} from "./openai-convert.ts";
import { getRateLimiter, type RateLimiter } from "./rate-limiter.ts";
import { parseRetryAfterHeader, withRetry } from "./retry.ts";
import type {
  ApiLimits,
  LLMProvider,
  NormalizedUsage,
  ProviderCapabilities,
  ProviderEvent,
  ProviderId,
  StreamIterationArgs,
} from "./types.ts";

export type OpenAIProviderOptions = {
  apiKey?: string;
  baseURL?: string;
  model: string;
  // Overrides for branded variants (Kimi etc.) that want to advertise a
  // different provider id and pull a different limits row.
  providerId?: ProviderId;
  limits?: ApiLimits;
  envPrefix?: string;
  capabilities?: Partial<ProviderCapabilities>;
  // Round-trip `reasoning_content` back onto assistant tool-call messages in
  // history. Required for Kimi thinking-class models, which return reasoning
  // as a separate field and 400 on subsequent requests if it's missing.
  preserveReasoning?: boolean;
};

export class OpenAIProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly limits: ApiLimits;
  readonly capabilities: ProviderCapabilities;

  protected client: OpenAI;
  protected limiter: RateLimiter;
  protected log: Logger;
  protected preserveReasoning: boolean;

  constructor(opts: OpenAIProviderOptions) {
    this.id = opts.providerId ?? "openai";
    this.model = opts.model;
    this.log = logger.child({ provider: this.id, model: this.model });

    const envPrefix = opts.envPrefix ?? this.id.toUpperCase();
    const envOverride = parseLimitsFromEnv(envPrefix);
    const baseline = opts.limits ?? lookupLimits(this.id, opts.model);
    this.limits = { ...baseline, ...envOverride };

    this.capabilities = {
      vision: false,
      thinking: false,
      serverTools: false,
      promptCache: false,
      ...opts.capabilities,
    };
    this.preserveReasoning = opts.preserveReasoning ?? false;

    this.limiter = getRateLimiter(this.id, this.model, this.limits);

    const apiKey = opts.apiKey ?? process.env[`${envPrefix}_API_KEY`] ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(`${envPrefix}_API_KEY not set. Copy .env.example to .env and fill it in.`);
    }
    // Disable the SDK's built-in retry so our shared retry layer (retry.ts)
    // is the single source of backoff — no nested/doubled retries.
    this.client = new OpenAI({ apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  }

  async *streamIteration(args: StreamIterationArgs): AsyncGenerator<ProviderEvent, void, void> {
    const reserveStart = Date.now();
    const reserved = await this.limiter.reserveRequest();
    const reserveMs = Date.now() - reserveStart;
    if (reserveMs > 10) {
      this.log.debug("rate-limiter wait", { ms: reserveMs });
    }
    if (!reserved) {
      this.log.warn("rate-limiter gave up waiting; sending anyway", {
        waited_ms: reserveMs,
      });
    }

    // Round-trip reasoning_content onto outgoing assistant tool-call messages
    // unconditionally when the provider needs it (Kimi-thinking rejects
    // tool-call turns that omit it — observed as
    // "thinking is enabled but reasoning_content is missing"). The user's
    // thinking-toggle only affects UI emission below, not the wire format.
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: systemBlocksToOpenAI(args.system) },
      ...messagesToOpenAI(args.messages, { preserveReasoning: this.preserveReasoning }),
    ];
    // Provider-specific builtins (e.g. Kimi's $web_search) are appended raw
    // alongside the converted client tools. The OpenAI SDK accepts unknown
    // tool entries as long as the server understands them.
    const tools = [
      ...this.sanitizeWireTools(toolsToOpenAI(args.tools)),
      ...this.extraWireTools(args.allowWebSearch),
    ];

    const isReasoning = isReasoningModel(this.model);
    const tokenParam = isReasoning
      ? { max_completion_tokens: args.maxTokens }
      : { max_tokens: args.maxTokens };

    const reqStart = Date.now();
    this.log.debug("request", {
      messages: messages.length,
      tools: tools.length,
      reasoning: isReasoning,
      max_tokens: args.maxTokens,
    });

    // Retry only the request-initiation (before any stream events are
    // consumed) so a retry can't double-emit partial output. Mid-stream
    // failures fall through to the streaming catch below and are not retried.
    let stream;
    try {
      stream = await withRetry(
        () =>
          this.client.chat.completions.create({
            model: this.model,
            ...tokenParam,
            messages: messages as unknown as Parameters<
              typeof this.client.chat.completions.create
            >[0]["messages"],
            tools: tools.length
              ? (tools as unknown as Parameters<
                  typeof this.client.chat.completions.create
                >[0]["tools"])
              : undefined,
            stream: true,
            stream_options: { include_usage: true },
            ...this.extraRequestParams(args),
          } as Parameters<typeof this.client.chat.completions.create>[0] & { stream: true }),
        { log: this.log, label: `${this.id} request`, limiter: this.limiter },
      );
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }

    // Accumulate text + tool_calls across chunks.
    let text = "";
    let reasoning = "";
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; args: string; started: boolean }
    >();
    let finishReason: string | null = null;
    let usage: NormalizedUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (choice) {
          if (choice.delta?.content) {
            text += choice.delta.content;
            yield { type: "text_delta", delta: choice.delta.content };
          }
          // Kimi thinking models (and some OpenAI-compat deployments) stream
          // server-side reasoning here. We ALWAYS accumulate it into the
          // canonical content so it round-trips onto subsequent tool-call
          // turns (Kimi requires this — see preserveReasoning). The user's
          // thinking-toggle only gates the UI stream: with it off, the chunk
          // is captured silently rather than rendered as a thinking pill.
          const rc = (choice.delta as { reasoning_content?: string } | undefined)
            ?.reasoning_content;
          if (rc) {
            reasoning += rc;
            if (args.thinking) {
              yield { type: "thinking_delta", delta: rc };
            }
          }
          for (const tcd of choice.delta?.tool_calls ?? []) {
            const idx = tcd.index;
            let entry = toolCallsByIndex.get(idx);
            if (!entry) {
              entry = { id: "", name: "", args: "", started: false };
              toolCallsByIndex.set(idx, entry);
            }
            if (tcd.id) entry.id = tcd.id;
            const fn = tcd.function;
            if (fn?.name) entry.name = fn.name;
            if (fn?.arguments) entry.args += fn.arguments;
            // Surface the start event as soon as we have id + name, so the
            // UI can render a pill without waiting for arguments to stream.
            if (!entry.started && entry.id && entry.name) {
              entry.started = true;
              yield {
                type: "tool_use_start",
                name: entry.name,
                tool_use_id: entry.id,
              };
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        const u = (chunk as { usage?: OpenAIUsageShape }).usage;
        if (u) {
          usage = {
            input_tokens: (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0),
            output_tokens: u.completion_tokens ?? 0,
            cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
            cache_creation_input_tokens: 0,
          };
        }
      }
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }

    // Build canonical assistant content[].
    const toolCalls: OpenAIToolCall[] = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({
        id: v.id,
        type: "function" as const,
        function: { name: v.name, arguments: v.args },
      }));
    // With the toggle off the reasoning was captured silently; mark it so a
    // history reload doesn't render it either.
    const content = openAIMessageToContent(
      {
        content: text,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        reasoning_content: reasoning || undefined,
      },
      { hideReasoning: !args.thinking },
    );

    // Provider-run builtins (Kimi's `$web_search`) arrive as ordinary tool
    // calls but carry a per-call fee, so count them into usage for billing.
    const webSearches = toolCalls.filter((t) => t.function.name === "$web_search").length;
    if (webSearches) usage = { ...usage, web_search_requests: webSearches };

    this.limiter.recordUsage(
      usage.input_tokens + usage.cache_creation_input_tokens,
      usage.output_tokens,
    );
    this.log.debug("response", {
      ms: Date.now() - reqStart,
      finish_reason: finishReason,
      stop_reason: mapFinishReason(finishReason),
      tool_calls: toolCalls.length,
      text_chars: text.length,
      usage,
    });

    yield {
      type: "done",
      content,
      stop_reason: mapFinishReason(finishReason),
      usage,
    };
  }

  // Provider-specific tools appended to the wire `tools` array beyond what
  // the agent passes. Used by branded subclasses to inject server-side
  // builtins — e.g. Kimi's `{type: "builtin_function", function: {name:
  // "$web_search"}}`. `allowWebSearch` is the agent's DB-first gate: a web
  // builtin must be withheld when it is false. Default is none.
  protected extraWireTools(_allowWebSearch: boolean): unknown[] {
    return [];
  }

  // Provider-specific top-level request fields merged into the chat
  // completions body — e.g. Kimi's `thinking: {type: "disabled"}` to honor a
  // thinking-off iteration. Default is none.
  protected extraRequestParams(_args: StreamIterationArgs): Record<string, unknown> {
    return {};
  }

  // Hook for branded subclasses to rewrite tool JSON Schemas before they hit
  // the wire, for servers whose schema validator is stricter than OpenAI's.
  // Default is a pass-through.
  protected sanitizeWireTools(tools: OpenAIFunctionTool[]): OpenAIFunctionTool[] {
    return tools;
  }

  protected handleApiError(err: unknown): void {
    // openai SDK exposes typed errors via OpenAI.* classes. We don't import
    // them to keep this loose — duck-type on `status` instead.
    const e = err as { status?: number; message?: string; headers?: Record<string, string> };
    if (e?.status === 429) {
      const retry = parseRetryAfterHeader(e.headers);
      if (retry) this.limiter.pauseUntil(Date.now() + retry);
      this.log.warn("rate limited");
    } else if (typeof e?.status === "number") {
      this.log.error("api error", err instanceof Error ? err : new Error(String(err)), {
        status: e.status,
      });
    }
  }
}

type OpenAIUsageShape = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

// o-series reasoning models use `max_completion_tokens` instead of
// `max_tokens` and ignore some sampling params. Matches "o1", "o3", "o4",
// "o1-mini", "o3-mini", etc. — but NOT "gpt-4o" (no leading o).
function isReasoningModel(model: string): boolean {
  return /^o\d+(-|$)/.test(model);
}
