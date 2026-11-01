/**
 * Kimi (Moonshot AI) adapter.
 *
 * Moonshot's API is OpenAI-compatible — same chat-completions wire format,
 * just a different baseURL and a different set of model IDs. We extend the
 * OpenAI adapter and override:
 *   - baseURL → https://api.moonshot.ai/v1
 *   - default API key env → KIMI_API_KEY (falls back to MOONSHOT_API_KEY)
 *   - provider id → "kimi" (so limits + ledger attribute correctly)
 *
 * Notable model IDs:
 *   - kimi-k2-0905-preview     general flagship
 *   - moonshot-v1-8k           classic, 8k context
 *   - moonshot-v1-32k          classic, 32k context
 *   - moonshot-v1-128k         classic, 128k context
 *   - kimi-thinking-preview    reasoning variant (server-side thinking)
 *   - kimi-k3                  frontier, always reasons (reasoning_effort)
 *
 * Rate limits (Tier 0 = $1 minimum recharge): RPM 3, TPM 500k, TPD 1.5M.
 * See providers/limits.ts.
 */
import type { OpenAIFunctionTool } from "./openai-convert.ts";
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai.ts";
import type { StreamIterationArgs } from "./types.ts";

const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

// Moonshot's "flavored" JSON-Schema validator rejects any node that carries a
// sibling `type` alongside `anyOf` ("when using anyOf, type should be defined
// in anyOf items instead of the parent schema"). Our tool registry uses that
// shape at the schema root to express either/or required-field sets — e.g.
//   { type: "object", properties: {...}, anyOf: [{required:[...]},{required:[...]}] }
// Anthropic *requires* the root `type: "object"`, so we can't drop it at the
// source; instead we strip the offending `anyOf` (a soft constraint already
// spelled out in each tool's description) only for the Moonshot wire. Nodes
// that use `anyOf` *without* a sibling `type` (each branch carries its own
// type — e.g. update_meal's `update_item` object-or-array) are already valid
// and left untouched.
function stripTypeSiblingAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripTypeSiblingAnyOf);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "anyOf" && "type" in (node as Record<string, unknown>)) continue;
    out[key] = stripTypeSiblingAnyOf(value);
  }
  return out;
}

export type KimiProviderOptions = Omit<OpenAIProviderOptions, "providerId" | "envPrefix"> & {
  baseURL?: string;
};

export class KimiProvider extends OpenAIProvider {
  constructor(opts: KimiProviderOptions) {
    const isThinkingModel = /thinking|k2\.[567]|k2-?[567]|k3/i.test(opts.model);
    // Models that accept the per-request `thinking` switch (see
    // extraRequestParams). kimi-thinking-preview always reasons.
    const thinkingToggle = /k2\.[56]|k2-?[56]/i.test(opts.model);
    super({
      ...opts,
      providerId: "kimi",
      envPrefix: "KIMI",
      baseURL: opts.baseURL ?? KIMI_BASE_URL,
      apiKey: opts.apiKey ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY,
      // Thinking-class Kimi models stream `reasoning_content` server-side and
      // demand it back on every assistant tool-call message in history. The
      // openai adapter captures it from the stream and re-attaches it on
      // round-trip when this flag is set.
      preserveReasoning: isThinkingModel,
      capabilities: {
        vision: opts.model.includes("vision"),
        // K2.5 / K2.6 take a per-request thinking switch, so the agent's
        // thinking flag really turns reasoning off (extraRequestParams).
        // Other thinking-class models always reason server-side.
        thinking: thinkingToggle,
        // serverTools=false here refers to the Anthropic-shaped server tool
        // contract (no `server_tool_call` stream events, no inline result
        // blocks). Moonshot's `$web_search` builtin works differently: the
        // model emits a normal tool_call which the developer must echo back
        // as a tool_result. That round-trip is handled like any other client
        // tool — see extraWireTools() below and the `$`-prefixed branch in
        // tools.ts runTool().
        serverTools: false,
        // Context caching exists but requires a separate caches endpoint;
        // not used here.
        promptCache: false,
        ...opts.capabilities,
      },
    });
  }

  // Moonshot rejects `type` + `anyOf` siblings; rewrite tool schemas to drop
  // that construct before they reach the wire. See stripTypeSiblingAnyOf.
  protected override sanitizeWireTools(tools: OpenAIFunctionTool[]): OpenAIFunctionTool[] {
    return tools.map((t) => ({
      ...t,
      function: {
        ...t.function,
        parameters: stripTypeSiblingAnyOf(t.function.parameters) as Record<string, unknown>,
      },
    }));
  }

  // Moonshot's `$web_search` builtin. The model decides when to call it; we
  // echo the tool_call's arguments back as the tool_result content, and the
  // server returns search results in the next iteration. Per-call fee is
  // ~$0.005 plus tokens; set KIMI_WEB_SEARCH_DISABLED=true to hide the tool
  // from the model. Note: Moonshot docs say "thinking must be disabled" when
  // $web_search is used — extraRequestParams below turns thinking off on any
  // iteration that offers it.
  //
  // `allowWebSearch` is the agent's DB-first gate: until the model has searched
  // our self-hosted food index (lookup_product), we withhold $web_search
  // entirely so it can't reach the internet before our own data. The gate flips
  // on once lookup_product runs (see chat() in agent.ts).
  protected override extraWireTools(allowWebSearch: boolean): unknown[] {
    // K3 can't disable thinking, which $web_search requires — never offer it.
    if (isK3(this.model) || !webSearchOffered(allowWebSearch)) return [];
    return [
      {
        type: "builtin_function",
        function: { name: "$web_search" },
      },
    ];
  }

  // K2.5 / K2.6 think by default and take `thinking: {type: "disabled"}` to
  // skip it for one request. Sent when the agent asks for a thinking-off
  // iteration, and whenever $web_search is on the wire (Moonshot requires it).
  // History needs no change either way: tool-call messages always carry a
  // (possibly empty) reasoning_content — see pushAssistant in openai-convert.
  //
  // K3 has no thinking switch — it always reasons, at `reasoning_effort: "max"`
  // unless told otherwise (reasoning bills as output at $15/M). Map the agent's
  // thinking flag onto effort instead: deep turns get "high", the rest "low".
  protected override extraRequestParams(args: StreamIterationArgs): Record<string, unknown> {
    if (isK3(this.model)) return { reasoning_effort: args.thinking ? "high" : "low" };
    if (!this.capabilities.thinking) return {};
    if (args.thinking && !webSearchOffered(args.allowWebSearch)) return {};
    return { thinking: { type: "disabled" } };
  }
}

function isK3(model: string): boolean {
  return /k3/i.test(model);
}

function webSearchOffered(allowWebSearch: boolean): boolean {
  return allowWebSearch && process.env.KIMI_WEB_SEARCH_DISABLED !== "true";
}
