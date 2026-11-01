// Remove already-indexed rows whose per-100g macros are physically impossible
// (mis-scaled source data, e.g. USDA Branded entries reporting per-package
// amounts — "kcal 90000, p 3400"). The importer now drops these at ingest time
// (see plausibleMacros in normalize.ts); this prunes the ones already in the
// live index using the SAME bounds, so a re-import isn't required.
//
//   MEILI_URL=http://localhost:7700 MEILI_MASTER_KEY=... \
//   bun run packages/db_meilisearch/src/prune-implausible.ts
//
// First writes every offending row to LOG_PATH (default ./logs.txt) so you can
// see exactly what's considered garbage, THEN deletes them by filter. Set
// PRUNE_DRY_RUN=1 to only write the log and skip deletion.
//
// Requires kcal/p/f/c/fiber to be filterable (sync-settings already did this).

import { logger } from "@fa/logger";
import { meili, foodsIndex } from "./client.ts";
import { MACRO_BOUNDS } from "./normalize.ts";

const log = logger.child({ mod: "foodref-prune" });

// Meilisearch filter matching exactly what plausibleMacros() rejects.
function pruneFilter(): string {
  const { maxKcal, maxGrams } = MACRO_BOUNDS;
  return [
    `kcal > ${maxKcal}`,
    "kcal < 0",
    `p > ${maxGrams}`,
    "p < 0",
    `f > ${maxGrams}`,
    "f < 0",
    `c > ${maxGrams}`,
    "c < 0",
    `fiber > ${maxGrams}`,
    "fiber < 0",
  ].join(" OR ");
}

type Row = {
  id: string;
  source: string;
  name: string;
  brand: string | null;
  kcal: number;
  p: number;
  f: number;
  c: number;
  fiber: number | null;
};

// Page through every document matching the filter (getDocuments isn't capped by
// maxTotalHits the way search is).
async function collectImplausible(filter: string): Promise<Row[]> {
  const fields: (keyof Row)[] = ["id", "source", "name", "brand", "kcal", "p", "f", "c", "fiber"];
  const PAGE = 1000;
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await foodsIndex().getDocuments<Row>({ filter, fields, limit: PAGE, offset });
    rows.push(...res.results);
    if (res.results.length < PAGE) break;
  }
  return rows;
}

function renderLog(rows: Row[], filter: string): string {
  const { maxKcal, maxGrams } = MACRO_BOUNDS;
  const header = [
    `# Meilisearch "foods" — implausible rows (per-100g sanity bounds)`,
    `# rule: 0 <= kcal <= ${maxKcal}, and 0 <= each of p/f/c/fiber <= ${maxGrams} g`,
    `# filter: ${filter}`,
    `# generated: ${new Date().toISOString()}`,
    `# total: ${rows.length}`,
    `id\tsource\tkcal\tp\tf\tc\tfiber\tname (brand)`,
  ].join("\n");
  const body = rows
    .map(
      (r) =>
        `${r.id}\t${r.source}\t${r.kcal}\t${r.p}\t${r.f}\t${r.c}\t${r.fiber ?? ""}\t${r.name}${
          r.brand ? ` (${r.brand})` : ""
        }`,
    )
    .join("\n");
  return `${header}\n${body}\n`;
}

async function main() {
  if (!(await meili().isHealthy())) {
    throw new Error("meilisearch not reachable — check MEILI_URL / MEILI_MASTER_KEY");
  }
  const filter = pruneFilter();
  const rows = await collectImplausible(filter);

  const logPath = process.env.LOG_PATH ?? "logs.txt";
  await Bun.write(logPath, renderLog(rows, filter));
  log.info("wrote implausible-row log", { logPath, count: rows.length });

  if (rows.length === 0) {
    log.info("nothing to prune — index is clean");
    return;
  }

  if (process.env.PRUNE_DRY_RUN) {
    log.info("dry run — leaving the index untouched", { wouldDelete: rows.length });
    return;
  }

  const task = await foodsIndex().deleteDocuments({ filter });
  log.info("delete enqueued", {
    taskUid: (task as { taskUid?: number }).taskUid,
    deleting: rows.length,
  });
}

await main();
