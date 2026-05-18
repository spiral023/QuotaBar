import os from "node:os";
import path from "node:path";

export function getHomeDir(): string {
  return os.homedir();
}

export function getAppConfigDir(): string {
  return path.join(getHomeDir(), ".codexbar-win");
}

export function getLogPath(): string {
  return path.join(getAppConfigDir(), "codexbar.log");
}

export function getSettingsPath(): string {
  return path.join(getAppConfigDir(), "settings.json");
}

export function getInstalledMarkerPath(): string {
  return path.join(getAppConfigDir(), ".installed");
}

export function getCodexAuthPath(): string {
  return path.join(process.env.CODEX_HOME?.trim() || path.join(getHomeDir(), ".codex"), "auth.json");
}

export function getClaudeCredentialsPath(): string {
  return path.join(getHomeDir(), ".claude", ".credentials.json");
}

export function getGeminiSettingsPath(): string {
  return path.join(getHomeDir(), ".gemini", "settings.json");
}

export function getGeminiTmpDir(): string {
  return path.join(getHomeDir(), ".gemini", "tmp");
}
