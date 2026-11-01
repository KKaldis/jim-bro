/**
 * Env-driven configuration for the root logger.
 *
 * Flags:
 *   LOG_LEVEL       debug|info|warn|error|silent   (default: info, debug in dev)
 *   LOG_FORMAT      pretty|json                    (default: pretty in dev, json in prod)
 *   LOG_TRANSPORTS  comma-separated names          (default: console)
 *                   Currently supported: "console"
 *                   Future:              "sentry", "loki", "otel"
 *   LOG_COLOR       1|0                            (default: 1 when stdout is a TTY)
 *   LOG_HTTP        1|0                            (default: 1) — toggles request-line logs
 *
 * Future transports plug in here (see TODOs below). The rest of the app
 * never imports a specific transport — it imports the root Logger.
 */
import { Logger } from "./logger.ts";
import { ConsoleTransport, type ConsoleFormat } from "./transports/console.ts";
import { LOG_LEVELS, type LogLevel } from "./types.ts";

export type LoggerConfig = {
  level: LogLevel;
  format: ConsoleFormat;
  transports: string[];
  color: boolean;
  httpEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoggerConfig {
  const isProd = env.NODE_ENV === "production";
  const level = parseLevel(env.LOG_LEVEL) ?? (isProd ? "info" : "debug");
  const format: ConsoleFormat =
    env.LOG_FORMAT === "json" || env.LOG_FORMAT === "pretty"
      ? env.LOG_FORMAT
      : isProd
        ? "json"
        : "pretty";
  const transports = (env.LOG_TRANSPORTS ?? "console")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const color = parseBool(env.LOG_COLOR, defaultColor(format));
  const httpEnabled = parseBool(env.LOG_HTTP, true);
  return { level, format, transports, color, httpEnabled };
}

export function createRootLogger(env: NodeJS.ProcessEnv = process.env): Logger {
  const cfg = loadConfig(env);
  const logger = new Logger({ level: cfg.level, transports: [] });

  for (const name of cfg.transports) {
    switch (name) {
      case "console":
        logger.addTransport(
          new ConsoleTransport({
            minLevel: cfg.level,
            format: cfg.format,
            color: cfg.color,
          }),
        );
        break;
      // TODO(sentry):  case "sentry": logger.addTransport(new SentryTransport({...})); break;
      // TODO(loki):    case "loki":   logger.addTransport(new LokiTransport({...}));   break;
      // TODO(otel):    case "otel":   logger.addTransport(new OtelTransport({...}));   break;
      default:
        console.warn(`[logger] unknown transport "${name}" — ignored`);
    }
  }

  return logger;
}

function parseLevel(raw: string | undefined): LogLevel | null {
  if (!raw) return null;
  const v = raw.toLowerCase() as LogLevel;
  return (LOG_LEVELS as readonly string[]).includes(v) ? v : null;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function defaultColor(format: ConsoleFormat): boolean {
  if (format === "json") return false;
  // Best-effort TTY check; bun/node both populate this.
  return Boolean((process.stdout as { isTTY?: boolean }).isTTY);
}
