/**
 * Canonical conversation + tool schema. Barrel for the `Fa*` types and the
 * Anthropic translator. Provider-neutral — nothing here pulls in a provider
 * SDK except schema/anthropic.ts (type-only import).
 */
export type {
  FaBlock,
  FaCitation,
  FaImageBlock,
  FaImageSource,
  FaMessage,
  FaRole,
  FaSystemBlock,
  FaTextBlock,
  FaThinkingBlock,
  FaToolCallBlock,
  FaToolDef,
  FaToolResultBlock,
  JsonObject,
  JsonValue,
} from "./types.ts";

export {
  anthropicContentToFa,
  faMessagesToAnthropic,
  faSystemToAnthropic,
  faToolsToAnthropic,
} from "./anthropic.ts";
