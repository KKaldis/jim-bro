// Cache Storage for the on-device body-scan assets (MediaPipe wasm + models,
// ~34 MB). Fetched once with byte-level progress, then read from disk on every
// later open — in dev too, where the service worker doesn't run, and for the
// models, which are cross-origin and outside the SW's rules anyway.
//
// Keys are versioned URLs (Vite-hashed wasm asset, pinned model version), so
// an upgrade simply misses and refetches; pruneStaleCaches drops older bundles.

// Exported so the dev-mode cache wipe in main.tsx can spare it.
export const MODEL_CACHE_PREFIX = "physique-models-";
export const MODEL_CACHE = `${MODEL_CACHE_PREFIX}v1`;

async function openCache(): Promise<Cache | null> {
  // `caches` is undefined outside secure contexts (plain-http LAN dev).
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
}

/**
 * The bytes at `url`, from the cache when present, else downloaded (reporting
 * progress) and stored. Only a complete download is stored, so an aborted
 * fetch never leaves a truncated model behind. A failed store (quota) is
 * swallowed — the scan still works, it just downloads again next time.
 */
export async function fetchCached(
  url: string,
  // `cached` is known from the first call, so a UI can tell a first-time
  // download from a disk read before any file has finished.
  onProgress: (loaded: number, total: number | null, cached: boolean) => void,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; cached: boolean }> {
  const cache = await openCache();
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onProgress(bytes.byteLength, bytes.byteLength, true);
    return { bytes, cached: true };
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get("Content-Length"));
  const total = Number.isFinite(len) && len > 0 ? len : null;
  onProgress(0, total, false);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total, false);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  onProgress(loaded, loaded, false);

  if (cache) {
    const type = res.headers.get("Content-Type") ?? "application/octet-stream";
    await cache
      .put(url, new Response(bytes, { headers: { "Content-Type": type } }))
      .catch(() => undefined);
  }
  return { bytes, cached: false };
}

/** Delete body-scan caches from older versions of this module. */
export async function pruneStaleCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(MODEL_CACHE_PREFIX) && k !== MODEL_CACHE)
        .map((k) => caches.delete(k)),
    );
  } catch {
    // Best effort.
  }
}
