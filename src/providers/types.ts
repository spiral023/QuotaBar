import type { UsagePace } from "../usage/usagePace";

export interface TokenUsageDetail {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  models: string[];
}

export interface CostFactorResult {
  apiCostUSD: number;
  subscriptionCostUSD: number;
  factor: number | null;
  isEstimate: boolean;
  label: string;
  windowLabel?: string;
  windowDays?: number;
  calculationMode?: "fixed" | "actual-span";
  tokenUsage?: TokenUsageDetail;
}

export type UsageStatus = "ok" | "not_authenticated" | "error" | "stale";

export interface UsageProvider {
  id: string;
  displayName: string;
  isAvailable(): Promise<boolean>;
  fetchUsage(): Promise<UsageSnapshot>;
  getAuthHint(): Promise<string | null>;
}

export interface UsageWindow {
  name: "session" | "fiveHour" | "weekly" | "monthly" | "credits";
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
  windowSeconds?: number;
  label?: string;
  pace?: UsagePace | null;
  burnRatePctPerHour?: number | null;
  safetyGapSeconds?: number | null;
}

export interface UsageSnapshot {
  provider: string;
  status: UsageStatus;
  planType?: string;
  model?: string;
  identity?: {
    email?: string;
    accountId?: string;
  };
  windows: UsageWindow[];
  updatedAt: string;
  errorMessage?: string;
  costFactor?: CostFactorResult;
}

export interface ProviderContext {
  timeoutMs?: number;
  debug?: boolean;
}

export function errorSnapshot(provider: string, message: string, status: UsageStatus = "error"): UsageSnapshot {
  return {
    provider,
    status,
    windows: [],
    updatedAt: new Date().toISOString(),
    errorMessage: message
  };
}
