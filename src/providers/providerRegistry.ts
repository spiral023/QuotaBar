import { ClaudeProvider } from "./claude";
import { CodexProvider } from "./codex";
import { UsageProvider } from "./types";
import type { Settings } from "../config/settings";

export type ProviderSettingsLoader = () => Promise<Settings>;

export function createProviderRegistry(timeoutMs = 10_000, settingsLoader?: ProviderSettingsLoader): UsageProvider[] {
  return [
    new ClaudeProvider(timeoutMs, settingsLoader),
    new CodexProvider(timeoutMs, settingsLoader)
  ];
}
