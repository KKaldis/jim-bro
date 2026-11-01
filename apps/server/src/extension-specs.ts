/**
 * Which server extensions to load (see ./extensions.ts). Kept dependency-free
 * so build scripts (scripts/gen-api-types.ts) can read it without pulling in
 * the agent or the database.
 *
 * Server modules, first match wins:
 *   1. SERVER_EXTENSIONS env — comma-separated module specifiers.
 *   2. `jimBro.serverExtensions` in the repo-root package.json — the way a
 *      build that ships an extension pins it, so a missing env var can't
 *      silently start the server without it.
 *
 * OpenAPI modules: `jimBro.openapiExtensions` in the same package.json. Each is
 * imported by `npm run gen:api` (and should also be imported by its server
 * module) to register the extension's schemas and paths on the shared
 * registry. Keep them free of IO: codegen runs with no database or secrets.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_PACKAGE_JSON = resolve(import.meta.dir, "..", "..", "..", "package.json");

type JimBroConfig = { serverExtensions?: unknown; openapiExtensions?: unknown };

function rootConfig(): JimBroConfig {
  try {
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8")) as { jimBro?: JimBroConfig };
    return pkg.jimBro ?? {};
  } catch {
    return {};
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}

/** Server extension modules to load at startup. */
export function extensionSpecs(): string[] {
  const env = process.env.SERVER_EXTENSIONS;
  if (env != null && env.trim() !== "") {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return stringList(rootConfig().serverExtensions);
}

/** Extension modules that register OpenAPI schemas/paths (for codegen). */
export function openapiExtensionSpecs(): string[] {
  return stringList(rootConfig().openapiExtensions);
}
