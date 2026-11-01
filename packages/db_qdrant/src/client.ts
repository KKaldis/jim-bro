// Runtime client for the self-hosted vector knowledge base (Qdrant).
//
// Three collections, all in the one Qdrant service (no Postgres):
//   - `knowledge`        : hybrid search index (named dense + sparse vectors).
//   - `knowledge_source` : raw source-of-truth records (one point per document).
//   - `embedding_cache`  : content-addressed vector memoizer (§5.4).
//
// The retrieval path is a fast read: every chunk is embedded (dense + sparse) at
// write time and queried by RRF-fused hybrid search + optional cross-encoder
// rerank at request time. See docs/vector-rag-implementation.md.

import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { logger } from "@fa/logger";
import {
  KNOWLEDGE_COLLECTION,
  SOURCE_COLLECTION,
  EMBED_CACHE_COLLECTION,
  DENSE_VECTOR,
  SPARSE_VECTOR,
  type KnowledgeDoc,
  type KnowledgeChunk,
  type KnowledgeSource,
  type KnowledgeHit,
} from "./types.ts";
import { embedBatch, embedQuery, embedKey, embedDim, embedInfo } from "./embed.ts";
import { sparseEncode } from "./sparse.ts";
import { rerank, rerankerEnabled } from "./rerank.ts";

const log = logger.child({ mod: "qdrant" });

// Lazily-built singleton so importing this module doesn't open a connection.
// Reads config from env: QDRANT_URL (default localhost) + optional QDRANT_API_KEY.
let _client: QdrantClient | null = null;
export function qdrant(): QdrantClient {
  if (!_client) {
    const url = process.env.QDRANT_URL ?? "http://localhost:6333";
    const apiKey = process.env.QDRANT_API_KEY || undefined;
    // checkCompatibility:false — the npm client tracks the latest Qdrant minor,
    // which may run ahead of our pinned server image; the REST surface we use is
    // stable across these minors, so skip the noisy version-skew warning.
    _client = new QdrantClient({ url, apiKey, checkCompatibility: false });
  }
  return _client;
}

// Qdrant point ids must be unsigned ints or UUIDs — our ids are human-readable
// strings ("kb:protein-timing", "pmid:123#2", a cache hash). Derive a stable
// UUID from the string (SHA-1 → UUID-shaped) so re-writing the same id upserts in
// place rather than duplicating.
export function pointIdFor(stableId: string): string {
  const h = createHash("sha1").update(stableId).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Per-process "ensured" cache so repeated calls don't re-hit Qdrant. Reset by
// dropCollection / dropAll.
const _ensured = new Set<string>();

// Create the hybrid `knowledge` collection (idempotent): a named dense vector
// sized to the active embedder + a named sparse vector with the IDF modifier so
// Qdrant applies BM25 weighting to the term-frequency vectors we supply.
export async function ensureCollection(): Promise<void> {
  if (_ensured.has(KNOWLEDGE_COLLECTION)) return;
  const client = qdrant();
  const exists = await client.collectionExists(KNOWLEDGE_COLLECTION);
  if (!exists.exists) {
    await client.createCollection(KNOWLEDGE_COLLECTION, {
      vectors: { [DENSE_VECTOR]: { size: embedDim(), distance: "Cosine" } },
      sparse_vectors: { [SPARSE_VECTOR]: { modifier: "idf" } },
    });
    await createPayloadIndexes(KNOWLEDGE_COLLECTION, {
      parent_id: "keyword",
      source: "keyword",
      evidence_level: "keyword",
      year: "integer",
      pmid: "keyword",
      tags: "keyword",
    });
    log.info("collection created", { collection: KNOWLEDGE_COLLECTION, dim: embedDim() });
  }
  _ensured.add(KNOWLEDGE_COLLECTION);
}

// Raw source-of-truth collection. Its vector is the embedding of title+abstract,
// which doubles as a coarse doc-level retrieval / dedup signal.
export async function ensureSourceCollection(): Promise<void> {
  if (_ensured.has(SOURCE_COLLECTION)) return;
  const client = qdrant();
  const exists = await client.collectionExists(SOURCE_COLLECTION);
  if (!exists.exists) {
    await client.createCollection(SOURCE_COLLECTION, {
      vectors: { [DENSE_VECTOR]: { size: embedDim(), distance: "Cosine" } },
    });
    await createPayloadIndexes(SOURCE_COLLECTION, {
      pmid: "keyword",
      source: "keyword",
      evidence_level: "keyword",
      year: "integer",
      indexed: "bool",
      deleted: "bool",
    });
    log.info("collection created", { collection: SOURCE_COLLECTION, dim: embedDim() });
  }
  _ensured.add(SOURCE_COLLECTION);
}

// Content-addressed embedding cache: plain dense vectors keyed by hash.
export async function ensureCacheCollection(): Promise<void> {
  if (_ensured.has(EMBED_CACHE_COLLECTION)) return;
  const client = qdrant();
  const exists = await client.collectionExists(EMBED_CACHE_COLLECTION);
  if (!exists.exists) {
    await client.createCollection(EMBED_CACHE_COLLECTION, {
      vectors: { [DENSE_VECTOR]: { size: embedDim(), distance: "Cosine" } },
    });
    log.info("collection created", { collection: EMBED_CACHE_COLLECTION, dim: embedDim() });
  }
  _ensured.add(EMBED_CACHE_COLLECTION);
}

async function createPayloadIndexes(
  collection: string,
  fields: Record<string, "keyword" | "integer" | "bool">,
): Promise<void> {
  for (const [field_name, field_schema] of Object.entries(fields)) {
    await qdrant().createPayloadIndex(collection, { field_name, field_schema, wait: true });
  }
}

// ---------------------------------------------------------------------------
// Content-addressed embedding (§5.4)
// ---------------------------------------------------------------------------

// Embed `texts` (documents — plain, no instruction) through the cache: look up
// each by its content hash, embed only the misses, write them back, and return
// vectors in the original order. Unchanged text is never re-embedded.
export async function embedCachedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  await ensureCacheCollection();

  const keys = texts.map((t) => embedKey(t));
  const ids = keys.map(pointIdFor);

  // Dedupe ids within the batch so identical text embeds once even in one call.
  const uniqueIds = [...new Set(ids)];
  const hits = await qdrant().retrieve(EMBED_CACHE_COLLECTION, {
    ids: uniqueIds,
    with_vector: true,
  });
  const byId = new Map<string, number[]>();
  for (const h of hits) {
    const v = (h.vector as { [k: string]: number[] } | number[] | undefined) ?? undefined;
    const vec = Array.isArray(v) ? v : v?.[DENSE_VECTOR];
    if (vec) byId.set(String(h.id), vec);
  }

  // Embed the distinct misses.
  const missIdx: number[] = [];
  const missText: string[] = [];
  const seen = new Set<string>();
  texts.forEach((t, i) => {
    if (byId.has(ids[i]) || seen.has(ids[i])) return;
    seen.add(ids[i]);
    missIdx.push(i);
    missText.push(t);
  });

  if (missText.length) {
    const fresh = await embedBatch(missText);
    const points = missText.map((_, j) => ({
      id: ids[missIdx[j]],
      vector: { [DENSE_VECTOR]: fresh[j] },
      payload: { key: keys[missIdx[j]] },
    }));
    await qdrant().upsert(EMBED_CACHE_COLLECTION, { wait: true, points });
    fresh.forEach((vec, j) => byId.set(ids[missIdx[j]], vec));
    log.debug("embedding cache", { hits: texts.length - missText.length, misses: missText.length });
  }

  return ids.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Upsert full chunks into the hybrid index. Embeds dense (via cache) + sparse,
// then writes named vectors + payload keyed by the derived chunk id.
export async function upsertChunks(chunks: KnowledgeChunk[]): Promise<number> {
  if (chunks.length === 0) return 0;
  await ensureCollection();
  const dense = await embedCachedBatch(
    chunks.map((c) => (c.context ? `${c.context}\n${c.text}` : c.text)),
  );
  await qdrant().upsert(KNOWLEDGE_COLLECTION, {
    wait: true,
    points: chunks.map((c, i) => ({
      id: pointIdFor(c.id),
      vector: {
        [DENSE_VECTOR]: dense[i],
        [SPARSE_VECTOR]: sparseEncode(`${c.title}\n${c.text}`),
      },
      payload: c as unknown as Record<string, unknown>,
    })),
  });
  log.info("upserted chunks", { count: chunks.length });
  return chunks.length;
}

// Upsert raw source records into the source-of-truth collection. The vector is
// the embedding of title + abstract.
export async function upsertSources(sources: KnowledgeSource[]): Promise<number> {
  if (sources.length === 0) return 0;
  await ensureSourceCollection();
  const dense = await embedCachedBatch(sources.map((s) => `${s.title}\n${s.abstract}`));
  await qdrant().upsert(SOURCE_COLLECTION, {
    wait: true,
    points: sources.map((s, i) => ({
      id: pointIdFor(s.id),
      vector: { [DENSE_VECTOR]: dense[i] },
      payload: s as unknown as Record<string, unknown>,
    })),
  });
  log.info("upserted sources", { count: sources.length });
  return sources.length;
}

// Seed/import path: treat each KnowledgeDoc as a single self-parented chunk so
// the starter corpus indexes into the hybrid collection like any other source.
export async function upsertKnowledge(docs: KnowledgeDoc[]): Promise<number> {
  if (docs.length === 0) return 0;
  const chunks: KnowledgeChunk[] = docs.map((d) => ({
    id: `${d.id}#0`,
    parent_id: d.id,
    title: d.title,
    text: d.text,
    source: d.source,
    url: null,
    tags: d.tags,
    chunk_index: 0,
  }));
  return upsertChunks(chunks);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type QdrantFilter = Record<string, unknown>;

export type SearchOptions = {
  top?: number;
  // How many candidates to pull before reranking (the "wide net"). Default 50.
  candidates?: number;
  // Optional Qdrant payload filter (e.g. evidence-level / year bias).
  filter?: QdrantFilter;
};

// Hybrid semantic + lexical search with RRF fusion, then optional cross-encoder
// rerank. Empty/whitespace query → no results. Backward-compatible second arg:
// a number is treated as `top`.
export async function searchKnowledge(
  query: string,
  opts: SearchOptions | number = {},
): Promise<KnowledgeHit[]> {
  const q = query.trim();
  if (!q) return [];
  const o: SearchOptions = typeof opts === "number" ? { top: opts } : opts;
  const top = Math.min(20, Math.max(1, o.top ?? 8));
  const candidates = Math.min(200, Math.max(top, o.candidates ?? (rerankerEnabled() ? 50 : top)));

  await ensureCollection();
  const dense = await embedQuery(q);
  const sparse = sparseEncode(q);

  const runQuery = () =>
    qdrant().query(KNOWLEDGE_COLLECTION, {
      // Hybrid candidate generation: dense + sparse prefetch, fused with RRF.
      prefetch: [
        { query: dense, using: DENSE_VECTOR, limit: candidates, filter: o.filter },
        ...(sparse.indices.length
          ? [{ query: sparse, using: SPARSE_VECTOR, limit: candidates, filter: o.filter }]
          : []),
      ],
      query: { fusion: "rrf" },
      limit: candidates,
      with_payload: true,
    } as Parameters<QdrantClient["query"]>[1]);

  let fused = await runQuery();
  // A freshly created collection can briefly return no points on the very first
  // query (segment not queryable yet) even though rows exist. Retry once.
  if ((fused.points ?? []).length === 0 && (await knowledgeCount()) > 0) {
    await new Promise((r) => setTimeout(r, 200));
    fused = await runQuery();
  }

  const points = fused.points ?? [];
  const hits: Array<KnowledgeHit & { _fused: number }> = points.map((p) => {
    const c = (p.payload ?? {}) as Partial<KnowledgeChunk>;
    return {
      id: c.id ?? String(p.id),
      title: c.title ?? "",
      text: c.text ?? "",
      source: c.source ?? null,
      tags: c.tags ?? [],
      url: c.url ?? null,
      parent_id: c.parent_id,
      evidence_level: c.evidence_level,
      year: c.year,
      score: p.score ?? 0,
      _fused: p.score ?? 0,
    };
  });

  // Rerank the wide candidate set down to `top` (identity passthrough when the
  // reranker isn't configured — see rerank.ts).
  const ranked = await rerank(q, hits, top, (h) => `${h.title}\n${h.text}`);
  return ranked.map(({ item, score }) => ({
    ...item,
    score: rerankerEnabled() ? score : item._fused,
    _fused: undefined,
  })) as KnowledgeHit[];
}

// Fetch the full raw source record for a chunk's parent_id (citations /
// parent-document retrieval). Returns null if absent.
export async function getSource(parentId: string): Promise<KnowledgeSource | null> {
  // Tolerate a not-yet-created collection (first ingest calls this for dedup
  // before any source has been written).
  if (!_ensured.has(SOURCE_COLLECTION)) {
    const exists = await qdrant().collectionExists(SOURCE_COLLECTION);
    if (!exists.exists) return null;
  }
  const res = await qdrant().retrieve(SOURCE_COLLECTION, {
    ids: [pointIdFor(parentId)],
    with_payload: true,
  });
  const p = res[0]?.payload;
  return p ? (p as unknown as KnowledgeSource) : null;
}

// How many chunk points are stored. Returns 0 if the collection doesn't exist.
export async function knowledgeCount(): Promise<number> {
  const exists = await qdrant().collectionExists(KNOWLEDGE_COLLECTION);
  if (!exists.exists) return 0;
  const info = await qdrant().getCollection(KNOWLEDGE_COLLECTION);
  return info.points_count ?? 0;
}

// Liveness + config snapshot for the test tool: confirms Qdrant is reachable and
// reports the active embedder. Throws on transport error (caller maps it to a
// friendly { ok: false }).
export async function knowledgeStatus(): Promise<{
  reachable: boolean;
  collection: string;
  points: number;
  embedder: ReturnType<typeof embedInfo>;
  reranker: boolean;
}> {
  const points = await knowledgeCount();
  return {
    reachable: true,
    collection: KNOWLEDGE_COLLECTION,
    points,
    embedder: embedInfo(),
    reranker: rerankerEnabled(),
  };
}

// Drop the hybrid index (used by tests / re-seeding after a dimension change).
export async function dropCollection(): Promise<void> {
  await qdrant().deleteCollection(KNOWLEDGE_COLLECTION);
  _ensured.delete(KNOWLEDGE_COLLECTION);
  log.warn("collection dropped", { collection: KNOWLEDGE_COLLECTION });
}

// Drop every knowledge collection — full reset.
export async function dropAll(): Promise<void> {
  for (const c of [KNOWLEDGE_COLLECTION, SOURCE_COLLECTION, EMBED_CACHE_COLLECTION]) {
    try {
      await qdrant().deleteCollection(c);
    } catch {
      // may not exist — fine
    }
    _ensured.delete(c);
  }
  log.warn("all knowledge collections dropped");
}
