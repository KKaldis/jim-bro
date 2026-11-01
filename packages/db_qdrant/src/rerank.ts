// Cross-encoder reranking via a self-hosted Qwen3-Reranker (vLLM / TEI / Infinity
// / Jina-shaped `/rerank` endpoint).
//
// Bi-encoder cosine is a cheap approximation; a cross-encoder reads (query,
// passage) jointly and is far more accurate — but too slow to run over the whole
// corpus. So retrieval pulls a wide candidate set and this reorders it down to
// the top N.
//
// Graceful degradation: if RERANKER_URL is unset (local/dev) or the call fails,
// we return the candidates unchanged (identity order) so the retrieval path keeps
// working without the reranker service.

import { logger } from "@fa/logger";

const log = logger.child({ mod: "qdrant-rerank" });

export type Reranked<T> = { item: T; score: number };

export function rerankerEnabled(): boolean {
  return !!process.env.RERANKER_URL && process.env.RAG_RERANK !== "false";
}

function rerankerModel(): string | undefined {
  return process.env.RERANKER_MODEL || undefined;
}

// Reorder `items` by cross-encoder relevance to `query`, returning the top `top`
// with scores. `textOf` extracts the passage text from each item. Falls back to
// the original order (scored 0) when the reranker isn't configured/reachable.
export async function rerank<T>(
  query: string,
  items: T[],
  top: number,
  textOf: (item: T) => string,
): Promise<Reranked<T>[]> {
  if (items.length === 0) return [];
  if (!rerankerEnabled()) {
    return items.slice(0, top).map((item) => ({ item, score: 0 }));
  }

  const url = process.env.RERANKER_URL!.replace(/\/+$/, "");
  const documents = items.map(textOf);
  // Hosted rerank providers (DeepInfra / SiliconFlow / Jina / Cohere-compatible)
  // require a bearer token; a self-hosted server ignores it.
  const apiKey = process.env.RERANKER_API_KEY;
  try {
    const res = await fetch(`${url}/rerank`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...(rerankerModel() ? { model: rerankerModel() } : {}),
        query,
        documents,
        top_n: top,
      }),
    });
    if (!res.ok) throw new Error(`reranker ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as RerankResponse;
    const results = normalizeRerank(body);
    if (!results.length) throw new Error("reranker returned no results");
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, top)
      .map((r) => ({ item: items[r.index], score: r.score }))
      .filter((r) => r.item !== undefined);
  } catch (err) {
    // Don't take down retrieval because the reranker hiccuped — log and pass the
    // pre-rerank order through.
    log.warn("rerank failed, falling back to fused order", {
      error: err instanceof Error ? err.message : String(err),
    });
    return items.slice(0, top).map((item) => ({ item, score: 0 }));
  }
}

// Different servers shape the response slightly differently; accept the common
// variants (TEI/Jina: `results: [{index, relevance_score}]`; some: `[{index,
// score}]`; vLLM score API: `data: [{index, score}]`).
type RerankResult = { index: number; relevance_score?: number; score?: number };
type RerankResponse = {
  results?: RerankResult[];
  data?: RerankResult[];
};

function normalizeRerank(body: RerankResponse): { index: number; score: number }[] {
  const rows = body.results ?? body.data ?? [];
  return rows.map((r) => ({
    index: r.index,
    score: r.relevance_score ?? r.score ?? 0,
  }));
}
