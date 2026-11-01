# Search and knowledge data

Jim-Bro uses two optional data stores besides Postgres:

| Store           | What it powers                                                        | Without it                                                             |
| --------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Meilisearch** | Food lookups (`lookup_product`, barcode scans, pantry auto-fill)      | Set `FOODREF_LIVE=true` to query OpenFoodFacts + USDA live instead     |
| **Qdrant**      | Evidence answers with citations (the agent's `search_knowledge` tool) | The tool is hidden (`KNOWLEDGE_DISABLED=true`, or `FOODREF_LIVE=true`) |

Both start empty. This guide takes each one from an empty container to working search.

**Before you start:** `docker compose up -d` starts Postgres, Meilisearch, Qdrant and
MinIO. The one-shot jobs below (`foodref-import`, `qdrant-seed`) run from the app image,
so build it once with `docker compose build`. Every script can also run directly from the
repo root with `bun run …`; Bun loads `.env` from the root automatically.

---

## Food search (Meilisearch)

The importer streams the public food databases into a `foods` index, keeping only rows
with a usable name **and** complete per-100 g macros (kcal, protein, fat, carbs), and
dropping rows whose macros are physically impossible. Documents have stable ids
(`off:<barcode>`, `usda:<fdcId>`), so re-running an import updates in place.

### 1. Download the source data into `./data/`

```sh
mkdir -p data/usda

# OpenFoodFacts: the full JSONL dump (gzipped, tens of GB; streamed, never loaded
# into memory). https://world.openfoodfacts.org/data
curl -L -o data/openfoodfacts-products.jsonl.gz \
  https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz

# USDA FoodData Central: put any of the JSON downloads (Foundation, SR Legacy,
# Branded) in data/usda/. https://fdc.nal.usda.gov/download-datasets.html
```

Either source is optional: the importer skips a missing dump or an empty folder.

### 2. Import

```sh
docker compose run --rm foodref-import
```

Or directly (uses `MEILI_URL` / `MEILI_MASTER_KEY` from `.env`):

```sh
OFF_DUMP_PATH=./data/openfoodfacts-products.jsonl.gz USDA_DIR=./data/usda \
  bun run packages/db_meilisearch/src/import.ts
```

It logs scanned / kept / skipped counts per source. The full OpenFoodFacts dump takes a
while; USDA alone is quick and enough to try things out.

### 3. Check it

```sh
curl -H "Authorization: Bearer $MEILI_MASTER_KEY" http://localhost:7700/indexes/foods/stats
```

`docker compose up` also starts a browser UI for the index on <http://localhost:24900>.

### Maintenance

| Command                                                    | When                                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run packages/db_meilisearch/src/sync-settings.ts`     | After changing `FOODS_SETTINGS` (searchable / filterable / sortable fields, ranking). Re-indexes without a re-import.                                                       |
| `bun run packages/db_meilisearch/src/prune-implausible.ts` | Removes already-indexed rows with impossible macros (e.g. per-package values). Writes them to `LOG_PATH` (default `logs.txt`) first; `PRUNE_DRY_RUN=1` only writes the log. |

**Production:** set a strong `MEILI_MASTER_KEY` (Meilisearch requires 16+ bytes when
`MEILI_ENV=production`, the compose default).

---

## Evidence knowledge base (Qdrant)

The knowledge base is two Qdrant collections:

- `knowledge_source` — one point per document (abstract, guideline, PDF text): the raw
  source of truth.
- `knowledge` — the searchable index built from it: chunks with a dense vector (from the
  embedder) and a sparse keyword vector, for hybrid search.

Because the raw text is kept, changing the embedder or chunking never needs a re-download:
`reindex` rebuilds `knowledge` from `knowledge_source`.

### 1. Choose an embedder

Set in `.env`; `QDRANT_EMBEDDER` picks the mode.

| Option                | Settings                                                                                                                                                                | Notes                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local** (no setup)  | `QDRANT_EMBEDDER=local`                                                                                                                                                 | Built-in hashing embedder, 384 dims. Fine for trying it out; keyword-level quality.                                                                                                                  |
| **Hosted API**        | `QDRANT_EMBEDDER=remote`, `EMBEDDER_URL` + `EMBEDDER_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`                                                                       | Any OpenAI-compatible `/embeddings` API. `.env.example` is set up for Qwen3-Embedding-8B on SiliconFlow (4096 dims). With only `OPENAI_API_KEY` set it uses OpenAI (`text-embedding-3-small`, 1536). |
| **Self-hosted** (GPU) | `docker compose --profile rag up -d embedder reranker`, then `EMBEDDER_URL=http://localhost:8080/v1`, `EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B`, `EMBEDDING_DIM=1024` | vLLM images; they want a GPU. On CPU-only hosts use an Infinity or TEI image instead.                                                                                                                |

The default, `QDRANT_EMBEDDER=auto`, uses remote when `EMBEDDER_URL` or `OPENAI_API_KEY` is
set, else local. Note that `.env.example` pins `remote` with a SiliconFlow URL: leave the key
empty and embedding calls fail, so either add a key or switch to `local`.

**Reranker (optional):** `RERANKER_URL` (+ `RERANKER_API_KEY`, `RERANKER_MODEL`) points at a
Cohere/Jina-style `/rerank` endpoint and reorders the top results. With the self-hosted
profile that's `http://localhost:8081/v1` and `Qwen/Qwen3-Reranker-0.6B`. Unset, or
`RAG_RERANK=false`, skips it; a failing reranker also falls back to plain search.

### 2. Seed a starter corpus

```sh
docker compose run --rm qdrant-seed
# or: bun run packages/db_qdrant/src/seed.ts
```

Loads a small built-in set of fitness and nutrition facts so `search_knowledge` returns
something on a fresh install. It skips work if the collection is already seeded; `--force`
drops and recreates the `knowledge` collection first.

The compose job only passes the local / OpenAI embedder settings into the container. With
another provider (`EMBEDDER_URL`, `EMBEDDING_DIM`), run it with `bun` so it reads your `.env`.

### 3. Ingest real sources

**PubMed** (abstracts via NCBI E-utilities, filtered to meta-analyses, systematic reviews,
RCTs and reviews):

```sh
bun run packages/db_qdrant/src/ingest/pubmed.ts "creatine supplementation" --max 100
bun run packages/db_qdrant/src/ingest/pubmed.ts --defaults   # a starter set of 8 topics
```

`--max` is per query (default 100). Set `NCBI_EMAIL` (NCBI asks for it) and ideally
`NCBI_API_KEY` (10 requests/s instead of 3); the script paces itself under the limit and
backs off on errors. NCBI asks that large jobs run on weekends or 9 pm–5 am US Eastern.

**Plan a bigger ingest first:** `report.ts` runs the same searches across every topic area
and writes every hit to a spreadsheet with token counts and an embedding cost estimate,
without touching Qdrant:

```sh
bun run packages/db_qdrant/src/ingest/report.ts --max 200 --out ./papers.xlsx
bun run packages/db_qdrant/src/ingest/report.ts --price 0.02   # your embedder's $ per 1M tokens
```

Without `--out` it writes to `reports/pubmed-papers-<date>.xlsx`.

**Your own documents** (PDF, Markdown, HTML, text — guidelines, book chapters):

```sh
bun run packages/db_qdrant/src/ingest/files.ts ./guidelines/position-stand.pdf \
  --title "Position stand on protein" --evidence guideline --year 2017
```

The original file is uploaded to MinIO (`S3_*` settings, bucket `fa-knowledge`) and served
at `/files/<key>`, so citations link to the source. `--evidence` is one of `meta-analysis`,
`systematic-review`, `rct`, `cohort`, `narrative-review`, `guideline`, `textbook`,
`other`.

### 4. Check it

Qdrant's dashboard is at <http://localhost:6333/dashboard>. Then ask the coach something
evidence-based ("how much protein do I need to build muscle?"): answers backed by the
knowledge base show a Sources card.

### Changing the embedder later

1. Update the embedder settings (and `EMBED_REVISION`, which invalidates the embedding cache).
2. If the vector size changed (`EMBEDDING_DIM`, or local ↔ remote), recreate the index:
   `bun run packages/db_qdrant/src/seed.ts --force`.
3. Re-embed everything you ingested: `bun run packages/db_qdrant/src/ingest/reindex.ts`.

No re-download needed. `reindex` also applies a chunk-size change.

The same scripts exist as package scripts: `npm --workspace @fa/db_qdrant run ingest:pubmed -- --defaults`
(also `seed`, `report:pubmed`, `ingest:file`, `reindex`).

For how retrieval works and where it's headed (chunking, hybrid search, reranking,
evaluation), see [vector-rag-implementation.md](vector-rag-implementation.md).
