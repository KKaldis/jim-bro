/**
 * HTTP helpers — small utilities so server code stays terse.
 *
 * `wrapFetch` decorates a Bun.serve fetch handler with:
 *   - a per-request id (added to the response under `x-request-id`)
 *   - a child logger bound to { request_id, method, path }
 *   - a single info-level "request" log line on completion with status + ms
 *   - a single error-level log if the handler throws
 *
 * The wrapped handler receives `(req, log)` so route code can call log.info /
 * log.error with the request-scoped context already bound.
 */
import type { Logger } from "./logger.ts";

export type RequestHandler = (req: Request, log: Logger) => Response | Promise<Response>;

export function wrapFetch(opts: {
  logger: Logger;
  enabled: boolean;
  handler: RequestHandler;
}): (req: Request) => Promise<Response> {
  const { logger, enabled, handler } = opts;
  return async (req: Request) => {
    const requestId = newRequestId();
    const url = new URL(req.url);
    const start = Date.now();
    const child = logger.child({
      request_id: requestId,
      method: req.method,
      path: url.pathname,
    });
    try {
      const res = await handler(req, child);
      // Attach the request id so clients can quote it in bug reports.
      if (!res.headers.has("x-request-id")) {
        res.headers.set("x-request-id", requestId);
      }
      if (enabled) {
        const ms = Date.now() - start;
        const level = res.status >= 500 ? "error" : res.status >= 400 ? "warn" : "info";
        child[level]("request", { status: res.status, ms });
      }
      return res;
    } catch (err) {
      const ms = Date.now() - start;
      child.error("request failed", err instanceof Error ? err : new Error(String(err)), { ms });
      return new Response("internal error", {
        status: 500,
        headers: { "x-request-id": requestId },
      });
    }
  };
}

function newRequestId(): string {
  // 16 hex chars = 64 bits of entropy. Enough to correlate within a process.
  // Avoid pulling in `crypto.randomUUID()` differences across runtimes.
  const a = Math.floor(Math.random() * 0x100000000);
  const b = Math.floor(Math.random() * 0x100000000);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
