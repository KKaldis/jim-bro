# syntax=docker/dockerfile:1.7

# ---------- 1. deps: install all workspace deps once, share across stages ----------
# Node-based: we only need npm + tsc + vite here. Bun is used only in runtime.
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Copy only manifests so this layer caches when source changes but deps don't.
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db_postgres/package.json packages/db_postgres/
COPY packages/auth/package.json packages/auth/
COPY packages/agent/package.json packages/agent/
COPY packages/db_meilisearch/package.json packages/db_meilisearch/

# Use npm because the lockfile is package-lock.json. `npm ci --workspaces`
# wires up the @fa/* symlinks under node_modules/@fa/* and hoists everything
# else to the root node_modules/.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root --no-audit --no-fund

# ---------- 2. builder: bring in source + build the React app ----------
FROM deps AS builder
WORKDIR /app

# Copy the rest of the source. .dockerignore keeps junk (node_modules, .env,
# data/, drizzle/, etc.) out of this layer.
COPY tsconfig.base.json tsconfig.json drizzle.config.ts ./
COPY drizzle drizzle
COPY packages packages
COPY apps apps

# Build only the web app. Server is run with `bun run` directly (no bundling).
RUN npm run web:build

# ---------- 3. runtime: slim image, only what the server needs ----------
FROM oven/bun:1.1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Drop root for the running process.
RUN groupadd --system --gid 1001 fa && \
    useradd  --system --uid 1001 --gid fa --shell /usr/sbin/nologin fa

# Copy hoisted deps + built code.
COPY --from=builder --chown=fa:fa /app/node_modules                node_modules
COPY --from=builder --chown=fa:fa /app/package.json                package.json
COPY --from=builder --chown=fa:fa /app/tsconfig.base.json          tsconfig.base.json
COPY --from=builder --chown=fa:fa /app/tsconfig.json               tsconfig.json
COPY --from=builder --chown=fa:fa /app/drizzle.config.ts           drizzle.config.ts
COPY --from=builder --chown=fa:fa /app/drizzle                     drizzle
COPY --from=builder --chown=fa:fa /app/packages                    packages
COPY --from=builder --chown=fa:fa /app/apps/server                 apps/server
COPY --from=builder --chown=fa:fa /app/apps/web/dist               apps/web/dist
# Manifests for the apps NOT copied as source (web) — keeps the
# node_modules/@fa/* workspace symlinks from dangling.
COPY --from=builder --chown=fa:fa /app/apps/web/package.json       apps/web/package.json

USER fa
EXPOSE 3000

# Liveness probe — exits 0 if /health responds.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run the server entrypoint directly with Bun — no bundling needed.
CMD ["bun", "run", "apps/server/src/index.ts"]
