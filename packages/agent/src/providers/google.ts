/**
 * Google Gemini adapter.
 *
 * Gemini's API is NOT OpenAI-compatible by default — it ships its own SDK
 * (`@google/genai`) with a different content/tool shape. Conversion lives in
 * google-convert.ts; this file wires the stream up and emits normalized
 * ProviderEvents.
 *
 * The SDK is loaded via dynamic import so users that don't enable the
 * Google provider don't have to install `@google/genai` (it's listed as an
 * optionalDependency in package.json).
 *
 * Rate limits (free tier, see providers/limits.ts):
 *   gemini-2.0-flash → 10 RPM, 1M TPM, 1500 RPD
 *   gemini-2.0-pro   →  5 RPM, 2M TPM,  100 RPD
 *
 * Caveats:
 *   - No native extended-thinking on 2.0 (capabilities.thinking = false).
 *     gemini-2.5-* exposes a thinking config but we don't surface it yet.
 *   - No server-managed tools (web_search).
 *   - Context caching exists but uses a separate `caches` endpoint — not
 *     wired here (capabilities.promptCache = false).
 */
import { logger, type Logger } from "@fa/logger";

// SDK types are loose on purpose — the @google/genai package is optional
// (loaded via dynamic import). Treating the client as `unknown` keeps the
// rest of the codebase typecheckable when the dep isn't installed.
type GoogleGenAIClient = {
  models: {
    generateContentStream: (args: {
      model: string;
      contents: unknown;
      config?: Record<string, unknown>;
    }) => Promise<AsyncIterable<unknown>>;
  };
};
type GoogleGenAIModule = {
  GoogleGenAI: new (opts: { apiKey: string }) => GoogleGenAIClient;
};

import {
  geminiResponseToContent,
  mapFinishReason,
  messagesToGemini,
  systemBlocksToGemini,
  toolsToGemini,
} from "./google-convert.ts";
import { lookupLimits, parseLimitsFromEnv } from "./limits.ts";
import { getRateLimiter, type RateLimiter } from "./rate-limiter.ts";
import { withRetry } from "./retry.ts";
import type {
  ApiLimits,
  LLMProvider,
  ProviderCapabilities,
  ProviderEvent,
  StreamIterationArgs,
} from "./types.ts";

const THINKING_BUDGET = 2_000;

// Gemini 2.5 family ships a thinking config that emits thought parts when
// `includeThoughts: true`. 2.0/1.x have no thinking surface.
function isThinkingModel(model: string): boolean {
  return /^gemini-2\.5/.test(model);
}

export type GoogleProviderOptions = {
  apiKey?: string;
  model: string;
  limits?: ApiLimits;
};

export class GoogleProvider implements LLMProvider {
  readonly id = "google" as const;
  readonly model: string;
  readonly limits: ApiLimits;
  readonly capabilities: ProviderCapabilities;

  private apiKey: string;
  private client: GoogleGenAIClient | null = null;
  private limiter: RateLimiter;
  private log: Logger;

  constructor(opts: GoogleProviderOptions) {
    this.model = opts.model;
    this.log = logger.child({ provider: this.id, model: this.model });
    const envOverride = parseLimitsFromEnv("GOOGLE");
    const baseline = opts.limits ?? lookupLimits("google", opts.model);
    this.limits = { ...baseline, ...envOverride };
    this.limiter = getRateLimiter("google", this.model, this.limits);
    // gemini-2.5-* exposes a thinking config that streams thought parts when
    // `includeThoughts: true`. 2.0 and earlier have no thinking surface.
    this.capabilities = {
      vision: true,
      thinking: isThinkingModel(opts.model),
      serverTools: false,
      promptCache: false,
    };

    const apiKey = opts.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY not set. Copy .env.example to .env and fill it in.");
    }
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<GoogleGenAIClient> {
    if (this.client) return this.client;
    let mod: GoogleGenAIModule;
    try {
      // Optional dep — listed in optionalDependencies; the dynamic import
      // falls through to the catch with a friendlier message when missing.
      mod = (await import("@google/genai")) as unknown as GoogleGenAIModule;
    } catch {
      throw new Error(
        "@google/genai not installed. Run `bun add @google/genai` (or `npm i @google/genai`) inside packages/agent.",
      );
    }
    this.client = new mod.GoogleGenAI({ apiKey: this.apiKey });
    return this.client;
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

    const client = await this.getClient();
    const contents = await messagesToGemini(args.messages);
    const systemInstruction = systemBlocksToGemini(args.system);
    const tools = toolsToGemini(args.tools);
    const thinkingOn = args.thinking && this.capabilities.thinking;

    const reqStart = Date.now();
    this.log.debug("request", {
      messages: args.messages.length,
      tools: tools.length,
      thinking: thinkingOn,
      max_tokens: args.maxTokens,
    });

    // Retry only the request-initiation (before any stream chunks are
    // consumed) so a retry can't double-emit partial output. Mid-stream
    // failures fall through to the streaming catch below and are not retried.
    let stream: AsyncIterable<GeminiStreamChunk>;
    try {
      stream = (await withRetry(
        () =>
          client.models.generateContentStream({
            model: this.model,
            contents,
            config: {
              systemInstruction,
              maxOutputTokens: args.maxTokens,
              ...(tools.length ? { tools } : {}),
              ...(thinkingOn
                ? {
                    thinkingConfig: {
                      includeThoughts: true,
                      thinkingBudget: THINKING_BUDGET,
                    },
                  }
                : {}),
            },
          }),
        { log: this.log, label: "google request", limiter: this.limiter },
      )) as unknown as AsyncIterable<GeminiStreamChunk>;
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }

    let textOut = "";
    const functionCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }> = [];
    let finishReason: string | null = null;
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    try {
      for await (const chunk of stream) {
        // Walk parts directly so we can distinguish thought parts (which
        // carry the reasoning) from visible text parts. Falling back to
        // chunk.text would conflate them.
        const cand = chunk.candidates?.[0];
        for (const p of cand?.content?.parts ?? []) {
          if (typeof p.text === "string" && p.text.length > 0) {
            if (p.thought === true) {
              yield { type: "thinking_delta", delta: p.text };
            } else {
              textOut += p.text;
              yield { type: "text_delta", delta: p.text };
            }
          }
          if (p.functionCall) {
            const fc = p.functionCall;
            const id = fc.id ?? `gem_${functionCalls.length}_${Date.now()}`;
            functionCalls.push({
              id,
              name: fc.name ?? "",
              args: (fc.args ?? {}) as Record<string, unknown>,
            });
            yield {
              type: "tool_use_start",
              name: fc.name ?? "",
              tool_use_id: id,
            };
          }
        }
        // Older SDK responses surface function calls on chunk.functionCalls
        // instead of inline parts. Read those too, deduping by id.
        const existing = new Set(functionCalls.map((f) => f.id));
        for (const fc of chunk.functionCalls ?? []) {
          const id = fc.id ?? `gem_${functionCalls.length}_${Date.now()}`;
          if (existing.has(id)) continue;
          functionCalls.push({
            id,
            name: fc.name ?? "",
            args: (fc.args ?? {}) as Record<string, unknown>,
          });
          yield {
            type: "tool_use_start",
            name: fc.name ?? "",
            tool_use_id: id,
          };
        }
        if (cand?.finishReason) finishReason = cand.finishReason;
        if (chunk.usageMetadata) {
          const um = chunk.usageMetadata;
          usage = {
            input_tokens: (um.promptTokenCount ?? 0) - (um.cachedContentTokenCount ?? 0),
            output_tokens: um.candidatesTokenCount ?? 0,
            cache_read_input_tokens: um.cachedContentTokenCount ?? 0,
            cache_creation_input_tokens: 0,
          };
        }
      }
    } catch (err) {
      this.handleApiError(err);
      throw err;
    }

    const content = geminiResponseToContent(textOut, functionCalls);

    this.limiter.recordUsage(
      usage.input_tokens + usage.cache_creation_input_tokens,
      usage.output_tokens,
    );

    // Gemini reports `STOP` even when tool calls are present. Force the
    // canonical stop reason so the agent loop re-enters for tool execution.
    const stop_reason = functionCalls.length > 0 ? "tool_use" : mapFinishReason(finishReason);

    this.log.debug("response", {
      ms: Date.now() - reqStart,
      finish_reason: finishReason,
      stop_reason,
      tool_calls: functionCalls.length,
      text_chars: textOut.length,
      usage,
    });

    yield { type: "done", content, stop_reason, usage };
  }

  private handleApiError(err: unknown): void {
    const e = err as { status?: number; message?: string };
    if (e?.status === 429) {
      this.log.warn("rate limited");
    } else if (typeof e?.status === "number") {
      this.log.error("api error", err instanceof Error ? err : new Error(String(err)), {
        status: e.status,
      });
    }
  }
}

// Loose shape of a streamed chunk — the SDK types vary by version, so we
// duck-type on the fields we read.
type GeminiStreamChunk = {
  text?: string;
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        // gemini-2.5 thought parts set this to true when
        // thinkingConfig.includeThoughts is enabled.
        thought?: boolean;
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
};
