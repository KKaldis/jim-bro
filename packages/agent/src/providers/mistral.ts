/**
 * Mistral adapter.
 *
 * Mistral's API is OpenAI-compatible — we use the OpenAI SDK with
 * `baseURL: 'https://api.mistral.ai/v1'`. Notable diffs to be aware of:
 *   - `tool_choice` enum is slightly different ("auto" | "any" | "none"),
 *     but we don't set tool_choice so this doesn't bite.
 *   - Usage shape may not include cached_tokens (most Mistral models don't
 *     expose prompt cache).
 *   - Vision support is model-dependent (mistral-large with vision variants).
 *
 * Rate limits (Experiment tier, free): RPM 60, TPM 500k (per the docs).
 * Override via env: MISTRAL_RPM / MISTRAL_TPM.
 */
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai.ts";

const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

export type MistralProviderOptions = Omit<OpenAIProviderOptions, "providerId" | "envPrefix">;

export class MistralProvider extends OpenAIProvider {
  constructor(opts: MistralProviderOptions) {
    super({
      ...opts,
      providerId: "mistral",
      envPrefix: "MISTRAL",
      baseURL: opts.baseURL ?? MISTRAL_BASE_URL,
      apiKey: opts.apiKey ?? process.env.MISTRAL_API_KEY,
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
