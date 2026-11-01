/**
 * Qwen (Alibaba Cloud Model Studio / DashScope) adapter.
 *
 * DashScope exposes an OpenAI-compatible endpoint
 * (`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`). The mainland
 * China region lives at `https://dashscope.aliyuncs.com/compatible-mode/v1` —
 * keys are region-bound, so set QWEN_BASE_URL to match the key's region.
 *
 * Notable model IDs:
 *   - qwen-plus / qwen-max / qwen-turbo   general chat (hybrid thinking off by default)
 *   - qwen3-max                           flagship
 *   - qwen-vl-max / qwen3-vl-plus         vision-enabled
 *   - qwq-plus                            reasoning model (streams reasoning_content)
 *
 * Reasoning models stream `reasoning_content`, which the openai adapter already
 * captures. Unlike Moonshot, DashScope doesn't demand it back on tool-call
 * turns, so preserveReasoning stays off.
 *
 * Key: QWEN_API_KEY, falling back to DASHSCOPE_API_KEY (the name Alibaba's
 * docs use). Rate limits in providers/limits.ts are placeholders — verify
 * against the Model Studio console.
 */
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai.ts";

const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export type QwenProviderOptions = Omit<OpenAIProviderOptions, "providerId" | "envPrefix">;

export class QwenProvider extends OpenAIProvider {
  constructor(opts: QwenProviderOptions) {
    super({
      ...opts,
      providerId: "qwen",
      envPrefix: "QWEN",
      baseURL: opts.baseURL ?? process.env.QWEN_BASE_URL?.trim() ?? QWEN_BASE_URL,
      apiKey: opts.apiKey ?? process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY,
      capabilities: {
        vision: /-vl|qvq|omni/i.test(opts.model),
        // Hybrid-thinking is toggled with DashScope's own `enable_thinking`
        // body param, not the Anthropic-shaped one the agent sends — keep the
        // capability off so the agent's thinking toggle doesn't try.
        thinking: false,
        serverTools: false,
        // DashScope caches implicitly; no explicit cache_control on this wire.
        promptCache: false,
        ...opts.capabilities,
      },
    });
  }
}
