/**
 * @fa/logger — minimal pluggable logger.
 *
 * Usage:
 *   import { logger } from "@fa/logger";
 *   logger.info("server started", { port: 3000 });
 *
 *   const log = logger.child({ user_id: "u_123" });
 *   log.error("something blew up", err);
 *
 * The root logger is constructed once from env on first import. Tests that
 * need a custom config can call `createRootLogger(customEnv)` directly.
 */
export { Logger } from "./logger.ts";
export { ConsoleTransport } from "./transports/console.ts";
export { createRootLogger, loadConfig } from "./config.ts";
export type { LoggerConfig } from "./config.ts";
export { wrapFetch } from "./http.ts";
export type { RequestHandler } from "./http.ts";
export type { LogContext, LogLevel, LogRecord, SerializedError, Transport } from "./types.ts";

import { createRootLogger } from "./config.ts";

// Process-wide root logger. Importers get the same instance.
export const logger = createRootLogger();
