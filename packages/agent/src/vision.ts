/**
 * Shared one-off vision plumbing.
 *
 * Both receipt scanning (receipt.ts) and food recognition (food-vision.ts)
 * make the same kind of call: a single tool-less, history-less
 * `provider.streamIteration` pass over an image that returns a JSON object.
 * This module owns the boilerplate — capability guard, image block, the
 * streaming collection, and tolerant JSON extraction — so the feature modules
 * only define their prompt + output shape.
 */
import { logger } from "@fa/logger";
import type { UsageSource } from "@fa/shared";

import { recordUsage } from "./usage.ts";
import { getVisionProvider } from "./providers/index.ts";
import type { NormalizedUsage } from "./providers/types.ts";
import type { FaImageBlock, FaMessage } from "./schema/index.ts";

const log = logger.child({ pkg: "agent", fn: "visionComplete" });

// Image as accepted by the canonical content-block format (base64 or URL) —
// the same shape the chat path already supports.
export type VisionImageInput =
  { kind: "base64"; media_type: string; data: string } | { kind: "url"; url: string };

// Run a single vision pass and return the model's raw text reply. Tool-less,
// thinking off, no conversation history. Throws if the configured provider
// can't accept images. With `bill`, the call's usage is recorded for that user
// as a usage event once the reply is in (a recording failure is logged, never
// thrown — the user already has their result).
export async function visionComplete(opts: {
  image: VisionImageInput;
  system: string;
  instruction: string;
  maxTokens?: number;
  bill?: { userId: string; source: UsageSource };
}): Promise<string> {
  const provider = getVisionProvider();
  if (!provider.capabilities.vision) {
    throw new Error(
      `the vision model (${provider.id}/${provider.model}) does not accept image input — set a vision-capable VISION_PROVIDER/VISION_MODEL (or LLM_PROVIDER/LLM_MODEL)`,
    );
  }

  const imageBlock: FaImageBlock =
    opts.image.kind === "url"
      ? { kind: "image", source: { kind: "url", url: opts.image.url } }
      : {
          kind: "image",
          source: {
            kind: "base64",
            mediaType: opts.image.media_type,
            data: opts.image.data,
          },
        };

  const messages: FaMessage[] = [
    {
      role: "user",
      content: [imageBlock, { kind: "text", text: opts.instruction }],
    },
  ];

  let text = "";
  let usage: NormalizedUsage | null = null;
  for await (const ev of provider.streamIteration({
    system: [{ text: opts.system }],
    messages,
    tools: [],
    serverTools: [],
    allowWebSearch: false,
    thinking: false,
    maxTokens: opts.maxTokens ?? 4_000,
  })) {
    if (ev.type === "text_delta") {
      text += ev.delta;
    } else if (ev.type === "done") {
      // Authoritative: rebuild from final content blocks in case an adapter
      // didn't stream text deltas. Overwrites the delta accumulation.
      const fromBlocks = ev.content
        .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join("");
      if (fromBlocks) text = fromBlocks;
      usage = ev.usage;
    }
  }
  if (opts.bill && usage) {
    await recordUsage(opts.bill.userId, {
      source: opts.bill.source,
      provider: provider.id,
      model: provider.model,
      usage,
    }).catch((e: unknown) => {
      log.error("usage record failed", e instanceof Error ? e : new Error(String(e)), {
        user_id: opts.bill?.userId,
        source: opts.bill?.source,
      });
    });
  }
  return text;
}

// Tolerant JSON-object extraction: strip any prose / markdown fences by
// slicing the outermost {...} and parsing. Throws a clear error on failure.
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  if (!text) throw new Error("model returned an empty response");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("could not find JSON in the model response");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(
      `model response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// snake_case normalization shared by the vision feature modules: lowercase,
// strip accents/punctuation, collapse runs to single underscores, cap length.
export function snakeize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function humanizeSnake(snake: string): string {
  const s = snake.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
