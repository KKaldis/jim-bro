/**
 * Canonical (`Fa*`) <-> Google Gemini conversion helpers.
 *
 * Gemini's shape is significantly different from OpenAI's:
 *   - Messages use `role: "user" | "model"` (not "assistant") and a `parts`
 *     array of typed objects.
 *   - System prompt is a top-level `systemInstruction` field.
 *   - Tools are wrapped in `tools: [{ functionDeclarations: [...] }]`.
 *   - Tool results carry the function NAME (not an id) — so on the way out
 *     we maintain a callId -> name map while walking history.
 *   - JSON Schema input is OpenAPI-style and rejects some constructs
 *     (additionalProperties, $schema, etc.) — we strip them before sending.
 */
import type { FaBlock, FaMessage, FaSystemBlock, FaToolDef, JsonObject } from "../schema/index.ts";

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | {
      functionResponse: { name: string; response: Record<string, unknown> };
    };

export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

export type GeminiSystemInstruction = { parts: { text: string }[] };

export type GeminiTool = {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
};

export function systemBlocksToGemini(system: FaSystemBlock[]): GeminiSystemInstruction {
  return { parts: [{ text: system.map((b) => b.text).join("\n\n") }] };
}

export function toolsToGemini(tools: FaToolDef[]): GeminiTool[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: sanitizeSchema(t.schema as unknown as Record<string, unknown>),
      })),
    },
  ];
}

// Gemini's schema parser is stricter than JSON Schema. Drop keys it rejects.
// $ref is resolved (inlined from definitions/$defs) before being dropped, so
// schemas that reference shared sub-objects survive the round trip.
const DROP_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "additionalProperties",
  "definitions",
  "$defs",
  "examples",
  "default",
]);
function sanitizeSchema(node: unknown): Record<string, unknown> {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return {};
  }
  const root = node as Record<string, unknown>;
  const defs = collectDefs(root);
  return walk(root, defs, new Set()) as Record<string, unknown>;
}
function collectDefs(root: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const merge = (obj: unknown) => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = v;
      }
    }
  };
  merge(root.definitions);
  merge(root["$defs"]);
  return out;
}
function walk(node: unknown, defs: Record<string, unknown>, stack: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, defs, stack));
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  // Inline $ref to a local definition (e.g. "#/definitions/Foo" or "#/$defs/Foo").
  if (typeof obj["$ref"] === "string") {
    const ref = obj["$ref"];
    const name = ref.replace(/^#\/(definitions|\$defs)\//, "");
    if (name !== ref && defs[name] && !stack.has(name)) {
      const next = new Set(stack);
      next.add(name);
      return walk(defs[name], defs, next);
    }
    // Unresolvable / circular — fall through, $ref gets dropped by DROP_KEYS.
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = walk(v, defs, stack);
  }
  return out;
}

export async function messagesToGemini(messages: FaMessage[]): Promise<GeminiContent[]> {
  const toolUseName = new Map<string, string>();
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    const parts: GeminiPart[] = [];
    let textBuf = "";
    const flushText = () => {
      if (textBuf) {
        parts.push({ text: textBuf });
        textBuf = "";
      }
    };
    for (const block of m.content) {
      if (block.kind === "text") {
        textBuf += block.text;
      } else if (block.kind === "tool_call") {
        flushText();
        toolUseName.set(block.callId, block.tool);
        parts.push({
          functionCall: {
            name: block.tool,
            args: (block.args ?? {}) as Record<string, unknown>,
          },
        });
      } else if (block.kind === "tool_result") {
        flushText();
        const name = toolUseName.get(block.callId) ?? "unknown";
        const responseStr = block.output;
        let response: Record<string, unknown>;
        try {
          const parsed = JSON.parse(responseStr);
          response =
            parsed !== null && typeof parsed === "object"
              ? (parsed as Record<string, unknown>)
              : { result: parsed };
        } catch {
          response = { result: responseStr };
        }
        parts.push({ functionResponse: { name, response } });
      } else if (block.kind === "image") {
        flushText();
        const part = await imageBlockToInlineData(block);
        if (part) parts.push(part);
      }
      // thinking dropped — no Gemini equivalent.
    }
    flushText();
    // Gemini requires at least one part per content; insert an empty text
    // block to keep the wire schema happy.
    if (parts.length === 0) parts.push({ text: "" });
    out.push({ role, parts });
  }
  return out;
}

async function imageBlockToInlineData(
  block: Extract<FaBlock, { kind: "image" }>,
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  const s = block.source;
  if (s.kind === "base64") {
    return { inlineData: { mimeType: s.mediaType, data: s.data } };
  }
  return fetchAsInlineData(s.url);
}

// Fetch a URL and convert to Gemini's inlineData (base64 + mimeType).
// Returns null on any failure — the message is sent without the image rather
// than the whole turn erroring out. Caps the body at 20 MB so a runaway
// download doesn't blow up the process.
async function fetchAsInlineData(
  url: string,
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mimeType =
      res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 20 * 1024 * 1024) return null;
    const data = Buffer.from(buf).toString("base64");
    return { inlineData: { mimeType, data } };
  } catch {
    return null;
  }
}

export type GeminiFunctionCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

export function geminiResponseToContent(
  textOut: string,
  functionCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): FaBlock[] {
  const out: FaBlock[] = [];
  if (textOut !== "") {
    out.push({ kind: "text", text: textOut });
  }
  for (const fc of functionCalls) {
    out.push({
      kind: "tool_call",
      callId: fc.id,
      tool: fc.name,
      args: (fc.args ?? {}) as JsonObject,
    });
  }
  return out;
}

export function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return reason ?? "end_turn";
  }
}
