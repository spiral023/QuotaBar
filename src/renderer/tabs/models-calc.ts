// Pure calculation helpers for the Models tab.
// This TypeScript version is used in tests; the UMD version in models-calc.js
// is used in the browser/renderer.

export function isoAddDays(iso: string, delta: number): string {
  const dt = new Date(iso + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export function windowDays(win: '30d' | '90d' | 'all'): number {
  return win === '30d' ? 30 : 90;
}

export type Day = {
  date: string;
  provider: "claude" | "codex";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
};

// win: '30d' | '90d' | 'all'; today: 'YYYY-MM-DD'
export function filterWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[] {
  if (win === 'all') return days.slice();
  const start = isoAddDays(today, -(windowDays(win) - 1));
  return days.filter((d) => d.date >= start && d.date <= today);
}

// Same-length window immediately before (Spec: "Vorperiode").
export function previousWindow(days: Day[], win: '30d' | '90d' | 'all', today: string): Day[] {
  if (win === 'all') return [];
  const n = windowDays(win);
  const start = isoAddDays(today, -(2 * n - 1));
  const end = isoAddDays(today, -n);
  return days.filter((d) => d.date >= start && d.date <= end);
}

export function metricOf(d: Day, metric: string): number {
  switch (metric) {
    case 'input':         return d.inputTokens;
    case 'output':        return d.outputTokens;
    case 'cacheRead':     return d.cacheReadTokens;
    case 'cacheCreation': return d.cacheCreationTokens;
    case 'cost':          return d.costUSD;
    default:              return d.totalTokens;
  }
}

// Identical semantics to isoWeekBucket in src/reports/reportService.ts.
export function isoWeek(iso: string): string {
  const date = new Date(iso + 'T00:00:00Z');
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const weekStr = String(week).padStart(2, '0');
  return date.getUTCFullYear() + '-W' + weekStr;
}
