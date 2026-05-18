import { ClaudeProvider } from "./claude";
import { CodexProvider } from "./codex";
import { GeminiProvider } from "./gemini";
import { UsageProvider } from "./types";

export function createProviderRegistry(timeoutMs = 10_000): UsageProvider[] {
  return [
    new ClaudeProvider(timeoutMs),
    new CodexProvider(timeoutMs),
    new GeminiProvider()
  ];
}
