export const PORTABLE_STORE_VERSION = 1 as const;
export type PortableStoreVersion = typeof PORTABLE_STORE_VERSION;

export type PortableProvider = "claude" | "codex";
export type PortableEventSource = "claude-log" | "codex-log" | "legacy-reconciliation";

export interface PortableUsageEvent {
  schemaVersion: PortableStoreVersion;
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
  schemaVersion: PortableStoreVersion;
  partitions: Record<string, { eventCount: number; firstAt: string; lastAt: string }>;
  updatedAt: string;
}

export interface PortableIngestState {
  schemaVersion: PortableStoreVersion;
  sources: Record<string, {
    size: string | number;
    mtimeMs?: number;
    mtimeNs?: string;
    ctimeNs?: string;
    processedAt: string;
    provider?: PortableProvider;
    path?: string;
    eventIds?: string[];
    active?: boolean;
  }>;
}

export interface PortableMigrationState {
  schemaVersion: PortableStoreVersion;
  status: "pending" | "running" | "complete" | "failed";
  usageMigrationVersion: number;
  storeRevision?: string;
  lastError?: string;
  updatedAt: string;
}
