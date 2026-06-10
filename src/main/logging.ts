import fs from "node:fs/promises";
import fsSync from "node:fs";
import { getAppConfigDir, getLogPath } from "../config/paths";
import { redactSecrets } from "../shared/redaction";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** ISO 8601 timestamp in local wall-clock time (e.g. 2026-06-10T08:41:13.778+02:00). */
export function localISOString(date: Date): string {
  const off = -date.getTimezoneOffset(); // minutes ahead of UTC (positive = east)
  const sign = off >= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, "0");
  const mm = String(absOff % 60).padStart(2, "0");
  const local = new Date(date.getTime() + off * 60_000);
  return local.toISOString().replace("Z", `${sign}${hh}:${mm}`);
}

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
  const line = `${localISOString(new Date())} ${level} ${redactSecrets(message)}\n`;
  try {
    fsSync.appendFileSync(getLogPath(), line, "utf8");
  } catch {
    // Logging must never crash the tray app.
  }
}
