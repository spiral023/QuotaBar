export type ReportProvider = "all" | "claude" | "codex";
export type ReportType = "daily" | "weekly" | "monthly" | "hourly" | "session";
export type CostMode = "auto" | "calculate" | "display";
export type ReportOrder = "asc" | "desc";
export type CodexSpeed = "auto" | "standard" | "fast";

export interface ReportRequest {
  provider?: ReportProvider;
  type?: ReportType;
  since?: string;
  until?: string;
  timezone?: string;
  project?: string;
  instances?: boolean;
  costMode?: CostMode;
  codexSpeed?: CodexSpeed;
  order?: ReportOrder;
  breakdown?: boolean;
  source?: "portable" | "legacy";
  limit?: number;
}

/** Kosten je Token-Typ; Summe == costUSD. Optional, da nicht jeder Erzeuger sie füllt. */
export interface CostComponents {
  inputCostUSD?: number;
  outputCostUSD?: number;
  cacheCreationCostUSD?: number;
  cacheReadCostUSD?: number;
}

export interface ModelBreakdown extends CostComponents {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
}

export interface ReportTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
}

export interface ReportRow extends ReportTotals {
  bucket: string;
  provider: "claude" | "codex";
  project?: string;
  session?: string;
  directory?: string;
  lastActivity?: string;
  models: string[];
  modelBreakdowns?: ModelBreakdown[];
  isFallback?: boolean;
}

export interface ReportResult {
  request: Required<Omit<ReportRequest, "since" | "until" | "project" | "limit">> & Pick<ReportRequest, "since" | "until" | "project" | "limit">;
  rows: ReportRow[];
  totals: ReportTotals;
  generatedAt: string;
}

export interface BackfillPerModelEntry extends CostComponents {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUSD: number;
}

export interface BackfillDayRecord {
  date: string; // YYYY-MM-DD UTC
  provider: "claude" | "codex";
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  sessionCount: number;
  models: string[];
  perModel: Record<string, BackfillPerModelEntry>;
}
