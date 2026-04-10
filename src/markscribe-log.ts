/**
 * MarkScribe logger — structured logging via pino.
 *
 * IMPORTANT: This is an MCP server using stdio transport.
 * stdout is reserved for JSON-RPC messages. All log output
 * goes to stderr (dev/human-readable) and optionally to a
 * log file (JSON, machine-parseable).
 *
 * Usage:
 *   import { markscribeLog } from "./markscribe-log.js";
 *
 *   markscribeLog.info({ vaultPath, noteCount }, "vault indexed");
 *   markscribeLog.debug({ schema, path }, "schema resolved");
 *   markscribeLog.error({ err, path }, "atomic write failed");
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

const PROJECT_NAME = "markscribe";

// Set LOG_TO_FILE=1 to enable file logging (off by default for MCP servers).
const LOG_TO_FILE = process.env.LOG_TO_FILE === "1";

// Log file location — defaults to logs/ in the working directory.
const LOG_DIR = process.env.LOG_DIR ?? "logs";
if (LOG_TO_FILE) {
  mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE = join(LOG_DIR, `${PROJECT_NAME}.log`);

const isDev = process.env.NODE_ENV === "development";

// stderr target — human-readable in dev, JSON in production.
// fd 2 = stderr, keeping stdout clean for MCP stdio transport.
const stderrTarget = isDev
  ? { target: "pino-pretty", options: { colorize: true, destination: 2 }, level: "debug" as const }
  : { target: "pino/file", options: { destination: 2 }, level: "info" as const };

// File target — always JSON, the durable record
const fileTarget = {
  target: "pino/file",
  options: { destination: LOG_FILE, mkdir: true },
  level: "debug" as const,
};

export const markscribeLog = pino({
  name: PROJECT_NAME,
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  transport: {
    targets: LOG_TO_FILE ? [stderrTarget, fileTarget] : [stderrTarget],
  },
});

/**
 * Create a child logger with additional context.
 * Useful for scoping logs to a specific tool call or operation.
 *
 * Example:
 *   const toolLog = createChildLog({ tool: "lint_note", path: notePath });
 *   toolLog.info("validation started");
 */
export function createChildLog(bindings: Record<string, unknown>) {
  return markscribeLog.child(bindings);
}
