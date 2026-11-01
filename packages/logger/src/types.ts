export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogContext = Record<string, unknown>;

export type LogRecord = {
  time: string; // ISO timestamp
  level: LogLevel;
  msg: string;
  ctx: LogContext; // bound context (merged) + per-call extras
  err?: SerializedError; // present when an Error was passed in
};

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  // Anything else worth surfacing (e.g. response status from API errors).
  extra?: Record<string, unknown>;
  // Wrapper libraries (drizzle, fetch) hide the real diagnostic on `cause`.
  cause?: SerializedError;
};

export interface Transport {
  readonly name: string;
  readonly minLevel: LogLevel;
  log(record: LogRecord): void | Promise<void>;
}
