import type { ReportRow } from "../reports/types";
import { buildWeekdayDistribution, type ActivityEntry, type AnalyticsData, type ProviderTriple, type SessionStats } from "./analyticsSummary";

interface Session { min: number; max: number; count: number }
interface Accumulator {
  hours: number[]; weekdays: number[]; days: Map<string, number>; sessions: Map<string, Session>;
}
function accumulator(): Accumulator {
  return { hours: Array<number>(24).fill(0), weekdays: Array<number>(7).fill(0), days: new Map(), sessions: new Map() };
}
function add(target: Accumulator, entry: ActivityEntry, date: Date, day: string): void {
  target.hours[date.getHours()]++;
  target.weekdays[date.getDay()]++;
  target.days.set(day, (target.days.get(day) ?? 0) + 1);
  const key = `${entry.project}\0${entry.session}`;
  const ts = date.getTime(), prior = target.sessions.get(key);
  if (prior) { prior.min = Math.min(prior.min, ts); prior.max = Math.max(prior.max, ts); prior.count++; }
  else target.sessions.set(key, { min: ts, max: ts, count: 1 });
}
function sessionStats(target: Accumulator, activeDays: number): SessionStats {
  let totalMs = 0, measured = 0;
  for (const { min, max, count } of target.sessions.values()) {
    if (count < 2 || max <= min) continue;
    totalMs += max - min; measured++;
  }
  const count = target.sessions.size;
  return { count, avgMinutes: measured ? Math.round(totalMs / measured / 60_000) : 0,
    totalHours: Math.round(totalMs / 3_600_000 * 10) / 10,
    sessionsPerActiveDay: activeDays ? Math.round(count / activeDays * 10) / 10 : 0 };
}
function topDays(target: Accumulator, rows: ReportRow[]): AnalyticsData["topActiveDays"]["all"] {
  const output = new Map<string, number>();
  for (const row of rows) output.set(row.bucket, (output.get(row.bucket) ?? 0) + row.outputTokens);
  return [...target.days].map(([date, count]) => ({ date, count, outputTokens: output.get(date) ?? 0 }))
    .sort((a, b) => b.count - a.count).slice(0, 5);
}

/** Parse activity timestamps once for provider and combined distributions/session statistics. */
export function buildActivityMetrics(claude: ActivityEntry[], codex: ActivityEntry[], activeDays: number, claudeRows: ReportRow[], codexRows: ReportRow[]) {
  const groups = { claude: accumulator(), codex: accumulator(), all: accumulator() };
  for (const [provider, entries] of [["claude", claude], ["codex", codex]] as const) {
    for (const entry of entries) {
      const date = new Date(entry.timestamp);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      add(groups[provider], entry, date, day); add(groups.all, entry, date, day);
    }
  }
  const triple = <T>(fn: (target: Accumulator) => T): ProviderTriple<T> => ({ claude: fn(groups.claude), codex: fn(groups.codex), all: fn(groups.all) });
  const labels = buildWeekdayDistribution([]).map((row) => row.label);
  return {
    sessionStats: triple((target) => sessionStats(target, activeDays)),
    hourHeatmap: triple((target) => { const peak = Math.max(...target.hours, 1); return target.hours.map((count, hour) => ({ hour, count, pct: count / peak })); }),
    weekdayDistribution: triple((target) => { const total = target.weekdays.reduce((sum, count) => sum + count, 0) || 1;
      return target.weekdays.map((count, day) => ({ day, label: labels[day], count, pct: count / total })); }),
    topActiveDays: { claude: topDays(groups.claude, claudeRows), codex: topDays(groups.codex, codexRows), all: topDays(groups.all, [...claudeRows, ...codexRows]) },
  };
}
