/**
 * Anthropic adapter.
 *
 * One provider among many: it translates the canonical `Fa*` schema to/from
 * the Anthropic SDK shapes at the wire (see ../schema/anthropic.ts). Because
 * Anthropic was the historical canonical format the conversion is mostly a
 * field rename, but it is a real translation step — the loop never sees an
 * Anthropic type. Extended thinking, prompt-cached system, server tools
 * (web_search), per-iteration usage are all forwarded.
 */
import Anthropic from "@anthropic-ai/sdk";

import { logger, type Logger } from "@fa/logger";

import {
  anthropicContentToFa,
  faMessagesToAnthropic,
  faSystemToAnthropic,
  faToolsToAnthropic,
} from "../schema/anthropic.ts";
import type { FaBlock } from "../schema/index.ts";
import { getRateLimiter, type RateLimiter } from "./rate-limiter.ts";
import { lookupLimits, parseLimitsFromEnv } from "./limits.ts";
import { planRetry, retryAfterMsFromError, sleep, statusOf } from "./retry.ts";
import type {
  ApiLimits,
  LLMProvider,
  ProviderCapabilities,
  ProviderEvent,
  StreamIterationArgs,
} from "./types.ts";

const THINKING_BUDGET = 2_000;

export type AnthropicProviderOptions = {
  apiKey?: string;
  model: string;
  limits?: ApiLimits;
};

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly model: string;
  readonly limits: ApiLimits;
  readonly capabilities: ProviderCapabilities = {
    vision: true,
    thinking: true,
    serverTools: true,
    promptCache: true,
  };

  private client: Anthropic;
  private limiter: RateLimiter;
  private log: Logger;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    // Env overrides published numbers when set, else fall back to the table.
    const envOverride = parseLimitsFromEnv("ANTHROPIC");
    const baseline = opts.limits ?? lookupLimits("anthropic", opts.model);
    this.limits = { ...baseline, ...envOverride };
    this.limiter = getRateLimiter("anthropic", this.model, this.limits);
    this.log = logger.child({ provider: this.id, model: this.model });

    if (!opts.apiKey && !process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not set. Copy .env.example to .env and fill it in.");
    }
    // Disable the SDK's built-in retry so our shared retry layer (retry.ts)
    // is the single source of backoff — no nested/doubled retries.
    this.client = new Anthropic({
      maxRetries: 0,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    });
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

    // The Anthropic SDK's `.stream()` defers request errors to the first
    // iteration rather than rejecting up front, so (unlike OpenAI/Google) we
    // can't wrap a single awaited init in withRetry(). Instead we loop here
    // and retry — using the same shared policy (planRetry) — but ONLY while
    // `yielded` is false, i.e. before any event has reached the caller. Once
    // we've emitted output a retry would double-emit, so we stop retrying.
    // Translate the canonical request to Anthropic SDK shapes once per call.
    const system = faSystemToAnthropic(args.system);
    const tools = faToolsToAnthropic(args.tools);
    const messages = faMessagesToAnthropic(args.messages);

    let attempt = 0;
    for (;;) {
      const reqStart = Date.now();
      this.log.debug("request", {
        messages: messages.length,
        tools: tools.length,
        server_tools: args.serverTools.length,
        thinking: args.thinking,
        max_tokens: args.maxTokens,
        system_blocks: system.length,
      });

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: args.maxTokens,
        ...(args.thinking
          ? {
              thinking: {
                type: "enabled" as const,
                budget_tokens: THINKING_BUDGET,
              },
            }
          : {}),
        system,
        // Server tools (web_search) widen the union; SDK types only expose
        // client-side Tool, so cast at the boundary.
        tools: [...tools, ...args.serverTools] as Anthropic.Tool[],
        messages,
      });

      // Track the type of each content block by index so we can label deltas.
      const blockType = new Map<number, string>();
      // Set once we emit anything to the caller — gates retry eligibility.
      let yielded = false;

      try {
        for await (const event of stream) {
          if (event.type === "content_block_start") {
            blockType.set(event.index, event.content_block.type);
            if (event.content_block.type === "tool_use") {
              yielded = true;
              yield {
                type: "tool_use_start",
                name: event.content_block.name,
                tool_use_id: event.content_block.id,
              };
            } else if ((event.content_block as { type: string }).type === "server_tool_use") {
              // Anthropic ran a server tool (web_search). No client-side
              // execution to await — surface a single event so the UI can
              // render a status pill.
              const cb = event.content_block as unknown as {
                id: string;
                name: string;
              };
              yielded = true;
              yield {
                type: "server_tool_call",
                name: cb.name,
                tool_use_id: cb.id,
              };
            }
          } else if (event.type === "content_block_delta") {
            const t = blockType.get(event.index);
            if (event.delta.type === "text_delta" && t === "text") {
              yielded = true;
              yield { type: "text_delta", delta: event.delta.text };
            } else if (event.delta.type === "thinking_delta") {
              yielded = true;
              yield { type: "thinking_delta", delta: event.delta.thinking };
            }
          }
        }

        const finalMsg = await stream.finalMessage();
        const usage = {
          input_tokens: finalMsg.usage.input_tokens ?? 0,
          output_tokens: finalMsg.usage.output_tokens ?? 0,
          cache_read_input_tokens: finalMsg.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: finalMsg.usage.cache_creation_input_tokens ?? 0,
          web_search_requests:
            (finalMsg.usage as { server_tool_use?: { web_search_requests?: number } | null })
              .server_tool_use?.web_search_requests ?? 0,
        };
        this.limiter.recordUsage(
          usage.input_tokens + usage.cache_creation_input_tokens,
          usage.output_tokens,
        );
        this.log.debug("response", {
          ms: Date.now() - reqStart,
          stop_reason: finalMsg.stop_reason ?? "end_turn",
          usage,
        });

        // Convert the assistant content back to canonical shape for history.
        const content = anthropicContentToFa(finalMsg.content) as FaBlock[];
        yield {
          type: "done",
          content,
          stop_reason: finalMsg.stop_reason ?? "end_turn",
          usage,
        };
        return;
      } catch (err) {
        // Retry transient failures (429 / 5xx / connection) only before any
        // output has been emitted. Same backoff policy as the other providers.
        if (!yielded) {
          const plan = planRetry(err, attempt);
          if (plan) {
            this.limiter.pauseUntil(Date.now() + plan.delayMs);
            attempt += 1;
            this.log.warn("retrying provider request", {
              label: "anthropic request",
              attempt,
              delay_ms: plan.delayMs,
              status: statusOf(err),
            });
            await sleep(plan.delayMs);
            continue;
          }
        }
        if (err instanceof Anthropic.RateLimitError) {
          // Honor server-imposed pause when present.
          const retry = retryAfterMsFromError(err);
          if (retry) this.limiter.pauseUntil(Date.now() + retry);
          this.log.warn("rate limited", { ms: Date.now() - reqStart });
          throw new Error(`rate limited (try again shortly): ${err.message}`);
        }
        if (err instanceof Anthropic.APIError) {
          this.log.error("api error", err, {
            status: err.status,
            ms: Date.now() - reqStart,
          });
          throw new Error(`Anthropic API error ${err.status}: ${err.message}`);
        }
        throw err;
      }
    }
  }
}
