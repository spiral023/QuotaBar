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
}

export interface ModelTableRow extends Day {
  firstUsed: string;
  lastUsed: string;
  effPerMTok: number | null;
  score: number | null;
  scorePerDollar: number | null;
  sharePct: number;
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

export interface EffRateCompositionRow {
  key: string;
  provider: string;
  costUSD: number;
  totalTokens: number;
  tokenShare: number;
  effPerMTok: number | null;
  contribution: number;
  grouped: number;
}

export interface EffRateComposition {
  totalCost: number;
  totalTokens: number;
  effPerMTok: number | null;
  rows: EffRateCompositionRow[];
}

export function effRateComposition(
  days: Day[],
  groupKey: 'provider' | 'model',
  maxGroups?: number,
): EffRateComposition;

export function isoAddDays(iso: string, delta: number): string;
export function filterWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[];
export function previousWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[];
export function metricOf(d: Day, metric: 'input' | 'output' | 'cacheCreation' | 'cacheRead' | 'total' | 'cost'): number;
export function isoWeek(iso: string): string;
export function tableRows(days: Day[], benchmarks: Record<string, number>): ModelTableRow[];
export function scatterPoints(rows: Array<Pick<ModelTableRow, 'model' | 'provider' | 'effPerMTok' | 'score' | 'sharePct'>>): ScatterPoint[];
export function scatterBubbleColors(
  points: Array<Pick<ScatterPoint, 'provider'>>,
  colorForProvider: (provider: string) => string,
): { backgroundColor: string[]; borderColor: string[] };
export function scatterAxisColorScale(
  points: Array<Pick<ScatterPoint, 'x' | 'y'>>,
): { costColor: (value: number) => string; scoreColor: (value: number) => string };
