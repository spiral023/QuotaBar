import type { CostFactorResult, UsageSnapshot, UsageWindow } from "../providers/types";

export type DebugEvent =
  | AppStartEvent
  | AppExitEvent
  | RefreshStartEvent
  | RefreshSkippedEvent
  | RefreshErrorEvent
  | SnapshotEvent
  | AuthRefreshEvent
  | DashboardOpenEvent
  | DashboardCloseEvent
  | DashboardRefreshRequestedEvent
  | SystemSuspendEvent
  | SystemResumeEvent
  | SystemLockEvent
  | SystemUnlockEvent
  | NetworkCheckFailedEvent
  | DnsLookupFailedEvent
  | NetworkRecoveredEvent
  | CostWindowChangedEvent;

export interface AppStartEvent { kind: "app.start"; version: string; variant?: string; pollIntervalSeconds: number; noWindow: boolean; platform: string; }
export interface AppExitEvent { kind: "app.exit"; reason: string; }
export interface RefreshStartEvent { kind: "refresh.start"; providers: string[]; trigger: "interval" | "manual" | "dashboard"; tick: number; }
export interface RefreshSkippedEvent { kind: "refresh.skipped"; provider: string; reason: "rate-limited"; remainingSeconds: number; }
export interface RefreshErrorEvent { kind: "refresh.error"; message: string; }
export interface SnapshotEvent {
  kind: "snapshot";
  provider: string;
  status: UsageSnapshot["status"];
  planType?: string;
  windows: UsageWindow[];
  cost?: CostFactorResult;
  fetchedAt: string;
  errorMessage?: string;
}
export interface AuthRefreshEvent { kind: "auth.refresh"; provider: string; success: boolean; durationMs: number; }
export interface DashboardOpenEvent { kind: "dashboard.open"; }
export interface DashboardCloseEvent { kind: "dashboard.close"; }
export interface DashboardRefreshRequestedEvent { kind: "dashboard.refreshRequested"; }

/**
 * Day summary line of the legacy `*.backfill.jsonl` files. Nothing writes them
 * anymore; reports/backfill-reader.ts still reads them for legacy reconciliation.
 */
export interface TokensDaySummaryEvent {
  kind: "tokens.daySummary";
  provider: "claude" | "codex";
  date: string; // YYYY-MM-DD UTC
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
  cachedInput?: number;
  reasoningOutput?: number;
  totalTokens: number;
  totalCostUSD: number;
  sessionCount: number;
  models: string[];
  perModel: Record<string, {
    input: number; output: number; cacheCreation?: number; cacheRead?: number;
    cachedInput?: number; reasoningOutput?: number; costUSD: number;
    // Per-token-type costs (sum == costUSD); only present in files written by later backfill versions.
    inputCostUSD?: number; outputCostUSD?: number;
    cacheCreationCostUSD?: number; cacheReadCostUSD?: number;
  }>;
}

export interface SystemSuspendEvent { kind: "system.suspend"; }
export interface SystemResumeEvent { kind: "system.resume"; sleepSeconds: number; }
export interface SystemLockEvent { kind: "system.lock"; }
export interface SystemUnlockEvent { kind: "system.unlock"; }
export interface NetworkCheckFailedEvent { kind: "network.check.failed"; provider: string; code: string; }
export interface DnsLookupFailedEvent { kind: "dns.lookup.failed"; provider: string; code: string; }
export interface NetworkRecoveredEvent { kind: "network.recovered"; }
export interface CostWindowChangedEvent { kind: "cost.window.changed"; from: string; to: string; reason: string; }

/**
 * Snapshot event factory — converts a UsageSnapshot to its event form.
 * Rename `costFactor` to `cost` for cleaner reading; keep `updatedAt` as `fetchedAt`.
 */
export function snapshotEvent(snap: UsageSnapshot): SnapshotEvent {
  return {
    kind: "snapshot",
    provider: snap.provider,
    status: snap.status,
    planType: snap.planType,
    windows: snap.windows,
    cost: snap.costFactor,
    fetchedAt: snap.updatedAt,
    errorMessage: snap.errorMessage,
  };
}
