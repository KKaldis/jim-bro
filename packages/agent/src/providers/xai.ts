/**
 * xAI (Grok) adapter.
 *
 * xAI's API is OpenAI-compatible (`https://api.x.ai/v1`). Models:
 *   - grok-2
 *   - grok-2-mini
 *   - grok-vision-beta  (vision-enabled)
 *
 * Rate limits: published per-model on the xAI console (defaults in
 * providers/limits.ts are placeholders — verify against your account).
 */
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai.ts";

const XAI_BASE_URL = "https://api.x.ai/v1";

export type XAIProviderOptions = Omit<OpenAIProviderOptions, "providerId" | "envPrefix">;

export class XAIProvider extends OpenAIProvider {
  constructor(opts: XAIProviderOptions) {
    super({
      ...opts,
      providerId: "xai",
      envPrefix: "XAI",
      baseURL: opts.baseURL ?? XAI_BASE_URL,
      apiKey: opts.apiKey ?? process.env.XAI_API_KEY,
      capabilities: {
        vision: opts.model.includes("vision"),
        thinking: false,
        serverTools: false,
        promptCache: false,
        ...opts.capabilities,
      },
    });
  }
}
