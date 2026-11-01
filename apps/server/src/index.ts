/**
 * HTTP server. Wraps the same agent module the CLI uses.
 *
 * Layout: routes/*.ts hold the handlers, one module per domain (chat, food,
 * diet, workout, progress, account), each exporting its route list;
 * router.ts matches them and http.ts holds the shared request helpers
 * (authed session boundary, Zod body parsing, CORS). This file wires the
 * routes, static SPA serving and the chat WebSocket into Bun.serve.
 *
 * Auth boundary:
 *   - Better Auth handler mounted at /api/auth/* (signup/login/logout/reset
 *     /verify-email). Sessions live in cookies.
 *   - All app endpoints (/chat, /chat/stream, /history, /reset, DELETE /me)
 *     derive userId from the session — never from the request body.
 *
 * Hardening (P3):
 *   - CORS allowlist driven by FRONTEND_ORIGIN.
 *   - Per-user in-memory token-bucket rate limit on chat endpoints.
 *     Single-process only; replace with Redis when you scale horizontally.
 *   - Usage ledger writes happen inside chat()/chatStream() (see agent.ts).
 */
import { UserStorage } from "@fa/agent";
import { auth, enabledSocialProviders } from "@fa/auth";
import { loadConfig, logger, type Logger, wrapFetch } from "@fa/logger";
import { openApiDocument } from "@fa/shared/openapi";
import { getObject } from "@fa/storage";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { extensionRoutes, loadExtensions } from "./extensions.ts";
import { corsHeaders, withCors } from "./http.ts";
import { dispatch, type Route, route } from "./router.ts";
import { type ChatSocketData, chatWebSocket, handleWsUpgrade } from "./routes/chat.ts";
import { apiRoutes } from "./routes/index.ts";

const logCfg = loadConfig();

const PORT = Number(process.env.PORT ?? 3001);

// Built React app lives at apps/web/dist after `npm run web:build`.
// In dev, Vite at :5173 proxies API calls here.
const WEB_DIST = resolve(import.meta.dir, "..", "..", "web", "dist");
const SERVE_STATIC = existsSync(WEB_DIST);

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// PWA assets that must not be served from the long-cache bucket. Vite hashes
// app JS/CSS so they're safe to cache for a year, but the service worker
// script itself (and the manifest) must revalidate on every load or installed
// PWAs would never pick up new builds.
const NO_CACHE_BASENAMES = new Set(["sw.js", "registerSW.js", "manifest.webmanifest"]);
function isNoCacheAsset(rel: string): boolean {
  const base = rel.split(/[\\/]/).pop() ?? rel;
  if (NO_CACHE_BASENAMES.has(base)) return true;
  // Workbox runtime chunks emitted next to sw.js.
  if (/^workbox-[a-f0-9]+\.js$/.test(base)) return true;
  return false;
}

// Social link-preview crawlers require absolute og:image/twitter:image URLs,
// but index.html ships them as paths; prefix them with the request origin.
function absolutizeShareImages(html: string, host: string): string {
  let out = html;
  if (host) {
    const origin = `https://${host}`;
    out = out.replace(
      /(property="og:image"|name="twitter:image") content="(\/[^"]+)"/g,
      (_m, attr, path) => `${attr} content="${origin}${path}"`,
    );
  }
  return out;
}

async function serveIndexHtml(file: ReturnType<typeof Bun.file>, host: string): Promise<Response> {
  const html = absolutizeShareImages(await file.text(), host);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

async function tryStatic(url: URL, host: string): Promise<Response | null> {
  if (!SERVE_STATIC) return null;
  // Strip leading slash; default to index.html for "/" or any non-file route
  // (SPA fallback so client-side navigation deep links work).
  const rel = url.pathname.replace(/^\/+/, "");
  const ext = extname(rel).toLowerCase();
  const candidate = ext ? join(WEB_DIST, rel) : join(WEB_DIST, "index.html");
  if (!candidate.startsWith(WEB_DIST)) return null; // path traversal guard
  const file = Bun.file(candidate);
  if (!(await file.exists())) {
    // SPA fallback for unknown non-file paths.
    if (ext) return null;
    const fallback = Bun.file(join(WEB_DIST, "index.html"));
    if (!(await fallback.exists())) return null;
    return serveIndexHtml(fallback, host);
  }
  // HTML (SPA root, deep link, or an explicit *.html) gets absolute share-image
  // URLs for link previews; text/html so the browser renders it.
  if (!ext || ext === ".html") {
    return serveIndexHtml(file, host);
  }
  const contentType = STATIC_MIME[ext] ?? "application/octet-stream";
  const longCache = !isNoCacheAsset(rel);
  return new Response(file, {
    headers: {
      "content-type": contentType,
      "cache-control": longCache ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

// ---------- routes ----------

// Add-on packages (SERVER_EXTENSIONS, see ./extensions.ts) load before the
// route table is built so their routes and OpenAPI paths are included.
await loadExtensions();

const routes: Route[] = [
  // Better Auth handler — covers /api/auth/sign-up, sign-in, sign-out,
  // session, request-password-reset, reset-password, verify-email, etc.
  route("*", "/api/auth/:rest(.*)", ({ req }) => auth.handler(req)),
  // Which social sign-in buttons the login page should show.
  route("GET", "/api/auth-providers", () => Response.json(enabledSocialProviders)),
  route("GET", "/health", () => new Response("ok")),
  // Serve a reference file from object storage (guideline PDFs, etc.).
  // These back the knowledge base's citations; proxied through the app so
  // the browser doesn't need direct access to the internal MinIO host.
  route(["GET", "HEAD"], "/files/:key(.+)", ({ req, log, params }) =>
    handleFile(decodeURIComponent(params.key), req.method, log),
  ),
  route("GET", "/openapi.json", () => Response.json(openApiDocument())),
  ...apiRoutes,
  ...extensionRoutes(),
];

const httpFetch = wrapFetch({
  logger,
  enabled: logCfg.httpEnabled,
  async handler(req, log) {
    const url = new URL(req.url);

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const res = await dispatch(routes, req, url, log);
    if (res) return res;

    // Static SPA (only when web/dist exists). API routes above always win.
    if (req.method === "GET") {
      const staticRes = await tryStatic(url, req.headers.get("host") ?? "");
      if (staticRes) return withCors(req, staticRes);
    }

    return withCors(req, new Response("not found", { status: 404 }));
  },
});

const server = Bun.serve<ChatSocketData>({
  port: PORT,
  // Bun's default is 10s. SSE chat streams can sit idle while the agent
  // waits at a `tool_proposed` gate; 255s (the documented max) buys
  // headroom on top of the 15s keepalive in handleChatStream.
  idleTimeout: 255,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") return handleWsUpgrade(req, srv);
    return httpFetch(req);
  },
  websocket: chatWebSocket,
});

// ---------- handlers ----------

// Stream a reference file from object storage. Returns 404 when the key is
// missing (or storage is unreachable). HEAD returns headers without the body.
async function handleFile(key: string, method: string, log: Logger): Promise<Response> {
  try {
    const obj = await getObject(key);
    const headers = {
      "content-type": obj.contentType,
      "content-length": String(obj.size),
      "cache-control": "public, max-age=3600",
    };
    return new Response(method === "HEAD" ? null : obj.bytes, { headers });
  } catch (err) {
    log.warn?.("file not found", { key, error: err instanceof Error ? err.message : String(err) });
    return new Response("not found", { status: 404 });
  }
}

logger.info("server listening", {
  url: `http://localhost:${server.port}`,
  port: server.port,
  static: SERVE_STATIC,
  log_level: logCfg.level,
  log_format: logCfg.format,
  log_transports: logCfg.transports.join(","),
});

// Periodic usage-ledger pruning: drop rows older than 12 months. Cost
// analysis windows are typically weeks to months, not years. Runs once at
// startup (in case the server was down for a while) and then daily.
const LEDGER_RETENTION_DAYS = 365;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function pruneOldLedger() {
  const cutoff = new Date(Date.now() - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const deleted = await UserStorage.pruneUsageLedger(cutoff);
    if (deleted > 0) {
      logger.info("usage ledger pruned", {
        deleted,
        cutoff: cutoff.toISOString(),
      });
    }
  } catch (err) {
    logger.error("usage ledger prune failed", err instanceof Error ? err : new Error(String(err)));
  }
}
void pruneOldLedger();
setInterval(pruneOldLedger, PRUNE_INTERVAL_MS);
