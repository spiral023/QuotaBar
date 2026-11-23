import { app, dialog, shell } from "electron";
import fs from "node:fs/promises";
import path from "path";
import {
  getAppConfigDir,
  getBonusStatePath,
  getFxCachePath,
  getHomeDir, getLogPath, getNotificationLogPath,
  getNotificationStatePath,
  getUsageSnapshotCachePath,
  getWindowHistoryPath,
  getWindowRatioPath
} from "../config/paths";
import { exportPortableData, stagePortableImport } from "../portable/archiveService";
import { errnoCode } from "../shared/errors";
import { getRuntimeAgentRoots, refreshRuntimeWslAgentRoots } from "./agentRootDiscovery";
import { detectAppVariant } from "./appIdentity";
import { flushLogging, log } from "./logging";
import { formatPathListForLog } from "./pathDiagnostics";
import { rendererIpc } from "./rendererSecurity";
import {
  collectSystemData,
  findOpenableSystemPath,
  formatWslDiscoveryDiagnostics,
} from "./systemData";

let archiveOperation: "export" | "import" | null = null;

let portableImportRestart: "pending" | "exiting" | null = null;

const ARCHIVE_BUSY_RESULT = Object.freeze({
  ok: false,
  error: "archive_operation_in_progress",
  message: "Another portable archive operation is already in progress.",
});

function runtimeRootContext(): { wslClaudeRoots: string[]; wslCodexHomes: string[] } {
  const roots = getRuntimeAgentRoots();
  return {
    wslClaudeRoots: roots.claudeRoots,
    wslCodexHomes: roots.codexHomes,
  };
}

export function registerSystemIpc(getQuickStatsLoadDurationMs: () => number | null): void {
  rendererIpc.handle("system:get", async () => {
    return await collectSystemData({
      quickStatsLoadDurationMs: getQuickStatsLoadDurationMs(),
      appVariant: detectAppVariant(),
      ...runtimeRootContext(),
    });
  });

  rendererIpc.handle("system:export-portable-data", async () => {
    if (archiveOperation !== null || portableImportRestart !== null) return ARCHIVE_BUSY_RESULT;
    archiveOperation = "export";
    try {
      const selected = await dialog.showSaveDialog({
        title: "Export portable data",
        defaultPath: path.join(getHomeDir(), "QuotaBar-portable-data.zip"),
        filters: [{ name: "ZIP archives", extensions: ["zip"] }],
        properties: ["showOverwriteConfirmation"],
      });
      if (selected.canceled || !selected.filePath) return { ok: false, cancelled: true };
      const result = await exportPortableData(getAppConfigDir(), selected.filePath);
      log.info(`Portable archive action=export result=success files=${result.fileCount} bytes=${result.totalBytes}`);
      return { ok: true, ...result };
    } catch (error) {
      const message = "Portable data export failed.";
      log.warn(`Portable archive action=export error=${message}${codeField(error)}`);
      return { ok: false, error: "portable_export_failed", message };
    } finally {
      archiveOperation = null;
    }
  });

  rendererIpc.handle("system:import-portable-data", async () => {
    if (archiveOperation !== null || portableImportRestart !== null) return ARCHIVE_BUSY_RESULT;
    archiveOperation = "import";
    try {
      const selected = await dialog.showOpenDialog({
        title: "Import portable data",
        filters: [{ name: "ZIP archives", extensions: ["zip"] }],
        properties: ["openFile"],
      });
      const source = selected.filePaths[0];
      if (selected.canceled || !source) return { ok: false, cancelled: true };
      const result = await stagePortableImport(source, getAppConfigDir(), getHomeDir());
      log.info(`Portable archive action=import result=success files=${result.fileCount} bytes=${result.totalBytes}`);
      portableImportRestart = "pending";
      return {
        ok: true,
        backupPath: result.backupPath,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        restartScheduled: true,
      };
    } catch (error) {
      const message = "Portable data import failed.";
      log.warn(`Portable archive action=import error=${message}${codeField(error)}`);
      return { ok: false, error: "portable_import_failed", message };
    } finally {
      archiveOperation = null;
    }
  });

  rendererIpc.handle("system:confirm-portable-import-restart", async () => {
    if (portableImportRestart !== "pending") {
      return {
        ok: false,
        error: "portable_import_restart_not_pending",
        message: "No portable import restart is pending.",
      };
    }
    portableImportRestart = "exiting";
    app.relaunch();
    await flushLogging();
    app.exit(0);
    return { ok: true };
  });

  rendererIpc.handle("system:codex-homes:suggest", async () => {
    log.info("Dashboard action: Detect WSL clicked for Codex homes");
    const { discovery, roots } = await refreshRuntimeWslAgentRoots();
    for (const line of formatWslDiscoveryDiagnostics(discovery)) log.info(line);
    log.info(`WSL discovery: runtime roots claudeRoots=${formatPathListForLog(roots.claudeRoots)} codexHomes=${formatPathListForLog(roots.codexHomes)}`);
    return discovery.codexHomes;
  });

  rendererIpc.handle("system:claude-roots:suggest", async () => {
    log.info("Dashboard action: Detect WSL clicked for Claude roots");
    const { discovery, roots } = await refreshRuntimeWslAgentRoots();
    for (const line of formatWslDiscoveryDiagnostics(discovery)) log.info(line);
    log.info(`WSL discovery: runtime roots claudeRoots=${formatPathListForLog(roots.claudeRoots)} codexHomes=${formatPathListForLog(roots.codexHomes)}`);
    return discovery.claudeRoots;
  });

  rendererIpc.handle("shell:open-url", async (_, url: unknown) => {
    const ALLOWED = new Set([
      "https://github.com/spiral023/QuotaBar",
      "https://github.com/spiral023/QuotaBar/releases/latest",
      "https://artificialanalysis.ai/methodology/intelligence-benchmarking",
      "https://artificialanalysis.ai/methodology/coding-agents-benchmarking",
    ]);
    if (typeof url !== "string" || !ALLOWED.has(url)) return { ok: false, error: "not_allowed" };
    await shell.openExternal(url);
    return { ok: true };
  });

  rendererIpc.handle("system:open-path", async (_, requestedPath: unknown) => {
    if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
      return { ok: false, error: "invalid_path" };
    }
    const report = await collectSystemData(runtimeRootContext());
    const openPath = findOpenableSystemPath(report, requestedPath);
    if (!openPath) return { ok: false, error: "path_not_allowed" };
    const error = await shell.openPath(openPath);
    return error ? { ok: false, error } : { ok: true };
  });

  rendererIpc.handle("system:delete-app-data", async (_, groups: unknown) => {
    if (!Array.isArray(groups)) return { ok: false, error: "invalid_groups" };
    const allowed = new Set(["cache", "logs", "state", "debug"]);
    const validGroups = groups.filter((g): g is string => typeof g === "string" && allowed.has(g));
    if (validGroups.length === 0) return { ok: true, deleted: [], errors: [] };

    const appDir = getAppConfigDir();
    const targets: Array<{ path: string; recursive: boolean }> = [];
    for (const group of validGroups) {
      switch (group) {
        case "cache":
          targets.push({ path: getUsageSnapshotCachePath(), recursive: false });
          targets.push({ path: getFxCachePath(), recursive: false });
          break;
        case "logs":
          targets.push({ path: getLogPath(), recursive: false });
          targets.push({ path: getNotificationLogPath(), recursive: false });
          break;
        case "state":
          targets.push({ path: getWindowHistoryPath(), recursive: false });
          targets.push({ path: getWindowRatioPath(), recursive: false });
          targets.push({ path: getBonusStatePath(), recursive: false });
          targets.push({ path: getNotificationStatePath(), recursive: false });
          break;
        case "debug":
          targets.push({ path: path.join(appDir, "debug"), recursive: true });
          break;
      }
    }

    const deleted: string[] = [];
    const errors: string[] = [];
    for (const target of targets) {
      try {
        await fs.rm(target.path, { recursive: target.recursive, force: true });
        deleted.push(target.path);
        log.info(`system:delete-app-data removed ${target.path}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
        log.warn(`system:delete-app-data failed for ${target.path}: ${msg}`);
      }
    }
    return { ok: errors.length === 0, deleted, errors };
  });
}

/** Log field with the errno code only; archive errors never carry paths. */
function codeField(error: unknown): string {
  const code = errnoCode(error);
  return code ? ` code=${code}` : "";
}
