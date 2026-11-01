// Rebuild the `knowledge` hybrid index from the `knowledge_source` raw records —
// no PubMed re-fetch. Run this after an embedder upgrade (bump EMBED_REVISION /
// EMBEDDING_MODEL) or a chunk-size change.
//
//   bun run packages/db_qdrant/src/ingest/reindex.ts

import { logger } from "@fa/logger";
import { reindexFromSources } from "./common.ts";
import { knowledgeCount } from "../client.ts";
import { embedInfo } from "../embed.ts";

const log = logger.child({ mod: "qdrant-reindex" });

async function main() {
  log.info("reindex starting", { ...embedInfo() });
  const sources = await reindexFromSources();
  const chunks = await knowledgeCount();
  log.info("reindex complete", { sources, chunks });
}

if (import.meta.main) {
  await main();
}
