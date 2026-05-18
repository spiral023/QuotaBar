import fs from "node:fs/promises";
import fsSync from "node:fs";
import { getAppConfigDir, getLogPath } from "../config/paths";
import { redactSecrets } from "../shared/redaction";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

let debugEnabled = false;

export async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(getAppConfigDir(), { recursive: true });
}

export function initializeLogging(debug: boolean): void {
  debugEnabled = debug;
  fsSync.mkdirSync(getAppConfigDir(), { recursive: true });
}

export const log = {
  debug(message: string) {
    if (debugEnabled) writeLog("DEBUG", message);
  },
  info(message: string) {
    writeLog("INFO", message);
  },
  warn(message: string) {
    writeLog("WARN", message);
  },
  error(message: string) {
    writeLog("ERROR", message);
  }
};

function writeLog(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} ${level} ${redactSecrets(message)}\n`;
  try {
    fsSync.appendFileSync(getLogPath(), line, "utf8");
  } catch {
    // Logging must never crash the tray app.
  }
}
