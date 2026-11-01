/**
 * Console transport.
 *
 * Two output modes:
 *   - "pretty": colorised one-line-per-record, intended for local dev.
 *   - "json":   one JSON object per line, intended for log shippers like
 *               Grafana Loki / Vector / Datadog Agent which parse stdout.
 *
 * Stays dependency-free. If you outgrow it, swap it for pino + pino-pretty.
 */
import type { LogLevel, LogRecord, SerializedError, Transport } from "../types.ts";

export type ConsoleFormat = "pretty" | "json";

const COLOR: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  silent: "",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export class ConsoleTransport implements Transport {
  readonly name = "console";
  readonly minLevel: LogLevel;
  readonly format: ConsoleFormat;
  readonly color: boolean;

  constructor(opts: { minLevel: LogLevel; format: ConsoleFormat; color: boolean }) {
    this.minLevel = opts.minLevel;
    this.format = opts.format;
    this.color = opts.color;
  }

  log(record: LogRecord): void {
    const line = this.format === "json" ? this.toJson(record) : this.toPretty(record);
    // warn/error → stderr so they can be tee'd separately if desired.
    if (record.level === "error" || record.level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  private toJson(r: LogRecord): string {
    // Flatten ctx onto the top level so log shippers can index fields without
    // a nested-object query syntax. `msg`/`level`/`time` win over ctx on conflict.
    const out: Record<string, unknown> = { ...r.ctx, time: r.time, level: r.level, msg: r.msg };
    if (r.err) out.err = r.err;
    return JSON.stringify(out);
  }

  private toPretty(r: LogRecord): string {
    const c = this.color ? COLOR[r.level] : "";
    const reset = this.color ? RESET : "";
    const dim = this.color ? DIM : "";
    const t = r.time.slice(11, 23); // HH:mm:ss.SSS
    const level = r.level.toUpperCase().padEnd(5);
    const ctxStr = formatCtx(r.ctx);
    const errStr = r.err ? ` ${c}${r.err.name}: ${r.err.message}${reset}` : "";
    const causeStr = formatCauseChain(r.err?.cause, c, reset);
    const stackStr =
      r.err?.stack && this.minLevel === "debug" ? `\n${dim}${r.err.stack}${reset}` : "";
    return `${dim}${t}${reset} ${c}${level}${reset} ${r.msg}${ctxStr}${errStr}${causeStr}${stackStr}`;
  }
}

function formatCauseChain(
  cause: SerializedError | undefined,
  color: string,
  reset: string,
): string {
  let out = "";
  let cur = cause;
  while (cur) {
    out += `\n  ${color}caused by ${cur.name}: ${cur.message}${reset}`;
    if (cur.extra && Object.keys(cur.extra).length) {
      out += ` ${formatCtx(cur.extra)}`.replace(/^ \s*/, " ");
    }
    cur = cur.cause;
  }
  return out;
}

function formatCtx(ctx: Record<string, unknown>): string {
  const keys = Object.keys(ctx);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const k of keys) {
    const v = ctx[k];
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
