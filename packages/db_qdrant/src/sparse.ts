// Lexical (sparse) encoder for hybrid retrieval.
//
// Qwen3-Embedding is dense-only, so the lexical half of hybrid search needs a
// separate signal. Rather than pull in a heavy model (SPLADE/FastEmbed), we emit
// BM25-style sparse vectors and let Qdrant apply the IDF weighting server-side:
// the collection's `lexical` sparse vector is created with `modifier: "idf"`, so
// here we only need to supply per-term *frequencies* (the TF part) keyed by a
// stable token id. Qdrant computes IDF across the collection at query time.
//
// This mirrors the dependency-free local dense embedder in embed.ts in spirit:
// deterministic, no network, works out of the box on a fresh checkout, and good
// enough to recover exact tokens (dosages, compound names, "1RM", PMIDs) that a
// dense vector blurs.

import { SparseVector } from "./types.ts";

// Tokenize to lowercase alphanumeric terms. Numbers are kept (they matter here:
// "1.6", "g/kg" → "1", "6", "g", "kg"); short single-char tokens are dropped as
// noise except digits.
function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return raw.filter((t) => t.length > 1 || /[0-9]/.test(t));
}

// Very small English stopword set — words that carry no lexical signal and only
// add noise to the sparse match. Kept tiny on purpose.
const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "be",
  "by",
  "with",
  "as",
  "at",
  "that",
  "this",
  "it",
  "from",
  "was",
  "were",
]);

// Map a token to a stable non-negative 32-bit id via FNV-1a. The id space is
// large (2^31) so collisions are rare; Qdrant treats sparse dims as opaque ids.
function tokenId(token: string): number {
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 0x7fffffff;
}

// Encode text → a sparse vector of (tokenId → term frequency). Returns an empty
// vector for text with no usable tokens. Pair with a collection whose `lexical`
// sparse vector uses `modifier: "idf"` so Qdrant applies BM25 IDF weighting.
export function sparseEncode(text: string): SparseVector {
  const tf = new Map<number, number>();
  for (const tok of tokenize(text)) {
    if (STOP.has(tok)) continue;
    const id = tokenId(tok);
    tf.set(id, (tf.get(id) ?? 0) + 1);
  }
  const indices: number[] = [];
  const values: number[] = [];
  for (const [id, count] of tf) {
    indices.push(id);
    values.push(count);
  }
  return { indices, values };
}
