// Apply FOODS_SETTINGS (searchable / filterable / sortable attributes, ranking)
// to the already-populated `foods` index WITHOUT re-importing the dump. Run this
// whenever FOODS_SETTINGS changes — e.g. after adding a new filterable macro —
// so the live index re-indexes under the new settings:
//
//   MEILI_URL=http://localhost:7700 MEILI_MASTER_KEY=... \
//   bun run packages/db_meilisearch/src/sync-settings.ts
//
// The full importer (import.ts) also applies these settings, but a settings-only
// change doesn't warrant re-streaming millions of rows.

import { logger } from "@fa/logger";
import { meili, syncFoodsSettings } from "./client.ts";

const log = logger.child({ mod: "foodref-settings" });

async function main() {
  if (!(await meili().isHealthy())) {
    throw new Error("meilisearch not reachable — check MEILI_URL / MEILI_MASTER_KEY");
  }
  const task = await syncFoodsSettings();
  log.info("settings update enqueued", { taskUid: (task as { taskUid?: number }).taskUid });
}

await main();
