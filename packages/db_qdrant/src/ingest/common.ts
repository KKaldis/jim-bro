// Shared ingest helpers: turn a raw source record into index chunks, and the
// "raw → split → embed → upsert" step both the PubMed ingest and the standalone
// reindex script run.

import { createHash } from "node:crypto";
import { splitText } from "../chunk.ts";
import { upsertChunks, upsertSources, qdrant } from "../client.ts";
import { KNOWLEDGE_COLLECTION, type KnowledgeChunk, type KnowledgeSource } from "../types.ts";

// Stable hash of the fields that affect the embedding/index, so re-ingest can
// skip unchanged records (§5.4 layer 1).
export function contentHash(s: Pick<KnowledgeSource, "title" | "abstract">): string {
  return createHash("sha256").update(`${s.title}\n${s.abstract}`).digest("hex");
}

// Split a source document into chunks, prefixing each with a breadcrumb so an
// isolated chunk keeps its parent context. Abstracts usually yield one chunk.
export function sourceToChunks(s: KnowledgeSource, opts?: { maxChars?: number }): KnowledgeChunk[] {
  const breadcrumb = `${s.title} › `;
  const pieces = splitText(s.abstract, { maxChars: opts?.maxChars });
  // A source with no abstract still deserves a title-only chunk so it's findable.
  const units = pieces.length ? pieces : [{ text: s.title, index: 0 }];
  return units.map((p) => ({
    id: `${s.id}#${p.index}`,
    parent_id: s.id,
    title: s.title,
    text: pieces.length ? `${breadcrumb}${p.text}` : p.text,
    source: s.source,
    url: s.url,
    pmid: s.pmid,
    doi: s.doi,
    journal: s.journal,
    year: s.year,
    evidence_level: s.evidence_level,
    mesh: s.mesh,
    tags: s.mesh.slice(0, 8),
    chunk_index: p.index,
  }));
}

// Persist a batch of raw records (source of truth) and their derived chunks.
// Upserts the source first so it survives even if chunk embedding fails midway.
export async function ingestSources(
  sources: KnowledgeSource[],
  opts?: { maxChars?: number },
): Promise<{ sources: number; chunks: number }> {
  if (sources.length === 0) return { sources: 0, chunks: 0 };
  await upsertSources(sources.map((s) => ({ ...s, indexed: false })));
  const chunks = sources.flatMap((s) => sourceToChunks(s, opts));
  await upsertChunks(chunks);
  // Mark the sources indexed (re-upsert the flag).
  await upsertSources(sources.map((s) => ({ ...s, indexed: true })));
  return { sources: sources.length, chunks: chunks.length };
}

// Purge a parent document's chunks from the index by parent_id (used on a
// PubMed delete / before a re-chunk that may produce fewer chunks).
export async function purgeChunks(parentId: string): Promise<void> {
  await qdrant().delete(KNOWLEDGE_COLLECTION, {
    wait: true,
    filter: { must: [{ key: "parent_id", match: { value: parentId } }] },
  });
}

// Re-derive and rewrite the index from the raw source collection — no re-fetch.
// This is what makes an embedder/chunk-size change a local operation. Returns
// the number of sources re-indexed.
export async function reindexFromSources(opts?: { maxChars?: number }): Promise<number> {
  const { SOURCE_COLLECTION } = await import("../types.ts");
  let offset: string | number | undefined | null = undefined;
  let total = 0;
  for (;;) {
    const page = await qdrant().scroll(SOURCE_COLLECTION, {
      limit: 128,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });
    const rows = page.points ?? [];
    const sources = rows
      .map((r) => r.payload as unknown as KnowledgeSource)
      .filter((s) => s && !s.deleted);
    if (sources.length) {
      const chunks = sources.flatMap((s) => sourceToChunks(s, opts));
      await upsertChunks(chunks);
      total += sources.length;
    }
    offset = page.next_page_offset as string | number | null | undefined;
    if (!offset) break;
  }
  return total;
}
