/**
 * Write apps/web/openapi.json — the spec Orval turns into the web app's typed
 * hooks + models (apps/web/src/api/**, via `npm run gen:hooks`).
 *
 * Runs fully offline: the spec is built in-process from the Zod registry
 * (@fa/shared/schemas → openapi.ts), so no server needs to be running and no DB is
 * touched.
 *
 * Usage (from repo root or apps/server):
 *   bun run apps/server/scripts/gen-api-types.ts
 *   # or via package script:  npm run gen:api  /  bun run gen:api
 *
 * Re-run after editing @fa/shared/schemas (`npm run gen:api` at the root does
 * this and then runs Orval). The OpenAPI modules of configured extensions
 * (`jimBro.openapiExtensions`, see ../src/extension-specs.ts) are imported
 * first, so the paths they register are included.
 */
import { resolve } from "node:path";

import { openApiDocument } from "@fa/shared/openapi";

import { openapiExtensionSpecs } from "../src/extension-specs.ts";

const SPEC_OUT = resolve(import.meta.dir, "..", "..", "web", "openapi.json");

for (const spec of openapiExtensionSpecs()) await import(spec);

await Bun.write(SPEC_OUT, JSON.stringify(openApiDocument(), null, 2) + "\n");
console.log(`✓ wrote ${SPEC_OUT}`);
