import fsSync from "node:fs";
import path from "node:path";
import { getAppConfigDir } from "../config/paths";

// Persisted load status for the external pricing data sources (LiteLLM model
// prices, Frankfurter FX rates). Written to disk so it survives across the
// main process AND the analytics worker thread (LiteLLM is fetched in the worker,
// FX in main) and can be read back for the System tab.

export type DataSourceName = "litellm" | "fx";
export type DataSourceKind = "live" | "fallback" | "offline";

export interface DataSourceStatus {
  ok: boolean;
  source: DataSourceKind;
  at: string;        // ISO timestamp of the last load attempt
  detail?: string;   // e.g. "1234 models" or the latest FX rate day
  error?: string;    // failure reason when ok === false
}

export interface DataSourceFileInfo {
  path: string;
  exists: boolean;
  totalBytes: number;
  lastModifiedAt: string | null;
}

export interface DataSourceInfo {
  status: DataSourceStatus | null;
  statusFile: DataSourceFileInfo;
  dataFile?: DataSourceFileInfo;
}

export function getDataSourceStatusPath(name: DataSourceName): string {
  return path.join(getAppConfigDir(), "cache", `${name}-status.json`);
}

/**
 * Persist the latest load status of a data source. Returns true when the
 * ok/source state changed versus the previously recorded value, so callers can
 * throttle logging to state transitions instead of every refresh. Never throws;
 * a no-op under vitest so tests don't write into the real home directory.
 */
export function recordDataSourceStatus(name: DataSourceName, status: DataSourceStatus): boolean {
  if (process.env.VITEST) return false;
  try {
    const prev = readDataSourceStatus(name);
    const changed = !prev || prev.ok !== status.ok || prev.source !== status.source;
    const p = getDataSourceStatusPath(name);
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.writeFileSync(p, JSON.stringify(status), "utf8");
    return changed;
  } catch {
    return false;
  }
}

export function readDataSourceStatus(name: DataSourceName): DataSourceStatus | null {
  try {
    return JSON.parse(fsSync.readFileSync(getDataSourceStatusPath(name), "utf8")) as DataSourceStatus;
  } catch {
    return null;
  }
}

export function readDataSourceInfo(name: DataSourceName, dataPath?: string): DataSourceInfo {
  const statusFile = fileInfo(getDataSourceStatusPath(name));
  const dataFile = dataPath ? fileInfo(dataPath) : undefined;
  const status = readDataSourceStatus(name) ?? inferStatusFromDataFile(name, dataFile);
  return { status, statusFile, ...(dataFile ? { dataFile } : {}) };
}

function fileInfo(filePath: string): DataSourceFileInfo {
  try {
    const stat = fsSync.statSync(filePath);
    if (!stat.isFile()) return missingFile(filePath);
    return {
      path: path.resolve(filePath),
      exists: true,
      totalBytes: stat.size,
      lastModifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return missingFile(filePath);
  }
}

function missingFile(filePath: string): DataSourceFileInfo {
  return {
    path: path.resolve(filePath),
    exists: false,
    totalBytes: 0,
    lastModifiedAt: null,
  };
}

function inferStatusFromDataFile(name: DataSourceName, file: DataSourceFileInfo | undefined): DataSourceStatus | null {
  if (!file?.exists || !file.lastModifiedAt) return null;
  return {
    ok: true,
    source: "live",
    at: file.lastModifiedAt,
    detail: name === "fx" ? inferFxDetail(file.path) : undefined,
  };
}

function inferFxDetail(filePath: string): string | undefined {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as { EURUSD?: Record<string, number> };
    const latest = Object.keys(parsed.EURUSD ?? {}).sort().pop();
    return latest ? `latest rate ${latest}` : "no cached rates";
  } catch {
    return undefined;
  }
}
