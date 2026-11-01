# Setup

The project is a Bun-flavored monorepo with npm workspaces.

```text
jim-bro/
├── apps/
│   ├── server/    # @fa/server — HTTP API (Bun.serve)
│   └── web/       # @fa/web    — React + Vite frontend
├── packages/
│   ├── shared/          # @fa/shared         — types + macro/food/etc. lib
│   ├── db_postgres/     # @fa/db_postgres    — Drizzle schema + client (Postgres)
│   ├── db_meilisearch/  # @fa/db_meilisearch — Meilisearch food index + OFF/USDA importer
│   ├── db_qdrant/       # @fa/db_qdrant      — Qdrant vector knowledge base + seeder
│   ├── auth/            # @fa/auth           — Better Auth config + email sender
│   ├── agent/           # @fa/agent          — chat loop, tools, prompts, storage
│   └── logger/          # @fa/logger         — structured logging util
├── drizzle.config.ts
├── package.json   # workspace root
└── tsconfig.base.json
```

Workspace deps resolve via npm symlinks (`@fa/shared` → `packages/shared`).

## 1. Install

```sh
npm install        # at the repo root — installs all workspaces
```

## 2. Provision Postgres

Pick one. **Neon** (serverless, free tier) is easiest:

- <https://neon.tech> → create project → copy the connection string.
- Or local Docker: `docker run -d --name pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16`
  → `postgres://postgres:dev@localhost:5432/postgres`.

## 3. Generate `BETTER_AUTH_SECRET`

```sh
openssl rand -hex 32
```

PowerShell: `-join ((48..57)+(97..102) | Get-Random -Count 64 | % {[char]$_})`

## 4. Fill in `.env` (at repo root)

Copy `.env.example` → `.env`:

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgres://...
BETTER_AUTH_SECRET=<32+ byte hex>
BETTER_AUTH_URL=http://localhost:3000
FRONTEND_ORIGIN=http://localhost:5173
RESEND_API_KEY=                    # leave empty in dev — emails print to stdout
EMAIL_FROM="Jim-Bro <noreply@yourdomain.com>"

# Food lookups: dev defaults to the self-hosted Meilisearch index. To test the
# live public-API path instead (no Meilisearch needed), set both:
# FOODREF_LIVE=true
# FDC_API_KEY=                       # USDA key (blank → OpenFoodFacts only)
```

See [Food data: two backends](#food-data-two-backends-self-hosted-vs-live) for the full
split. `.env.example` documents every var.

## 5. Apply the schema

Migrations live in `drizzle/` (one baseline to start). Apply them:

```sh
npm run db:migrate          # drizzle-kit migrate: applies what's new, in order
```

With Docker, `docker compose run --rm migrate` does the same from the image (which
ships `drizzle/`).

**Changing the schema:** edit `packages/db_postgres/src/schema.ts`, run
`npm run db:generate` (writes `drizzle/<n>_*.sql`), review and commit the file, then
`npm run db:migrate`. `npm run db:push` (sync without a migration file) is only for
throwaway local databases: on a real one the history drifts from the schema.

## 6. Run

**Dev (two terminals):**

```sh
npm run dev            # terminal 1 — Bun API at :3000 (hot reload)
npm run web:dev        # terminal 2 — Vite + React at :5173 (proxies API to :3000)
```

Open <http://localhost:5173> — sign up, then chat.

**Production (single process):**

```sh
npm run web:build      # builds apps/web/dist/
npm run server         # serves API + React app from :3000 (no Vite)
```

When `apps/web/dist` exists, the Bun server serves the React app at `/` and the API at `/api/auth/*`, `/chat`, `/openapi.json`, etc. — same origin, no CORS, no proxy.

## 7. Endpoints

| Method | Path            | Description                                                                                                                                            |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `*`    | `/api/auth/*`   | Better Auth (signup/login/logout/forgot/reset/verify)                                                                                                  |
| POST   | `/chat`         | Non-streaming chat. Body: `ChatRequest`. Returns `ChatResult`.                                                                                         |
| POST   | `/chat/stream`  | SSE stream. Same body. Events: `iteration_start`, `thinking_delta`, `text_delta`, `tool_started`, `tool_finished`, `iteration_usage`, `done`, `error`. |
| GET    | `/history`      | Current user's conversation.                                                                                                                           |
| POST   | `/reset`        | Wipe conversation.                                                                                                                                     |
| DELETE | `/me`           | Delete account + cascade all data (GDPR).                                                                                                              |
| GET    | `/openapi.json` | OpenAPI 3.1 spec.                                                                                                                                      |
| GET    | `/health`       | Liveness probe.                                                                                                                                        |

All app endpoints require the Better Auth session cookie.

## 8. OpenAPI / frontend codegen

The OpenAPI spec is **derived from Zod schemas** in `packages/shared/src/schemas.ts`
— the server validates request bodies with the same schemas (`readBody` in
`apps/server/src/http.ts`). Orval turns the spec into typed React Query hooks
and models under `apps/web/src/api/`:

```sh
npm run gen:api          # from repo root: writes apps/web/openapi.json, then runs Orval
```

This runs fully **offline** — the spec is built in-process from the Zod
registry (`apps/server/scripts/gen-api-types.ts`), so no running server or DB
is needed. Re-run after backend schema changes; the generated files are not
hand-edited.

Import request/response models from `apps/web/src/api/model` (e.g.
`StreamEvent`, `ChatRequest`, `HistoryResponse`) and endpoint functions/hooks
from `apps/web/src/api/endpoints`.

The Better Auth endpoints (`/api/auth/*`) are intentionally **not** in the
spec — `better-auth/react` already provides correct types for those.

## 9. Docker

Single-image production build (server + built React app). The image
runs as a non-root user, exposes port 3000, and includes a `/health`
healthcheck.

### Local stack with docker compose

`.env` at the repo root must contain `ANTHROPIC_API_KEY` and `BETTER_AUTH_SECRET`
at minimum. Compose auto-loads it.

```sh
docker compose build              # build the image (~2-3 min first time)
docker compose run --rm migrate   # one-shot: apply migrations to the postgres container
docker compose up -d              # start postgres + app
docker compose logs -f app        # tail logs
```

Open <http://localhost:3000> — sign up, chat. The app container serves both
the API and the built React app at the same origin.

```sh
docker compose down               # stop (postgres data volume persists)
docker compose down -v            # stop + wipe the postgres + meili volumes
```

### Food data: two backends (self-hosted vs live)

Product/nutrition lookups (`lookup_product`, and `import_pantry` barcode
auto-fill) have two interchangeable backends, chosen by the **`FOODREF_LIVE`**
env flag:

| `FOODREF_LIVE`  | Food lookups                                        | `search_knowledge` (evidence RAG) | Use         |
| --------------- | --------------------------------------------------- | --------------------------------- | ----------- |
| unset / `false` | self-hosted **Meilisearch** index (below)           | on (Qdrant)                       | self-hosted |
| `true`          | live **OpenFoodFacts + USDA FoodData Central** APIs | auto-hidden                       | live        |

`FOODREF_LIVE=true` is the easiest way to deploy: no Meilisearch or Qdrant to
run — food lookups go straight to the public APIs and the Qdrant-backed evidence
tool is hidden. Flip the flag back to `false` (and run those services) to
re-enable them.

**Env / secrets for the live path:**

- `FOODREF_LIVE=true` — non-secret; set it in `.env` (or your deploy environment).
- `FDC_API_KEY` — **secret**; the USDA FoodData Central key
  ([free signup](https://fdc.nal.usda.gov/api-key-signup.html)). Set it in
  `.env` (or your deploy secrets). **Optional:** if blank, lookups use **OpenFoodFacts
  only** (keyless) — USDA generics are skipped with one warning, everything else
  keeps working. Add the key to turn on USDA.

**The actual API calls per request:**

The dispatchers in `packages/agent/src/tools.ts` (`refSearch` /
`refLookupByBarcode`) route each lookup to the active backend — same signatures
either way, so call sites are backend-agnostic.

- **Self-hosted (`FOODREF_LIVE` unset/`false`) — Meilisearch, local, no outbound calls.**
  Reads the self-hosted `foods` index at `MEILI_URL` (default
  `http://localhost:7700`). Barcode → exact filter (`barcode = "<code>"`);
  query → typo-tolerant search with server-side macro/brand filters + sort.
  Code: `packages/db_meilisearch/src/client.ts`.

- **Live (`FOODREF_LIVE=true`) — public HTTP APIs, one outbound call per
  lookup.** Code: `packages/agent/src/foodref-live.ts`.
  - **OpenFoodFacts** (branded, keyless — polite `User-Agent` only):
    - barcode: `GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json?fields=...`
      (OFF-only — USDA generics carry no barcode)
    - search: `GET https://world.openfoodfacts.org/cgi/search.pl?search_terms=...&search_simple=1&action=process&json=1&page_size=<top>&fields=...`
  - **USDA FoodData Central** (generics, needs `FDC_API_KEY`):
    - search: `GET https://api.nal.usda.gov/fdc/v1/foods/search?api_key=...&query=...&dataType=Foundation,SR Legacy,Survey (FNDDS)`
  - Search runs OFF + USDA in parallel and merges; since the live APIs can't
    express the `FoodSearchOpts` filters/sort server-side, macro/brand narrowing
    and sort are applied client-side to the merged set. Nutriments are read
    per-100g (kJ→kcal fallback); a product is emitted only when its core macros
    (kcal + protein + fat + carbs) are complete, otherwise the lookup misses and
    the agent falls back to asking the user / reading the label.

#### Self-hosted food data (Meilisearch — dev)

> Full guide, including the Qdrant evidence knowledge base and every maintenance
> script: [docs/search-and-knowledge-data.md](docs/search-and-knowledge-data.md).

The Meilisearch index (used when `FOODREF_LIVE` is off) is served instead of the
live OpenFoodFacts API. `docker compose up` already starts the `meilisearch`
service; you just need to load data into it once.

The importer (`packages/db_meilisearch`) ingests a **filtered subset** — it keeps only
rows that have a usable name **and** complete per-100g macros (kcal + protein +
fat + carbs), which trims the multi-GB OpenFoodFacts dump down to the useful
core. Re-running is safe: documents use stable ids, so a re-import upserts.

**1. Download the dumps into `./data/`:**

```sh
mkdir -p data/usda

# OpenFoodFacts — full JSONL dump (gzipped, tens of GB; streamed, never fully
# loaded into memory). From https://world.openfoodfacts.org/data
curl -L -o data/openfoodfacts-products.jsonl.gz \
  https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz

# USDA FoodData Central — JSON downloads. From
# https://fdc.nal.usda.gov/download-datasets.html
# Drop any of the JSON files (Foundation, SR Legacy, Branded) into data/usda/.
# e.g. FoodData_Central_foundation_food_json_2026-04-30.json
```

**2. Run the importer (one-shot):**

```sh
docker compose run --rm foodref-import
```

It logs scanned/kept/skipped counts per source. Override input paths via
`OFF_DUMP_PATH` / `USDA_DIR` env if your files live elsewhere; either source can
be omitted (the importer skips a missing dump or empty dir).

**Verify the index** (master key defaults to `dev_master_key_change_me` — set `MEILI_MASTER_KEY` in prod):

```sh
curl -H "Authorization: Bearer dev_master_key_change_me" \
  http://localhost:7700/indexes/foods/stats
```

> The live-API path (`FOODREF_LIVE=true`) lives in
> `packages/agent/src/foodref-live.ts` — OpenFoodFacts + USDA FoodData Central,
> returning the same shape as the index so it's a drop-in swap. The even older
> inline OFF-only integration is still preserved commented-out (renamed `*_api`)
> in `packages/agent/src/tools.ts`.

### Building the image standalone

```sh
docker build -t jim-bro:latest .

# Run against a managed Postgres (e.g. Neon)
docker run -d --name fa --restart unless-stopped \
  -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e DATABASE_URL=postgres://... \
  -e BETTER_AUTH_SECRET=... \
  -e BETTER_AUTH_URL=https://yourdomain.com \
  -e FRONTEND_ORIGIN=https://yourdomain.com \
  -e RESEND_API_KEY=... \
  -e EMAIL_FROM='Jim-Bro <noreply@yourdomain.com>' \
  jim-bro:latest
```

Apply migrations once before first start:

```sh
docker run --rm \
  -e DATABASE_URL=postgres://... \
  jim-bro:latest \
  bunx drizzle-kit migrate
```

(The image ships `drizzle/` migration files generated by `npm run db:generate`.)

### Image structure

- Multi-stage Dockerfile: `deps` → `builder` → `runtime`.
- Final image is `oven/bun:1.1-slim` + hoisted `node_modules` + server source + built `apps/web/dist`.
- `.dockerignore` keeps `node_modules`, `.env`, `data/`, `.git`, `*.md` out of the build context.
- For deploy: tag and push to your registry of choice (`docker tag jim-bro:latest ghcr.io/you/fa:v0.1`).

## What's NOT done

- **No spending caps** — every AI call is recorded and shown on the AI usage page, but
  nothing limits it. A server extension can add a cap through `preflight`
  (`apps/server/src/extensions.ts`).
- **Rate limit is in-memory** — per process (60 chat calls/min per user). Running several
  server instances needs a shared store such as Redis.
