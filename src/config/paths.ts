import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface PathContext {
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export function getHomeDir(): string {
  return os.homedir();
}

export function getAppConfigDir(): string {
  return path.join(getHomeDir(), ".quotabar-win");
}

export function getLogPath(): string {
  return path.join(getAppConfigDir(), "quotabar.log");
}

export function getSettingsPath(): string {
  return path.join(getAppConfigDir(), "settings.json");
}

export function getInstalledMarkerPath(): string {
  return path.join(getAppConfigDir(), ".installed");
}

export function getCodexAuthPath(): string {
  return path.join(firstCodexHome(), "auth.json");
}

export function getClaudeCredentialsPath(): string {
  return path.join(getHomeDir(), ".claude", ".credentials.json");
}

export function getClaudeProjectsDir(): string {
  return getClaudeProjectsDirs()[0] ?? path.join(getHomeDir(), ".claude", "projects");
}

export function getClaudeProjectsDirs(context: PathContext = {}): string[] {
  const home = context.homeDir ?? getHomeDir();
  const env = context.env ?? process.env;
  const roots = env.CLAUDE_CONFIG_DIR?.trim()
    ? parsePathList(env.CLAUDE_CONFIG_DIR)
    : [path.join(home, ".config", "claude"), path.join(home, ".claude")];
  return uniqueExisting(roots.map((root) => path.join(root, "projects")));
}

export function getCodexHomes(context: PathContext = {}): string[] {
  const home = context.homeDir ?? getHomeDir();
  const env = context.env ?? process.env;
  const roots = env.CODEX_HOME?.trim()
    ? parsePathList(env.CODEX_HOME)
    : [path.join(home, ".codex")];
  return uniqueExisting(roots);
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

function firstCodexHome(): string {
  return getCodexHomes()[0] ?? path.join(getHomeDir(), ".codex");
}

function parsePathList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => path.resolve(part.replace(/^~(?=$|[\\/])/, getHomeDir())));
}

function uniqueExisting(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(resolved)) result.push(resolved);
  }
  return result;
}
