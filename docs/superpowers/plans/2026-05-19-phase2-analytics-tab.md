# Phase 2 Analytics-Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analytics-Tab mit Usage-Over-Time-Liniendiagramm, Usage-Breakdown-Donut, Top-Models-Tabelle und Aktivitätsstats in das Dashboard einbauen.

**Architecture:** Neuer `analytics:get` IPC-Handler liefert 30-Tage-Datenbuckets (Client sliced auf 7D). `shared/charts.js` initialisiert Chart.js-Instanzen. `tabs/analytics.js` rendert das Tab in einen `#view-analytics`-Container. Tab-Navigation ([Live][Analytics]) wird in der Titelleiste verdrahtet.

**Tech Stack:** Vanilla JS (kein Bundler), Chart.js 4.x UMD, TypeScript (Main-Prozess), Vitest (Tests), Electron IPC

---

## Dateistruktur

| Datei | Aktion | Verantwortlichkeit |
|---|---|---|
| `assets/vendor/chart.min.js` | Neu (kopiert) | Chart.js 4.x UMD-Build lokal |
| `src/renderer/shared/charts.js` | Neu | `QB.charts.createLine()` + `QB.charts.createDoughnut()` |
| `src/renderer/tabs/analytics.js` | Neu | `QB.renderAnalytics()` — gesamte Tab-UI |
| `src/renderer/index.html` | Ändern | Tab-Navigation CSS+HTML+JS, `#view-analytics` Container, neue Script-Tags |
| `src/main/analyticsSummary.ts` | Ändern | `AnalyticsData`, `buildDailyBuckets()`, `buildSessionStats()`, `buildTotalTokens()` |
| `src/main/detailsWindow.ts` | Ändern | `analytics:get` IPC-Handler |
| `tests/analyticsGet.test.ts` | Neu | Tests für `buildDailyBuckets`, `buildSessionStats`, `buildTotalTokens` |

---

## Task 1: Chart.js lokal einbinden + shared/charts.js erstellen

**Files:**
- Create: `assets/vendor/chart.min.js` (kopiert aus node_modules)
- Create: `src/renderer/shared/charts.js`

- [ ] **Step 1.1: Chart.js installieren und vendor-Datei kopieren**

```powershell
npm install --save-dev chart.js
New-Item -ItemType Directory -Force -Path "assets\vendor"
Copy-Item "node_modules\chart.js\dist\chart.umd.min.js" "assets\vendor\chart.min.js"
```

Erwartete Ausgabe: `assets/vendor/chart.min.js` existiert (~230 KB).

- [ ] **Step 1.2: Datei erstellen `src/renderer/shared/charts.js`**

```javascript
/* global QB */
'use strict';

window.QB = window.QB || {};
QB.charts = QB.charts || {};

QB.charts.createLine = function(ctx, labels, datasets) {
  return new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#b4c8d8',
          bodyColor: '#8298aa',
          padding: 8,
          callbacks: {
            label: (item) => ` ${item.dataset.label}: $${item.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.07)' },
          ticks: {
            color: '#506070',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            maxTicksLimit: 8,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          border: { color: 'rgba(255,255,255,0.07)' },
          ticks: {
            color: '#506070',
            font: { family: "'IBM Plex Mono', monospace", size: 9 },
            callback: (v) => '$' + Number(v).toFixed(0),
          },
          beginAtZero: true,
        },
      },
    },
  });
};

QB.charts.createDoughnut = function(ctx, labels, data, colors) {
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0f1319',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#b4c8d8',
          bodyColor: '#8298aa',
          callbacks: {
            label: (item) => ` ${item.label}: $${item.parsed.toFixed(2)}`,
          },
        },
      },
    },
  });
};
```

- [ ] **Step 1.3: Commit**

```bash
git add assets/vendor/chart.min.js src/renderer/shared/charts.js package.json package-lock.json
git commit -m "feat: add Chart.js vendor file and shared charts.js helpers"
```

---

## Task 2: analyticsSummary.ts erweitern + Tests

**Files:**
- Modify: `src/main/analyticsSummary.ts`
- Create: `tests/analyticsGet.test.ts`

- [ ] **Step 2.1: Failing tests schreiben**

Datei anlegen: `tests/analyticsGet.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import type { ReportRow } from "../src/reports/types";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import {
  buildDailyBuckets,
  buildSessionStats,
  buildTotalTokens,
} from "../src/main/analyticsSummary";

function makeRow(
  bucket: string,
  costUSD: number,
  provider: "claude" | "codex",
  tokens: Partial<Pick<ReportRow, "inputTokens"|"outputTokens"|"cacheReadTokens"|"cacheCreationTokens">> = {}
): ReportRow {
  return {
    bucket, provider, costUSD,
    inputTokens: tokens.inputTokens ?? 0,
    outputTokens: tokens.outputTokens ?? 0,
    cacheCreationTokens: tokens.cacheCreationTokens ?? 0,
    cacheReadTokens: tokens.cacheReadTokens ?? 0,
    totalTokens: 0, models: [], modelBreakdowns: [],
  };
}

function makeEntry(project: string, session: string, isoTimestamp: string): ClaudeUsageEntry {
  return {
    provider: "claude", timestamp: isoTimestamp, model: "claude-sonnet-4-6",
    project, session,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
  };
}

describe("buildDailyBuckets", () => {
  it("returns exactly windowDays entries", () => {
    expect(buildDailyBuckets([], [], 7)).toHaveLength(7);
    expect(buildDailyBuckets([], [], 30)).toHaveLength(30);
  });

  it("maps claudeUSD and codexUSD from report rows by date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const claudeRows = [makeRow(today, 3.5, "claude")];
    const codexRows  = [makeRow(today, 1.2, "codex")];
    const buckets = buildDailyBuckets(claudeRows, codexRows, 7);
    const todayBucket = buckets.find(b => b.date === today);
    expect(todayBucket?.claudeUSD).toBe(3.5);
    expect(todayBucket?.codexUSD).toBe(1.2);
  });

  it("fills missing days with 0", () => {
    const buckets = buildDailyBuckets([], [], 7);
    expect(buckets.every(b => b.claudeUSD === 0 && b.codexUSD === 0)).toBe(true);
  });

  it("sets claudeQuotaPct and codexQuotaPct to null", () => {
    const buckets = buildDailyBuckets([], [], 7);
    expect(buckets[0].claudeQuotaPct).toBeNull();
    expect(buckets[0].codexQuotaPct).toBeNull();
  });
});

describe("buildSessionStats", () => {
  it("returns zeros for empty entries", () => {
    const stats = buildSessionStats([], 0);
    expect(stats.count).toBe(0);
    expect(stats.avgMinutes).toBe(0);
    expect(stats.totalHours).toBe(0);
    expect(stats.sessionsPerActiveDay).toBe(0);
  });

  it("counts distinct project+session pairs", () => {
    const entries = [
      makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
      makeEntry("p1", "s1", "2026-05-01T10:30:00.000Z"),
      makeEntry("p1", "s2", "2026-05-01T11:00:00.000Z"),
      makeEntry("p2", "s1", "2026-05-01T12:00:00.000Z"),
    ];
    const stats = buildSessionStats(entries, 1);
    expect(stats.count).toBe(3);
  });

  it("computes avgMinutes from first to last timestamp per session", () => {
    const entries = [
      makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
      makeEntry("p1", "s1", "2026-05-01T11:00:00.000Z"),
    ];
    const stats = buildSessionStats(entries, 1);
    expect(stats.avgMinutes).toBe(60);
  });

  it("computes sessionsPerActiveDay", () => {
    const entries = [
      makeEntry("p1", "s1", "2026-05-01T10:00:00.000Z"),
      makeEntry("p1", "s2", "2026-05-01T11:00:00.000Z"),
    ];
    const stats = buildSessionStats(entries, 2);
    expect(stats.sessionsPerActiveDay).toBe(1);
  });
});

describe("buildTotalTokens", () => {
  it("sums tokens across all claude rows", () => {
    const rows = [
      makeRow("2026-05-01", 1, "claude", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheCreationTokens: 10 }),
      makeRow("2026-05-02", 2, "claude", { inputTokens: 300, outputTokens: 100 }),
    ];
    const totals = buildTotalTokens(rows, []);
    expect(totals.claude.input).toBe(400);
    expect(totals.claude.output).toBe(150);
    expect(totals.claude.cacheRead).toBe(200);
    expect(totals.claude.cacheCreate).toBe(10);
  });

  it("sums tokens across all codex rows", () => {
    const rows = [
      makeRow("2026-05-01", 1, "codex", { inputTokens: 500, outputTokens: 200, cacheReadTokens: 50 }),
    ];
    const totals = buildTotalTokens([], rows);
    expect(totals.codex.input).toBe(500);
    expect(totals.codex.output).toBe(200);
    expect(totals.codex.cached).toBe(50);
  });

  it("returns zeros for empty inputs", () => {
    const totals = buildTotalTokens([], []);
    expect(totals.claude.input).toBe(0);
    expect(totals.codex.output).toBe(0);
  });
});
```

- [ ] **Step 2.2: Tests ausführen — müssen FAIL**

```powershell
npm test -- --reporter=verbose tests/analyticsGet.test.ts
```

Erwartete Ausgabe: Fehler wie `"buildDailyBuckets" is not exported from ...`

- [ ] **Step 2.3: Funktionen in `src/main/analyticsSummary.ts` hinzufügen**

Am Ende der Datei folgendes anhängen:

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

function getLastNDays(n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return days;
}
```

Hinweis: Die bestehende `getLast7Days()`-Funktion in der Datei lassen. `buildSparkline7d` nutzt sie weiterhin.

- [ ] **Step 2.4: Tests ausführen — müssen PASS**

```powershell
npm test -- --reporter=verbose tests/analyticsGet.test.ts
```

Erwartete Ausgabe: Alle Tests grün.

- [ ] **Step 2.5: Gesamte Testsuite ausführen**

```powershell
npm test
```

Erwartete Ausgabe: Alle bestehenden Tests weiterhin grün.

- [ ] **Step 2.6: Commit**

```bash
git add src/main/analyticsSummary.ts tests/analyticsGet.test.ts
git commit -m "feat: add buildDailyBuckets, buildSessionStats, buildTotalTokens to analyticsSummary"
```

---

## Task 3: `analytics:get` IPC-Handler in detailsWindow.ts

**Files:**
- Modify: `src/main/detailsWindow.ts`

- [ ] **Step 3.1: Import in `detailsWindow.ts` erweitern**

Am Anfang der Datei die bestehende Import-Zeile von `analyticsSummary` ersetzen:

Alte Zeile (ca. Zeile 12–16):
```typescript
import {
  computeActiveDays, buildSparkline7d, buildTopModels,
  computeAvgSessionMinutes, computeCacheHitRate,
  type AnalyticsSummary,
} from "./analyticsSummary";
```

Neue Zeile:
```typescript
import {
  computeActiveDays, buildSparkline7d, buildTopModels,
  computeAvgSessionMinutes, computeCacheHitRate,
  buildDailyBuckets, buildSessionStats, buildTotalTokens,
  type AnalyticsSummary, type AnalyticsData,
} from "./analyticsSummary";
```

- [ ] **Step 3.2: `analytics:get` Handler in `registerIpcHandlers()` einfügen**

Direkt nach dem bestehenden `analytics:summary` Handler (nach der schließenden `});` von `analytics:summary`, also nach Zeile 238) einfügen:

```typescript
    ipcMain.handle("analytics:get", async () => {
      const settings = await loadSettings();
      const windowDays = 30;
      const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

      const [claudeReport, codexReport] = await Promise.all([
        generateUsageReport({ type: "daily", provider: "claude", since, order: "asc", breakdown: true }, { settings }),
        generateUsageReport({ type: "daily", provider: "codex",  since, order: "asc", breakdown: true }, { settings }),
      ]);

      const claudeEntries = await readClaudeUsageEntriesForPeriod(
        getClaudeProjectsDirs(),
        new Date(Date.now() - windowDays * 24 * 3600 * 1000),
      );

      const activeDays        = computeActiveDays(claudeReport.rows, codexReport.rows);
      const sparkline7d       = buildSparkline7d(claudeReport.rows, codexReport.rows);
      const topModels         = buildTopModels(claudeReport.rows, codexReport.rows, 5);
      const avgSessionMinutes = computeAvgSessionMinutes(claudeEntries);
      const cacheHitRate      = computeCacheHitRate(this.lastSnapshots);
      const dailyBuckets      = buildDailyBuckets(claudeReport.rows, codexReport.rows, windowDays);
      const sessionStats      = buildSessionStats(claudeEntries, activeDays);
      const totalTokens       = buildTotalTokens(claudeReport.rows, codexReport.rows);

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
        activeDays,
        avgSessionMinutes,
        cacheHitRate,
        sparkline7d,
        topModels,
        windowDays,
        dailyBuckets,
        sessionStats,
        totalTokens,
      } satisfies AnalyticsData;
    });
```

- [ ] **Step 3.3: TypeScript-Build prüfen**

```powershell
npm run build
```

Erwartete Ausgabe: Keine TypeScript-Fehler, `dist/` wird neu gebaut.

- [ ] **Step 3.4: Tests ausführen**

```powershell
npm test
```

Erwartete Ausgabe: Alle Tests grün.

- [ ] **Step 3.5: Commit**

```bash
git add src/main/detailsWindow.ts
git commit -m "feat: add analytics:get IPC handler returning 30d daily buckets, session stats, total tokens"
```

---

## Task 4: Tab-Navigation in index.html

**Files:**
- Modify: `src/renderer/index.html`

- [ ] **Step 4.1: CSS für Tab-Navigation in den `<style>`-Block einfügen**

Direkt vor `/* ══ VIEWS ══ */` (Zeile 113 in index.html) einfügen:

```css
    /* ══ TAB NAVIGATION ════════════════════════════════════════ */
    .tab-nav {
      display: flex;
      align-items: center;
      gap: 2px;
      margin: 0 6px;
      -webkit-app-region: no-drag;
    }
    .tab-btn {
      padding: 4px 11px;
      background: none;
      border: 1px solid transparent;
      border-radius: var(--r-btn);
      color: var(--t400);
      font-family: 'DM Sans', system-ui, sans-serif;
      font-size: 10.5px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
      transition-property: background, border-color, color;
      transition-duration: 120ms;
      -webkit-app-region: no-drag;
    }
    .tab-btn:hover  { color: var(--t200); background: rgba(255,255,255,0.04); }
    .tab-btn:active { scale: 0.97; }
    .tab-btn.active { color: var(--t100); border-color: rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); }
    .view-compact .tab-nav { display: none; }
```

- [ ] **Step 4.2: CSS für Analytics-View in den `<style>`-Block einfügen**

Direkt vor `/* ══ FOOTER ══ */` (ca. Zeile 557) einfügen:

```css
    /* ══ ANALYTICS ═════════════════════════════════════════════ */
    .analytics-wrap {
      flex: 1; overflow-y: auto; padding: 8px 10px;
    }
    .analytics-wrap::-webkit-scrollbar { width: 3px; }
    .analytics-wrap::-webkit-scrollbar-track { background: transparent; }
    .analytics-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

    .an-section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--r-card);
      padding: 10px 12px;
      margin-bottom: 6px;
    }
    .an-section-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px;
    }
    .an-section-title {
      font-size: 9px; font-weight: 600; letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--t400);
    }
    .an-window-pills { display: flex; gap: 3px; }
    .an-window-pills .pill { padding: 3px 10px; font-size: 10px; height: auto; }
    .an-chart-wrap { height: 140px; position: relative; }

    .an-row2 {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;
    }
    .an-donut-wrap { position: relative; height: 130px; margin-bottom: 8px; }
    .an-donut-center {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      text-align: center; pointer-events: none;
    }
    .an-donut-center-val {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 16px; font-weight: 500;
      font-variant-numeric: tabular-nums; line-height: 1;
    }
    .an-donut-center-lbl { font-size: 8px; color: var(--t400); margin-top: 2px; }
    .an-legend { display: flex; flex-direction: column; gap: 4px; }
    .an-legend-row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--t200); }
    .an-legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
    .an-legend-pct {
      margin-left: auto;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 10px; font-variant-numeric: tabular-nums; color: var(--t300);
    }

    .an-stats-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px;
    }
    .an-stat-tile {
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: var(--r-inner); padding: 7px 9px;
    }
    .an-stat-lbl {
      font-size: 8px; font-weight: 600; letter-spacing: 0.09em;
      text-transform: uppercase; color: var(--t400); margin-bottom: 3px;
    }
    .an-stat-val {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px; font-weight: 500;
      font-variant-numeric: tabular-nums; line-height: 1;
    }
```

- [ ] **Step 4.3: Tab-Buttons in die Titelleiste einfügen**

In der HTML-Titelleiste, nach `<div class="titlebar-logo">...</div>` (ca. Zeile 733) und VOR `<div class="titlebar-btns">` folgendes einfügen:

```html
    <nav class="tab-nav">
      <button class="tab-btn active" id="tab-live"      data-tab="live">Live</button>
      <button class="tab-btn"        id="tab-analytics" data-tab="analytics">Analytics</button>
    </nav>
```

- [ ] **Step 4.4: `#view-analytics` Container nach `#view-dashboard` einfügen**

Nach dem schließenden `</div>` von `#view-dashboard` (nach dem `</div>` das `#right-panel` schließt, ca. Zeile 806) einfügen:

```html
  <!-- ── Analytics View ────────────────────────────────── -->
  <div class="view" id="view-analytics" hidden>
    <div class="analytics-wrap" id="analytics-content">
      <div class="empty"><div class="spinner"></div><span>Lädt…</span></div>
    </div>
  </div>
```

- [ ] **Step 4.5: Script-Tags für Chart.js, charts.js und analytics.js vor `</head>` hinzufügen**

Die bestehenden Script-Tags (Zeilen 717–720) durch folgende ersetzen:

```html
  <script src="../../assets/vendor/chart.min.js"></script>
  <script src="shared/ipc.js"></script>
  <script src="shared/format.js"></script>
  <script src="shared/colors.js"></script>
  <script src="shared/charts.js"></script>
  <script src="tabs/live.js"></script>
  <script src="tabs/analytics.js"></script>
```

- [ ] **Step 4.6: Tab-Switching-Logik ins inline `<script>` einfügen**

Im `<script>`-Block am Ende der HTML-Datei, nach den bestehenden Variable-Deklarationen (`let lastRefreshedAt`, `let footerTimer`, usw., ca. Zeile 888–891) folgendes einfügen:

```javascript
    let activeTab = 'live';

    function switchTab(tab) {
      if (inSettings) {
        inSettings = false;
        document.getElementById('view-settings').hidden = true;
        document.getElementById('btn-settings').classList.remove('active');
      }
      activeTab = tab;
      document.getElementById('view-dashboard').hidden  = tab !== 'live';
      document.getElementById('view-analytics').hidden  = tab !== 'analytics';
      document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab)
      );
      if (tab === 'analytics') QB.renderAnalytics();
    }

    document.getElementById('tab-live').addEventListener('click',      () => switchTab('live'));
    document.getElementById('tab-analytics').addEventListener('click', () => switchTab('analytics'));
```

- [ ] **Step 4.7: Settings-Toggle-Handler anpassen**

Den bestehenden `btn-settings` Event-Listener (ca. Zeile 947–953) ersetzen:

Alt:
```javascript
    document.getElementById('btn-settings').addEventListener('click', () => {
      inSettings = !inSettings;
      document.getElementById('view-dashboard').hidden = inSettings;
      document.getElementById('view-settings').hidden  = !inSettings;
      document.getElementById('btn-settings').classList.toggle('active', inSettings);
      if (inSettings) loadSettingsUI();
    });
```

Neu:
```javascript
    document.getElementById('btn-settings').addEventListener('click', () => {
      inSettings = !inSettings;
      document.getElementById('view-dashboard').hidden  = inSettings || activeTab !== 'live';
      document.getElementById('view-analytics').hidden  = inSettings || activeTab !== 'analytics';
      document.getElementById('view-settings').hidden   = !inSettings;
      document.getElementById('btn-settings').classList.toggle('active', inSettings);
      if (inSettings) loadSettingsUI();
    });
```

- [ ] **Step 4.8: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: add tab navigation (Live/Analytics) and analytics view container to index.html"
```

---

## Task 5: tabs/analytics.js erstellen

**Files:**
- Create: `src/renderer/tabs/analytics.js`

- [ ] **Step 5.1: Datei erstellen `src/renderer/tabs/analytics.js`**

```javascript
/* global QB, Chart */
'use strict';

window.QB = window.QB || {};

let _lineChart    = null;
let _donutChart   = null;
let _currentData  = null;
let _timeWindow   = '30d';

QB.renderAnalytics = async function renderAnalytics() {
  const container = document.getElementById('analytics-content');
  if (!container) return;
  container.innerHTML = '<div class="empty"><div class="spinner"></div><span>Lädt…</span></div>';

  try {
    _currentData = await QB.ipc.invoke('analytics:get');
    _renderUI(_currentData);
  } catch (e) {
    console.error('analytics:get failed', e);
    container.innerHTML = '<div class="empty"><span>Fehler beim Laden</span></div>';
  }
};

function _renderUI(data) {
  const container = document.getElementById('analytics-content');
  const winLabel  = _timeWindow === '7d' ? '7D' : '30D';

  container.innerHTML = `
    <div class="an-section">
      <div class="an-section-head">
        <span class="an-section-title">USAGE OVER TIME</span>
        <div class="an-window-pills">
          <button class="pill ${_timeWindow === '7d'  ? 'active' : ''}" data-win="7d">7D</button>
          <button class="pill ${_timeWindow === '30d' ? 'active' : ''}" data-win="30d">30D</button>
        </div>
      </div>
      <div class="an-chart-wrap"><canvas id="an-line-canvas"></canvas></div>
    </div>

    <div class="an-row2">
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">USAGE BREAKDOWN (${winLabel})</span></div>
        <div class="an-donut-wrap">
          <canvas id="an-donut-canvas"></canvas>
          <div class="an-donut-center" id="an-donut-center"></div>
        </div>
        <div class="an-legend" id="an-legend"></div>
      </div>
      <div class="an-section">
        <div class="an-section-head"><span class="an-section-title">TOP MODELS BY COST (30D)</span></div>
        <table class="top-models-table">
          <thead><tr><th>Modell</th><th>Kosten</th><th>%</th></tr></thead>
          <tbody id="an-top-models-body"></tbody>
        </table>
      </div>
    </div>

    <div class="an-section">
      <div class="an-section-head"><span class="an-section-title">AKTIVITÄTSSTATS (30D)</span></div>
      <div class="an-stats-grid" id="an-stats-grid"></div>
    </div>
  `;

  _buildLineChart(data);
  _buildDonut(data);
  _buildTopModels(data);
  _buildStats(data);

  container.querySelectorAll('.an-window-pills .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      _timeWindow = btn.dataset.win;
      _renderUI(_currentData);
    });
  });
}

function _buckets(data) {
  const all = data.dailyBuckets || [];
  return _timeWindow === '7d' ? all.slice(-7) : all;
}

function _buildLineChart(data) {
  if (_lineChart) { _lineChart.destroy(); _lineChart = null; }
  const ctx = document.getElementById('an-line-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const buckets = _buckets(data);
  const labels  = buckets.map(b => {
    const d = new Date(b.date);
    return d.toLocaleDateString('de-AT', { day: '2-digit', month: 'short' });
  });

  _lineChart = QB.charts.createLine(ctx, labels, [
    {
      label: 'Claude',
      data: buckets.map(b => b.claudeUSD),
      borderColor: '#f59830',
      backgroundColor: 'rgba(245,152,48,0.08)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
    {
      label: 'Codex',
      data: buckets.map(b => b.codexUSD),
      borderColor: '#52d017',
      backgroundColor: 'rgba(82,208,23,0.06)',
      borderWidth: 1.5,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    },
  ]);
}

function _buildDonut(data) {
  if (_donutChart) { _donutChart.destroy(); _donutChart = null; }
  const ctx = document.getElementById('an-donut-canvas');
  if (!ctx || typeof Chart === 'undefined') return;

  const claudeCost = data.apiCostUSD?.claude ?? 0;
  const codexCost  = data.apiCostUSD?.codex  ?? 0;
  const total      = claudeCost + codexCost;

  const chartData   = total > 0 ? [claudeCost, codexCost] : [1, 1];
  const chartColors = ['#f59830', '#52d017'];
  const labels      = ['Claude', 'Codex'];

  _donutChart = QB.charts.createDoughnut(ctx, labels, chartData, chartColors);

  const roi    = data.roiFactor?.combined ?? 0;
  const center = document.getElementById('an-donut-center');
  if (center) {
    center.innerHTML = `
      <div class="an-donut-center-val" style="color:${QB.roiColor(roi)}">${roi.toFixed(1)}×</div>
      <div class="an-donut-center-lbl">ROI</div>
    `;
  }

  const legend = document.getElementById('an-legend');
  if (legend && total > 0) {
    legend.innerHTML = [
      { label: 'Claude', cost: claudeCost, color: '#f59830' },
      { label: 'Codex',  cost: codexCost,  color: '#52d017' },
    ].map(p => `
      <div class="an-legend-row">
        <span class="an-legend-dot" style="background:${p.color}"></span>
        <span>${QB.esc(p.label)}</span>
        <span class="an-legend-pct">$${p.cost.toFixed(2)} · ${total > 0 ? ((p.cost/total)*100).toFixed(0) : 0}%</span>
      </div>
    `).join('');
  }
}

function _buildTopModels(data) {
  const tbody = document.getElementById('an-top-models-body');
  if (!tbody) return;
  if (!data.topModels?.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--t400);text-align:center;padding:8px">Keine Daten</td></tr>';
    return;
  }
  tbody.innerHTML = data.topModels.map(m => `
    <tr>
      <td class="model-name" title="${QB.esc(m.model)}">${QB.esc(m.model.replace(/^claude-|^gpt-/, ''))}</td>
      <td>$${(m.costUSD).toFixed(2)}</td>
      <td>${(m.pctOfTotal * 100).toFixed(0)}%</td>
    </tr>
  `).join('');
}

function _buildStats(data) {
  const grid = document.getElementById('an-stats-grid');
  if (!grid) return;

  const cacheAvg  = ((data.cacheHitRate?.claude ?? 0) + (data.cacheHitRate?.codex ?? 0)) / 2;
  const totalIn   = (data.totalTokens?.claude?.input  ?? 0) + (data.totalTokens?.codex?.input  ?? 0);
  const totalOut  = (data.totalTokens?.claude?.output ?? 0) + (data.totalTokens?.codex?.output ?? 0);
  const roi       = data.roiFactor?.combined ?? 0;

  const tiles = [
    { lbl: 'Aktive Tage',   val: `${data.activeDays ?? 0}/${data.windowDays ?? 30}` },
    { lbl: 'Cache-Hit',     val: `${(cacheAvg * 100).toFixed(1)}%` },
    { lbl: 'Ø Session',     val: `${data.avgSessionMinutes ?? 0} min` },
    { lbl: 'API-Kosten',    val: `$${(data.apiCostUSD?.total ?? 0).toFixed(0)}`,      color: 'var(--t100)' },
    { lbl: 'ROI',           val: `${roi.toFixed(1)}×`,                                color: QB.roiColor(roi) },
    { lbl: 'Tokens',        val: QB.fmtTokens(totalIn + totalOut) },
  ];

  grid.innerHTML = tiles.map(t => `
    <div class="an-stat-tile">
      <div class="an-stat-lbl">${QB.esc(t.lbl)}</div>
      <div class="an-stat-val" style="${t.color ? `color:${t.color}` : ''}">${QB.esc(String(t.val))}</div>
    </div>
  `).join('');
}
```

- [ ] **Step 5.2: Commit**

```bash
git add src/renderer/tabs/analytics.js
git commit -m "feat: add analytics.js tab with line chart, donut breakdown, top models, activity stats"
```

---

## Task 6: Gesamte Testsuite + Build-Verifikation

- [ ] **Step 6.1: TypeScript-Build**

```powershell
npm run build
```

Erwartete Ausgabe: Keine Fehler.

- [ ] **Step 6.2: Alle Tests**

```powershell
npm test
```

Erwartete Ausgabe: Alle Tests grün (inkl. bestehende + neue Tests aus Task 2).

- [ ] **Step 6.3: App starten und manuell testen**

```powershell
npm run dev
```

Prüfliste:
- [ ] App startet ohne Fehler
- [ ] `[Live]`-Tab ist initial aktiv, Live-Ansicht sichtbar
- [ ] Klick auf `[Analytics]` zeigt Spinner, danach:
  - Line Chart mit Claude (orange) und Codex (grün) Linien
  - Donut mit ROI in der Mitte
  - Top-Models-Tabelle gefüllt
  - Aktivitätsstats-Kacheln befüllt
- [ ] `[7D]`/`[30D]`-Toggle aktualisiert den Linien-Chart
- [ ] Klick auf `[Live]` bringt die Live-Ansicht zurück
- [ ] Settings-Zahnrad öffnet sich aus beiden Tabs heraus
- [ ] Compact-Modus: keine Tab-Navigation sichtbar

- [ ] **Step 6.4: Finaler Commit**

```bash
git add -A
git commit -m "feat(phase2): complete analytics tab with charts, tab navigation, and IPC handler"
```

---

## Spec-Coverage-Check

| Spec-Anforderung | Task |
|---|---|
| `analytics:get` IPC-Channel mit `AnalyticsData`-Interface | Task 3 |
| Tab-Navigation `[Live] [Analytics]` in Titelleiste | Task 4 |
| Usage Over Time Liniendiagramm, 2 Datasets (Claude/Codex) | Task 5 |
| `[7D]`/`[30D]` Zeitfenster-Toggle | Task 5 |
| Usage Breakdown Donut, ROI in Mitte | Task 5 |
| Top Models by Cost Tabelle | Task 5 |
| Aktivitätsstats-Zeile (6 Kacheln) | Task 5 |
| Chart.js lokal eingebunden, kein CDN | Task 1 |
| `shared/charts.js` mit Chart-Init-Helpers | Task 1 |
| Compact-Modus: keine Tab-Navigation | Task 4 (CSS `.view-compact .tab-nav { display: none }`) |
| `dailyBuckets`, `sessionStats`, `totalTokens` im Backend | Task 2 + 3 |
