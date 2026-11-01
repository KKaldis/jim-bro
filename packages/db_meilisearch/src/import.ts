// One-shot ingester: load a filtered subset of the OpenFoodFacts dump + USDA
// FoodData Central JSON into the Meilisearch `foods` index.
//
// Run it via docker compose (see docker-compose.yml `foodref-import` service)
// or directly:
//   MEILI_URL=http://localhost:7700 MEILI_MASTER_KEY=... \
//   OFF_DUMP_PATH=./data/openfoodfacts-products.jsonl.gz \
//   USDA_DIR=./data/usda \
//   bun run packages/db_meilisearch/src/import.ts
//
// Re-running is safe: docs use stable ids ("off:<barcode>", "usda:<fdcId>") so
// a re-import upserts in place rather than duplicating.
//
// Where to get the data (see SETUP.md):
//   OFF  : https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz
//   USDA : https://fdc.nal.usda.gov/download-datasets.html  (JSON downloads)

import { readdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "@fa/logger";
import { meili, foodsIndex } from "./client.ts";
import { FOODS_INDEX, FOODS_PRIMARY_KEY, FOODS_SETTINGS, type FoodDoc } from "./types.ts";
import { offRowToDoc, usdaFoodToDoc, type OffRow, type UsdaFood } from "./normalize.ts";

const log = logger.child({ mod: "foodref-import" });

const BATCH_SIZE = 10_000;

// Poll Meilisearch /health until it's up (it boots fast, but compose only
// guarantees the container *started*, not that the HTTP API is listening yet).
async function waitForMeili(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      if (await meili().isHealthy()) return;
    } catch {
      // not listening yet
    }
    log.info("waiting for meilisearch", { attempt: i });
    await Bun.sleep(1000);
  }
  throw new Error("meilisearch did not become healthy in time");
}

// Create the index (idempotent) and apply our settings before loading.
async function ensureIndex(): Promise<void> {
  try {
    await meili().createIndex(FOODS_INDEX, { primaryKey: FOODS_PRIMARY_KEY });
  } catch (err) {
    // index_already_exists is fine — anything else is a real failure.
    const code = (err as { code?: string }).code;
    if (code !== "index_already_exists") throw err;
  }
  await foodsIndex().updateSettings(FOODS_SETTINGS);
  log.info("index ready", { index: FOODS_INDEX });
}

// Buffered batch uploader. Push docs in; it flushes every BATCH_SIZE.
function makeUploader() {
  let buf: FoodDoc[] = [];
  let uploaded = 0;
  async function flush() {
    if (buf.length === 0) return;
    const batch = buf;
    buf = [];
    await foodsIndex().addDocuments(batch);
    uploaded += batch.length;
    log.info("uploaded batch", { uploaded });
  }
  return {
    async push(doc: FoodDoc) {
      buf.push(doc);
      if (buf.length >= BATCH_SIZE) await flush();
    },
    async done() {
      await flush();
      return uploaded;
    },
  };
}

// Yield decompressed lines from a (optionally gzipped) JSONL file without ever
// holding the whole file in memory — the OFF dump is tens of GB.
async function* iterLines(filePath: string): AsyncGenerator<string> {
  let stream: ReadableStream<Uint8Array> = Bun.file(filePath).stream();
  if (filePath.endsWith(".gz")) {
    // @types/node brands web-stream chunks as NonSharedUint8Array, which the
    // DOM-typed DecompressionStream doesn't satisfy — a type-only distinction
    // with no runtime effect, so cast across the seam.
    stream = stream.pipeThrough(
      new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const tail = (buf + decoder.decode()).trim();
  if (tail) yield tail;
}

async function importOff(filePath: string, up: ReturnType<typeof makeUploader>) {
  let scanned = 0;
  let kept = 0;
  for await (const line of iterLines(filePath)) {
    scanned++;
    let row: OffRow;
    try {
      row = JSON.parse(line) as OffRow;
    } catch {
      continue; // skip malformed lines rather than abort the whole import
    }
    const doc = offRowToDoc(row);
    if (doc) {
      kept++;
      await up.push(doc);
    }
    if (scanned % 100_000 === 0) log.info("off progress", { scanned, kept });
  }
  log.info("off done", { scanned, kept, skipped: scanned - kept });
}

// Stream the objects of the first top-level JSON array in `filePath`, parsing
// one element at a time so multi-GB downloads never get held whole in memory
// (Branded Foods is ~3.3GB unzipped — JSON.parse of the whole file OOMs / blows
// the max string length). Works for both bare arrays and the single-key
// wrappers USDA ships ({"BrandedFoods":[ ... ]}). String contents are skipped so
// braces inside values don't confuse the depth counter.
async function* iterJsonArrayObjects(filePath: string): AsyncGenerator<UsdaFood> {
  const reader = Bun.file(filePath).stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let i = 0; // scan cursor within buf
  let started = false; // entered the outer array
  let inObj = false; // accumulating an element object
  let depth = 0; // brace depth within current element
  let inStr = false; // inside a JSON string
  let esc = false; // previous char was a backslash
  let start = 0; // index in buf where the current element began

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (!started) {
        if (c === "[") started = true;
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (!inObj) {
        if (c === "{") {
          inObj = true;
          depth = 1;
          start = i;
        } else if (c === "]") {
          return; // end of the outer array
        }
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        yield JSON.parse(buf.slice(start, i + 1)) as UsdaFood;
        inObj = false;
      }
    }
    // Drop the consumed prefix so buf stays small (~one element + one chunk).
    const cut = inObj ? start : i;
    if (cut > 0) {
      buf = buf.slice(cut);
      i -= cut;
      if (inObj) start -= cut;
    }
  }
}

async function importUsdaFile(filePath: string, up: ReturnType<typeof makeUploader>) {
  let scanned = 0;
  let kept = 0;
  for await (const food of iterJsonArrayObjects(filePath)) {
    scanned++;
    const doc = usdaFoodToDoc(food);
    if (doc) {
      kept++;
      await up.push(doc);
    }
    if (scanned % 100_000 === 0)
      log.info("usda progress", { file: path.basename(filePath), scanned, kept });
  }
  log.info("usda file done", {
    file: path.basename(filePath),
    scanned,
    kept,
    skipped: scanned - kept,
  });
}

async function importUsdaDir(dir: string, up: ReturnType<typeof makeUploader>) {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    log.warn("USDA dir not found, skipping", { dir });
    return;
  }
  const files = entries.filter((f) => f.toLowerCase().endsWith(".json"));
  if (files.length === 0) log.warn("no USDA .json files found", { dir });
  for (const f of files) await importUsdaFile(path.join(dir, f), up);
}

async function main() {
  await waitForMeili();
  await ensureIndex();
  const up = makeUploader();

  const offPath = process.env.OFF_DUMP_PATH;
  if (offPath && (await Bun.file(offPath).exists())) {
    log.info("importing OpenFoodFacts", { path: offPath });
    await importOff(offPath, up);
  } else {
    log.warn("OFF_DUMP_PATH unset or missing, skipping OFF", { path: offPath ?? null });
  }

  const usdaDir = process.env.USDA_DIR;
  if (usdaDir) {
    log.info("importing USDA", { dir: usdaDir });
    await importUsdaDir(usdaDir, up);
  } else {
    log.warn("USDA_DIR unset, skipping USDA");
  }

  const total = await up.done();
  log.info("import complete", { total_uploaded: total });
}

await main();
