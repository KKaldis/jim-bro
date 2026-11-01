// @fa/db_qdrant — self-hosted vector knowledge base (RAG), served from the
// `qdrant` compose service. Hybrid (dense + lexical) retrieval over
// fitness/nutrition/exercise-science knowledge, with a raw source-of-truth
// collection and a content-addressed embedding cache. See
// docs/vector-rag-implementation.md.
export * from "./types.ts";
export {
  qdrant,
  pointIdFor,
  ensureCollection,
  ensureSourceCollection,
  ensureCacheCollection,
  embedCachedBatch,
  upsertChunks,
  upsertSources,
  upsertKnowledge,
  searchKnowledge,
  getSource,
  knowledgeCount,
  knowledgeStatus,
  dropCollection,
  dropAll,
  type SearchOptions,
} from "./client.ts";
export {
  embedText,
  embedQuery,
  embedBatch,
  embedKey,
  embedDim,
  embedModelName,
  embedRevision,
  embedderKind,
  embedInfo,
  queryInstruction,
  type EmbedderKind,
} from "./embed.ts";
export { sparseEncode } from "./sparse.ts";
export { splitText, type Chunk, type SplitOptions } from "./chunk.ts";
export { rerank, rerankerEnabled } from "./rerank.ts";
export {
  sourceToChunks,
  ingestSources,
  reindexFromSources,
  purgeChunks,
  contentHash,
} from "./ingest/common.ts";
export { ingestTopic } from "./ingest/pubmed.ts";
export { ingestFile, type FileIngestMeta } from "./ingest/files.ts";
export { DEFAULT_KNOWLEDGE, seedDefaults } from "./seed.ts";
