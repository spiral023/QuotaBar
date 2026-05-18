export type ReportProvider = "all" | "claude" | "codex";
export type ReportType = "daily" | "weekly" | "monthly" | "session";
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
}

export interface ModelBreakdown {
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
  request: Required<Omit<ReportRequest, "since" | "until" | "project">> & Pick<ReportRequest, "since" | "until" | "project">;
  rows: ReportRow[];
  totals: ReportTotals;
  generatedAt: string;
}
