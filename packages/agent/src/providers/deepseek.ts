/**
 * DeepSeek adapter.
 *
 * DeepSeek's API is OpenAI-compatible (`https://api.deepseek.com/v1`).
 * Models:
 *   - deepseek-chat       general chat
 *   - deepseek-reasoner   reasoning model (think before answer)
 *
 * Rate limits per their docs: DeepSeek does not impose strict per-user rate
 * limits today — values in providers/limits.ts are conservative defaults to
 * protect the bucket when sharing one API key across many users. Override
 * via DEEPSEEK_RPM / DEEPSEEK_TPM env vars.
 */
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai.ts";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

export type DeepSeekProviderOptions = Omit<OpenAIProviderOptions, "providerId" | "envPrefix">;

export class DeepSeekProvider extends OpenAIProvider {
  constructor(opts: DeepSeekProviderOptions) {
    super({
      ...opts,
      providerId: "deepseek",
      envPrefix: "DEEPSEEK",
      baseURL: opts.baseURL ?? DEEPSEEK_BASE_URL,
      apiKey: opts.apiKey ?? process.env.DEEPSEEK_API_KEY,
      capabilities: {
        vision: false,
        // deepseek-reasoner produces reasoning content but doesn't stream
        // it as a separate channel on the chat-completions endpoint.
        thinking: false,
        serverTools: false,
        promptCache: false,
        ...opts.capabilities,
      },
    });
  }
}
