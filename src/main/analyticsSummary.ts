import type { ReportRow } from "../reports/types";
import type { ClaudeUsageEntry } from "../pricing/jsonl-reader";
import type { UsageSnapshot } from "../providers/types";
import type { CodexTokenEvent } from "../pricing/codex-log-reader";
import type { PlanChangePoint } from "../pricing/plan-cost";
import type { PressureDist } from "../usage/windowHistory";

// Provider-neutrale Aktivitäts-Sicht auf einen Usage-Eintrag. Sowohl Claude-
// (project/session) als auch Codex-Events (directory→project) werden hierauf
// gemappt, damit die zeit-/session-basierten Aggregationen für beide Anbieter
// (und die kombinierte "all"-Sicht) dieselbe Logik nutzen können.
export interface ActivityEntry {
  timestamp: string;
  project: string;   // bei "all" provider-präfixiert, damit Keys nicht kollidieren
  session: string;
  outputTokens: number;
}

// Eine pro-Anbieter aufgeschlüsselte Kennzahl plus kombinierte "all"-Sicht.
export interface ProviderTriple<T> {
  claude: T;
  codex: T;
  all: T;
}

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
  const map = new Map<string, { model: string; provider: "claude" | "codex"; costUSD: number }>();
  for (const row of [...claudeRows, ...codexRows]) {
    for (const mb of row.modelBreakdowns ?? []) {
      const key = `${row.provider}\0${mb.model}`;
      const existing = map.get(key);
      if (existing) {
        existing.costUSD += mb.costUSD;
      } else {
        map.set(key, { model: mb.model, provider: row.provider, costUSD: mb.costUSD });
      }
    }
  }
  const total = Array.from(map.values()).reduce((s, m) => s + m.costUSD, 0);
  return Array.from(map.values())
    .map(({ model, provider, costUSD }) => ({
      model,
      provider,
      costUSD,
      pctOfTotal: total > 0 ? costUSD / total : 0,
    }))
    .sort((a, b) => b.costUSD - a.costUSD)
    .slice(0, limit);
}

export function computeAvgSessionMinutes(entries: ClaudeUsageEntry[]): number {
  const sessionMap = new Map<string, { min: number; max: number; count: number }>();
  for (const entry of entries) {
    const ts  = new Date(entry.timestamp).getTime();
    const key = `${entry.project}\0${entry.session}`;
    const ex  = sessionMap.get(key);
    if (!ex) {
      sessionMap.set(key, { min: ts, max: ts, count: 1 });
    } else {
      if (ts < ex.min) ex.min = ts;
      if (ts > ex.max) ex.max = ts;
      ex.count++;
    }
  }
  if (sessionMap.size === 0) return 0;
  let totalMs = 0;
  let measured = 0;
  for (const { min, max, count } of sessionMap.values()) {
    if (count < 2 || max <= min) continue;
    totalMs += max - min;
    measured++;
  }
  return measured > 0 ? Math.round(totalMs / measured / 60_000) : 0;
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

export interface SessionStats {
  count: number;
  avgMinutes: number;
  totalHours: number;
  sessionsPerActiveDay: number;
}

export interface SessionDurationBucket {
  date: string;
  days: number;
  claudeMinutes: number;
  codexMinutes: number;
  allMinutes: number;
}

type SessionDurationMeta = {
  claude: { totalMs: number; count: number };
  codex: { totalMs: number; count: number };
  all: { totalMs: number; count: number };
};

const SESSION_DURATION_META = Symbol("sessionDurationMeta");

export interface AnalyticsData extends AnalyticsSummary {
  dailyBuckets: DailyBucket[];
  sessionDurationBuckets: {
    daily: SessionDurationBucket[];
    weekly: SessionDurationBucket[];
    monthly: SessionDurationBucket[];
  };
  sessionStats: ProviderTriple<SessionStats>;
  totalTokens: {
    claude: { input: number; output: number; cacheRead: number; cacheCreate: number };
    codex:  { input: number; output: number; cached: number };
  };
  // Phase 3 — pro Anbieter + kombinierte "all"-Sicht, gesteuert vom Provider-Toggle:
  hourHeatmap: ProviderTriple<{ hour: number; count: number; pct: number }[]>;
  weekdayDistribution: ProviderTriple<{ day: number; label: string; count: number; pct: number }[]>;
  topActiveDays: ProviderTriple<{ date: string; count: number; outputTokens: number }[]>;
  fiveHourPressure: ProviderTriple<PressureDist>;
  weeklySummary: WeeklyBucket[];
  costEfficiency: ProviderTriple<CostEfficiency>;
  planChanges: PlanChangePoint[];
}

export interface DailyBucket {
  date: string;
  claudeUSD: number;
  codexUSD: number;
  claudeQuotaPct: number | null;
  codexQuotaPct: number | null;
  claudeSubUSD: number;  // USD-Abokosten dieses Tages (Claude)
  codexSubUSD: number;   // USD-Abokosten dieses Tages (Codex)
}

export function buildDailyBuckets(
  claudeRows: ReportRow[],
  codexRows: ReportRow[],
  since: string,
  until: string,
): DailyBucket[] {
  const days = localDaysInRange(since, until);
  const claudeByDate = new Map(claudeRows.map(r => [r.bucket, r.costUSD]));
  const codexByDate  = new Map(codexRows.map(r  => [r.bucket, r.costUSD]));
  return days.map(date => ({
    date,
    claudeUSD:      claudeByDate.get(date) ?? 0,
    codexUSD:       codexByDate.get(date)  ?? 0,
    claudeQuotaPct: null,
    codexQuotaPct:  null,
    claudeSubUSD:   0,
    codexSubUSD:    0,
  }));
}

export function buildSessionStats(
  entries: ActivityEntry[],
  activeDays: number,
): { count: number; avgMinutes: number; totalHours: number; sessionsPerActiveDay: number } {
  const sessions = new Map<string, { min: number; max: number; count: number }>();
  for (const e of entries) {
    const ts  = new Date(e.timestamp).getTime();
    const key = `${e.project}\0${e.session}`;
    const ex  = sessions.get(key);
    if (!ex) {
      sessions.set(key, { min: ts, max: ts, count: 1 });
    } else {
      if (ts < ex.min) ex.min = ts;
      if (ts > ex.max) ex.max = ts;
      ex.count++;
    }
  }
  const count = sessions.size;
  if (count === 0) return { count: 0, avgMinutes: 0, totalHours: 0, sessionsPerActiveDay: 0 };
  let totalMs = 0;
  let measured = 0;
  for (const { min, max, count: entryCount } of sessions.values()) {
    if (entryCount < 2 || max <= min) continue;
    totalMs += max - min;
    measured++;
  }
  return {
    count,
    avgMinutes:          measured > 0 ? Math.round(totalMs / measured / 60_000) : 0,
    totalHours:          Math.round(totalMs / 3_600_000 * 10) / 10,
    sessionsPerActiveDay: activeDays > 0 ? Math.round(count / activeDays * 10) / 10 : 0,
  };
}

function emptySessionDurationMeta(): SessionDurationMeta {
  return {
    claude: { totalMs: 0, count: 0 },
    codex: { totalMs: 0, count: 0 },
    all: { totalMs: 0, count: 0 },
  };
}

function durationMinutes(part: { totalMs: number; count: number }): number {
  return part.count > 0 ? Math.round(part.totalMs / part.count / 60_000) : 0;
}

function attachSessionDurationMeta(bucket: SessionDurationBucket, meta: SessionDurationMeta): SessionDurationBucket {
  Object.defineProperty(bucket, SESSION_DURATION_META, {
    value: meta,
    enumerable: false,
    configurable: false,
  });
  return bucket;
}

function getSessionDurationMeta(bucket: SessionDurationBucket): SessionDurationMeta {
  const withMeta = bucket as SessionDurationBucket & { [SESSION_DURATION_META]?: SessionDurationMeta };
  if (withMeta[SESSION_DURATION_META]) return withMeta[SESSION_DURATION_META];
  return {
    claude: bucket.claudeMinutes > 0 ? { totalMs: bucket.claudeMinutes * 60_000, count: 1 } : { totalMs: 0, count: 0 },
    codex:  bucket.codexMinutes  > 0 ? { totalMs: bucket.codexMinutes  * 60_000, count: 1 } : { totalMs: 0, count: 0 },
    all:    bucket.allMinutes    > 0 ? { totalMs: bucket.allMinutes    * 60_000, count: 1 } : { totalMs: 0, count: 0 },
  };
}

function addSessionDurations(
  target: Map<string, SessionDurationMeta>,
  provider: keyof SessionDurationMeta,
  entries: ActivityEntry[],
): void {
  const sessions = new Map<string, { day: string; min: number; max: number; count: number }>();
  for (const entry of entries) {
    const ts = new Date(entry.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    const day = localDayKey(entry.timestamp);
    const key = `${entry.project}\0${entry.session}`;
    const ex = sessions.get(key);
    if (!ex) {
      sessions.set(key, { day, min: ts, max: ts, count: 1 });
    } else {
      if (ts < ex.min) {
        ex.min = ts;
        ex.day = day;
      }
      if (ts > ex.max) ex.max = ts;
      ex.count++;
    }
  }
  for (const session of sessions.values()) {
    if (session.count < 2 || session.max <= session.min) continue;
    const meta = target.get(session.day) ?? emptySessionDurationMeta();
    meta[provider].totalMs += session.max - session.min;
    meta[provider].count++;
    target.set(session.day, meta);
  }
}

export function buildSessionDurationBuckets(
  claudeEntries: ActivityEntry[],
  codexEntries: ActivityEntry[],
  allEntries: ActivityEntry[],
  since: string,
  until: string,
): SessionDurationBucket[] {
  const byDay = new Map<string, SessionDurationMeta>();
  addSessionDurations(byDay, "claude", claudeEntries);
  addSessionDurations(byDay, "codex", codexEntries);
  addSessionDurations(byDay, "all", allEntries);

  return localDaysInRange(since, until).map(date => {
    const meta = byDay.get(date) ?? emptySessionDurationMeta();
    return attachSessionDurationMeta({
      date,
      days: 1,
      claudeMinutes: durationMinutes(meta.claude),
      codexMinutes: durationMinutes(meta.codex),
      allMinutes: durationMinutes(meta.all),
    }, meta);
  });
}

export function aggregateSessionDurationBuckets(
  daily: SessionDurationBucket[],
  agg: "daily" | "weekly" | "monthly",
): SessionDurationBucket[] {
  if (agg === "daily") return daily;
  const keyOf = agg === "weekly"
    ? (b: SessionDurationBucket) => getWeekStart(b.date)
    : (b: SessionDurationBucket) => `${b.date.slice(0, 7)}-01`;
  const grouped = new Map<string, { date: string; days: number; meta: SessionDurationMeta }>();
  for (const bucket of daily) {
    const key = keyOf(bucket);
    let group = grouped.get(key);
    if (!group) {
      group = { date: key, days: 0, meta: emptySessionDurationMeta() };
      grouped.set(key, group);
    }
    group.days += bucket.days;
    const meta = getSessionDurationMeta(bucket);
    for (const provider of ["claude", "codex", "all"] as const) {
      group.meta[provider].totalMs += meta[provider].totalMs;
      group.meta[provider].count += meta[provider].count;
    }
  }
  return Array.from(grouped.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(group => attachSessionDurationMeta({
      date: group.date,
      days: group.days,
      claudeMinutes: durationMinutes(group.meta.claude),
      codexMinutes: durationMinutes(group.meta.codex),
      allMinutes: durationMinutes(group.meta.all),
    }, group.meta));
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
  entries: ActivityEntry[],
): { hour: number; count: number; pct: number }[] {
  const counts = new Array(24).fill(0) as number[];
  for (const e of entries) {
    counts[new Date(e.timestamp).getHours()]++; // lokale Stunde — konsistent mit den Tages-Buckets
  }
  const peak = Math.max(...counts, 1);
  return counts.map((count, hour) => ({ hour, count, pct: count / peak }));
}

export function buildWeekdayDistribution(
  entries: ActivityEntry[],
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
  entries: ActivityEntry[],
  rows: ReportRow[],
  limit: number,
): { date: string; count: number; outputTokens: number }[] {
  const countByDate = new Map<string, number>();
  for (const e of entries) {
    const d = localDayKey(e.timestamp); // lokaler Tag — passt zu den bucket-Keys aus dem Report-Layer
    countByDate.set(d, (countByDate.get(d) ?? 0) + 1);
  }
  // Über Bucket summieren (statt überschreiben), damit die kombinierte "all"-
  // Sicht mit claude+codex-Rows korrekte Output-Token pro Tag liefert.
  const outputByDate = new Map<string, number>();
  for (const r of rows) outputByDate.set(r.bucket, (outputByDate.get(r.bucket) ?? 0) + r.outputTokens);
  return Array.from(countByDate.entries())
    .map(([date, count]) => ({ date, count, outputTokens: outputByDate.get(date) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
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
export function computeActiveHours(entries: ActivityEntry[]): number {
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

// Effizienz-Kennzahlen eines einzelnen Anbieters (bzw. der kombinierten Sicht).
// Generisch über Zahlen — der Worker ruft die Funktion je Anbieter mit dessen
// Kosten/Token/Stunden/Sessions auf.
export interface CostEfficiency {
  costPer1kOutputTokens: number;
  costPerActiveHour: number;
  subCostPerActiveHour: number;
  costPerSession: number;            // costUSD / sessions
  outputTokensPerActiveHour: number; // outputTokens / activeHours
  tokensPerSession: number;          // (input+output) tokens / sessions
}

export function buildCostEfficiency(
  costUSD: number,
  outputTokens: number,
  activeHours: number,
  periodSubCost = 0,
  sessionCount = 0,
  totalTokens = 0, // input + output (cache excluded), consistent with the "Tokens" stat tile
): CostEfficiency {
  return {
    costPer1kOutputTokens: outputTokens > 0
      ? (costUSD / outputTokens) * 1000 : 0,
    costPerActiveHour: activeHours > 0
      ? costUSD / activeHours : 0,
    subCostPerActiveHour: activeHours > 0 && periodSubCost > 0
      ? periodSubCost / activeHours : 0,
    costPerSession: sessionCount > 0
      ? costUSD / sessionCount : 0,
    outputTokensPerActiveHour: activeHours > 0
      ? outputTokens / activeHours : 0,
    tokensPerSession: sessionCount > 0
      ? totalTokens / sessionCount : 0,
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
export function localDayKey(timestamp: string): string {
  const d = new Date(timestamp);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Liste der lokalen Kalendertage (YYYY-MM-DD) von `since` bis `until` (inkl.).
// Lokale Tage, konsistent mit den bucket-Keys des Report-Layers. Leeres Array
// bei ungültigen Grenzen oder until < since; gegen pathologische Bereiche gedeckelt.
export function localDaysInRange(since: string, until: string): string[] {
  const pad = (v: number) => String(v).padStart(2, "0");
  const start = new Date(`${since}T00:00:00`);
  const end   = new Date(`${until}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const days: string[] = [];
  for (let i = 0; i < 100_000; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    if (d > end) break;
    days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return days;
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
