# Phase 3 Analytics Deep Dive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stunden-Heatmap, Wochentag-Verteilung, Top-Tage, 5h-Fenster-Peak, Wöchentlicher Verlauf und Kosteneffizienz-Analyse als neue Sektionen im Analytics-Tab einbauen.

**Architecture:** Sechs neue exportierte Funktionen in `analyticsSummary.ts` (TDD). `AnalyticsData` um `hourHeatmap`, `weekdayDistribution`, `topActiveDays`, `fiveHourPeak`, `weeklySummary`, `costEfficiency` erweitern. `analytics:get` Handler lädt zusätzlich Codex-Raw-Events (`CodexTokenEvent[]`). Neue CSS-Klassen in `index.html`. Sechs neue private Render-Funktionen in `analytics.js` bauen die Sektionen als HTML-String auf.

**Tech Stack:** Vanilla JS (kein Bundler), TypeScript (Main-Prozess), Vitest (Tests), Electron IPC, CSS-Balkencharts (kein Chart.js für Heatmap)

---

## Dateistruktur

| Datei | Aktion | Verantwortlichkeit |
|---|---|---|
| `src/main/analyticsSummary.ts` | Ändern | 6 neue Funktionen + erweitertes `AnalyticsData` Interface |
| `src/main/detailsWindow.ts` | Ändern | Codex-Events laden, alle neuen Builder-Aufrufe im `analytics:get` Handler |
| `src/renderer/index.html` | Ändern | CSS-Klassen für Heatmap, Threshold-Gauge, Weekly-Tabelle |
| `src/renderer/tabs/analytics.js` | Ändern | 6 neue Render-Funktionen + neue Sektionen in `_renderUI` |
| `tests/analyticsDeepDive.test.ts` | Neu | Tests für alle 6 neuen Backend-Funktionen |

---

## Task 1: Backend — Zeitliche Aggregation (TDD)

**Files:**
- Create: `tests/analyticsDeepDive.test.ts` (Steps 1.1–1.2)
- Modify: `src/main/analyticsSummary.ts` (Step 1.3)

Neue Funktionen:
- `buildHourHeatmap(entries: ClaudeUsageEntry[]): HourBucket[]`
- `buildWeekdayDistribution(entries: ClaudeUsageEntry[]): WeekdayBucket[]`
- `buildTopActiveDays(entries: ClaudeUsageEntry[], claudeRows: ReportRow[], limit: number): TopDay[]`

- [ ] **Step 1.1: Testdatei anlegen `tests/analyticsDeepDive.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import type { ReportRow } from "../src/reports/types";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import {
  buildHourHeatmap,
  buildWeekdayDistribution,
  buildTopActiveDays,
} from "../src/main/analyticsSummary";

function makeEntry(isoTimestamp: string, out = 0): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
    project: "p1", session: "s1",
    inputTokens: 0, outputTokens: out, cacheCreationTokens: 0, cacheReadTokens: 0,
  };
}

function makeRow(bucket: string, outputTokens: number): ReportRow {
  return {
    bucket, provider: "claude", costUSD: 0,
    inputTokens: 0, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: outputTokens, models: [], modelBreakdowns: [],
  };
}

describe("buildHourHeatmap", () => {
  it("returns exactly 24 entries for hours 0–23", () => {
    const result = buildHourHeatmap([]);
    expect(result).toHaveLength(24);
    expect(result.map(b => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("counts entries by UTC hour", () => {
    const entries = [
      makeEntry("2026-05-01T14:30:00.000Z"),
      makeEntry("2026-05-01T14:59:00.000Z"),
      makeEntry("2026-05-01T16:00:00.000Z"),
    ];
    const result = buildHourHeatmap(entries);
    expect(result[14].count).toBe(2);
    expect(result[16].count).toBe(1);
    expect(result[0].count).toBe(0);
  });

  it("sets pct=1 for peak hour, pct=0 for empty hours", () => {
    const entries = [
      makeEntry("2026-05-01T14:00:00.000Z"),
      makeEntry("2026-05-01T14:00:00.000Z"),
      makeEntry("2026-05-01T16:00:00.000Z"),
    ];
    const result = buildHourHeatmap(entries);
    expect(result[14].pct).toBe(1);
    expect(result[16].pct).toBe(0.5);
    expect(result[0].pct).toBe(0);
  });

  it("returns all pct=0 for empty input", () => {
    expect(buildHourHeatmap([]).every(b => b.pct === 0 && b.count === 0)).toBe(true);
  });
});

describe("buildWeekdayDistribution", () => {
  it("returns exactly 7 entries for days 0–6", () => {
    const result = buildWeekdayDistribution([]);
    expect(result).toHaveLength(7);
    expect(result.map(b => b.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("counts entries by UTC weekday (0=Sunday)", () => {
    // 2026-05-04 is a Monday (UTC day 1)
    // 2026-05-10 is a Sunday (UTC day 0)
    const entries = [
      makeEntry("2026-05-04T12:00:00.000Z"), // Monday
      makeEntry("2026-05-04T18:00:00.000Z"), // Monday
      makeEntry("2026-05-10T10:00:00.000Z"), // Sunday
    ];
    const result = buildWeekdayDistribution(entries);
    expect(result[1].count).toBe(2); // Monday
    expect(result[0].count).toBe(1); // Sunday
    expect(result[2].count).toBe(0); // Tuesday
  });

  it("computes pct as share of total entries", () => {
    const entries = [
      makeEntry("2026-05-04T12:00:00.000Z"), // Monday
      makeEntry("2026-05-04T18:00:00.000Z"), // Monday
    ];
    const result = buildWeekdayDistribution(entries);
    expect(result[1].pct).toBeCloseTo(1.0);
    expect(result[0].pct).toBe(0);
  });

  it("labels are German day names starting with Sonntag", () => {
    const result = buildWeekdayDistribution([]);
    expect(result[0].label).toBe("Sonntag");
    expect(result[1].label).toBe("Montag");
    expect(result[6].label).toBe("Samstag");
  });
});

describe("buildTopActiveDays", () => {
  it("returns at most limit entries", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-02T10:00:00.000Z"),
      makeEntry("2026-05-03T10:00:00.000Z"),
    ];
    expect(buildTopActiveDays(entries, [], 2)).toHaveLength(2);
  });

  it("sorts by count descending", () => {
    const entries = [
      makeEntry("2026-05-01T10:00:00.000Z"),
      makeEntry("2026-05-02T10:00:00.000Z"),
      makeEntry("2026-05-02T11:00:00.000Z"),
    ];
    const result = buildTopActiveDays(entries, [], 3);
    expect(result[0].date).toBe("2026-05-02");
    expect(result[0].count).toBe(2);
    expect(result[1].date).toBe("2026-05-01");
  });

  it("picks outputTokens from claudeRows by date", () => {
    const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
    const rows = [makeRow("2026-05-01", 500)];
    const result = buildTopActiveDays(entries, rows, 5);
    expect(result[0].outputTokens).toBe(500);
  });

  it("returns 0 outputTokens if no matching row", () => {
    const entries = [makeEntry("2026-05-01T10:00:00.000Z")];
    const result = buildTopActiveDays(entries, [], 5);
    expect(result[0].outputTokens).toBe(0);
  });
});
```

- [ ] **Step 1.2: Tests ausführen — müssen FAIL**

```powershell
npm test -- --reporter=verbose tests/analyticsDeepDive.test.ts
```

Erwartete Ausgabe: `buildHourHeatmap is not a function` o.ä.

- [ ] **Step 1.3: Drei Funktionen ans Ende von `src/main/analyticsSummary.ts` anhängen**

Vor der bestehenden `function getLastNDays` einfügen (also vor der letzten privaten Funktion, aber nach `buildTotalTokens`):

```typescript
const WEEKDAY_LABELS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export function buildHourHeatmap(
  entries: ClaudeUsageEntry[],
): { hour: number; count: number; pct: number }[] {
  const counts = new Array(24).fill(0) as number[];
  for (const e of entries) {
    counts[new Date(e.timestamp).getUTCHours()]++;
  }
  const peak = Math.max(...counts, 1);
  return counts.map((count, hour) => ({ hour, count, pct: count / peak }));
}

export function buildWeekdayDistribution(
  entries: ClaudeUsageEntry[],
): { day: number; label: string; count: number; pct: number }[] {
  const counts = new Array(7).fill(0) as number[];
  for (const e of entries) {
    counts[new Date(e.timestamp).getUTCDay()]++;
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
    const d = e.timestamp.slice(0, 10);
    countByDate.set(d, (countByDate.get(d) ?? 0) + 1);
  }
  const outputByDate = new Map(claudeRows.map(r => [r.bucket, r.outputTokens]));
  return Array.from(countByDate.entries())
    .map(([date, count]) => ({ date, count, outputTokens: outputByDate.get(date) ?? 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
```

- [ ] **Step 1.4: Tests ausführen — müssen PASS**

```powershell
npm test -- --reporter=verbose tests/analyticsDeepDive.test.ts
```

Erwartete Ausgabe: Alle neuen Tests grün.

- [ ] **Step 1.5: Gesamte Testsuite ausführen**

```powershell
npm test
```

Erwartete Ausgabe: Alle bestehenden Tests + neue Tests grün.

- [ ] **Step 1.6: Commit**

```bash
git add src/main/analyticsSummary.ts tests/analyticsDeepDive.test.ts
git commit -m "feat: add buildHourHeatmap, buildWeekdayDistribution, buildTopActiveDays"
```

---

## Task 2: Backend — 5h-Fenster-Peak (TDD)

**Files:**
- Modify: `tests/analyticsDeepDive.test.ts` (neuen `describe`-Block anhängen)
- Modify: `src/main/analyticsSummary.ts`

Neue Funktion: `buildFiveHourPeak(entries: ClaudeUsageEntry[])`

- [ ] **Step 2.1: Failing tests an `tests/analyticsDeepDive.test.ts` anhängen**

Am Ende der Datei ergänzen:

```typescript
import {
  buildHourHeatmap,
  buildWeekdayDistribution,
  buildTopActiveDays,
  buildFiveHourPeak,
} from "../src/main/analyticsSummary";
```

Die bestehende Import-Zeile für `buildFiveHourPeak` erweitern (bestehende 3 Importe bleiben):

```typescript
// Ersetze die bestehende import-Zeile durch:
import {
  buildHourHeatmap,
  buildWeekdayDistribution,
  buildTopActiveDays,
  buildFiveHourPeak,
} from "../src/main/analyticsSummary";
```

Dann am Ende der Datei anhängen:

```typescript
function makeEntryFull(isoTimestamp: string, outputTokens: number, inputTokens = 0): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
    project: "p1", session: "s1",
    inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
  };
}

describe("buildFiveHourPeak", () => {
  it("returns zeros and null for empty input", () => {
    const r = buildFiveHourPeak([]);
    expect(r.maxOutputTokens).toBe(0);
    expect(r.maxTotalTokens).toBe(0);
    expect(r.peakWindowStart).toBeNull();
  });

  it("returns single entry as its own peak", () => {
    const r = buildFiveHourPeak([makeEntryFull("2026-05-01T10:00:00.000Z", 1000, 500)]);
    expect(r.maxOutputTokens).toBe(1000);
    expect(r.maxTotalTokens).toBe(1500);
    expect(r.peakWindowStart).toBe("2026-05-01T10:00:00.000Z");
  });

  it("sums entries within 5h window", () => {
    const entries = [
      makeEntryFull("2026-05-01T10:00:00.000Z", 300),
      makeEntryFull("2026-05-01T12:00:00.000Z", 400),
      makeEntryFull("2026-05-01T14:59:00.000Z", 200), // 4h59m after first → within 5h
    ];
    const r = buildFiveHourPeak(entries);
    expect(r.maxOutputTokens).toBe(900);
  });

  it("excludes entries outside the 5h window", () => {
    const entries = [
      makeEntryFull("2026-05-01T10:00:00.000Z", 300),
      makeEntryFull("2026-05-01T15:01:00.000Z", 1000), // 5h01m later → separate window
    ];
    const r = buildFiveHourPeak(entries);
    expect(r.maxOutputTokens).toBe(1000); // second window wins
  });

  it("peakWindowStart is the first entry of the best window", () => {
    const entries = [
      makeEntryFull("2026-05-01T08:00:00.000Z", 100),
      makeEntryFull("2026-05-01T10:00:00.000Z", 500),
      makeEntryFull("2026-05-01T11:00:00.000Z", 500),
    ];
    const r = buildFiveHourPeak(entries);
    expect(r.peakWindowStart).toBe("2026-05-01T10:00:00.000Z");
  });
});
```

- [ ] **Step 2.2: Tests ausführen — müssen FAIL**

```powershell
npm test -- --reporter=verbose tests/analyticsDeepDive.test.ts
```

Erwartete Ausgabe: `buildFiveHourPeak is not a function`

- [ ] **Step 2.3: `buildFiveHourPeak` in `src/main/analyticsSummary.ts` hinzufügen**

Nach `buildTopActiveDays` und vor `getLastNDays` einfügen:

```typescript
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export function buildFiveHourPeak(
  entries: ClaudeUsageEntry[],
): { maxOutputTokens: number; maxTotalTokens: number; peakWindowStart: string | null } {
  if (entries.length === 0) return { maxOutputTokens: 0, maxTotalTokens: 0, peakWindowStart: null };

  const sorted = [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  let maxOut = 0, maxTotal = 0, peakStart: string | null = null;
  let left = 0, winOut = 0, winTotal = 0;

  for (let right = 0; right < sorted.length; right++) {
    const e = sorted[right];
    winOut   += e.outputTokens;
    winTotal += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreationTokens;

    const rightMs = new Date(e.timestamp).getTime();
    while (new Date(sorted[left].timestamp).getTime() < rightMs - FIVE_HOURS_MS) {
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
```

- [ ] **Step 2.4: Tests ausführen — müssen PASS**

```powershell
npm test -- --reporter=verbose tests/analyticsDeepDive.test.ts
```

- [ ] **Step 2.5: Gesamte Testsuite ausführen**

```powershell
npm test
```

- [ ] **Step 2.6: Commit**

```bash
git add src/main/analyticsSummary.ts tests/analyticsDeepDive.test.ts
git commit -m "feat: add buildFiveHourPeak with sliding 5h window"
```

---

## Task 3: Backend — Wöchentliche Zusammenfassung + Kosteneffizienz (TDD)

**Files:**
- Modify: `tests/analyticsDeepDive.test.ts`
- Modify: `src/main/analyticsSummary.ts`

Neue Funktionen: `buildWeeklySummary`, `buildCostEfficiency`

- [ ] **Step 3.1: Import erweitern und Tests anhängen**

Import-Zeile in `tests/analyticsDeepDive.test.ts` auf alle 6 Funktionen erweitern:

```typescript
import {
  buildHourHeatmap,
  buildWeekdayDistribution,
  buildTopActiveDays,
  buildFiveHourPeak,
  buildWeeklySummary,
  buildCostEfficiency,
} from "../src/main/analyticsSummary";
```

Codex-Event-Hilfstyp und Tests am Ende der Datei anhängen:

```typescript
import type { CodexTokenEvent } from "../src/pricing/codex-log-reader";

function makeCodexEvent(isoTimestamp: string): CodexTokenEvent {
  return {
    timestamp: isoTimestamp, model: "gpt-5.5", isFallback: false,
    session: "s1", directory: "/home",
    inputTokens: 100, cachedInputTokens: 0, outputTokens: 50,
    reasoningOutputTokens: 0, totalTokens: 150,
  };
}

describe("buildWeeklySummary", () => {
  it("groups daily rows by Monday-start week", () => {
    // 2026-05-04 = Monday, 2026-05-05 = Tuesday (same week)
    // 2026-05-11 = Monday (next week)
    const rows = [
      makeRow("2026-05-04", 0),
      makeRow("2026-05-05", 0),
      makeRow("2026-05-11", 0),
    ];
    const result = buildWeeklySummary(rows, [], [], []);
    expect(result).toHaveLength(2);
    expect(result[0].weekStart).toBe("2026-05-04");
    expect(result[1].weekStart).toBe("2026-05-11");
  });

  it("sums claudeTokens and claudeCostUSD from rows", () => {
    const rows = [
      { ...makeRow("2026-05-04", 200), totalTokens: 500, costUSD: 3.5 } as ReportRow,
      { ...makeRow("2026-05-05", 100), totalTokens: 300, costUSD: 1.5 } as ReportRow,
    ];
    const result = buildWeeklySummary(rows, [], [], []);
    expect(result[0].claudeTokens).toBe(800);
    expect(result[0].claudeCostUSD).toBeCloseTo(5.0);
  });

  it("counts claudeMessages from entries", () => {
    const entries = [
      makeEntry("2026-05-04T10:00:00.000Z"),
      makeEntry("2026-05-04T11:00:00.000Z"),
      makeEntry("2026-05-11T10:00:00.000Z"),
    ];
    const result = buildWeeklySummary([], [], entries, []);
    const week1 = result.find(w => w.weekStart === "2026-05-04");
    expect(week1?.claudeMessages).toBe(2);
  });

  it("counts codexEvents from codex events", () => {
    const events = [
      makeCodexEvent("2026-05-04T10:00:00.000Z"),
      makeCodexEvent("2026-05-04T12:00:00.000Z"),
    ];
    const result = buildWeeklySummary([], [], [], events);
    expect(result[0].codexEvents).toBe(2);
  });

  it("returns weeks sorted oldest first", () => {
    const rows = [makeRow("2026-05-11", 0), makeRow("2026-05-04", 0)];
    const result = buildWeeklySummary(rows, [], [], []);
    expect(result[0].weekStart < result[1].weekStart).toBe(true);
  });
});

describe("buildCostEfficiency", () => {
  it("computes costPer1kOutputTokens", () => {
    const r = buildCostEfficiency(10, 100_000, 5);
    expect(r.costPer1kOutputTokens).toBeCloseTo(0.1);
  });

  it("returns 0 costPer1kOutputTokens when outputTokens=0", () => {
    expect(buildCostEfficiency(10, 0, 5).costPer1kOutputTokens).toBe(0);
  });

  it("computes costPerActiveHour", () => {
    const r = buildCostEfficiency(50, 1_000_000, 10);
    expect(r.costPerActiveHour).toBeCloseTo(5);
  });

  it("returns 0 costPerActiveHour when totalHours=0", () => {
    expect(buildCostEfficiency(10, 100_000, 0).costPerActiveHour).toBe(0);
  });

  it("returns exactly 3 ROI tier entries", () => {
    expect(buildCostEfficiency(200, 1_000_000, 10).roiByTier).toHaveLength(3);
  });

  it("computes ROI correctly for Pro tier", () => {
    const r = buildCostEfficiency(200, 1_000_000, 10);
    const pro = r.roiByTier.find(t => t.tier === "Claude Pro")!;
    expect(pro.price).toBe(20);
    expect(pro.roi).toBeCloseTo(10);
  });
});
```

- [ ] **Step 3.2: Tests ausführen — müssen FAIL**

```powershell
npm test -- --reporter=verbose tests/analyticsDeepDive.test.ts
```

- [ ] **Step 3.3: `buildWeeklySummary` und `buildCostEfficiency` in `analyticsSummary.ts` hinzufügen**

Neuen Import oben in der Datei ergänzen:

```typescript
import type { CodexTokenEvent } from "../pricing/codex-log-reader";
```

Dann die zwei Funktionen nach `buildFiveHourPeak` und vor `getLastNDays` einfügen:

```typescript
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

export interface CostEfficiency {
  costPer1kOutputTokens: number;
  costPerActiveHour: number;
  roiByTier: { tier: string; price: number; roi: number }[];
}

export function buildCostEfficiency(
  claudeCostUSD: number,
  claudeOutputTokens: number,
  sessionTotalHours: number,
): CostEfficiency {
  return {
    costPer1kOutputTokens: claudeOutputTokens > 0
      ? (claudeCostUSD / claudeOutputTokens) * 1000 : 0,
    costPerActiveHour: sessionTotalHours > 0
      ? claudeCostUSD / sessionTotalHours : 0,
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
```

- [ ] **Step 3.4: Tests ausführen — müssen PASS**

```powershell
npm test -- --reporter=verbose tests/analyticsDeepDive.test.ts
```

- [ ] **Step 3.5: Gesamte Testsuite ausführen**

```powershell
npm test
```

- [ ] **Step 3.6: Commit**

```bash
git add src/main/analyticsSummary.ts tests/analyticsDeepDive.test.ts
git commit -m "feat: add buildWeeklySummary, buildCostEfficiency, getWeekStart helper"
```

---

## Task 4: `AnalyticsData` Interface + `analytics:get` IPC Update

**Files:**
- Modify: `src/main/analyticsSummary.ts`
- Modify: `src/main/detailsWindow.ts`

- [ ] **Step 4.1: `AnalyticsData` Interface in `analyticsSummary.ts` erweitern**

Das bestehende `AnalyticsData` Interface (beginnt bei `export interface AnalyticsData extends AnalyticsSummary`) um folgende Felder ergänzen:

```typescript
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
```

- [ ] **Step 4.2: Import in `detailsWindow.ts` erweitern**

Bestehende Import-Zeile ersetzen:

```typescript
import {
  computeActiveDays, buildSparkline7d, buildTopModels,
  computeAvgSessionMinutes, computeCacheHitRate,
  buildDailyBuckets, buildSessionStats, buildTotalTokens,
  buildHourHeatmap, buildWeekdayDistribution, buildTopActiveDays,
  buildFiveHourPeak, buildWeeklySummary, buildCostEfficiency,
  type AnalyticsSummary, type AnalyticsData,
} from "./analyticsSummary";
```

Ebenfalls am Anfang der Datei ergänzen (nach den bestehenden Imports):

```typescript
import { readCodexTokensForPeriod } from "../pricing/codex-log-reader";
import { getCodexSessionsDirs } from "../config/paths";
```

- [ ] **Step 4.3: `analytics:get` Handler in `detailsWindow.ts` erweitern**

Den bestehenden `analytics:get` Handler vollständig ersetzen:

```typescript
    ipcMain.handle("analytics:get", async () => {
      const settings = await loadSettings();
      const windowDays = 30;
      const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const periodStart = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

      const [claudeReport, codexReport] = await Promise.all([
        generateUsageReport({ type: "daily", provider: "claude", since, order: "asc", breakdown: true }, { settings }),
        generateUsageReport({ type: "daily", provider: "codex",  since, order: "asc", breakdown: true }, { settings }),
      ]);

      const [claudeEntries, codexEvents] = await Promise.all([
        readClaudeUsageEntriesForPeriod(getClaudeProjectsDirs(), periodStart),
        readCodexTokensForPeriod(getCodexSessionsDirs(), periodStart),
      ]);

      const activeDays        = computeActiveDays(claudeReport.rows, codexReport.rows);
      const sparkline7d       = buildSparkline7d(claudeReport.rows, codexReport.rows);
      const topModels         = buildTopModels(claudeReport.rows, codexReport.rows, 5);
      const avgSessionMinutes = computeAvgSessionMinutes(claudeEntries);
      const cacheHitRate      = computeCacheHitRate(this.lastSnapshots);
      const dailyBuckets      = buildDailyBuckets(claudeReport.rows, codexReport.rows, windowDays);
      const sessionStats      = buildSessionStats(claudeEntries, activeDays);
      const totalTokens       = buildTotalTokens(claudeReport.rows, codexReport.rows);
      const hourHeatmap       = buildHourHeatmap(claudeEntries);
      const weekdayDistribution = buildWeekdayDistribution(claudeEntries);
      const topActiveDays     = buildTopActiveDays(claudeEntries, claudeReport.rows, 5);
      const fiveHourPeak      = buildFiveHourPeak(claudeEntries);
      const weeklySummary     = buildWeeklySummary(claudeReport.rows, codexReport.rows, claudeEntries, codexEvents);
      const costEfficiency    = buildCostEfficiency(
        claudeReport.totals.costUSD,
        totalTokens.claude.output,
        sessionStats.totalHours,
      );

      const claudeCost = claudeReport.totals.costUSD;
      const codexCost  = codexReport.totals.costUSD;
      const claudeSub  = settings.subscriptionCosts.claude;
      const codexSub   = settings.subscriptionCosts.codex;

      return {
        apiCostUSD:          { claude: claudeCost, codex: codexCost, total: claudeCost + codexCost },
        subscriptionCostUSD: { claude: claudeSub,  codex: codexSub,  total: claudeSub  + codexSub  },
        roiFactor: {
          claude:   claudeSub  > 0 ? claudeCost  / claudeSub  : 0,
          codex:    codexSub   > 0 ? codexCost   / codexSub   : 0,
          combined: (claudeSub + codexSub) > 0 ? (claudeCost + codexCost) / (claudeSub + codexSub) : 0,
        },
        activeDays, avgSessionMinutes, cacheHitRate, sparkline7d, topModels, windowDays,
        dailyBuckets, sessionStats, totalTokens,
        hourHeatmap, weekdayDistribution, topActiveDays, fiveHourPeak, weeklySummary, costEfficiency,
      } satisfies AnalyticsData;
    });
```

- [ ] **Step 4.4: TypeScript-Build prüfen**

```powershell
npm run build
```

Erwartete Ausgabe: Keine Fehler.

- [ ] **Step 4.5: Tests ausführen**

```powershell
npm test
```

- [ ] **Step 4.6: Commit**

```bash
git add src/main/analyticsSummary.ts src/main/detailsWindow.ts
git commit -m "feat: extend AnalyticsData with phase3 fields, load codex events in analytics:get"
```

---

## Task 5: CSS-Erweiterungen in `index.html`

**Files:**
- Modify: `src/renderer/index.html`

Alle neuen CSS-Klassen direkt am Ende des `/* ══ ANALYTICS ══ */` Blocks einfügen — also vor der Zeile `/* ══ FOOTER ══ */`.

- [ ] **Step 5.1: CSS-Block einfügen**

Direkt vor `/* ══ FOOTER ══ */` einfügen:

```css
    /* ══ ANALYTICS PHASE 3 ═════════════════════════════════════ */
    .an-heatmap { display: flex; flex-direction: column; gap: 2px; }
    .an-heatmap-row { display: flex; align-items: center; gap: 5px; }
    .an-heatmap-lbl {
      width: 26px; flex-shrink: 0; text-align: right;
      font-family: 'IBM Plex Mono', monospace; font-size: 8px; color: var(--t400);
    }
    .an-heatmap-track {
      flex: 1; height: 7px; background: rgba(255,255,255,0.04); border-radius: 2px;
    }
    .an-heatmap-fill { height: 100%; border-radius: 2px; background: #f59830; opacity: 0.75; }
    .an-heatmap-count {
      width: 32px; flex-shrink: 0; text-align: right;
      font-family: 'IBM Plex Mono', monospace; font-size: 8px; color: var(--t400);
    }

    .an-wkday-row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .an-wkday-lbl { width: 56px; flex-shrink: 0; font-size: 9.5px; color: var(--t300); }
    .an-wkday-track {
      flex: 1; height: 7px; background: rgba(255,255,255,0.04); border-radius: 2px;
    }
    .an-wkday-fill { height: 100%; border-radius: 2px; background: #52d017; opacity: 0.75; }
    .an-wkday-pct {
      width: 30px; flex-shrink: 0; text-align: right;
      font-family: 'IBM Plex Mono', monospace; font-size: 8px; color: var(--t400);
    }

    .an-top-days { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
    .an-top-day-row { display: flex; align-items: baseline; gap: 6px; font-size: 10px; }
    .an-top-day-date {
      font-family: 'IBM Plex Mono', monospace; font-size: 9px;
      color: var(--t300); flex-shrink: 0;
    }
    .an-top-day-count { font-weight: 600; color: var(--t100); }
    .an-top-day-tokens { color: var(--t400); font-size: 9px; margin-left: auto; }

    .an-peak-hero {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 24px; font-weight: 500; font-variant-numeric: tabular-nums;
      color: var(--t100); line-height: 1;
    }
    .an-peak-sub { font-size: 9px; color: var(--t400); margin: 3px 0 10px; }
    .an-threshold { display: flex; flex-direction: column; gap: 5px; }
    .an-threshold-row { display: flex; align-items: center; gap: 8px; }
    .an-threshold-lbl {
      width: 88px; flex-shrink: 0; font-size: 10px; color: var(--t300);
    }
    .an-threshold-track {
      flex: 1; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden;
    }
    .an-threshold-fill { height: 100%; border-radius: 3px; }
    .an-threshold-pct {
      width: 44px; flex-shrink: 0; text-align: right;
      font-family: 'IBM Plex Mono', monospace; font-size: 10px;
      font-variant-numeric: tabular-nums; color: var(--t200);
    }

    .an-weekly-table {
      width: 100%; border-collapse: collapse; font-size: 10px;
    }
    .an-weekly-table th {
      font-size: 8px; font-weight: 600; letter-spacing: 0.09em;
      text-transform: uppercase; color: var(--t400);
      padding: 3px 5px; text-align: right; border-bottom: 1px solid var(--border);
    }
    .an-weekly-table th:first-child { text-align: left; }
    .an-weekly-table td {
      padding: 4px 5px; color: var(--t200);
      font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums;
      text-align: right; border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .an-weekly-table td:first-child {
      font-family: 'DM Sans', system-ui, sans-serif; text-align: left; color: var(--t300);
    }
    .an-weekly-table tr:last-child td { border-bottom: none; }

    .an-roi-table { width: 100%; border-collapse: collapse; font-size: 10px; }
    .an-roi-table th {
      font-size: 8px; font-weight: 600; letter-spacing: 0.09em;
      text-transform: uppercase; color: var(--t400);
      padding: 3px 6px; text-align: left; border-bottom: 1px solid var(--border);
    }
    .an-roi-table th:last-child { text-align: right; }
    .an-roi-table td {
      padding: 5px 6px; color: var(--t200);
      border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 10px;
    }
    .an-roi-table td:last-child {
      font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .an-roi-table tr:last-child td { border-bottom: none; }
```

- [ ] **Step 5.2: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: add phase3 analytics CSS (heatmap, threshold gauge, weekly table, roi table)"
```

---

## Task 6: Frontend — Zeitliche Analyse + 5h-Fenster in `analytics.js`

**Files:**
- Modify: `src/renderer/tabs/analytics.js`

- [ ] **Step 6.1: Neue Sektionen in `_renderUI` einfügen**

Das bestehende `container.innerHTML = \`...\`` Template in `_renderUI` erweitern. Nach der letzten bestehenden Sektion (`AKTIVITÄTSSTATS`) folgende Abschnitte anhängen (innerhalb des Template-Strings):

```javascript
    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">STUNDEN-HEATMAP (UTC, 30D)</span></div>
        <div id="an-hour-heatmap"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">WOCHENTAG (30D)</span></div>
        <div id="an-weekday-bars"></div>
        <div class="an-section-head" style="margin-top:8px"><span class="an-section-title">TOP 5 TAGE</span></div>
        <div id="an-top-days"></div>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">5H-FENSTER-PEAK (CLAUDE, 30D)</span></div>
      <div id="an-peak"></div>
    </div>
```

Sowie am Ende von `_renderUI` (nach `_buildStats(data)`) die neuen Render-Aufrufe:

```javascript
  _buildHourHeatmap(data);
  _buildWeekdayBars(data);
  _buildTopDays(data);
  _buildFiveHourPeak(data);
```

- [ ] **Step 6.2: `_buildHourHeatmap` Funktion hinzufügen**

Nach `_buildStats` am Ende der Datei einfügen:

```javascript
function _buildHourHeatmap(data) {
  const el = document.getElementById('an-hour-heatmap');
  if (!el) return;
  const buckets = data.hourHeatmap ?? [];
  if (buckets.every(b => b.count === 0)) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px;padding:4px 0">Keine Daten</div>';
    return;
  }
  el.innerHTML = '<div class="an-heatmap">' + buckets.map(b => `
    <div class="an-heatmap-row">
      <span class="an-heatmap-lbl">H${String(b.hour).padStart(2, '0')}</span>
      <div class="an-heatmap-track">
        <div class="an-heatmap-fill" style="width:${(b.pct * 100).toFixed(1)}%"></div>
      </div>
      <span class="an-heatmap-count">${b.count}</span>
    </div>
  `).join('') + '</div>';
}
```

- [ ] **Step 6.3: `_buildWeekdayBars` Funktion hinzufügen**

```javascript
function _buildWeekdayBars(data) {
  const el = document.getElementById('an-weekday-bars');
  if (!el) return;
  const dist = data.weekdayDistribution ?? [];
  el.innerHTML = dist.map(d => `
    <div class="an-wkday-row">
      <span class="an-wkday-lbl">${QB.esc(d.label)}</span>
      <div class="an-wkday-track">
        <div class="an-wkday-fill" style="width:${(d.pct * 100).toFixed(1)}%"></div>
      </div>
      <span class="an-wkday-pct">${(d.pct * 100).toFixed(0)}%</span>
    </div>
  `).join('');
}
```

- [ ] **Step 6.4: `_buildTopDays` Funktion hinzufügen**

```javascript
function _buildTopDays(data) {
  const el = document.getElementById('an-top-days');
  if (!el) return;
  const days = data.topActiveDays ?? [];
  if (!days.length) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px">Keine Daten</div>';
    return;
  }
  el.innerHTML = '<div class="an-top-days">' + days.map(d => `
    <div class="an-top-day-row">
      <span class="an-top-day-date">${QB.esc(d.date)}</span>
      <span class="an-top-day-count">${d.count} Calls</span>
      <span class="an-top-day-tokens">${QB.fmtTokens(d.outputTokens)} out</span>
    </div>
  `).join('') + '</div>';
}
```

- [ ] **Step 6.5: `_buildFiveHourPeak` Funktion hinzufügen**

```javascript
const _FIVE_HOUR_THRESHOLDS = [
  { label: '200k Output', limit: 200_000 },
  { label: '500k Output', limit: 500_000 },
  { label: '800k Output', limit: 800_000 },
];

function _buildFiveHourPeak(data) {
  const el = document.getElementById('an-peak');
  if (!el) return;
  const peak = data.fiveHourPeak ?? { maxOutputTokens: 0, maxTotalTokens: 0, peakWindowStart: null };

  const dateStr = peak.peakWindowStart
    ? new Date(peak.peakWindowStart).toLocaleDateString('de-AT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
    : '—';

  const thresholdRows = _FIVE_HOUR_THRESHOLDS.map(t => {
    const pct = Math.min(peak.maxOutputTokens / t.limit, 1);
    const color = pct >= 1 ? '#e55' : pct >= 0.7 ? '#f59830' : '#52d017';
    return `
      <div class="an-threshold-row">
        <span class="an-threshold-lbl">${QB.esc(t.label)}</span>
        <div class="an-threshold-track">
          <div class="an-threshold-fill" style="width:${(pct * 100).toFixed(1)}%;background:${color}"></div>
        </div>
        <span class="an-threshold-pct" style="color:${color}">${(pct * 100).toFixed(0)}%</span>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="an-peak-hero">${QB.fmtTokens(peak.maxOutputTokens)}</div>
    <div class="an-peak-sub">Output-Token · Fenster: ${QB.esc(dateStr)} · Gesamt ${QB.fmtTokens(peak.maxTotalTokens)}</div>
    <div class="an-threshold">${thresholdRows}</div>
  `;
}
```

- [ ] **Step 6.6: Commit**

```bash
git add src/renderer/tabs/analytics.js
git commit -m "feat(analytics): add hour heatmap, weekday bars, top days, 5h peak sections"
```

---

## Task 7: Frontend — Wöchentlicher Verlauf + Kosteneffizienz in `analytics.js`

**Files:**
- Modify: `src/renderer/tabs/analytics.js`

- [ ] **Step 7.1: Neue Sektionen in `_renderUI` einfügen**

Nach der 5h-Fenster-Sektion (nach `<div id="an-peak"></div>\n    </div>`) folgende Abschnitte anhängen:

```javascript
    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">WÖCHENTLICHER VERLAUF (30D)</span></div>
      <div id="an-weekly"></div>
    </div>

    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">KOSTENEFFIZIENZ</span></div>
        <div id="an-cost-eff"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">ROI NACH ABO-TIER</span></div>
        <div id="an-roi-tiers"></div>
      </div>
    </div>
```

Am Ende von `_renderUI` (nach `_buildFiveHourPeak(data)`) anhängen:

```javascript
  _buildWeeklySummary(data);
  _buildCostEfficiency(data);
```

- [ ] **Step 7.2: `_buildWeeklySummary` Funktion hinzufügen**

```javascript
function _buildWeeklySummary(data) {
  const el = document.getElementById('an-weekly');
  if (!el) return;
  const weeks = data.weeklySummary ?? [];
  if (!weeks.length) {
    el.innerHTML = '<div style="color:var(--t400);font-size:10px;padding:4px 0">Keine Daten</div>';
    return;
  }
  el.innerHTML = `
    <table class="an-weekly-table">
      <thead>
        <tr>
          <th>Woche ab</th>
          <th>Claude Msg</th>
          <th>Claude Token</th>
          <th>Kosten</th>
          <th>Codex Ev.</th>
        </tr>
      </thead>
      <tbody>
        ${weeks.map(w => {
          const d = new Date(w.weekStart + 'T00:00:00Z');
          const label = d.toLocaleDateString('de-AT', { day: '2-digit', month: 'short', timeZone: 'UTC' });
          return `
            <tr>
              <td>${QB.esc(label)}</td>
              <td>${w.claudeMessages}</td>
              <td>${QB.fmtTokens(w.claudeTokens)}</td>
              <td>$${w.claudeCostUSD.toFixed(2)}</td>
              <td>${w.codexEvents}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}
```

- [ ] **Step 7.3: `_buildCostEfficiency` Funktion hinzufügen**

```javascript
function _buildCostEfficiency(data) {
  const elTiles = document.getElementById('an-cost-eff');
  const elRoi   = document.getElementById('an-roi-tiers');
  const eff = data.costEfficiency ?? { costPer1kOutputTokens: 0, costPerActiveHour: 0, roiByTier: [] };

  if (elTiles) {
    const tiles = [
      { lbl: '$/1k Output',   val: `$${eff.costPer1kOutputTokens.toFixed(3)}` },
      { lbl: '$/Arbeitsstd',  val: `$${eff.costPerActiveHour.toFixed(2)}` },
    ];
    elTiles.innerHTML = `<div class="an-stats-grid" style="grid-template-columns:1fr 1fr">` +
      tiles.map(t => `
        <div class="an-stat-tile">
          <div class="an-stat-lbl">${QB.esc(t.lbl)}</div>
          <div class="an-stat-val">${QB.esc(t.val)}</div>
        </div>
      `).join('') + '</div>';
  }

  if (elRoi) {
    elRoi.innerHTML = `
      <table class="an-roi-table">
        <thead><tr><th>Abo</th><th>Preis/Mo</th><th>ROI</th></tr></thead>
        <tbody>
          ${(eff.roiByTier ?? []).map(t => {
            const color = t.roi >= 5 ? '#52d017' : t.roi >= 1 ? '#f59830' : '#e55';
            return `
              <tr>
                <td>${QB.esc(t.tier)}</td>
                <td>$${t.price}</td>
                <td style="color:${color}">${t.roi.toFixed(1)}×</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }
}
```

- [ ] **Step 7.4: Commit**

```bash
git add src/renderer/tabs/analytics.js
git commit -m "feat(analytics): add weekly summary table and cost efficiency / ROI sections"
```

---

## Task 8: Gesamte Testsuite + Build-Verifikation

- [ ] **Step 8.1: TypeScript-Build**

```powershell
npm run build
```

Erwartete Ausgabe: Keine Fehler.

- [ ] **Step 8.2: Alle Tests**

```powershell
npm test
```

Erwartete Ausgabe: Alle Tests grün (inkl. neue Tests aus Tasks 1–3).

- [ ] **Step 8.3: App manuell testen**

```powershell
npm run dev
```

Prüfliste:
- [ ] Analytics-Tab öffnet ohne Fehler
- [ ] Stunden-Heatmap zeigt 24 Balken (H00–H23) mit sichtbaren Peaks
- [ ] Wochentag-Verteilung zeigt 7 Balken mit deutschen Tags
- [ ] Top 5 Tage zeigt Datum, Call-Anzahl, Output-Token
- [ ] 5h-Fenster: `an-peak-hero` zeigt Token-Wert, 3 Threshold-Balken farbkodiert (grün/orange/rot)
- [ ] Wöchentlicher Verlauf: 5 Zeilen mit Kosten, Nachrichten, Tokens
- [ ] Kosteneffizienz: 2 Kacheln ($/1k Output, $/Arbeitsstd)
- [ ] ROI-Tabelle: 3 Zeilen (Pro/Max/Max200) mit farbkodierten ROI-Werten
- [ ] 7D/30D-Toggle: Line Chart wechselt, alle anderen Sektionen bleiben stabil

- [ ] **Step 8.4: Finaler Commit**

```bash
git add -A
git commit -m "feat(phase3): complete analytics deep dive with heatmap, 5h peak, weekly summary, cost efficiency"
```

---

## Spec-Coverage-Check

| Feature aus Benutzer-Beispiel | Task |
|---|---|
| Stunden-Heatmap (H00–H23, UTC) | Tasks 1 + 5 + 6 |
| Wochentag-Verteilung mit % | Tasks 1 + 5 + 6 |
| Top aktive Tage (Datum, Calls, Output-Token) | Tasks 1 + 5 + 6 |
| 5h-Fenster-Peak mit Schwellenwert-Balken | Tasks 2 + 5 + 6 |
| Wöchentlicher Verlauf (Nachrichten, Tokens, Kosten) | Tasks 3 + 5 + 7 |
| Kosteneffizienz ($/1k Output, $/Stunde) | Tasks 3 + 5 + 7 |
| ROI nach Abo-Tier (Pro/Max/Max200) | Tasks 3 + 5 + 7 |
| Alle neuen Backend-Funktionen TDD-getestet | Tasks 1–3 |
| TypeScript-Build sauber | Task 4 + 8 |
