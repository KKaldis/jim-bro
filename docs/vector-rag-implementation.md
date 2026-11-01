# Vector RAG Implementation Guide

How to grow `@fa/db_qdrant` from the current smoke-test into a production,
evidence-based retrieval system over the scientific literature (PubMed,
guidelines, reference texts). Self-hosted end to end: **Qdrant** for the index,
the **Qwen3 open-source embedder + reranker**, **recursive character splitting**
for chunking, and a handful of accuracy techniques layered on top.

The pipeline, end to end:

```text
Qwen3-Embedding ─► Vector search (Qdrant, hybrid) ─► Qwen3-Reranker ─► LLM (Claude / @fa/agent)
```

> Scope: this is a design/implementation spec, not a finished feature. Each
> section maps onto concrete files in [packages/db_qdrant/](../packages/db_qdrant/)
> and the compose stack in [docker-compose.yml](../docker-compose.yml). Build it
> in the phases at the end — don't try to land it all at once.

---

## 1. Where we are today

The current vector path ([packages/db_qdrant/src/](../packages/db_qdrant/src/)) is
deliberately minimal — enough for a basic retrieval smoke-test:

- **One collection** `qdrant` ([types.ts](../packages/db_qdrant/src/types.ts)),
  single dense vector, cosine.
- **Embedder** ([embed.ts](../packages/db_qdrant/src/embed.ts)): OpenAI
  `text-embedding-3-small` when `OPENAI_API_KEY` is set, else a 384-dim local
  hashing fallback. No real open-source model.
- **No chunking** — whole snippets are embedded as-is
  ([client.ts:61](../packages/db_qdrant/src/client.ts#L61)).
- **No reranking** — top-k cosine is returned raw
  ([client.ts:76](../packages/db_qdrant/src/client.ts#L76)).
- **Tiny hand-written corpus** ([seed.ts](../packages/db_qdrant/src/seed.ts)).

What's good and worth keeping: the lazy-singleton client, env-driven config,
stable `pointIdFor()` ids so re-ingest upserts in place, and the `embedDim()`
indirection so the collection is always created at the embedder's true size.

What we're adding: a real ingestion pipeline, hybrid (dense + sparse) retrieval,
a cross-encoder reranker, contextual chunking, metadata filtering biased toward
high-quality evidence, and an evaluation harness so "accuracy" is measured, not
guessed.

---

## 2. Target architecture

```text
                          INGEST (offline, batched)
  PubMed E-utilities ─┐
  Guidelines / PDFs  ─┼─► clean/normalize ─► Qdrant knowledge_source ─► recursive split ─► contextualize ─┐
  App content        ─┘                      (raw source of truth)     (chunk + overlap)   (Claude Haiku) │
                                                      │ reindex anytime ◄──────────────────────────────────┤
                                                      ▼                                                     ▼
                                                                             ┌───────────────────────────────┐
                                                                             │  embed dense: Qwen3-Embedding  │
                                                                             │  embed sparse: BM25 (Qdrant)   │
                                                                             └───────────────┬───────────────┘
                                                                                             ▼
                                                          Qdrant `knowledge` collection (derived index)
                                                          (named vectors + payload + indexes)

                          RETRIEVE (request time)
  user query ─► embed dense (Qwen3, w/ instruction) + sparse (BM25) ─► Qdrant Query API
                                                  prefetch dense  ┐
                                                  prefetch sparse ┼─► RRF fusion ─► top-50
                                                  + payload filter ┘                  │
                                                                                      ▼
                                                          rerank (Qwen3-Reranker, cross-encoder)
                                                                                      │  top-8
                                                                                      ▼
                                                          assemble context ─► @fa/agent (Claude) answers
```

Two new compose services serving the **Qwen3-Embedding** and **Qwen3-Reranker**
models (see §10 for the server — vLLM/Infinity/TEI, OpenAI-compatible routes).
The lexical/sparse signal is BM25, computed by Qdrant itself — no third model.
Everything stays on the box; nothing about a user's data leaves at request time.

---

## 3. Component choices

Recommendations first, rationale and alternatives after. All open-source,
self-hostable, and good-or-better than `text-embedding-3-small` on retrieval
benchmarks.

### 3.1 Embedding model — **Qwen3-Embedding** (chosen)

The Qwen3-Embedding series (released 2025) topped the MTEB multilingual
leaderboard at release and is the dense embedder for this build. Pick the size by
the hardware you can give it:

| Model                           | Dense dim (native) | Footprint    | Use when                 |
| ------------------------------- | ------------------ | ------------ | ------------------------ |
| **`Qwen/Qwen3-Embedding-0.6B`** | 1024               | CPU-friendly | **default** — start here |
| `Qwen/Qwen3-Embedding-4B`       | 2560               | needs a GPU  | quality upgrade          |
| `Qwen/Qwen3-Embedding-8B`       | 4096               | bigger GPU   | top of the leaderboard   |

Properties that shape the design:

- **Instruction-aware.** Queries are embedded with a short task instruction
  prefix (e.g. _"Given a fitness/nutrition question, retrieve passages that
  answer it"_); **documents are embedded plain**. This asymmetry adds a few
  points of retrieval accuracy — wire it into `embedQuery` vs `embedBatch` (§6).
- **Matryoshka (MRL).** The dense dim is truncatable (e.g. 0.6B → any size up to
  1024). Plan the collection at the model's chosen output dim and keep
  `embedDim()` ([embed.ts:47](../packages/db_qdrant/src/embed.ts#L47)) as the
  single source of truth.
- **Long context** (32k tokens) and **100+ languages** — abstracts and full
  sections embed without aggressive truncation; non-English sources just work.

> Start with **0.6B at 1024 dims**. Promote to 4B/8B only if the eval harness
> (§8) shows the larger model clears a real recall gap on _our_ questions.
> `ncbi/MedCPT` (PubMed-trained, asymmetric query/article encoders) stays a
> domain-specialized A/B contender for later.

### 3.2 Sparse / lexical signal — **BM25 (Qdrant-native)**

Qwen3-Embedding is **dense-only** — unlike BGE-M3 it does not emit a sparse
vector — so hybrid retrieval needs a separate lexical component. Use **Qdrant's
built-in BM25 sparse vectors** (via FastEmbed / the `Qdrant/bm25` model); SPLADE
is a heavier alternative. This recovers exact tokens a semantic vector blurs —
dosages ("1.6 g/kg"), compounds ("creatine monohydrate"), tests ("1RM",
"VO2max"), PMIDs — and needs no extra GPU service.

### 3.3 Reranker — **Qwen3-Reranker** (chosen)

A cross-encoder that scores `(query, passage)` _jointly_ — far more accurate than
bi-encoder cosine, but too slow over the whole corpus. Standard pattern: retrieve
top ~50 cheaply, rerank to top ~8. Match the reranker size to the embedder:

| Model                            | Use when                                     |
| -------------------------------- | -------------------------------------------- |
| **`Qwen/Qwen3-Reranker-0.6B`**   | **default**, pairs with Embedding-0.6B       |
| `Qwen/Qwen3-Reranker-4B` / `-8B` | when running the larger embedders / have GPU |

- **Same family as the embedder** → consistent tokenization and domain behavior.
- **Instruction-aware** too: it takes `(instruction, query, document)`. Pass the
  same task framing as the query instruction for best results.
- Served by a **second instance** of the model server (§10).

Reranking is the single highest-ROI accuracy lever after hybrid — see §7.

### 3.4 Chunking — recursive character splitting

Implement a `RecursiveCharacterTextSplitter` (LangChain-style) directly in TS —
it's small and avoids a heavy dep, matching the package's "small self-contained
helpers" style. Split on a _hierarchy_ of separators, falling back to finer ones
only when a piece is still too big:

```text
["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""]
```

so it prefers paragraph → sentence → word boundaries and only ever hard-cuts mid-
word as a last resort. Target **~512 tokens / chunk with ~15% overlap** (start
there; tune against the eval set). Overlap keeps a fact that straddles a boundary
retrievable from both chunks.

Reference implementation (new file `packages/db_qdrant/src/chunk.ts`):

```ts
// Recursive character splitter. Greedily packs text up to ~maxChars, splitting on
// the coarsest separator that fits, recursing into finer ones, with overlap.
const SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""];

export type Chunk = { text: string; index: number };

export function splitText(
  text: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): Chunk[] {
  // ~4 chars/token heuristic → 512 tokens ≈ 2048 chars. Measure, then tune.
  const maxChars = opts.maxChars ?? 2048;
  const overlap = opts.overlapChars ?? Math.floor(maxChars * 0.15);
  const pieces = split(text.trim(), 0, maxChars);
  return mergeWithOverlap(pieces, maxChars, overlap).map((t, index) => ({ text: t, index }));
}

function split(text: string, sepIdx: number, maxChars: number): string[] {
  if (text.length <= maxChars || sepIdx >= SEPARATORS.length) return [text];
  const sep = SEPARATORS[sepIdx];
  const parts = sep === "" ? hardCut(text, maxChars) : text.split(sep);
  const out: string[] = [];
  for (const part of parts) {
    const piece = sep === "" ? part : part + sep;
    if (piece.length > maxChars) out.push(...split(piece, sepIdx + 1, maxChars));
    else out.push(piece);
  }
  return out;
}

function hardCut(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

// Greedily pack small pieces back up to maxChars, carrying `overlap` trailing
// chars into the next chunk so boundary-straddling facts stay retrievable.
function mergeWithOverlap(pieces: string[], maxChars: number, overlap: number): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const p of pieces) {
    if (buf.length + p.length > maxChars && buf) {
      chunks.push(buf.trim());
      buf = overlap > 0 ? buf.slice(-overlap) : "";
    }
    buf += p;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
```

**Don't split blindly across structure.** For PubMed, a single abstract is often
best kept whole (it's already ~250 words). For full texts / guidelines / book
chapters, split _within_ sections and prefix each chunk with a breadcrumb
(`Title › Section ›`) before embedding so an isolated chunk keeps its context.

---

## 4. Qdrant collection schema

Replace the single unnamed vector with **named vectors** (dense + sparse) and a
real payload + indexes. New collection name `knowledge` (keep `qdrant` for the
legacy smoke test until cutover; see §9).

```ts
await client.createCollection("knowledge", {
  vectors: {
    dense: { size: 1024, distance: "Cosine" }, // Qwen3-Embedding-0.6B (= embedDim())
  },
  sparse_vectors: {
    lexical: { modifier: "idf" }, // BM25 (idf modifier for proper BM25 scoring)
  },
});

// Payload indexes make filtered hybrid search fast and let us bias toward
// high-quality evidence (see §7.5). Create once after the collection.
for (const [field, schema] of [
  ["evidence_level", "keyword"], // "meta-analysis" | "systematic-review" | "rct" | ...
  ["year", "integer"],
  ["source", "keyword"], // "pubmed" | "nsca" | "guideline" | ...
  ["pmid", "keyword"],
  ["tags", "keyword"],
] as const) {
  await client.createPayloadIndex("knowledge", { field_name: field, field_schema: schema });
}
```

Per-chunk payload (extends the current `KnowledgeDoc` in
[types.ts](../packages/db_qdrant/src/types.ts)):

```ts
export type KnowledgeChunk = {
  id: string; // stable: `pmid:12345678#3` → pointIdFor() → UUID
  parent_id: string; // the source doc, for parent-document retrieval (§7.3)
  title: string;
  text: string; // the chunk (with breadcrumb prefix)
  context?: string; // LLM-generated situating sentence (§7.4)
  source: string | null; // "pubmed" | "nsca-essentials" | ...
  url: string | null; // PubMed/DOI link for citations
  pmid?: string;
  doi?: string;
  journal?: string;
  year?: number;
  evidence_level?: EvidenceLevel; // drives quality bias
  mesh?: string[]; // MeSH terms from PubMed
  tags: string[];
  chunk_index: number; // ordinal within parent, for stitching neighbors
};

export type EvidenceLevel =
  | "meta-analysis"
  | "systematic-review"
  | "rct"
  | "cohort"
  | "narrative-review"
  | "guideline"
  | "textbook"
  | "other";
```

> Keep `pointIdFor()` from [client.ts:34](../packages/db_qdrant/src/client.ts#L34)
> — derive the chunk id from `pmid:...#chunkIndex` so re-ingest upserts in place.

### 4.1 Raw documents — a second Qdrant collection (source of truth)

**Everything lives in Qdrant — no Postgres for this feature.** The `knowledge`
collection holds **derived** data (chunks + vectors). Keep the **raw fetched
record** — cleaned abstract + full metadata — in a _separate_ Qdrant collection,
`knowledge_source`, one point per source document. This is the "store the raw for
sources" layer.

Why a separate collection, not just fatter chunk payloads:

- **Re-chunk / re-embed without re-fetching.** Upgrading the embedder
  (Qwen3-0.6B → 4B, → MedCPT) or changing chunk size = `scroll` the raw
  collection → re-split → re-embed → rewrite `knowledge`. **No re-hitting
  PubMed** for thousands of records. The raw collection is rebuilt only by ingest.
- **Clean citations.** The agent cites from one complete record (full abstract,
  authors, journal, DOI, MeSH), not whatever chunk matched.
- **No duplication.** The full abstract is stored once per document, not copied
  into every chunk's payload.

It's a normal collection, so it needs a vector. **Embed the title + abstract as
that vector** — it does double duty: source-of-truth payload _and_ a coarse
doc-level retrieval / dedup signal. Point id = `pointIdFor(sourceId)`.

```ts
await client.createCollection("knowledge_source", {
  vectors: { dense: { size: 1024, distance: "Cosine" } }, // embed(title + abstract)
});
for (const [field, schema] of [
  ["pmid", "keyword"],
  ["source", "keyword"],
  ["evidence_level", "keyword"],
  ["year", "integer"],
  ["indexed", "bool"], // chunked+embedded into `knowledge` yet?
  ["deleted", "bool"], // PubMed delete → flag + purge chunks
] as const) {
  await client.createPayloadIndex("knowledge_source", { field_name: field, field_schema: schema });
}
```

Payload = the full raw record (a superset of the chunk payload in §4):

```ts
export type KnowledgeSource = {
  id: string; // "pmid:12345678" | "nsca:ch7" | ...
  source: string; // "pubmed" | "guideline" | "textbook"
  pmid?: string;
  doi?: string;
  url: string | null; // canonical link for citations
  title: string;
  abstract: string; // cleaned full text / abstract — the archived copy
  journal?: string;
  year?: number;
  authors: string[];
  mesh: string[];
  evidence_level?: EvidenceLevel;
  pub_types: string[];
  raw?: unknown; // original parsed record, for reprocessing
  // Ingest bookkeeping:
  content_hash: string; // detect changed records → re-embed
  indexed: boolean; // chunks written to `knowledge`?
  deleted: boolean; // soft-delete (PubMed retraction/delete)
};
```

Each `knowledge` chunk's `parent_id` (§4) is the `knowledge_source` point id, so
a hit resolves to its full record via `client.retrieve("knowledge_source", { ids:
[pointIdFor(parentId)], with_payload: true })` — that's how citations and
parent-document retrieval (§7.3) get the complete context, no second datastore.

---

## 5. Ingestion pipeline

New file `packages/db_qdrant/src/ingest/pubmed.ts`, run as a Bun script like the
existing [seed.ts](../packages/db_qdrant/src/seed.ts).

### 5.0 How much of PubMed to pull — **targeted, not the whole DB**

There are two ways to get PubMed data. **Default to the targeted API path; only
bulk-download if you specifically need the offline mirror.**

**A — Targeted via E-utilities (recommended for us).** Query for _only_ our
topics and evidence levels, fetch just those records (§5.1). The full corpus we
care about — exercise science, nutrition, hypertrophy, supplements, sleep,
recovery — is a tiny slice of PubMed: realistically **tens of thousands** of
citations, not 37 million. Fast, current, no multi-GB storage, trivially
re-runnable on a cron. **This is the right tool for "only the ones related to
us."**

**B — Bulk baseline (only if you need a full offline mirror).** NCBI publishes
the _entire_ database as gzipped XML — there is **no topical subset on the FTP
server, it's all-or-nothing**, so you'd download everything and filter locally.

|           | Baseline                                                         | Daily updates                                      |
| --------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| URL       | `https://ftp.ncbi.nlm.nih.gov/pubmed/baseline/`                  | `https://ftp.ncbi.nlm.nih.gov/pubmed/updatefiles/` |
| What      | Complete annual snapshot of all ~37M citations                   | New / revised / deleted citations since baseline   |
| Files     | `pubmed26n0001.xml.gz` … (1,200+ numbered files, ~16–37 MB each) | `pubmed26nXXXX.xml.gz`, continuing the numbering   |
| Size      | **~50 GB compressed, several hundred GB uncompressed**           | small, grows daily                                 |
| Each file | `.xml.gz` + a matching `.md5` for integrity                      | same                                               |

> The `26` in `pubmed26n…` is the **2026** annual release; it rolls over each
> year. Terms & conditions live in
> [`baseline/README.txt`](https://ftp.ncbi.nlm.nih.gov/pubmed/baseline/README.txt)
> — downloading is acceptance. Abstracts + metadata are freely redistributable;
> respect it for anything you re-publish.

If you go bulk: download with `wget -c -r -np -A "*.xml.gz,*.md5"`, **verify every
file against its `.md5`**, then stream-parse each `.gz` and **keep only records
that match our filter** (MeSH terms like `Resistance Training`, `Dietary
Proteins`, `Sports Nutritional Sciences`, `Exercise`, plus our publication-type
bias) before chunk→embed→upsert. Load `baseline/` first, then `updatefiles/` in
numerical order. Re-sync = pull new update files + apply deletes by PMID.

**Recommendation for this project: start with path A.** It gives us exactly the
relevant corpus for a fraction of the cost; revisit path B only if we later want
an exhaustive offline index or to do our own corpus-wide analytics.

### 5.1 Fetch from PubMed (E-utilities)

PubMed's [E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) are a free
REST API. Two calls:

1. **`esearch`** — query + filters → list of PMIDs.
   **Bias toward strong evidence at fetch time** with the publication-type
   filter, e.g. append `AND (systematic[sb] OR meta-analysis[pt] OR
randomized controlled trial[pt])` and a recency window.
2. **`efetch`** (`retmode=xml`) — PMIDs → titles, abstracts, journals, years,
   publication types, MeSH terms, DOIs.

Be a good citizen: set `tool` + `email` params, get an **NCBI API key**
(`api_key` param → 10 req/s vs 3), and back off on 429.

```ts
const E = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
async function esearch(term: string, retmax = 200): Promise<string[]> {
  const u = new URL(`${E}/esearch.fcgi`);
  u.search = new URLSearchParams({
    db: "pubmed",
    term,
    retmax: String(retmax),
    retmode: "json",
    sort: "relevance",
    api_key: process.env.NCBI_API_KEY ?? "",
    tool: "jim-bro",
    email: process.env.NCBI_EMAIL ?? "",
  }).toString();
  const r = await fetch(u);
  return (await r.json()).esearchresult.idlist as string[];
}
```

Map publication types → `evidence_level` (`Meta-Analysis` → `meta-analysis`,
`Systematic Review` → `systematic-review`, `Randomized Controlled Trial` →
`rct`, …).

### 5.2 Clean → persist raw → split → contextualize → embed → upsert

```text
efetch XML ─► strip markup, normalize whitespace
           ─► UPSERT knowledge_source (Qdrant)      ← raw source of truth (§4.1)
           ─► skip if content_hash unchanged AND indexed=true
           ─► splitText() per doc (abstracts usually 1 chunk; full text → many)
           ─► prepend breadcrumb (Title › Section ›)
           ─► [optional] contextualize each chunk via Claude Haiku (§7.4)
           ─► embed: dense via Qwen3-Embedding (plain docs), sparse via BM25
           ─► upsertKnowledge(chunks)               // `knowledge`: named vectors + payload
           ─► set knowledge_source.indexed = true
```

Upsert the raw record into `knowledge_source` **before** chunking, so the source
of truth exists even if embedding fails midway — a retry resumes from
`indexed=false`. The `content_hash` gate makes re-runs cheap: unchanged records
skip the embed step. Batch the embedding calls (the server handles batches
efficiently) and `upsert({ wait:true })` in pages of a few hundred, like the
current [upsertKnowledge](../packages/db_qdrant/src/client.ts#L58). On a PubMed
delete, set `deleted=true` on the source point and purge its chunks from
`knowledge` by `parent_id`.

> **Rebuild `knowledge` from `knowledge_source` anytime** with a `reindex` script
> that `scroll`s the raw collection → split → embed → upsert. This is what makes
> embedder upgrades (Qwen3-0.6B → 4B, → MedCPT) a local operation. Path A or B,
> the raw collection is the same — only the _fetch_ differs. Both collections
> live in the one Qdrant service; nothing else is needed.

### 5.3 Other sources & file storage (MinIO)

Abstracts are text-only, but guidelines, position stands, and book chapters are
**files** (PDFs). The text gets chunked + embedded like anything else; the
**original binary** is kept in object storage so a citation can open the actual
document. We run **MinIO** (S3-compatible) for this — see
[@fa/storage](../packages/storage/) and the `minio` compose service.

Flow ([ingestFile](../packages/db_qdrant/src/ingest/files.ts)):

```text
local file ─► upload to MinIO (key: docs/<sha>/<name>) ─► extract text
          ─► KnowledgeSource{ object_key, url, abstract:text } ─► ingestSources()
```

- **`object_key`** on `KnowledgeSource` (§4.1) records the stored binary; the
  content-addressed `docs/<sha>/<name>` key makes re-upload idempotent.
- **Serving.** The browser can't reach the internal `minio:9000` host, so files
  are served through the app at **`GET /files/<object_key>`**
  ([apps/server](../apps/server/src/index.ts)), which streams from MinIO. The
  citation `url` is `publicUrl(key)` → that route (or a CDN base if
  `S3_PUBLIC_BASE_URL` is set).
- **Text extraction**: `.txt`/`.md`/`.html` inline; `.pdf` via the optional
  `pdf-parse` dep (or pass pre-extracted `text`).
- **The app's own content** — reuse for grounded, on-brand answers.

Always store a real `url` for citations — answers should link the source
(PubMed for abstracts, the `/files` route for uploaded documents).

### 5.4 Incremental embedding — content-addressed cache (avoid re-embedding)

An embedding is a **pure function** of `(embedder model+revision, instruction,
exact input text)`. So make _that_ the cache key and never compute the same
vector twice. Two layers, coarse → fine:

**Layer 1 — document hash (coarse, already in §5.2).** `content_hash` on the
`knowledge_source` point. If a re-fetched record hashes identically and
`indexed=true`, skip the whole doc — no split, no embed. This is the cheap 90%
case for daily PubMed syncs: most re-fetched records are unchanged.

**Layer 2 — chunk-level content-addressed cache (fine).** For docs that _did_
change (or a `reindex`), only embed the chunks whose text actually changed, and
reuse vectors for everything else — including identical boilerplate shared across
different documents. The cache key is the hash, so it's a vector memoizer:

```text
embed_key = sha256( EMBED_MODEL + "@" + EMBED_REVISION + "|" + instruction + "|" + chunkText )
```

Keep the cache **in Qdrant** (no extra datastore) — a dedicated collection:

```ts
// Content-addressed vector cache. id = pointIdFor(embed_key); vector = the
// embedding; payload just records provenance. Survives `knowledge` rebuilds.
await client.createCollection("embedding_cache", {
  vectors: { dense: { size: 1024, distance: "Cosine" } },
});
```

Embed path becomes **lookup-then-compute-misses**:

```ts
async function embedCached(texts: string[]): Promise<number[][]> {
  const keys = texts.map(embedKey); // sha256(model@rev|instr|text)
  const ids = keys.map(pointIdFor);
  const hits = await qdrant().retrieve("embedding_cache", { ids, with_vector: true });
  const byId = new Map(hits.map((h) => [h.id, h.vector as number[]]));

  const misses = texts.filter((_, i) => !byId.has(ids[i]));
  const fresh = misses.length ? await embedBatch(misses) : []; // only misses hit the model
  // write new vectors back to the cache for next time
  if (misses.length) {
    let k = 0;
    await qdrant().upsert("embedding_cache", {
      wait: true,
      points: texts.flatMap((_, i) =>
        byId.has(ids[i]) ? [] : [{ id: ids[i], vector: fresh[k++], payload: { key: keys[i] } }],
      ),
    });
  }
  // reassemble in original order
  let k = 0;
  return texts.map((_, i) => byId.get(ids[i]) ?? fresh[k++]);
}
```

What this buys, and its one hard limit:

- **Daily updates ≈ free.** Unchanged docs short-circuit at Layer 1; edited docs
  re-embed only their changed chunks at Layer 2.
- **Cross-document dedup.** The same sentence in two papers embeds once.
- **`reindex` on the same model = zero embed calls** — every chunk is a cache hit,
  so a collection rebuild just rewrites points.
- **Limit: an embedder _upgrade_ invalidates the cache by design.** `EMBED_MODEL`/
  `EMBED_REVISION` are in the key, so Qwen3-0.6B → 4B changes every key → full
  re-embed. That's unavoidable — the vectors genuinely differ. Mitigate with a
  **blue/green rebuild**: keep serving the old `knowledge` collection while a new
  one (new model, new cache namespace) is built in the background, then cut over.
  Old cache entries can be GC'd by `EMBED_REVISION` once nothing references them.

> The instruction string is in the key for queries too, but query vectors aren't
> usually worth caching (unbounded, low repeat rate). Cache the **corpus** side;
> embed queries fresh.

---

## 6. Retrieval pipeline

Rewrite `searchKnowledge` ([client.ts:76](../packages/db_qdrant/src/client.ts#L76))
to hybrid + rerank using Qdrant's **Query API** (`prefetch` + fusion).

```ts
export async function searchKnowledge(
  query: string,
  opts: { top?: number; filter?: QdrantFilter } = {},
): Promise<KnowledgeHit[]> {
  const q = query.trim();
  if (!q) return [];
  const top = opts.top ?? 8;

  // 1. Embed the query: dense via Qwen3 *with the task instruction prefix*
  //    (docs are embedded plain — see §3.1), sparse via BM25.
  const dense = await embedQuery(q); // instruction-prefixed Qwen3 dense vector
  const sparse = await bm25(q); // { indices, values }

  // 2. Hybrid candidate generation: run dense and sparse prefetches, fuse with
  //    Reciprocal Rank Fusion. Pull a wide net (≈50) for the reranker to sort.
  const fused = await qdrant().query("knowledge", {
    prefetch: [
      { query: dense, using: "dense", limit: 50, filter: opts.filter },
      {
        query: { indices: sparse.indices, values: sparse.values },
        using: "lexical",
        limit: 50,
        filter: opts.filter,
      },
    ],
    query: { fusion: "rrf" },
    limit: 50,
    with_payload: true,
  });

  // 3. Rerank the 50 candidates with Qwen3-Reranker → keep top N.
  const candidates = fused.points.map((p) => p.payload as KnowledgeChunk);
  const ranked = await rerank(q, candidates, top); // Qwen3-Reranker cross-encoder
  return ranked;
}
```

`rerank()` posts `{ query, documents: [...] }` (plus the task instruction) to the
Qwen3-Reranker instance and returns candidates sorted by the cross-encoder score,
truncated to `top`. Surface that score as the hit `score` so the agent (and eval)
can threshold on it.

**Assembling context for the agent**: dedupe by `parent_id`, optionally stitch
adjacent `chunk_index` neighbors (§7.3), cap total tokens, and pass each snippet
with its citation (`title`, `journal`, `year`, `url`). The generation step stays
in [@fa/agent](../packages/agent/) (Claude) — the prompt should instruct the
model to answer _only_ from retrieved context and cite PMIDs, and to say when the
evidence is thin or conflicting.

---

## 7. Improving retrieval accuracy

Ordered by ROI. The first three are the backbone; the rest are incremental once
you can _measure_ (§8). Rough impact figures are directional, from public
benchmarks — verify on our own eval set.

### 7.1 Hybrid (dense + sparse) — **biggest single win**

Pure semantic vectors miss exact tokens that matter in this domain: dosages
("1.6 g/kg"), compounds ("creatine monohydrate"), tests ("1RM", "VO2max"),
PMIDs. Sparse/lexical recovers them; dense recovers paraphrase and concept
overlap. RRF fusion (§6) needs no score calibration between the two. With Qwen3
(dense-only) the sparse side is **Qdrant BM25** (§3.2). _Already in the §6
design._

### 7.2 Cross-encoder reranking — **second biggest win**

Bi-encoder cosine is a cheap approximation; a cross-encoder reads query and
passage _together_. Retrieve wide (50), rerank to ~8. Anthropic's published
numbers put reranking on top of hybrid at a **~67% reduction in failed
retrievals** vs a naive dense baseline. _Already in the §6 design._

### 7.3 Parent-document / "small-to-big" retrieval

Embed **small** chunks (precise matching) but feed the model the **larger**
surrounding context (parent section or ±1 neighbor chunk). Store `parent_id` +
`chunk_index` (§4); after rerank, expand each winning chunk to its neighbors —
or fetch the full record from `knowledge_source` (§4.1) by `parent_id` — before
assembling context. Fixes the classic "the answer was in the sentence right after
the matched chunk" failure.

### 7.4 Contextual retrieval (Anthropic) — **high ROI, we already have Claude**

Before embedding a chunk, prepend a 1–2 sentence, LLM-written description that
situates it in its parent document ("This is from a 2021 meta-analysis on
protein timing; the passage reports the per-meal dose ceiling…"). Embed and index
_context + chunk_. Anthropic reports **~35% fewer failed retrievals** (≈49% when
combined with sparse, ≈67% with reranking too).

- Generate with a **cheap, fast model** — `claude-haiku-4-5` — and use **prompt
  caching** on the full parent document so each chunk's call only pays for the
  small unique completion. This is an _offline, one-time_ ingest cost.
- Store the generated `context` in the payload (§4) for transparency/debugging.

### 7.5 Evidence-quality bias (domain-specific, high value here)

The user's own ranking — _meta-analyses & systematic reviews > single studies_ —
should be encoded, not left to chance:

- **Filter** to strong evidence at query time when appropriate
  (`evidence_level in {meta-analysis, systematic-review}`), via the payload
  index (§4).
- **Or boost**: rerank normally, then apply a small score multiplier by
  `evidence_level` and recency, so a 2023 meta-analysis outranks a 2009 n=12
  trial at similar relevance.
- Surface `evidence_level` + `year` in the answer so the user sees _why_ a claim
  is trusted.

### 7.6 Query transformation

- **Multi-query**: have Claude rewrite the user's question into 2–3 paraphrases,
  retrieve for each, union + rerank. Catches vocabulary mismatch.
- **HyDE** (Hypothetical Document Embeddings): generate a hypothetical ideal
  answer, embed _that_, retrieve against it. Strong when queries are short/vague.
- Cheap to add once the pipeline exists; gate behind a flag and measure — they
  add latency and can drift off-topic.

### 7.7 Diversity (MMR) + dedup

Maximal Marginal Relevance during candidate selection avoids returning eight
near-identical chunks from the same paper; dedupe by `parent_id` so the context
window spans _multiple_ sources. More distinct evidence → better-grounded answers.

### 7.8 Right-sizing chunks

The §3.4 defaults (~512 tokens, 15% overlap) are a starting point. Too large →
diluted embeddings and wasted context; too small → lost meaning. Sweep a few
sizes against the eval set and pick by recall@k, don't guess.

### 7.9 Quantization (scale, not accuracy — for later)

At large corpus sizes, Qdrant **scalar/binary quantization** with on-disk vectors
and a rescore pass cuts memory ~4–32× for a small recall hit. Irrelevant at
thousands of docs; turn on when it's millions.

---

## 8. Evaluation harness — build this _early_

You cannot tune what you don't measure, and every choice above (M3 vs MedCPT,
chunk size, rerank on/off, contextualization) is an A/B. Build a small harness
before over-investing in §7.

1. **Golden set**: 30–100 real fitness/nutrition questions, each with the
   PMIDs/passages that _should_ be retrieved. Seed it from real
   [search_knowledge](../packages/agent/src/tools.ts) queries and grow it.
2. **Metrics**: `recall@k`, `MRR`, `nDCG@10` for retrieval; for end-to-end,
   an **LLM-as-judge** (Claude) scoring answer faithfulness + citation accuracy.
3. **Run as a script** (`packages/db_qdrant/src/eval/run.ts`) that prints a table
   per config so changes are comparison, not vibes.
4. Gate retrieval-pipeline changes on "recall@10 didn't regress."

---

## 9. Phased rollout

Land it incrementally; each phase is independently useful and shippable.

| Phase    | Deliverable                                                                                                                                          | Touches                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**    | Eval harness + golden set against the _current_ pipeline (baseline numbers)                                                                          | new `src/eval/`                                                                                                                                                                     |
| **1**    | Qwen3-Embedding service + swap `embed.ts` to Qwen3 dense (keep cosine, single vector). New `knowledge` collection at 1024d.                          | [docker-compose.yml](../docker-compose.yml), [embed.ts](../packages/db_qdrant/src/embed.ts), [client.ts](../packages/db_qdrant/src/client.ts)                                       |
| **2**    | `knowledge_source` + `embedding_cache` collections, recursive chunking, content-addressed `embedCached()` (§5.4), PubMed ingest + `reindex` scripts. | [client.ts](../packages/db_qdrant/src/client.ts), [types.ts](../packages/db_qdrant/src/types.ts), [embed.ts](../packages/db_qdrant/src/embed.ts), new `src/chunk.ts`, `src/ingest/` |
| **3**    | Hybrid: add BM25 sparse named vector + Query API fusion.                                                                                             | [client.ts](../packages/db_qdrant/src/client.ts), [types.ts](../packages/db_qdrant/src/types.ts)                                                                                    |
| **4**    | Qwen3-Reranker service + rerank step.                                                                                                                | docker-compose, `client.ts`                                                                                                                                                         |
| **5**    | Contextual chunking (Claude Haiku) + parent-document expansion.                                                                                      | `src/ingest/`, `client.ts`                                                                                                                                                          |
| **6**    | Evidence-quality bias, query transforms, MMR — each gated and eval-measured.                                                                         | `client.ts`                                                                                                                                                                         |
| **7** ✅ | Done: `search_knowledge` agent tool — hybrid + rerank, cited, enriched from `knowledge_source`.                                                      | [packages/agent/src/tools.ts](../packages/agent/src/tools.ts)                                                                                                                       |

Keep [embed.ts](../packages/db_qdrant/src/embed.ts)'s `embedderKind()` indirection
so `local` stays the zero-dependency fallback for CI/fresh checkouts, `openai`
stays available, and `qwen3` becomes the new default. **Never switch embedder mode
against an existing collection** — dimensions won't match; re-ingest into a fresh
one (the existing warning in `embed.ts` still applies).

---

## 10. New compose services & env

Two model-server instances alongside the existing `qdrant`
([docker-compose.yml:67](../docker-compose.yml#L67)) — one for Qwen3-Embedding,
one for Qwen3-Reranker.

**Serving Qwen3.** Use a server with first-class Qwen3-Embedding/Reranker
support and an **OpenAI-compatible `/v1/embeddings`** route, so `embed.ts` reaches
it through the existing OpenAI client by just setting `OPENAI_BASE_URL`:

- **[vLLM](https://docs.vllm.ai)** (recommended, GPU) — explicit Qwen3-Embedding
  _and_ Qwen3-Reranker (`--task score`) support, OpenAI-compatible server.
- **[Infinity](https://github.com/michaelfeil/infinity)** — CPU/GPU, serves
  embeddings + reranking, OpenAI-compatible. Good when there's no GPU.
- **[TEI](https://github.com/huggingface/text-embeddings-inference)** — check the
  running version supports the chosen Qwen3 checkpoint before committing.

The 0.6B models run on CPU (slowly); give them a GPU reservation for real
throughput — the **reranker is the latency hot path**, so it gets the GPU first.

```yaml
embedder:
  image: vllm/vllm-openai:latest
  command: ["--model", "Qwen/Qwen3-Embedding-0.6B", "--task", "embed"]
  ports: ["${EMBEDDER_PORT:-8080}:8000"]
  volumes: [hf_cache:/root/.cache/huggingface]
  restart: unless-stopped
  # deploy: { resources: { reservations: { devices: [{ capabilities: [gpu] }] } } }

reranker:
  image: vllm/vllm-openai:latest
  command: ["--model", "Qwen/Qwen3-Reranker-0.6B", "--task", "score"]
  ports: ["${RERANKER_PORT:-8081}:8000"]
  volumes: [hf_cache:/root/.cache/huggingface]
  restart: unless-stopped
```

Env (extend the `app` service block and `.env`):

```text
QDRANT_EMBEDDER=remote                 # remote (any OpenAI-compatible API) | local
EMBEDDER_URL=http://embedder:8000/v1   # OpenAI-compatible embeddings route
RERANKER_URL=http://reranker:8000      # reranker /score|/rerank route
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
EMBED_REVISION=v1                      # bump to bust the embedding_cache (§5.4); part of the cache key
RERANKER_MODEL=Qwen/Qwen3-Reranker-0.6B
EMBEDDING_DIM=1024
RAG_QUERY_INSTRUCTION=Given a fitness and nutrition question, retrieve scientific passages that answer it.
NCBI_API_KEY=                          # PubMed E-utilities (10 req/s)
NCBI_EMAIL=you@example.com
ANTHROPIC_API_KEY=...                  # already set — reused for contextualization
RAG_RERANK=true
RAG_CONTEXTUAL=true
RAG_TOP_K=8
RAG_CANDIDATES=50
```

`embed.ts` gains a `qwen3` branch: `embedBatch` (documents, plain) and
`embedQuery` (prepend `RAG_QUERY_INSTRUCTION`) both POST to `EMBEDDER_URL`. Since
the route is OpenAI-compatible, it can reuse the existing OpenAI client by setting
`OPENAI_BASE_URL=EMBEDDER_URL`. The `openai` and `local` branches stay untouched.

---

## 11. Open questions / decisions to make

- **Qwen3 size (0.6B → 4B → 8B) and MedCPT** — settle the embedder with
  Phase-0/8 eval, not benchmark blogs. Start at 0.6B; only pay for 4B/8B (GPU) or
  switch to MedCPT (PubMed-specialized) if recall on _our_ questions justifies it.
- **GPU?** CPU serving is fine for ingest (offline) and modest query volume. If
  request-time latency with reranking is too high on CPU, give the reranker a
  GPU first (it's the hot path), embedder second.
- **Corpus scope & licensing** — PubMed _abstracts_ + metadata are freely usable;
  full texts and books (NSCA) have licensing constraints. Index what we're
  licensed to store; for the rest, store metadata + link out.
- **Refresh cadence** — re-run PubMed ingest on a schedule (new meta-analyses
  land continuously). A weekly cron over saved search terms keeps it current;
  stable ids mean re-ingest just upserts.
- **Answer guardrails** — the generation prompt must refuse to fabricate
  citations and must flag when retrieved evidence is weak or conflicting. This is
  a prompt + eval concern in [@fa/agent](../packages/agent/), not a retrieval one.

```text

```
