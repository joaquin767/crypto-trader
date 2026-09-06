// Simple logger that writes to a session file.
// Each session creates a new file: logs/session-YYYY-MM-DD-HHMMSS.log

import { writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = "logs";

// Create logs directory if it doesn't exist
if (!existsSync(LOG_DIR)) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Fallback to current directory
  }
}

const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logFile = join(LOG_DIR, `session-${timestamp}.log`);

try {
  writeFileSync(logFile, `=== Session started at ${now.toISOString()} ===\n`);
} catch {
  // Cannot write log file — continue without it
}

function formatMsg(level: string, ...args: unknown[]): string {
  const time = new Date().toISOString();
  const msg = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  return `[${time}] [${level}] ${msg}`;
}

export const logger = {
  info: (...args: unknown[]) => {
    const line = formatMsg("INFO", ...args);
    console.log(line);
    try { appendFileSync(logFile, line + "\n"); } catch {}
  },

  warn: (...args: unknown[]) => {
    const line = formatMsg("WARN", ...args);
    console.warn(line);
    try { appendFileSync(logFile, line + "\n"); } catch {}
  },

  error: (...args: unknown[]) => {
    const line = formatMsg("ERROR", ...args);
    console.error(line);
    try { appendFileSync(logFile, line + "\n"); } catch {}
  },

  trade: (...args: unknown[]) => {
    const line = formatMsg("TRADE", ...args);
    console.log(line);
    try { appendFileSync(logFile, line + "\n"); } catch {}
  },
};