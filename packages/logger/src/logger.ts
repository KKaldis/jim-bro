/**
 * Pluggable structured logger.
 *
 * Pattern:
 *   - One root Logger holds an array of Transports.
 *   - `child(ctx)` returns a Logger that merges `ctx` into every record.
 *   - Each level method (`debug/info/warn/error`) builds a LogRecord and
 *     dispatches to every transport whose minLevel allows it.
 *
 * Adding a new sink (Sentry, Grafana Loki, OpenTelemetry, ...):
 *   - Implement the `Transport` interface (see transports/console.ts).
 *   - Register it via `addTransport()` on the root logger, or wire it into
 *     `createRootLogger()` in config.ts behind an env flag.
 *   - Nothing else changes — call sites stay identical.
 */
import {
  LEVEL_RANK,
  type LogContext,
  type LogLevel,
  type LogRecord,
  type SerializedError,
  type Transport,
} from "./types.ts";

export class Logger {
  private readonly transports: Transport[];
  private readonly level: LogLevel;
  private readonly ctx: LogContext;

  constructor(opts: { level: LogLevel; transports: Transport[]; ctx?: LogContext }) {
    this.level = opts.level;
    this.transports = opts.transports;
    this.ctx = opts.ctx ?? {};
  }

  child(ctx: LogContext): Logger {
    return new Logger({
      level: this.level,
      transports: this.transports,
      ctx: { ...this.ctx, ...ctx },
    });
  }

  addTransport(t: Transport): void {
    this.transports.push(t);
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
  }

  debug(msg: string, ctx?: LogContext): void {
    this.emit("debug", msg, ctx);
  }
  info(msg: string, ctx?: LogContext): void {
    this.emit("info", msg, ctx);
  }
  warn(msg: string, ctx?: LogContext): void {
    this.emit("warn", msg, ctx);
  }
  error(msg: string, errOrCtx?: unknown, ctx?: LogContext): void {
    // Two shapes:
    //   logger.error("oops", err)
    //   logger.error("oops", err, { request_id })
    //   logger.error("oops", { request_id })
    if (errOrCtx instanceof Error) {
      this.emit("error", msg, ctx, errOrCtx);
    } else if (errOrCtx && typeof errOrCtx === "object") {
      this.emit("error", msg, errOrCtx as LogContext);
    } else {
      this.emit("error", msg);
    }
  }

  private emit(level: LogLevel, msg: string, extra?: LogContext, err?: Error): void {
    if (!this.isEnabled(level)) return;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      msg,
      ctx: extra ? { ...this.ctx, ...extra } : this.ctx,
      ...(err ? { err: serializeError(err) } : {}),
    };
    for (const t of this.transports) {
      if (LEVEL_RANK[level] < LEVEL_RANK[t.minLevel]) continue;
      // Transports must not throw into call sites. Swallow & report once.
      try {
        const out = t.log(record);
        if (out && typeof (out as Promise<unknown>).then === "function") {
          (out as Promise<unknown>).catch((e) => {
            console.error(`[logger] transport ${t.name} async log failed:`, e);
          });
        }
      } catch (e) {
        console.error(`[logger] transport ${t.name} log failed:`, e);
      }
    }
  }
}

function serializeError(err: Error, depth = 0): SerializedError {
  const out: SerializedError = {
    name: err.name,
    message: err.message,
  };
  if (err.stack) out.stack = err.stack;
  // Common extras from Anthropic SDK / fetch / pg errors.
  const anyErr = err as unknown as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  if (typeof anyErr.status === "number") extra.status = anyErr.status;
  if (typeof anyErr.code === "string") extra.code = anyErr.code;
  if (Object.keys(extra).length) out.extra = extra;
  // Walk `cause` so wrappers like DrizzleQueryError don't hide the real
  // diagnostic. Cap depth to avoid pathological cycles.
  if (depth < 3 && err.cause instanceof Error) {
    out.cause = serializeError(err.cause, depth + 1);
  }
  return out;
}
