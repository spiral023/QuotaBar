import fs from "node:fs/promises";
import path from "node:path";
import {
  getCodexConfigPaths,
  getCodexHomes,
  getCodexSessionsDirs,
  getClaudeProjectsDirs,
  getHomeDir,
  getLiteLLMModelPricesPath,
} from "../config/paths";
import type { AppVariantInfo } from "./appIdentity";

export type SystemAgentStatus = "connected" | "detected" | "not_found";
export type SystemPathKind = "file" | "folder";
export type SystemDataCategoryId = "logs" | "credentials" | "config" | "cache";

export interface SystemDataContext {
  homeDir?: string;
  appConfigDir?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
  quickStatsLoadDurationMs?: number | null;
  appVariant?: AppVariantInfo;
}

export interface SystemDataPath {
  id: string;
  label: string;
  category: SystemDataCategoryId;
  kind: SystemPathKind;
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  lastModifiedAt: string | null;
  openPath: string | null;
}

export interface SystemAgentData {
  id: string;
  name: string;
  vendor: string;
  logo: string;
  status: SystemAgentStatus;
  paths: SystemDataPath[];
  totals: SystemDataTotals;
}

export interface SystemDataTotals {
  fileCount: number;
  totalBytes: number;
  lastModifiedAt: string | null;
}

export interface SystemDataCategory {
  id: SystemDataCategoryId;
  label: string;
  fileCount: number;
  totalBytes: number;
}

export interface SystemAppData {
  name: "QuotaBar";
  variant: AppVariantInfo;
  paths: SystemDataPath[];
  totals: SystemDataTotals;
}

export interface SystemDataReport {
  generatedAt: string;
  scanDurationMs: number;
  quickStatsLoadDurationMs: number | null;
  agents: SystemAgentData[];
  app: SystemAppData;
  categories: SystemDataCategory[];
  totals: SystemDataTotals;
}

interface PathSpec {
  id: string;
  label: string;
  category: SystemDataCategoryId;
  kind: SystemPathKind;
  path: string;
}

const CATEGORY_LABELS: Record<SystemDataCategoryId, string> = {
  logs: "Logs & Sessions",
  credentials: "Credentials",
  config: "Configuration",
  cache: "Cache",
};

export async function collectSystemData(context: SystemDataContext = {}): Promise<SystemDataReport> {
  const scanStartedAtMs = Date.now();
  const generatedAt = (context.now ?? new Date()).toISOString();
  const agentSpecs = buildAgentSpecs(context);
  const agents = await Promise.all(agentSpecs.map(async (agent) => {
    const paths = await scanSpecs(agent.paths);
    return {
      id: agent.id,
      name: agent.name,
      vendor: agent.vendor,
      logo: agent.logo,
      status: resolveAgentStatus(paths),
      paths,
      totals: sumPaths(paths),
    };
  }));
  const app = {
    name: "QuotaBar" as const,
    variant: context.appVariant ?? { id: "development" as const, label: "Development" },
    paths: await scanSpecs(buildAppSpecs(context)),
    totals: emptyTotals(),
  };
  app.totals = sumPaths(app.paths);

  const allPaths = [...agents.flatMap((agent) => agent.paths), ...app.paths];
  const categories = categoryTotals(allPaths);

  return {
    generatedAt,
    scanDurationMs: Math.max(0, Date.now() - scanStartedAtMs),
    quickStatsLoadDurationMs: normalizeDurationMs(context.quickStatsLoadDurationMs),
    agents,
    app,
    categories,
    totals: sumPaths(allPaths),
  };
}

export function findOpenableSystemPath(report: SystemDataReport, requestedPath: string): string | null {
  const requestedKey = pathKey(requestedPath);
  for (const item of allReportPaths(report)) {
    if (item.exists && pathKey(item.path) === requestedKey) return item.path;
    if (!item.openPath) continue;
    if (pathKey(item.openPath) === requestedKey) return item.openPath;
  }
  return null;
}

function buildAgentSpecs(context: SystemDataContext): Array<{
  id: string;
  name: string;
  vendor: string;
  logo: string;
  paths: PathSpec[];
}> {
  const home = context.homeDir ?? getHomeDir();
  const env = context.env ?? process.env;
  const pathContext = { homeDir: home, env };
  const codexHomeCandidates = configuredRoots(env.CODEX_HOME, [path.join(home, ".codex")], home);
  const codexHomes = uniquePaths([...getCodexHomes(pathContext), ...codexHomeCandidates]);
  const codexSessions = uniquePaths([
    ...getCodexSessionsDirs(pathContext),
    ...codexHomeCandidates.map((codexHome) => path.join(codexHome, "sessions")),
  ]);
  const codexConfigs = uniquePaths([
    ...getCodexConfigPaths(pathContext),
    ...codexHomeCandidates.map((codexHome) => path.join(codexHome, "config.toml")),
  ]);
  const claudeRootCandidates = configuredRoots(
    env.CLAUDE_CONFIG_DIR,
    [path.join(home, ".config", "claude"), path.join(home, ".claude")],
    home,
  );
  const claudeProjects = uniquePaths([
    ...getClaudeProjectsDirs(pathContext),
    ...claudeRootCandidates.map((root) => path.join(root, "projects")),
  ]);

  return [
    {
      id: "claude",
      name: "Claude Code",
      vendor: "Anthropic",
      logo: "../../logos/claude.png",
      paths: [
        {
          id: "claude-credentials",
          label: "Credentials",
          category: "credentials",
          kind: "file",
          path: path.join(home, ".claude", ".credentials.json"),
        },
        ...claudeProjects.map((projectDir, index) => ({
          id: `claude-projects-${index + 1}`,
          label: claudeProjects.length > 1 ? `Projects ${index + 1}` : "Projects",
          category: "logs" as const,
          kind: "folder" as const,
          path: projectDir,
        })),
      ],
    },
    {
      id: "codex",
      name: "Codex",
      vendor: "OpenAI",
      logo: "../../logos/codex.png",
      paths: [
        ...codexHomes.map((codexHome, index) => ({
          id: `codex-auth-${index + 1}`,
          label: codexHomes.length > 1 ? `Auth ${index + 1}` : "Auth",
          category: "credentials" as const,
          kind: "file" as const,
          path: path.join(codexHome, "auth.json"),
        })),
        ...codexConfigs.map((configPath, index) => ({
          id: `codex-config-${index + 1}`,
          label: codexConfigs.length > 1 ? `Config ${index + 1}` : "Config",
          category: "config" as const,
          kind: "file" as const,
          path: configPath,
        })),
        ...codexSessions.map((sessionsDir, index) => ({
          id: `codex-sessions-${index + 1}`,
          label: codexSessions.length > 1 ? `Sessions ${index + 1}` : "Sessions",
          category: "logs" as const,
          kind: "folder" as const,
          path: sessionsDir,
        })),
      ],
    },
  ];
}

function buildAppSpecs(context: SystemDataContext): PathSpec[] {
  const appDir = context.appConfigDir ?? path.join(context.homeDir ?? getHomeDir(), ".quotabar-win");
  return [
    { id: "app-settings",          label: "Settings",          category: "config", kind: "file",   path: path.join(appDir, "settings.json") },
    { id: "app-log",               label: "App Log",           category: "logs",   kind: "file",   path: path.join(appDir, "quotabar.log") },
    { id: "app-notification-log",  label: "Notification Log",  category: "logs",   kind: "file",   path: path.join(appDir, "notifications.log") },
    { id: "app-cache",             label: "Usage Cache",       category: "cache",  kind: "file",   path: path.join(appDir, "cache", "usage-snapshots.json") },
    { id: "app-fx-cache",          label: "FX Cache",          category: "cache",  kind: "file",   path: path.join(appDir, "cache", "fx-rates.json") },
    { id: "app-fx-status",         label: "FX Status",         category: "cache",  kind: "file",   path: path.join(appDir, "cache", "fx-status.json") },
    { id: "app-litellm-prices",    label: "LiteLLM Model Prices", category: "cache", kind: "file", path: getLiteLLMModelPricesPathForContext(context, appDir) },
    { id: "app-litellm-status",    label: "LiteLLM Status",    category: "cache",  kind: "file",   path: path.join(appDir, "cache", "litellm-status.json") },
    { id: "app-window-history",    label: "Window History",    category: "cache",  kind: "file",   path: path.join(appDir, "window-history.json") },
    { id: "app-window-ratio",      label: "Window Ratio",      category: "cache",  kind: "file",   path: path.join(appDir, "window-ratio.json") },
    { id: "app-bonus-state",       label: "Bonus State",       category: "cache",  kind: "file",   path: path.join(appDir, "bonus-state.json") },
    { id: "app-notification-state",label: "Notification State",category: "cache",  kind: "file",   path: path.join(appDir, "notification-state.json") },
    { id: "app-debug",             label: "Debug Logs",        category: "logs",   kind: "folder", path: path.join(appDir, "debug") },
  ];
}

function getLiteLLMModelPricesPathForContext(context: SystemDataContext, appDir: string): string {
  return context.appConfigDir
    ? path.join(appDir, "cache", "litellm-model-prices.json")
    : getLiteLLMModelPricesPath();
}

async function scanSpecs(specs: PathSpec[]): Promise<SystemDataPath[]> {
  return Promise.all(specs.map(scanSpec));
}

async function scanSpec(spec: PathSpec): Promise<SystemDataPath> {
  const stats = spec.kind === "folder"
    ? await scanFolder(spec.path)
    : await scanFile(spec.path);
  return {
    ...spec,
    path: path.resolve(spec.path),
    exists: stats.exists,
    fileCount: stats.fileCount,
    totalBytes: stats.totalBytes,
    lastModifiedAt: stats.lastModifiedAt,
    openPath: stats.exists ? openTarget(spec.path, spec.kind) : null,
  };
}

async function scanFile(filePath: string): Promise<SystemDataTotals & { exists: boolean }> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { exists: false, ...emptyTotals() };
    return {
      exists: true,
      fileCount: 1,
      totalBytes: stat.size,
      lastModifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { exists: false, ...emptyTotals() };
  }
}

async function scanFolder(folderPath: string): Promise<SystemDataTotals & { exists: boolean }> {
  try {
    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) return { exists: false, ...emptyTotals() };
  } catch {
    return { exists: false, ...emptyTotals() };
  }
  const totals = await scanFolderContents(folderPath);
  return { exists: true, ...totals };
}

async function scanFolderContents(folderPath: string): Promise<SystemDataTotals> {
  const totals = emptyTotals();
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true });
  } catch {
    return totals;
  }

  for (const entry of entries) {
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      addTotals(totals, await scanFolderContents(entryPath));
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(entryPath);
      totals.fileCount += 1;
      totals.totalBytes += stat.size;
      totals.lastModifiedAt = maxIso(totals.lastModifiedAt, stat.mtime.toISOString());
    } catch {
      // Ignore files that disappear while scanning.
    }
  }
  return totals;
}

function resolveAgentStatus(paths: SystemDataPath[]): SystemAgentStatus {
  const hasCredentials = paths.some((item) => item.category === "credentials" && item.exists);
  if (hasCredentials) return "connected";
  const hasData = paths.some((item) => item.category === "logs" && item.exists);
  return hasData ? "detected" : "not_found";
}

function categoryTotals(paths: SystemDataPath[]): SystemDataCategory[] {
  return (Object.keys(CATEGORY_LABELS) as SystemDataCategoryId[]).map((id) => {
    const items = paths.filter((item) => item.category === id);
    return {
      id,
      label: CATEGORY_LABELS[id],
      fileCount: items.reduce((sum, item) => sum + item.fileCount, 0),
      totalBytes: items.reduce((sum, item) => sum + item.totalBytes, 0),
    };
  });
}

function sumPaths(paths: SystemDataPath[]): SystemDataTotals {
  return paths.reduce((totals, item) => addTotals(totals, item), emptyTotals());
}

function addTotals<T extends SystemDataTotals>(target: T, source: SystemDataTotals): T {
  target.fileCount += source.fileCount;
  target.totalBytes += source.totalBytes;
  target.lastModifiedAt = maxIso(target.lastModifiedAt, source.lastModifiedAt);
  return target;
}

function emptyTotals(): SystemDataTotals {
  return { fileCount: 0, totalBytes: 0, lastModifiedAt: null };
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function normalizeDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function openTarget(targetPath: string, kind: SystemPathKind): string {
  return path.resolve(kind === "folder" ? targetPath : path.dirname(targetPath));
}

function allReportPaths(report: SystemDataReport): SystemDataPath[] {
  return [...report.agents.flatMap((agent) => agent.paths), ...report.app.paths];
}

function configuredRoots(value: string | undefined, fallback: string[], home: string): string[] {
  const raw = value?.trim()
    ? value.split(",").map((part) => part.trim()).filter(Boolean)
    : fallback;
  return raw.map((item) => path.resolve(item.replace(/^~(?=$|[\\/])/, home)));
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = pathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
