// Type definitions for models-calc UMD module

export interface Day {
  date: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  inputCostUSD?: number;
  outputCostUSD?: number;
  cacheCreationCostUSD?: number;
  cacheReadCostUSD?: number;
}

export interface ModelTableRow extends Day {
  firstUsed: string;
  lastUsed: string;
  effPerMTok: number | null;
  score: number | null;
  scorePerDollar: number | null;
  sharePct: number;
  tokenSharePct: number;
  cacheHitRate: number | null;
}

export interface ScatterPoint {
  model: string;
  provider: string;
  x: number;
  y: number;
  r: number;
  sharePct: number;
  valueScore: number;
  valueColor: string;
}

export interface ProviderCostRow {
  key: string;
  label: string;
  tokens: number;
  costUSD: number;
  perMTok: number | null;
  tokenPct: number;
}

export interface ProviderCostBreakdown {
  provider: string;
  rows: ProviderCostRow[];
  totalTokens: number;
  totalCostUSD: number;
  effPerMTok: number | null;
  hasCostBreakdown: boolean;
}

export function providerCostBreakdown(days: Day[]): ProviderCostBreakdown[];

export type Granularity = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface RateSeries {
  buckets: string[];
  claude: Array<number | null>;
  codex: Array<number | null>;
  total: Array<number | null>;
}

export function isoAddDays(iso: string, delta: number): string;
export function filterWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[];
export function previousWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[];
export function filterRange(days: Day[], from: string, to: string): Day[];
export function previousRange(days: Day[], from: string, to: string): Day[];
export function metricOf(d: Day, metric: 'input' | 'output' | 'cacheCreation' | 'cacheRead' | 'total' | 'cost'): number;
export function isoWeek(iso: string): string;
export function bucketFnFor(granularity: Granularity): (d: Day) => string;
export function buildRateSeries(days: Day[], granularity: Granularity): RateSeries;
export function tableRows(days: Day[], benchmarks: Record<string, number>): ModelTableRow[];
export function scatterPoints(
  rows: Array<Pick<ModelTableRow, 'model' | 'provider' | 'effPerMTok' | 'score' | 'sharePct' | 'tokenSharePct'>>,
  minTokenSharePct?: number,
): ScatterPoint[];
export function scatterBubbleColors(
  points: Array<Pick<ScatterPoint, 'provider'>>,
  colorForProvider: (provider: string) => string,
): { backgroundColor: string[]; borderColor: string[] };
export function scatterAxisColorScale(
  points: Array<Pick<ScatterPoint, 'x' | 'y'>>,
): { costColor: (value: number) => string; scoreColor: (value: number) => string };
export function scatterOptimumRegion(
  points: Array<Pick<ScatterPoint, 'x' | 'y'>>,
): { xMin: number; xMax: number; yMin: number; yMax: number } | null;

export type Metric = Parameters<typeof metricOf>[1];
export interface ModelAggregate extends Omit<Day, 'date'> { firstUsed: string; lastUsed: string }
export interface TrendFit { a: number; b: number; samples: Array<{ x: number; y: number }> }
export function nextBucket(bucket: string, granularity: Granularity): string;
export function bucketAxis(days: Day[], granularity: Granularity, fillGaps?: boolean): string[];
export function buildStack(days: Day[], metric: Metric, granularity: Granularity, othersThreshold?: number, fillGaps?: boolean): {
  buckets: string[]; series: Array<{ model: string; provider: string; values: number[] }>; othersGrouped: string[];
};
export function modelColorOrder(days: Day[]): string[];
export function aggregateByModel(days: Day[]): ModelAggregate[];
export function computeKpis(days: Day[], previousDays: Day[], benchmarks: Record<string, number>, minTokenSharePct?: number): {
  activeModels: number; activeModelsDelta: number | null;
  topCost: { model: string; provider: string; costUSD: number; sharePct: number } | null;
  topOutput: { model: string; provider: string; outputTokens: number } | null;
  effPerMTok: number | null; effPerMTokDeltaPct: number | null;
  bestValue: { model: string; provider: string; scorePerDollar: number } | null; top3SharePct: number;
};
export function scatterTrendCurve(points: Array<{ x: number; y: number }>, sampleCount?: number): TrendFit | null;
export function trendResidual(point: { x: number; y: number } | null, fit: Pick<TrendFit, 'a' | 'b'> | null): number | null;
export function adoptionTimeline(days: Day[]): Array<{ model: string; provider: string; first: string; last: string; months: Array<{ month: string; intensity: number }> }>;
export function cacheEfficiency(days: Day[], pricing: Record<string, { inputPerMTok: number; cacheReadPerMTok: number }>): Array<{ model: string; provider: string; hitRate: number; savedUSD: number }>;
export function providerRibbon(days: Day[], metric: Metric, granularity: Granularity): Array<{ bucket: string; claudeShare: number }>;
export function tokenTypeBreakdown(days: Day[]): { input: number; output: number; cacheRead: number; cacheCreation: number; total: number; inputPct: number; outputPct: number; cacheReadPct: number; cacheCreationPct: number };
