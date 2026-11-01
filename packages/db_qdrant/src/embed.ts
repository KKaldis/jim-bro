// Text → dense vector embedding for the knowledge base.
//
// Provider-agnostic, like @fa/agent's LLM providers — but simpler, because
// embedding APIs are almost universally OpenAI-shaped (`POST /v1/embeddings`).
// So there are just two adapters:
//
//   - "remote" : ANY OpenAI-compatible embeddings endpoint. This is the
//                production path and covers every provider we'd realistically
//                use — OpenAI, SiliconFlow, DeepInfra, Together, or a self-hosted
//                vLLM / TEI / Infinity server. Swap provider OR model by changing
//                env only (EMBEDDER_URL / EMBEDDING_MODEL / EMBEDDING_DIM /
//                EMBEDDER_API_KEY), then `reindex` to re-embed from
//                knowledge_source. No code change.
//   - "local"  : a deterministic, dependency-free hashing embedder (384 dims).
//                No network, no key — keeps search + seeding working out of the
//                box on a fresh checkout / in CI.
//
// A truly bespoke provider (Cohere / Voyage / Jina native formats) would be a
// small additional adapter here — the same extension seam @fa/agent uses for
// non-OpenAI LLMs. Until we need one, "remote" is the whole story.
//
// IMPORTANT: a Qdrant collection is created with one vector size. Don't switch
// embedding models against an existing collection — the dimensions won't match.
// Re-ingest (dropAll → ingest) or `reindex` into a fresh collection after a
// model/dimension change.

import { createHash } from "node:crypto";
import OpenAI from "openai";
import { logger } from "@fa/logger";

const log = logger.child({ mod: "qdrant-embed" });

const LOCAL_DIM = 384;
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIM = 1536;

export type EmbedderKind = "remote" | "local";

// Decide the active adapter from env. Accepts provider-neutral `remote` plus the
// legacy aliases (`openai`, `qwen3`) for back-compat. `auto` resolves to remote
// when an endpoint or key is configured, else the local fallback.
export function embedderKind(): EmbedderKind {
  const pin = (process.env.QDRANT_EMBEDDER ?? "auto").toLowerCase();
  if (pin === "local") return "local";
  if (["remote", "openai", "qwen3", "openai-compatible"].includes(pin)) return "remote";
  return process.env.EMBEDDER_URL || process.env.OPENAI_API_KEY ? "remote" : "local";
}

// The model id sent to the remote provider (e.g. "Qwen/Qwen3-Embedding-8B" or
// "text-embedding-3-small"). Local mode reports a synthetic name.
export function embedModelName(): string {
  if (embedderKind() === "local") return `local-hash-${LOCAL_DIM}`;
  return process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
}

// The vector size the active embedder produces. The collection is created with
// exactly this size. For remote models set EMBEDDING_DIM to the model's output
// (Qwen3-Embedding-8B = 4096, -0.6B = 1024, OpenAI 3-small = 1536).
export function embedDim(): number {
  if (embedderKind() === "local") return LOCAL_DIM;
  const d = Number(process.env.EMBEDDING_DIM);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_DIM;
}

// Whether this model wants an instruction prefix on *queries* (documents stay
// plain). Qwen3 embedders are instruction-aware; OpenAI's are not. Auto-detected
// from the model name; override with EMBEDDING_INSTRUCT=true|false.
function instructionAware(): boolean {
  const override = process.env.EMBEDDING_INSTRUCT;
  if (override === "true") return true;
  if (override === "false") return false;
  return /qwen|instruct/i.test(embedModelName());
}

// A revision tag folded into the content-addressed cache key (§5.4). Bump
// EMBED_REVISION to deliberately invalidate cached vectors without changing the
// model name.
export function embedRevision(): string {
  return process.env.EMBED_REVISION || "v1";
}

// The instruction prepended to query text for instruction-aware models.
export function queryInstruction(): string {
  return (
    process.env.RAG_QUERY_INSTRUCTION ||
    "Given a fitness and nutrition question, retrieve scientific passages that answer it."
  );
}

// Content-addressed cache key: a vector is a pure function of model + revision +
// instruction + exact text. Hash all four so the same input is never embedded
// twice (see client.ts embedCachedBatch). Documents pass instruction="".
export function embedKey(text: string, instruction = ""): string {
  return createHash("sha256")
    .update(`${embedModelName()}@${embedRevision()}|${instruction}|${text}`)
    .digest("hex");
}

let _openai: OpenAI | null = null;
let _openaiBase: string | undefined;
let _openaiKey: string | undefined;
// One OpenAI-shaped client for the "remote" adapter — works against any
// OpenAI-compatible endpoint (hosted provider or self-hosted server). Rebuilt if
// the target base URL or key changes.
function remoteClient(): OpenAI {
  // EMBEDDER_URL points at the provider; unset → OpenAI's own cloud.
  const baseURL = process.env.EMBEDDER_URL || process.env.OPENAI_BASE_URL || undefined;
  // Hosted providers require a real key; a self-hosted server ignores it, so
  // fall back to a placeholder so the SDK doesn't throw when no key is set.
  const apiKey = process.env.EMBEDDER_API_KEY || process.env.OPENAI_API_KEY || "sk-noauth";
  if (!_openai || _openaiBase !== baseURL || _openaiKey !== apiKey) {
    _openai = new OpenAI({ apiKey, baseURL });
    _openaiBase = baseURL;
    _openaiKey = apiKey;
  }
  return _openai;
}

// Deterministic feature-hashing embedder. Tokenize to lowercase alphanumerics,
// hash each token (FNV-1a) into a signed bucket, accumulate, then L2-normalize so
// dot-product == cosine. No randomness → stable across runs and processes.
function localEmbed(text: string): number[] {
  const v = new Array<number>(LOCAL_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const u = h >>> 0;
    const bucket = u % LOCAL_DIM;
    const sign = u & 1 ? 1 : -1;
    v[bucket] += sign;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

// Max inputs per remote embeddings request. Providers cap this (SiliconFlow,
// most OpenAI-compatible APIs allow only a few dozen per call), so we sub-batch
// large ingests rather than sending one giant request. Override with
// EMBED_BATCH_SIZE.
function embedBatchSize(): number {
  const n = Number(process.env.EMBED_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32;
}

// Embed one sub-batch with validation + retry. Hosted providers occasionally
// return a short, empty, or NaN-laced batch under load; an unchecked response
// then produces vectors Qdrant rejects with an opaque 400. So we validate count
// + dimension + finiteness and retry a few times before giving up.
async function embedSlice(
  slice: string[],
  model: string,
  sendDim: boolean,
  dim: number,
  expectedDim: number,
): Promise<number[][]> {
  const attempts = Math.max(1, Number(process.env.EMBED_RETRIES) || 3);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await remoteClient().embeddings.create({
        model,
        input: slice,
        ...(sendDim ? { dimensions: dim } : {}),
      });
      // The API echoes inputs back in order, but sort by index defensively.
      const vecs = res.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding as number[]);
      const valid =
        vecs.length === slice.length &&
        vecs.every((v) => v.length === expectedDim && v.every(Number.isFinite));
      if (valid) return vecs;
      lastErr = new Error(
        `malformed response: ${vecs.length}/${slice.length} vectors, ` +
          `dims ${vecs[0]?.length ?? 0} (expected ${expectedDim})`,
      );
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) {
      log.warn("embed slice retry", { model, attempt, size: slice.length });
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(
    `embedder ${model} failed after ${attempts} attempts: ` +
      (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  );
}

// Embed a batch of texts in the active mode. Remote requests are sub-batched to
// stay under the provider's per-request input cap (each slice validated +
// retried); local is computed inline. Returned vector order matches the input.
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (embedderKind() === "local") return texts.map(localEmbed);

  // OpenAI's text-embedding-3-* accept an explicit `dimensions` (Matryoshka);
  // other providers/models generally don't, so only send it for those.
  const model = embedModelName();
  const dim = Number(process.env.EMBEDDING_DIM);
  const sendDim = /^text-embedding-3/.test(model) && Number.isFinite(dim) && dim > 0;
  const size = embedBatchSize();
  const expectedDim = embedDim();

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    out.push(...(await embedSlice(texts.slice(i, i + size), model, sendDim, dim, expectedDim)));
  }
  return out;
}

// Embed a single document (plain — no instruction).
export async function embedText(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  return v;
}

// Embed a *query*. For instruction-aware models the task instruction is
// prepended; other models behave like embedText.
export async function embedQuery(text: string): Promise<number[]> {
  const input = instructionAware() ? `${queryInstruction()}\n${text}` : text;
  return embedText(input);
}

// One-line summary of the active embedder for the test tool / logs.
export function embedInfo(): { embedder: EmbedderKind; model: string; dim: number } {
  const info = { embedder: embedderKind(), model: embedModelName(), dim: embedDim() };
  log.debug("embedder selected", info);
  return info;
}
