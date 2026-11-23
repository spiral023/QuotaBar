import type { FetchErrorClass, FetchErrorKind } from "../usage/fetchErrorClassifier";
import type { UsagePace } from "../usage/usagePace";
import type { WindowBudgetInfo } from "../usage/windowRatio";

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
  /**
   * Modelle im Fenster, für die keine Preisdaten gefunden wurden (weder LiteLLM
   * noch Fallback). Deren Tokens fehlen in apiCostUSD — die Summe ist also eine
   * Untergrenze. Leer/undefined = alle Modelle eingepreist.
   */
  missingPricingModels?: string[];
}

export type UsageStatus = "ok" | "not_authenticated" | "error" | "stale";

export interface UsageProvider {
  id: string;
  displayName: string;
  isAvailable(): Promise<boolean>;
  /** `signal` aborts the provider's requests when the refresh cycle gives up on it. */
  fetchUsage(signal?: AbortSignal): Promise<UsageSnapshot>;
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
  /**
   * Transport class of the failure behind an error snapshot. Providers turn
   * exceptions into snapshots, so this is how the refresh loop still learns
   * that the network or DNS was down.
   */
  errorKind?: FetchErrorKind;
  /** errno-style code of that failure, e.g. ENOTFOUND or TIMEOUT. */
  errorCode?: string;
  costFactor?: CostFactorResult;
  windowBudget?: WindowBudgetInfo;
}

export function errorSnapshot(
  provider: string,
  message: string,
  status: UsageStatus = "error",
  failure?: FetchErrorClass,
): UsageSnapshot {
  return {
    provider,
    status,
    windows: [],
    updatedAt: new Date().toISOString(),
    errorMessage: message,
    ...(failure && failure.kind !== "other" ? { errorKind: failure.kind, errorCode: failure.code } : {})
  };
}
