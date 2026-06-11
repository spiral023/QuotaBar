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

export function isoAddDays(iso: string, delta: number): string;
export function filterWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[];
export function previousWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[];
export function metricOf(d: Day, metric: 'input' | 'output' | 'cacheCreation' | 'cacheRead' | 'total' | 'cost'): number;
export function isoWeek(iso: string): string;
