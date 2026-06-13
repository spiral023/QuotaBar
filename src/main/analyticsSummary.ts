import type { ReportRow } from "../reports/types";
import type { ClaudeUsageEntry } from "../pricing/jsonl-reader";
import type { UsageSnapshot } from "../providers/types";
import type { CodexTokenEvent } from "../pricing/codex-log-reader";

export interface AnalyticsSummary {
  apiCostUSD: { claude: number; codex: number; total: number };
  subscriptionCostUSD: { claude: number; codex: number; total: number };
  roiFactor: { claude: number; codex: number; combined: number };
  activeDays: number;
  avgSessionMinutes: number;
  cacheHitRate: { claude: number; codex: number };
  sparkline7d: { date: string; claudeUSD: number; codexUSD: number }[];
  topModels: { model: string; provider: "claude" | "codex"; costUSD: number; pctOfTotal: number }[];
  windowDays: number;
}

export function computeActiveDays(claudeRows: ReportRow[], codexRows: ReportRow[]): number {
  const dates = new Set<string>();
  for (const r of claudeRows) if (r.costUSD > 0 || r.totalTokens > 0) dates.add(r.bucket);
  for (const r of codexRows)  if (r.costUSD > 0 || r.totalTokens > 0) dates.add(r.bucket);
  return dates.size;
}

export function buildSparkline7d(
  claudeRows: ReportRow[],
  codexRows: ReportRow[],
): { date: string; claudeUSD: number; codexUSD: number }[] {
  const claudeByDate = new Map(claudeRows.map(r => [r.bucket, r.costUSD]));
  const codexByDate  = new Map(codexRows.map(r  => [r.bucket, r.costUSD]));
  return getLast7Days().map(date => ({
    date,
    claudeUSD: claudeByDate.get(date) ?? 0,
    codexUSD:  codexByDate.get(date)  ?? 0,
  }));
}

export function buildTopModels(
  claudeRows: ReportRow[],
  codexRows: ReportRow[],
  limit: number,
): { model: string; provider: "claude" | "codex"; costUSD: number; pctOfTotal: number }[] {
  const map = new Map<string, { provider: "claude" | "codex"; costUSD: number }>();
  for (const row of [...claudeRows, ...codexRows]) {
    for (const mb of row.modelBreakdowns ?? []) {
      const existing = map.get(mb.model);
      if (existing) {
        existing.costUSD += mb.costUSD;
      } else {
        map.set(mb.model, { provider: row.provider, costUSD: mb.costUSD });
      }
    }
  }
  const total = Array.from(map.values()).reduce((s, m) => s + m.costUSD, 0);
  return Array.from(map.entries())
    .map(([model, { provider, costUSD }]) => ({
      model,
      provider,
      costUSD,
      pctOfTotal: total > 0 ? costUSD / total : 0,
    }))
    .sort((a, b) => b.costUSD - a.costUSD)
    .slice(0, limit);
}

export function computeAvgSessionMinutes(entries: ClaudeUsageEntry[]): number {
  const sessionMap = new Map<string, { min: number; max: number }>();
  for (const entry of entries) {
    const ts  = new Date(entry.timestamp).getTime();
    const key = `${entry.project}\0${entry.session}`;
    const ex  = sessionMap.get(key);
    if (!ex) {
      sessionMap.set(key, { min: ts, max: ts });
    } else {
      if (ts < ex.min) ex.min = ts;
      if (ts > ex.max) ex.max = ts;
    }
  }
  if (sessionMap.size === 0) return 0;
  let totalMs = 0;
  for (const { min, max } of sessionMap.values()) totalMs += max - min;
  return Math.round(totalMs / sessionMap.size / 60_000);
}

export function computeCacheHitRate(snapshots: UsageSnapshot[] | null): { claude: number; codex: number } {
  if (!snapshots) return { claude: 0, codex: 0 };
  let cRead = 0, cFresh = 0, dCached = 0, dFresh = 0;
  for (const snap of snapshots) {
    const t = snap.costFactor?.tokenUsage;
    if (!t) continue;
    if (snap.provider === "claude") { cRead  += t.cacheReadTokens; cFresh  += t.inputTokens; }
    if (snap.provider === "codex")  { dCached += t.cacheReadTokens; dFresh += t.inputTokens; }
  }
  return {
    claude: (cRead  + cFresh)  > 0 ? cRead  / (cRead  + cFresh)  : 0,
    codex:  (dCached + dFresh) > 0 ? dCached / (dCached + dFresh) : 0,
  };
}

function getLast7Days(): string[] {
  return getLastNDays(7);
}

export interface AnalyticsData extends AnalyticsSummary {
  dailyBuckets: {
    date: string;
    claudeUSD: number;
    codexUSD: number;
    claudeQuotaPct: number | null;
    codexQuotaPct: number | null;
  }[];
  sessionStats: {
    count: number;
    avgMinutes: number;
    totalHours: number;
    sessionsPerActiveDay: number;
  };
  totalTokens: {
    claude: { input: number; output: number; cacheRead: number; cacheCreate: number };
    codex:  { input: number; output: number; cached: number };
  };
  // Phase 3:
  hourHeatmap: { hour: number; count: number; pct: number }[];
  weekdayDistribution: { day: number; label: string; count: number; pct: number }[];
  topActiveDays: { date: string; count: number; outputTokens: number }[];
  fiveHourPeak: { maxOutputTokens: number; maxTotalTokens: number; peakWindowStart: string | null };
  weeklySummary: WeeklyBucket[];
  costEfficiency: CostEfficiency;
}

export function buildDailyBuckets(
  claudeRows: ReportRow[],
  codexRows: ReportRow[],
  windowDays: number,
): { date: string; claudeUSD: number; codexUSD: number; claudeQuotaPct: null; codexQuotaPct: null }[] {
  const days = getLastNDays(windowDays);
  const claudeByDate = new Map(claudeRows.map(r => [r.bucket, r.costUSD]));
  const codexByDate  = new Map(codexRows.map(r  => [r.bucket, r.costUSD]));
  return days.map(date => ({
    date,
    claudeUSD:      claudeByDate.get(date) ?? 0,
    codexUSD:       codexByDate.get(date)  ?? 0,
    claudeQuotaPct: null,
    codexQuotaPct:  null,
  }));
}

export function buildSessionStats(
  entries: ClaudeUsageEntry[],
  activeDays: number,
): { count: number; avgMinutes: number; totalHours: number; sessionsPerActiveDay: number } {
  const sessions = new Map<string, { min: number; max: number }>();
  for (const e of entries) {
    const ts  = new Date(e.timestamp).getTime();
    const key = `${e.project}\0${e.session}`;
    const ex  = sessions.get(key);
    if (!ex) {
      sessions.set(key, { min: ts, max: ts });
    } else {
      if (ts < ex.min) ex.min = ts;
      if (ts > ex.max) ex.max = ts;
    }
  }
  const count = sessions.size;
  if (count === 0) return { count: 0, avgMinutes: 0, totalHours: 0, sessionsPerActiveDay: 0 };
  let totalMs = 0;
  for (const { min, max } of sessions.values()) totalMs += max - min;
  return {
    count,
    avgMinutes:          Math.round(totalMs / count / 60_000),
    totalHours:          Math.round(totalMs / 3_600_000 * 10) / 10,
    sessionsPerActiveDay: activeDays > 0 ? Math.round(count / activeDays * 10) / 10 : 0,
  };
}

export function buildTotalTokens(
  claudeRows: ReportRow[],
  codexRows:  ReportRow[],
): { claude: { input: number; output: number; cacheRead: number; cacheCreate: number }; codex: { input: number; output: number; cached: number } } {
  let cIn = 0, cOut = 0, cRead = 0, cCreate = 0;
  for (const r of claudeRows) {
    cIn     += r.inputTokens;
    cOut    += r.outputTokens;
    cRead   += r.cacheReadTokens;
    cCreate += r.cacheCreationTokens;
  }
  let dIn = 0, dOut = 0, dCached = 0;
  for (const r of codexRows) {
    dIn     += r.inputTokens;
    dOut    += r.outputTokens;
    dCached += r.cacheReadTokens;
  }
  return {
    claude: { input: cIn, output: cOut, cacheRead: cRead, cacheCreate: cCreate },
    codex:  { input: dIn, output: dOut, cached: dCached },
  };
}

const WEEKDAY_LABELS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export function buildHourHeatmap(
  entries: ClaudeUsageEntry[],
): { hour: number; count: number; pct: number }[] {
  const counts = new Array(24).fill(0) as number[];
  for (const e of entries) {
    counts[new Date(e.timestamp).getHours()]++; // lokale Stunde — konsistent mit den Tages-Buckets
  }
  const peak = Math.max(...counts, 1);
  return counts.map((count, hour) => ({ hour, count, pct: count / peak }));
}

export function buildWeekdayDistribution(
  entries: ClaudeUsageEntry[],
): { day: number; label: string; count: number; pct: number }[] {
  const counts = new Array(7).fill(0) as number[];
  for (const e of entries) {
    counts[new Date(e.timestamp).getDay()]++; // lokaler Wochentag — konsistent mit den Tages-Buckets
  }
  const total = counts.reduce((s, c) => s + c, 0) || 1;
  return counts.map((count, day) => ({
    day, label: WEEKDAY_LABELS[day], count, pct: count / total,
  }));
}

export function buildTopActiveDays(
  entries: ClaudeUsageEntry[],
  claudeRows: ReportRow[],
  limit: number,
): { date: string; count: number; outputTokens: number }[] {
  const countByDate = new Map<string, number>();
  for (const e of entries) {
    const d = localDayKey(e.timestamp); // lokaler Tag — passt zu den bucket-Keys aus dem Report-Layer
    countByDate.set(d, (countByDate.get(d) ?? 0) + 1);
  }
  const outputByDate = new Map(claudeRows.map(r => [r.bucket, r.outputTokens]));
  return Array.from(countByDate.entries())
    .map(([date, count]) => ({ date, count, outputTokens: outputByDate.get(date) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export function buildFiveHourPeak(
  entries: ClaudeUsageEntry[],
): { maxOutputTokens: number; maxTotalTokens: number; peakWindowStart: string | null } {
  if (entries.length === 0) return { maxOutputTokens: 0, maxTotalTokens: 0, peakWindowStart: null };

  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const timestamps = sorted.map(e => new Date(e.timestamp).getTime());

  let maxOut = 0, maxTotal = 0, peakStart: string | null = null;
  let left = 0, winOut = 0, winTotal = 0;

  for (let right = 0; right < sorted.length; right++) {
    const e = sorted[right];
    winOut   += e.outputTokens;
    winTotal += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreationTokens;

    const rightMs = timestamps[right];
    while (timestamps[left] < rightMs - FIVE_HOURS_MS) {
      winOut   -= sorted[left].outputTokens;
      winTotal -= sorted[left].inputTokens + sorted[left].outputTokens
               + sorted[left].cacheReadTokens + sorted[left].cacheCreationTokens;
      left++;
    }

    if (winOut > maxOut) {
      maxOut   = winOut;
      maxTotal = winTotal;
      peakStart = sorted[left].timestamp;
    }
  }

  return { maxOutputTokens: maxOut, maxTotalTokens: maxTotal, peakWindowStart: peakStart };
}

export interface WeeklyBucket {
  weekStart: string;
  claudeMessages: number;
  claudeTokens: number;
  claudeCostUSD: number;
  codexEvents: number;
  codexTokens: number;
}

export function buildWeeklySummary(
  claudeRows: ReportRow[],
  codexRows: ReportRow[],
  claudeEntries: ClaudeUsageEntry[],
  codexEvents: CodexTokenEvent[],
): WeeklyBucket[] {
  const init = (): WeeklyBucket => ({
    weekStart: "", claudeMessages: 0, claudeTokens: 0,
    claudeCostUSD: 0, codexEvents: 0, codexTokens: 0,
  });
  const weeks = new Map<string, WeeklyBucket>();

  const getOrCreate = (date: string) => {
    const ws = getWeekStart(date);
    if (!weeks.has(ws)) weeks.set(ws, { ...init(), weekStart: ws });
    return weeks.get(ws)!;
  };

  for (const r of claudeRows) {
    const b = getOrCreate(r.bucket);
    b.claudeTokens  += r.totalTokens;
    b.claudeCostUSD += r.costUSD;
  }
  for (const r of codexRows) {
    const b = getOrCreate(r.bucket);
    b.codexTokens += r.totalTokens;
  }
  for (const e of claudeEntries) {
    getOrCreate(e.timestamp.slice(0, 10)).claudeMessages++;
  }
  for (const e of codexEvents) {
    getOrCreate(e.timestamp.slice(0, 10)).codexEvents++;
  }

  return Array.from(weeks.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

const ACTIVE_GAP_MS = 30 * 60 * 1000;
const MIN_BLOCK_MS  = 60 * 1000;

// Tatsächliche Arbeitszeit: Union aller Entry-Timestamps über alle Sessions
// (parallele Sessions zählen nicht doppelt), aufgeteilt in Aktivitätsblöcke —
// Idle-Lücken > 30 min zählen nicht als Arbeitszeit. Liefert ungerundete Stunden.
export function computeActiveHours(entries: ClaudeUsageEntry[]): number {
  if (entries.length === 0) return 0;
  const timestamps = entries
    .map(e => new Date(e.timestamp).getTime())
    .sort((a, b) => a - b);

  let totalMs = 0;
  let blockStart = timestamps[0];
  let blockEnd   = timestamps[0];
  for (let i = 1; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (ts - blockEnd > ACTIVE_GAP_MS) {
      totalMs += Math.max(blockEnd - blockStart, MIN_BLOCK_MS);
      blockStart = ts;
    }
    blockEnd = ts;
  }
  totalMs += Math.max(blockEnd - blockStart, MIN_BLOCK_MS);
  return totalMs / 3_600_000;
}

export interface CostEfficiency {
  costPer1kOutputTokens: number;
  costPerActiveHour: number;
  subCostPerActiveHour: number;
  roiByTier: { tier: string; price: number; roi: number }[]; // roi = apiCostUSD / tierPrice (how many times the plan price you've spent)
}

export function buildCostEfficiency(
  claudeCostUSD: number,
  claudeOutputTokens: number,
  activeHours: number,
  claudePeriodSubCost = 0,
): CostEfficiency {
  return {
    costPer1kOutputTokens: claudeOutputTokens > 0
      ? (claudeCostUSD / claudeOutputTokens) * 1000 : 0,
    costPerActiveHour: activeHours > 0
      ? claudeCostUSD / activeHours : 0,
    subCostPerActiveHour: activeHours > 0 && claudePeriodSubCost > 0
      ? claudePeriodSubCost / activeHours : 0,
    roiByTier: [
      { tier: "Claude Pro",      price: 20  },
      { tier: "Claude Max",      price: 100 },
      { tier: "Claude Max 200",  price: 200 },
    ].map(t => ({ ...t, roi: t.price > 0 ? claudeCostUSD / t.price : 0 })),
  };
}

function getWeekStart(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const toMonday = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
  return new Date(d.getTime() + toMonday * 86400000).toISOString().slice(0, 10);
}

// Lokaler Tagesschlüssel (YYYY-MM-DD) aus einem ISO-Timestamp — passt zu den
// bucket-Keys des Report-Layers (lokale Kalendertage). UTC-Slicing würde Einträge
// um einen Tag verschieben.
function localDayKey(timestamp: string): string {
  const d = new Date(timestamp);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getLastNDays(n: number): string[] {
  // Local calendar days to match the local-timezone bucket keys produced by the
  // report layer; UTC slicing would shift cells by a day off-UTC.
  const pad = (v: number) => String(v).padStart(2, "0");
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return days;
}
