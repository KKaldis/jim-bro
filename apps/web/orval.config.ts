import { execSync } from "node:child_process";

import { defineConfig } from "orval";

/**
 * Orval codegen: OpenAPI spec → typed React Query hooks (+ TS models) backed
 * by our configured Axios instance.
 *
 * Input is the spec emitted by `npm run gen:api` (apps/server writes
 * apps/web/openapi.json from the Zod registry — fully offline, no server). Run
 * via `npm run gen:hooks` (or `npm run gen:api` from the repo root, which does
 * both). Generated output under src/api/** is auto-generated — don't hand-edit.
 */
export default defineConfig({
  fitness: {
    input: "./openapi.json",
    output: {
      mode: "tags-split", // group generated hooks by OpenAPI tag
      target: "src/api/endpoints", // generated hooks
      schemas: "src/api/model", // generated TS models
      client: "react-query",
      httpClient: "axios",
      clean: true, // wipe stale generated files on each run
      // Format generated output with Prettier (honours .prettierrc.json, so
      // double quotes / trailing commas etc. land natively — no manual pass).
      prettier: true,
      override: {
        mutator: { path: "src/api/axios.ts", name: "customFetch" },
        query: { useQuery: true, useInfinite: false },
        // Generate enums as plain string-literal unions (e.g. 'user' | 'assistant')
        // instead of the default type+`as const` object pair. The const-object
        // form forces a `// eslint-disable-next-line @typescript-eslint/no-redeclare`
        // on every enum (type and value sharing a name); nothing in the codebase
        // uses those runtime objects, so the union form is equivalent and cleaner.
        enumGenerationType: "union",
      },
    },
    hooks: {
      // After codegen, type-check the app. (Formatting is handled by Orval's
      // own Prettier pass above; the generated src/api is intentionally excluded
      // from ESLint, so we don't lint it here — tsc just verifies types.)
      // Use the function form (not a string command) so the generated file paths
      // orval would otherwise append don't get passed to `tsc` — appending files
      // makes tsc ignore tsconfig and breaks the project-wide check.
      afterAllFilesWrite: () => {
        execSync("tsc --noEmit", { stdio: "inherit" });
      },
    },
  },
});
