/**
 * Provider registry + env-driven factory.
 *
 * Single entry point the agent calls:
 *   getProvider() — returns an LLMProvider instance based on env config.
 *
 * Env:
 *   LLM_PROVIDER   anthropic | openai | kimi | google | mistral | deepseek | xai | qwen
 *                  Default: anthropic.
 *   LLM_MODEL      Model id for the chosen provider. Falls back to a
 *                  provider-specific default.
 *   VISION_PROVIDER / VISION_MODEL
 *                  Optional override for one-off vision passes (image captions,
 *                  food photo recognition, receipt scanning — see vision.ts).
 *                  When unset, vision reuses the chat provider if it's
 *                  vision-capable, else falls back to Anthropic when an
 *                  ANTHROPIC_API_KEY is present. This lets a non-vision chat
 *                  model (e.g. kimi-k2.6) still process images.
 *   LLM_FAST_PROVIDER / LLM_FAST_MODEL
 *                  Optional model for "fast" chat turns (logging, lookups,
 *                  quick reads — see pickTurnTier in agent.ts). Fast turns
 *                  always run with thinking off; when unset they reuse the
 *                  chat provider, so the only change is the thinking switch.
 *   LLM_TIERING    "off" sends every turn down the deep path (chat provider,
 *                  thinking per the user's toggle). Default: on.
 *
 * Provider-specific keys live in their adapter (e.g. ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, KIMI_API_KEY). Limits can be overridden per-provider via
 * <PROVIDER>_RPM / _ITPM / _OTPM / _TPM / _TPD.
 */
import { AnthropicProvider } from "./anthropic.ts";
import { DeepSeekProvider } from "./deepseek.ts";
import { GoogleProvider } from "./google.ts";
import { KimiProvider } from "./kimi.ts";
import { MistralProvider } from "./mistral.ts";
import { OpenAIProvider } from "./openai.ts";
import { QwenProvider } from "./qwen.ts";
import { XAIProvider } from "./xai.ts";
import type { LLMProvider, ProviderId } from "./types.ts";

export type { LLMProvider, ProviderId } from "./types.ts";
export type {
  ApiLimits,
  ProviderCapabilities,
  ProviderEvent,
  NormalizedUsage,
  StreamIterationArgs,
} from "./types.ts";

const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  kimi: "kimi-k2.6",
  google: "gemini-2.0-flash",
  mistral: "mistral-large-latest",
  deepseek: "deepseek-chat",
  xai: "grok-2",
  qwen: "qwen-plus",
};

// Vision-capable defaults per provider, used when VISION_MODEL is unset but a
// provider's own DEFAULT_MODELS entry isn't a vision model (e.g. kimi). Only
// the providers we'd auto-route vision to need an entry here.
const DEFAULT_VISION_MODELS: Partial<Record<ProviderId, string>> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
  qwen: "qwen-vl-max",
};

const VALID_PROVIDERS = new Set<ProviderId>([
  "anthropic",
  "openai",
  "kimi",
  "google",
  "mistral",
  "deepseek",
  "xai",
  "qwen",
]);

// Cached instance — provider config is process-scoped (env-driven), so one
// instance suffices. Future per-user provider selection would key this map
// on (userId) and resolve from a profile field instead.
let _instance: LLMProvider | null = null;
let _visionInstance: LLMProvider | null = null;
let _fastInstance: LLMProvider | null = null;

export function getProvider(): LLMProvider {
  if (_instance) return _instance;
  const id = resolveProviderId();
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_MODELS[id];
  _instance = createProvider(id, model);
  return _instance;
}

// Provider for one-off vision passes (vision.ts: image captions, food photo
// recognition, receipt scanning). Decoupled from the chat provider so a
// non-vision chat model (e.g. kimi-k2.6) can still handle images. Resolution:
//   1. Explicit VISION_PROVIDER (+ optional VISION_MODEL).
//   2. The chat provider, when it's vision-capable.
//   3. Anthropic, when ANTHROPIC_API_KEY is present (VISION_MODEL overrides).
//   4. Otherwise the chat provider — so visionComplete's own capability guard
//      surfaces the clear "set a vision-capable provider" error.
export function getVisionProvider(): LLMProvider {
  if (_visionInstance) return _visionInstance;

  const explicit = process.env.VISION_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    if (!VALID_PROVIDERS.has(explicit as ProviderId)) {
      throw new Error(
        `VISION_PROVIDER must be one of: ${[...VALID_PROVIDERS].join(", ")} (got: ${explicit})`,
      );
    }
    const id = explicit as ProviderId;
    const model =
      process.env.VISION_MODEL?.trim() || DEFAULT_VISION_MODELS[id] || DEFAULT_MODELS[id];
    _visionInstance = createProvider(id, model);
    return _visionInstance;
  }

  const chat = getProvider();
  if (chat.capabilities.vision) {
    _visionInstance = chat;
  } else if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.VISION_MODEL?.trim() || DEFAULT_VISION_MODELS.anthropic!;
    _visionInstance = createProvider("anthropic", model);
  } else {
    _visionInstance = chat;
  }
  return _visionInstance;
}

// Provider for "fast" chat turns. Explicit LLM_FAST_PROVIDER (+ optional
// LLM_FAST_MODEL, else that provider's default), else LLM_FAST_MODEL on the
// chat provider, else the chat provider itself.
export function getFastProvider(): LLMProvider {
  if (_fastInstance) return _fastInstance;
  const explicit = process.env.LLM_FAST_PROVIDER?.trim().toLowerCase();
  const model = process.env.LLM_FAST_MODEL?.trim();
  if (explicit) {
    if (!VALID_PROVIDERS.has(explicit as ProviderId)) {
      throw new Error(
        `LLM_FAST_PROVIDER must be one of: ${[...VALID_PROVIDERS].join(", ")} (got: ${explicit})`,
      );
    }
    const id = explicit as ProviderId;
    _fastInstance = createProvider(id, model || DEFAULT_MODELS[id]);
  } else if (model) {
    _fastInstance = createProvider(getProvider().id, model);
  } else {
    _fastInstance = getProvider();
  }
  return _fastInstance;
}

// Test/dev hook — clears the cached singletons so the next getProvider() /
// getVisionProvider() / getFastProvider() call re-reads env. Not exported from
// the package barrel.
export function _resetProviderForTest(): void {
  _instance = null;
  _visionInstance = null;
  _fastInstance = null;
}

export function createProvider(id: ProviderId, model: string): LLMProvider {
  switch (id) {
    case "anthropic":
      return new AnthropicProvider({ model });
    case "openai":
      return new OpenAIProvider({ model });
    case "kimi":
      return new KimiProvider({ model });
    case "google":
      return new GoogleProvider({ model });
    case "mistral":
      return new MistralProvider({ model });
    case "deepseek":
      return new DeepSeekProvider({ model });
    case "xai":
      return new XAIProvider({ model });
    case "qwen":
      return new QwenProvider({ model });
    default:
      throw new Error(`unknown LLM provider: ${id as string}`);
  }
}

function resolveProviderId(): ProviderId {
  const raw = process.env.LLM_PROVIDER?.trim().toLowerCase() ?? "anthropic";
  if (!VALID_PROVIDERS.has(raw as ProviderId)) {
    throw new Error(
      `LLM_PROVIDER must be one of: ${[...VALID_PROVIDERS].join(", ")} (got: ${raw})`,
    );
  }
  return raw as ProviderId;
}

export type LlmStatus = {
  /** A chat provider is configured (its adapter found an API key). */
  llm: boolean;
  /** A vision-capable provider is configured. */
  vision: boolean;
  /** The chat provider + model, when configured. */
  chat: { provider: ProviderId; model: string } | null;
};

// What the server can serve right now. Provider adapters throw on construction
// when their API key is missing, so "configured" = the factory succeeds. A
// success is cached by the factories; a failure is cheap to retry, so a key
// added to the env shows up on the next restart without special handling.
export function llmStatus(): LlmStatus {
  let chat: LLMProvider | null = null;
  try {
    chat = getProvider();
  } catch {
    chat = null;
  }
  let vision = false;
  try {
    vision = getVisionProvider().capabilities.vision;
  } catch {
    vision = false;
  }
  return {
    llm: chat != null,
    vision,
    chat: chat ? { provider: chat.id, model: chat.model } : null,
  };
}
