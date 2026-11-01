// Shape of the self-hosted vector knowledge base (RAG), served from the `qdrant`
// compose service. It stores fitness/nutrition/exercise-science knowledge as
// embeddings so the agent can do semantic + lexical (hybrid) retrieval instead
// of relying solely on the model's training data.
//
// Three collections, all in the one Qdrant service (no Postgres — see
// docs/vector-rag-implementation.md):
//
//   - `knowledge`        : the search index. One point per *chunk*, with a named
//                          dense vector ("dense") + a named sparse/lexical vector
//                          ("lexical") for hybrid search.
//   - `knowledge_source` : the raw source of truth. One point per source
//                          document (full abstract + metadata), so we can
//                          re-chunk/re-embed without re-fetching, and cite from a
//                          clean record.
//   - `embedding_cache`  : content-addressed vector memoizer (§5.4) keyed by
//                          model@revision|instruction|text, so unchanged text is
//                          never re-embedded.

// Collection names. Kept here so the client, seeder, and ingest can't drift.
export const KNOWLEDGE_COLLECTION = "knowledge";
export const SOURCE_COLLECTION = "knowledge_source";
export const EMBED_CACHE_COLLECTION = "embedding_cache";

// Named vectors inside the `knowledge` collection.
export const DENSE_VECTOR = "dense";
export const SPARSE_VECTOR = "lexical";

// Evidence quality, ordered strongest → weakest. Drives the quality bias at
// retrieval time (a meta-analysis should outrank an n=12 single trial).
export type EvidenceLevel =
  | "meta-analysis"
  | "systematic-review"
  | "rct"
  | "cohort"
  | "narrative-review"
  | "guideline"
  | "textbook"
  | "other";

// One knowledge snippet, as authored/imported (the seed corpus shape). `id` is a
// stable, human-readable key ("kb:protein-timing"); the Qdrant point id is
// derived from it deterministically (see pointIdFor in client.ts) so re-seeding
// upserts in place rather than duplicating.
export type KnowledgeDoc = {
  id: string;
  title: string;
  text: string;
  // Where this came from (book, guideline, "seed"), display + provenance only.
  source: string | null;
  // Free-text tags for coarse filtering / display, e.g. ["nutrition","protein"].
  tags: string[];
};

// A stored chunk: the unit of retrieval in the `knowledge` collection. Derived
// from a source document by the recursive splitter (chunk.ts). The full doc-level
// metadata is duplicated here for display/citation without a second lookup, but
// the authoritative copy lives in `knowledge_source`.
export type KnowledgeChunk = {
  id: string; // stable: `${parent_id}#${chunk_index}` → pointIdFor() → UUID
  parent_id: string; // the source document id (point id in `knowledge_source`)
  title: string;
  text: string; // the chunk text (may carry a "Title › Section ›" breadcrumb)
  context?: string; // optional LLM-generated situating sentence (contextual retrieval)
  source: string | null; // "pubmed" | "guideline" | "textbook" | "seed" | ...
  url: string | null; // canonical link for citations
  pmid?: string;
  doi?: string;
  journal?: string;
  year?: number;
  evidence_level?: EvidenceLevel;
  mesh?: string[];
  tags: string[];
  chunk_index: number; // ordinal within the parent, for neighbor stitching
};

// The raw source-of-truth record, one per document, stored in
// `knowledge_source`. A superset of the chunk payload plus ingest bookkeeping.
export type KnowledgeSource = {
  id: string; // "pmid:12345678" | "nsca:ch7" | ...
  source: string; // "pubmed" | "guideline" | "textbook" | "app" | "seed"
  pmid?: string;
  doi?: string;
  url: string | null;
  // Object-storage key of the original file (PDF/doc) in MinIO, when this
  // source was ingested from an uploaded file rather than an abstract. The
  // binary is served via the app's /files/<object_key> route.
  object_key?: string;
  title: string;
  abstract: string; // cleaned full text / abstract — the archived copy
  journal?: string;
  year?: number;
  authors: string[];
  mesh: string[];
  evidence_level?: EvidenceLevel;
  pub_types: string[];
  // Ingest bookkeeping (§5.2):
  content_hash: string; // detect changed records → re-embed
  indexed: boolean; // chunks written to `knowledge`?
  deleted: boolean; // soft-delete (PubMed retraction/delete)
};

// A single search hit: the stored doc/chunk fields plus its score. After
// reranking, `score` is the cross-encoder relevance; before, the fused retrieval
// score. Shape kept stable for the agent's `search_knowledge` tool.
export type KnowledgeHit = {
  id: string;
  title: string;
  text: string;
  source: string | null;
  tags: string[];
  score: number;
  // Enriched fields (present once the ingest pipeline populates them).
  url?: string | null;
  parent_id?: string;
  evidence_level?: EvidenceLevel;
  year?: number;
};

// A sparse vector in Qdrant's wire shape: parallel arrays of dimension indices
// and their weights. Produced by the lexical encoder (sparse.ts).
export type SparseVector = {
  indices: number[];
  values: number[];
};
