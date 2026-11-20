import { createRequire } from "node:module";

import pino from "pino";

// The levels pino recognises, plus "silent" to turn logging off entirely.
// Anything else makes pino throw while this module is being imported, with a
// message ("default level:verbose must be included in custom levels") that
// names neither LOG_LEVEL nor the values it accepts, so the variable is
// validated here instead of being passed straight through.
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

// Resolves LOG_LEVEL to a level pino accepts. Spellings that differ only in
// case ("INFO", "Warn") are accepted because pino accepts them too, and are
// normalized to lower case; an unset or blank value falls back to the default.
export function resolveLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LOG_LEVEL;

  const normalized = raw.trim().toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Invalid LOG_LEVEL "${raw}": expected one of ${LOG_LEVELS.join(", ")} ` +
        `(case-insensitive), or leave it unset for "${DEFAULT_LOG_LEVEL}".`,
    );
  }
  return normalized as LogLevel;
}

// Production logs are newline-delimited JSON, which is what log shippers want
// but hard to read while developing. Setting LOG_PRETTY opts a local process
// into human-readable output; nothing else about the logger changes, so what a
// deployment emits is unaffected unless the variable is set there too.
const PRETTY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export function isPrettyEnabled(raw: string | undefined): boolean {
  return raw !== undefined && PRETTY_ENV_VALUES.has(raw.trim().toLowerCase());
}

const require = createRequire(import.meta.url);

// pino-pretty is a dev dependency: it is absent from a production install
// (`npm ci --omit=dev`, the Docker image), so its presence is probed rather
// than assumed. Importing it unconditionally would make the image fail to
// start.
export function isPrettyAvailable(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export const PRETTY_UNAVAILABLE_MESSAGE =
  'LOG_PRETTY is set but the "pino-pretty" package is not installed, so logs stay JSON. ' +
  "It is a development-only dependency: install it with `npm install` (without --omit=dev) " +
  "in the environment that needs readable logs.";

export interface LoggerSetup {
  options: pino.LoggerOptions;
  /** Set when pretty output was asked for but cannot be provided. */
  warning?: string;
}

// Resolves the pino options for this process. Split out from the logger itself
// so the LOG_PRETTY decision can be unit tested without spawning a transport
// worker or depending on whether pino-pretty happens to be installed.
export function buildLoggerSetup(
  env: NodeJS.ProcessEnv = process.env,
  prettyAvailable: () => boolean = isPrettyAvailable,
): LoggerSetup {
  const options: pino.LoggerOptions = { level: resolveLogLevel(env.LOG_LEVEL) };

  if (!isPrettyEnabled(env.LOG_PRETTY)) return { options };
  if (!prettyAvailable()) return { options, warning: PRETTY_UNAVAILABLE_MESSAGE };

  return {
    options: {
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    },
  };
}

const setup = buildLoggerSetup();

// Shared logger for the entire process. Both Fastify (HTTP server) and the
// indexer import this single instance so all structured output lands in one
// stream. Individual components attach context via `logger.child({ module: "…" })`.
export const logger = pino(setup.options);

// Reported through the logger itself so the message lands in the same stream
// the operator is already watching, and in JSON when that is what is being
// collected.
if (setup.warning !== undefined) {
  logger.warn(setup.warning);
}

export type Logger = typeof logger;
