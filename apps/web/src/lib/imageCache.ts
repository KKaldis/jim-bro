/**
 * Local cache of images the user has attached in chat.
 *
 * The server strips image blocks from persisted conversation history (cost +
 * GDPR + row size; see packages/agent/src/storage.ts), so after a refresh the
 * restored chat can only show the text placeholder — at best a caption, at
 * worst "photo no longer available". This cache keeps the original image bytes
 * in the browser (IndexedDB) so the chat can re-display previously-sent photos
 * on reload, entirely client-side.
 *
 * Matching to restored history is positional: images are appended in send
 * order, history image placeholders appear in that same order, and the render
 * aligns them from the most-recent end (see Chat.tsx messagesToTurns), so the
 * newest N images stay visible even when older ones age out of the cap.
 *
 * Scoped per user (one IndexedDB database per user id) so a shared browser
 * never bleeds one account's photos into another's chat. Best-effort
 * throughout: any IndexedDB failure (quota, private mode, unavailability)
 * degrades silently to the text placeholder.
 */

const STORE = "images";
// Keep only the most recent N images per user. Bounds storage growth; older
// images fall back to their text placeholder on restore.
const MAX_CACHED = 60;

function dbName(userId: string): string {
  return `fa-chat-images:${userId}`;
}

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(userId), 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // autoIncrement keys preserve insertion (send) order, which is how
        // getAll() returns values — the positional match relies on this.
        db.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Append images (in order) to the user's cache, then trim to MAX_CACHED.
export async function cacheSentImages(
  userId: string,
  images: ReadonlyArray<{ media_type: string; data: string }>,
): Promise<void> {
  if (!images.length || !available()) return;
  try {
    const db = await openDb(userId);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const img of images) {
        store.add(`data:${img.media_type};base64,${img.data}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await trim(db);
    db.close();
  } catch {
    // best-effort: ignore quota / availability failures
  }
}

// Delete the oldest entries (lowest keys) until at most MAX_CACHED remain.
function trim(db: IDBDatabase): Promise<void> {
  return new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const excess = countReq.result - MAX_CACHED;
      if (excess <= 0) {
        resolve();
        return;
      }
      let removed = 0;
      const curReq = store.openCursor();
      curReq.onsuccess = () => {
        const cursor = curReq.result;
        if (cursor && removed < excess) {
          cursor.delete();
          removed++;
          cursor.continue();
        } else {
          resolve();
        }
      };
      curReq.onerror = () => resolve();
    };
    countReq.onerror = () => resolve();
  });
}

// All cached image data-URLs for the user, oldest-first (insertion order).
export async function loadCachedImageUrls(userId: string): Promise<string[]> {
  if (!available()) return [];
  try {
    const db = await openDb(userId);
    const urls = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return urls;
  } catch {
    return [];
  }
}

// Drop the user's cached images — called when the conversation is reset so a
// fresh chat doesn't re-hydrate stale photos.
export async function clearImageCache(userId: string): Promise<void> {
  if (!available()) return;
  try {
    const db = await openDb(userId);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // best-effort
  }
}
