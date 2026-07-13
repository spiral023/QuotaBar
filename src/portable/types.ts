export const PORTABLE_STORE_VERSION = 1 as const;

export type PortableProvider = "claude" | "codex";
export type PortableEventSource = "claude-log" | "codex-log" | "legacy-reconciliation";

export interface PortableUsageEvent {
  schemaVersion: 1;
  id: string;
  provider: PortableProvider;
  occurredAt: string;
  model: string;
  projectName?: string;
  sessionKey: string;
  source: PortableEventSource;
  synthetic: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
  costUSD?: number;
  inputCostUSD?: number;
  outputCostUSD?: number;
  cacheCreationCostUSD?: number;
  cacheReadCostUSD?: number;
  pricingVersion?: string;
}

export interface PortableStoreMetadata {
  schemaVersion: 1;
  partitions: Record<string, { eventCount: number; firstAt: string; lastAt: string }>;
  updatedAt: string;
}

export interface PortableIngestState {
  schemaVersion: 1;
  sources: Record<string, { size: number; mtimeMs: number; processedAt: string }>;
}

export interface PortableMigrationState {
  schemaVersion: 1;
  status: "pending" | "running" | "complete" | "failed";
  legacyVersion: number;
  lastError?: string;
  updatedAt: string;
}
