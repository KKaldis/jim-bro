import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// Dev-only: serve /sw.js with a self-destruct worker so any stale SW left over
// from a prior `web:build` (which precaches a prod index.html referencing
// hashed bundles Vite doesn't have) updates itself, unregisters, wipes caches,
// and reloads controlled tabs. Without this, dev navigations get intercepted
// and 404 on /assets/index-*.js.
const devSwKillSwitch = (): Plugin => ({
  name: "dev-sw-killswitch",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/sw.js" || req.url?.startsWith("/sw.js?")) {
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Service-Worker-Allowed", "/");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});`,
        );
        return;
      }
      next();
    });
  },
});

// Proxy backend calls to the Bun server during dev so cookies stay first-party
// (Vite at :5173 → API at :3000 would otherwise be cross-origin).
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    devSwKillSwitch(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png", "logo.svg"],
      manifest: {
        name: "Jim-Bro.ai",
        short_name: "Jim-Bro",
        description: "AI fitness & nutrition assistant",
        theme_color: "#0d1117",
        background_color: "#0d1117",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // The 287 exercise silhouette icons are lazy — a user only ever sees a
        // handful, so precaching all ~1.4 MB upfront would bloat every install.
        // Excluded from precache here and served via the CacheFirst runtime rule
        // below, so each icon is fetched (and then cached offline) only on use.
        // Same for the muscle icons (~23 KB each, ~30 of them).
        // The MediaPipe runtime (body scan) is excluded too: ~12 MB that only
        // scanner users need, and src/physique/modelCache.ts already keeps it
        // in its own cache alongside the models.
        // Non-English translation chunks (src/i18n/index.ts) are lazy as well:
        // a user needs one language, not all seven (~255 KB gzipped together).
        globIgnores: [
          "**/exercise-icons/**",
          "**/muscle-icons/**",
          "**/vision_wasm*",
          "**/locale-*",
        ],
        // Anything under the API surface must always hit the network — these
        // responses are user/session-scoped and must not be cached by the SW.
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/chat/,
          /^\/history/,
          /^\/dashboard/,
          /^\/progress/,
          // Exact match: backend `POST /reset` clears user data. Without
          // anchoring, this also blocks the SPA-served `/reset-password`.
          /^\/reset$/,
          /^\/me/,
          /^\/health/,
          /^\/workout/,
          /^\/foods/,
          /^\/tools/,
          /^\/pantry/,
          /^\/recipes/,
          /^\/cardio/,
          /^\/steps/,
          /^\/water/,
        ],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === "font",
            handler: "CacheFirst",
            options: {
              cacheName: "fonts",
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            // Exercise silhouette icons — excluded from precache (globIgnores
            // above), so cache each one the first time it's shown; thereafter it
            // loads instantly and works offline.
            urlPattern: ({ url }) => url.pathname.startsWith("/exercise-icons/"),
            handler: "CacheFirst",
            options: {
              cacheName: "exercise-icons",
              expiration: { maxEntries: 320, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            // Muscle icons (MuscleMap) — lazy like the exercise icons above.
            urlPattern: ({ url }) => url.pathname.startsWith("/muscle-icons/"),
            handler: "CacheFirst",
            options: {
              cacheName: "muscle-icons",
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            // Translation chunks — excluded from precache (globIgnores above),
            // so only the languages a user actually opens are fetched and then
            // kept offline. Names are content-hashed, so CacheFirst never serves
            // stale text; maxEntries evicts the old hashes deploys leave behind.
            urlPattern: ({ url }) => /\/assets\/locale-[^/]+\.js$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "locales",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            // The barcode-scanner wasm (zxing) is only fetched by browsers that
            // lack a native BarcodeDetector (iOS Safari / Firefox). CacheFirst
            // instead of precache so the Chrome/Android majority — who use the
            // native detector and never load it — don't pay the ~1MB download;
            // the browsers that do fetch it can then scan offline after once.
            // MediaPipe's wasm is skipped: modelCache.ts caches it already, and
            // a second copy here would be 12 MB of duplicate storage.
            urlPattern: ({ url }) =>
              url.pathname.endsWith(".wasm") && !url.pathname.includes("vision_wasm"),
            handler: "CacheFirst",
            options: {
              cacheName: "wasm",
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // One chunk per lazy language (src/i18n/index.ts) instead of one per
        // locale JSON file, so a language switch is a single request.
        manualChunks(id) {
          const lang = /\/i18n\/locales\/([^/]+)\//.exec(id)?.[1];
          if (lang && lang !== "en") return `locale-${lang}`;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host (the string shorthand rewrites it to :3001):
      // Better Auth derives its base URL — and so the Google OAuth redirect URI
      // — from it. Must come before "/api"; the first matching key wins.
      "/api/auth": { target: "http://localhost:3001", changeOrigin: false },
      "/api": "http://localhost:3001",
      "/chat": "http://localhost:3001",
      // Chat WebSocket — `ws: true` makes Vite forward the upgrade.
      "/ws": { target: "ws://localhost:3001", ws: true },
      "/history": "http://localhost:3001",
      "/dashboard": "http://localhost:3001",
      "/progress": "http://localhost:3001",
      "/reset": "http://localhost:3001",
      "/me": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/workout": "http://localhost:3001",
      "/foods": "http://localhost:3001",
      "/tools": "http://localhost:3001",
      "/link-preview": "http://localhost:3001",
      "/pantry": "http://localhost:3001",
      "/recipes": "http://localhost:3001",
      "/body": "http://localhost:3001",
      "/cardio": "http://localhost:3001",
      "/measurements": "http://localhost:3001",
      "/diet": "http://localhost:3001",
      "/steps": "http://localhost:3001",
      "/water": "http://localhost:3001",
      "/openapi.json": "http://localhost:3001",
    },
  },
});
