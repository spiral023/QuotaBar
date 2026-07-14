import type { Settings } from "../config/settings";
import { loadSettings } from "../config/settings";
import { isFirstRun } from "../config/firstRun";
import { getAppConfigDir } from "../config/paths";
import {
  applyPendingImport,
  PortableImportApplyError,
  type AppliedImportResult,
} from "../portable/archiveService";
import { log } from "./logging";

interface StartupLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface InitialStartupDependencies {
  applyPendingImport: () => Promise<AppliedImportResult>;
  isFirstRun: () => Promise<boolean>;
  loadSettings: (overrides: Partial<Settings>) => Promise<Settings>;
  log: StartupLogger;
}

const defaultDependencies: InitialStartupDependencies = {
  applyPendingImport: () => applyPendingImport(getAppConfigDir()),
  isFirstRun,
  loadSettings,
  log,
};

export async function loadInitialStartupState(
  settingsOverrides: Partial<Settings>,
  dependencies: InitialStartupDependencies = defaultDependencies,
): Promise<{ firstRun: boolean; settings: Settings }> {
  let pendingImport: AppliedImportResult;
  try {
    pendingImport = await dependencies.applyPendingImport();
  } catch (error) {
    const rollback = error instanceof PortableImportApplyError ? error.rollbackOutcome : "unknown";
    dependencies.log.error(
      `Portable pending import apply failed rollback=${rollback} error=Portable data apply failed`,
    );
    // The archive boundary intentionally drops raw causes because they may contain private paths or secrets.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Portable pending import apply failed");
  }
  if (pendingImport.applied) {
    dependencies.log.info(
      `Portable pending import applied files=${pendingImport.fileCount} bytes=${pendingImport.totalBytes}`,
    );
  }
  const firstRun = await dependencies.isFirstRun();
  const settings = await dependencies.loadSettings(settingsOverrides);
  return { firstRun, settings };
}
