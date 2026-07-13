import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface PathContext {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  claudeRoots?: string[];
  codexHomes?: string[];
}

export function getHomeDir(): string {
  return os.homedir();
}

export function getAppConfigDir(): string {
  return path.join(getHomeDir(), ".quotabar-win");
}

export function getPortableUsageDir(): string {
  return path.join(getAppConfigDir(), "usage");
}

export function getPortableEventsDir(): string {
  return path.join(getPortableUsageDir(), "events");
}

export function getPortableQuotaDir(): string {
  return path.join(getAppConfigDir(), "quota");
}

export function getPortableMetadataPath(): string {
  return path.join(getPortableUsageDir(), "store-metadata.json");
}

export function getPortableIngestStatePath(): string {
  return path.join(getPortableUsageDir(), "ingest-state.json");
}

export function getPortableMigrationPath(): string {
  return path.join(getPortableUsageDir(), "migration-state.json");
}

export function getImportStagingDir(): string {
  return path.join(getAppConfigDir(), "import-staging");
}

export function getPendingImportPath(): string {
  return path.join(getAppConfigDir(), "pending-import.json");
}

export function getLogPath(): string {
  return path.join(getAppConfigDir(), "quotabar.log");
}

export function getNotificationLogPath(): string {
  return path.join(getAppConfigDir(), "notifications.log");
}

export function getNotificationStatePath(): string {
  return path.join(getAppConfigDir(), "notification-state.json");
}

export function getSettingsPath(): string {
  return path.join(getAppConfigDir(), "settings.json");
}

export function getUsageSnapshotCachePath(): string {
  return path.join(getAppConfigDir(), "cache", "usage-snapshots.json");
}

export function getFxCachePath(): string {
  return path.join(getAppConfigDir(), "cache", "fx-rates.json");
}

export function getLiteLLMModelPricesPath(): string {
  return path.join(getAppConfigDir(), "cache", "litellm-model-prices.json");
}

export function getHistoricalPricingPath(): string {
  return path.join(getAppConfigDir(), "cache", "historical-model-prices.json");
}

export function getWindowRatioPath(): string {
  return path.join(getAppConfigDir(), "window-ratio.json");
}

export function getBonusStatePath(): string {
  return path.join(getAppConfigDir(), "bonus-state.json");
}

export function getWindowHistoryPath(): string {
  return path.join(getAppConfigDir(), "window-history.json");
}

export function getInstalledMarkerPath(): string {
  return path.join(getAppConfigDir(), ".installed");
}

export function getCodexAuthPath(context: PathContext = {}): string {
  return path.join(firstCodexHome(context), "auth.json");
}

export function getClaudeCredentialsPath(context: PathContext = {}): string {
  return firstExistingPath(getClaudeCredentialPaths(context)) ?? path.join(firstClaudeRoot(context), ".credentials.json");
}

export function getClaudeProjectsDir(): string {
  return getClaudeProjectsDirs()[0] ?? path.join(getHomeDir(), ".claude", "projects");
}

export function getClaudeProjectsDirs(context: PathContext = {}): string[] {
  return uniqueExisting(getClaudeRoots(context).map((root) => path.join(root, "projects")));
}

export function getClaudeCredentialPaths(context: PathContext = {}): string[] {
  return uniquePaths(getClaudeCredentialRoots(context).map((root) => path.join(root, ".credentials.json")));
}

export function getClaudeRoots(context: PathContext = {}): string[] {
  return uniqueExisting(getClaudeRootCandidates(context));
}

export function getConfiguredClaudeRoots(context: PathContext = {}): string[] {
  return uniquePaths([
    ...parseOptionalPathList(context.env?.CLAUDE_CONFIG_DIR, context.homeDir ?? getHomeDir()),
    ...(context.claudeRoots ?? readSavedClaudeRoots(context)),
  ]);
}

export function getCodexHomes(context: PathContext = {}): string[] {
  return uniqueExisting(getCodexHomeCandidates(context));
}

export function getCodexHomeCandidates(context: PathContext = {}): string[] {
  const home = context.homeDir ?? getHomeDir();
  const env = context.env ?? process.env;
  const envRoots = env.CODEX_HOME?.trim() ? parsePathList(env.CODEX_HOME, home) : [];
  const savedRoots = context.codexHomes ?? readSavedCodexHomes(context);
  return uniquePaths([...envRoots, ...savedRoots, path.join(home, ".codex")]);
}

export function getConfiguredCodexHomes(context: PathContext = {}): string[] {
  return uniquePaths([
    ...parseOptionalPathList(context.env?.CODEX_HOME, context.homeDir ?? getHomeDir()),
    ...(context.codexHomes ?? readSavedCodexHomes(context)),
  ]);
}

export function getCodexSessionsDir(): string {
  return getCodexSessionsDirs()[0] ?? path.join(firstCodexHome(), "sessions");
}

export function getCodexSessionsDirs(context: PathContext = {}): string[] {
  return uniqueExisting(getCodexHomes(context).map((home) => path.join(home, "sessions")));
}

export function getCodexConfigPath(): string {
  return getCodexConfigPaths()[0] ?? path.join(firstCodexHome(), "config.toml");
}

export function getCodexConfigPaths(context: PathContext = {}): string[] {
  return getCodexHomes(context).map((home) => path.join(home, "config.toml"));
}

function firstCodexHome(context: PathContext = {}): string {
  return getCodexHomes(context)[0] ?? path.join(context.homeDir ?? getHomeDir(), ".codex");
}

export function getDebugLogDir(): string {
  return path.join(getAppConfigDir(), "debug");
}

export function getDebugLogPath(date: Date): string {
  return path.join(getDebugLogDir(), `${utcDateKey(date)}.jsonl`);
}

export function getDebugBackfillPath(date: Date): string {
  return path.join(getDebugLogDir(), `${utcDateKey(date)}.backfill.jsonl`);
}

function utcDateKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parsePathList(value: string, homeDir = getHomeDir()): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => resolveUserPath(part, homeDir));
}

function uniqueExisting(paths: string[]): string[] {
  return uniquePaths(paths).filter((resolved) => fs.existsSync(resolved));
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function parseOptionalPathList(value: string | undefined, homeDir = getHomeDir()): string[] {
  return value?.trim() ? parsePathList(value, homeDir) : [];
}

function readSavedCodexHomes(context: PathContext): string[] {
  return readSavedPathList(context, "codexHomes");
}

function readSavedClaudeRoots(context: PathContext): string[] {
  return readSavedPathList(context, "claudeRoots");
}

function readSavedPathList(context: PathContext, key: "claudeRoots" | "codexHomes"): string[] {
  if (context.homeDir || context.env || (key === "claudeRoots" ? context.claudeRoots : context.codexHomes)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8")) as Record<string, unknown>;
    const value = parsed[key];
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => resolveUserPath(item.trim()));
  } catch {
    return [];
  }
}

export function getClaudeRootCandidates(context: PathContext = {}): string[] {
  const home = context.homeDir ?? getHomeDir();
  return uniquePaths([
    ...parseOptionalPathList(context.env?.CLAUDE_CONFIG_DIR, home),
    ...(context.claudeRoots ?? readSavedClaudeRoots(context)),
    path.join(home, ".claude"),
    path.join(home, ".config", "claude"),
  ]);
}

function getClaudeCredentialRoots(context: PathContext = {}): string[] {
  return getClaudeRootCandidates(context);
}

function firstClaudeRoot(context: PathContext = {}): string {
  return getClaudeRoots(context)[0] ?? path.join(context.homeDir ?? getHomeDir(), ".claude");
}

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function resolveUserPath(value: string, homeDir = getHomeDir()): string {
  const expanded = value.replace(/^~(?=$|[\\/])/, homeDir);
  if (process.platform === "win32" && /^\\\\/.test(expanded)) return path.win32.normalize(expanded);
  return path.resolve(expanded);
}
