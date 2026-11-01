import { describe, expect, test } from "bun:test";

import type { Logger } from "@fa/logger";
import { openApiDocument } from "@fa/shared/openapi";

import { dispatch, route } from "./router.ts";
import { apiRoutes } from "./routes/index.ts";

const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

async function hit(routes: Parameters<typeof dispatch>[0], method: string, path: string) {
  const req = new Request(`http://test${path}`, { method });
  return dispatch(routes, req, new URL(req.url), log);
}

describe("route()", () => {
  const echo = route(["GET", "PUT"], "/plans/:id(\\d+)/days/:day", ({ params }) =>
    Response.json(params),
  );

  test("matches methods and extracts params", async () => {
    const res = await hit([echo], "PUT", "/plans/12/days/monday");
    expect(await res?.json()).toEqual({ id: "12", day: "monday" });
  });

  test("falls through on a constraint, segment or method mismatch", async () => {
    expect(await hit([echo], "GET", "/plans/abc/days/monday")).toBeNull();
    expect(await hit([echo], "GET", "/plans/12/days/a/b")).toBeNull();
    expect(await hit([echo], "DELETE", "/plans/12/days/monday")).toBeNull();
  });

  test("escapes literal regex characters in the path", async () => {
    const r = route("GET", "/openapi.json", () => new Response("ok"));
    expect(await hit([r], "GET", "/openapi.json")).not.toBeNull();
    expect(await hit([r], "GET", "/openapiXjson")).toBeNull();
  });
});

describe("apiRoutes", () => {
  // Every documented operation must reach a handler (the OpenAPI doc is the
  // contract the web client is generated from).
  const SAMPLE: Record<string, string> = { date: "2026-01-05", code: "5000112637922" };
  const ops: Array<[string, string]> = [];
  const doc = openApiDocument() as { paths?: Record<string, object> };
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (!(item as Record<string, unknown>)[method]) continue;
      ops.push([method.toUpperCase(), path.replace(/\{(\w+)\}/g, (_, n) => SAMPLE[n] ?? "7")]);
    }
  }

  test("covers the documented API", () => {
    expect(ops.length).toBeGreaterThan(50);
  });

  test.each(ops)("%s %s is routed", (method, path) => {
    const matched = apiRoutes.some(
      (r) => (r.methods === "*" || r.methods.includes(method as never)) && r.pattern.test(path),
    );
    // Infra routes (auth, health, files, openapi) live in index.ts.
    const infra = /^\/(api\/auth|health|files|openapi\.json)/.test(path);
    expect(matched || infra).toBe(true);
  });
});
