# Dashboard Redesign Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Breites 900×660 px Dashboard mit 2-Spalten-Live-Tab, View-Switcher (Dashboard ↔ Compact), Analytics-Summary-Panel (Quick Stats, Top Models, Sparkline) und einklappbarer Insights-Leiste im Compact-Modus.

**Architecture:** `index.html` wird zur Shell; Rendering-Logik zieht in `tabs/live.js` und `shared/*.js`. Ein neuer `analytics:summary` IPC-Handler im Main-Prozess berechnet Kosten, ROI, Session-Stats aus `reportService` + JSONL-Entries und gibt ein gecachtes `AnalyticsSummary`-Objekt zurück. Window-Dimensionen und View-Modus werden in Settings gespeichert.

**Tech Stack:** TypeScript (Main-Prozess), Vanilla JS (Renderer), Electron IPC, Vitest (Tests)

---

## File Map

| Datei | Aktion | Verantwortung |
|---|---|---|
| `src/config/settings.ts` | Modify | `viewMode`, `insightsPanelOpen` hinzufügen |
| `src/pricing/litellm-fetcher.ts` | Modify | Codex gpt-5.x Fallback-Preise |
| `src/main/analyticsSummary.ts` | **Create** | Reine Hilfsfunktionen für analytics:summary (testbar) |
| `src/main/detailsWindow.ts` | Modify | Window-Sizing, view-toggle IPC, analytics:summary IPC |
| `src/renderer/shared/format.js` | **Create** | `esc`, `fmtTokens`, `formatCountdown`, `fmtDate` |
| `src/renderer/shared/colors.js` | **Create** | `usageColor`, `accentVar`, `providerColor` |
| `src/renderer/shared/ipc.js` | **Create** | Dünner IPC-Wrapper: `QB.ipc.invoke`, `QB.ipc.on` |
| `src/renderer/tabs/live.js` | **Create** | Alle Render-Funktionen aus index.html extrahiert |
| `src/renderer/index.html` | Modify | Shell + Tabs-Chrome + Settings-UI + `<script>`-Tags |
| `tests/analyticsSummary.test.ts` | **Create** | Unit-Tests für Hilfsfunktionen |
| `tests/litellm-fetcher.test.ts` | Modify | Tests für gpt-5.x Preise |
| `tests/settings.test.ts` | Modify | Tests für viewMode + insightsPanelOpen |

---

### Task 1: Settings — `viewMode` + `insightsPanelOpen`

**Files:**
- Modify: `src/config/settings.ts`
- Modify: `tests/settings.test.ts`

- [x] **Step 1: Failing tests schreiben**

In `tests/settings.test.ts` am Ende des `describe`-Blocks einfügen:

```typescript
  it("defaults viewMode to 'dashboard'", () => {
    const result = normalizeSettings({ ...defaultSettings });
    expect(result.viewMode).toBe("dashboard");
  });

  it("accepts viewMode 'compact'", () => {
    const result = normalizeSettings({ ...defaultSettings, viewMode: "compact" });
    expect(result.viewMode).toBe("compact");
  });

  it("rejects unknown viewMode, falls back to 'dashboard'", () => {
    const result = normalizeSettings({ ...defaultSettings, viewMode: "sidebar" as never });
    expect(result.viewMode).toBe("dashboard");
  });

  it("defaults insightsPanelOpen to false", () => {
    const result = normalizeSettings({ ...defaultSettings });
    expect(result.insightsPanelOpen).toBe(false);
  });
```

- [x] **Step 2: Test laufen lassen — muss FAIL sein**

```
npx vitest run tests/settings.test.ts
```
Erwartet: 4 neue Tests schlagen fehl mit `viewMode is not a property`.

- [x] **Step 3: Implementation**

`src/config/settings.ts` vollständig ersetzen:

```typescript
import fs from "node:fs/promises";
import { ensureConfigDir } from "../main/logging";
import { getSettingsPath } from "./paths";

export type CostWindow = "7d" | "30d" | "billing";
export type ViewMode = "dashboard" | "compact";

export interface SubscriptionCosts {
  claude: number;
  codex: number;
}

export interface Settings {
  pollIntervalSeconds: number;
  providerTimeoutMs: number;
  subscriptionCosts: SubscriptionCosts;
  pricingOfflineMode: boolean;
  costWindow: CostWindow;
  viewMode: ViewMode;
  insightsPanelOpen: boolean;
}

export const defaultSettings: Settings = {
  pollIntervalSeconds: 60,
  providerTimeoutMs: 10_000,
  subscriptionCosts: { claude: 20, codex: 10 },
  pricingOfflineMode: false,
  costWindow: "billing",
  viewMode: "dashboard",
  insightsPanelOpen: false,
};

export async function loadSettings(overrides: Partial<Settings> = {}): Promise<Settings> {
  try {
    const parsed = JSON.parse(await fs.readFile(getSettingsPath(), "utf8")) as Partial<Settings>;
    return normalizeSettings({ ...defaultSettings, ...parsed, ...overrides });
  } catch {
    await saveSettings({ ...defaultSettings, ...overrides });
    return normalizeSettings({ ...defaultSettings, ...overrides });
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(getSettingsPath(), `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, "utf8");
}

export function normalizeSettings(settings: Settings): Settings {
  const sub = (settings.subscriptionCosts ?? {}) as Partial<SubscriptionCosts>;
  const validWindows: CostWindow[] = ["7d", "30d", "billing"];
  const costWindow: CostWindow = validWindows.includes(settings.costWindow as CostWindow)
    ? (settings.costWindow as CostWindow)
    : "billing";
  const validViewModes: ViewMode[] = ["dashboard", "compact"];
  const viewMode: ViewMode = validViewModes.includes(settings.viewMode as ViewMode)
    ? (settings.viewMode as ViewMode)
    : "dashboard";
  return {
    pollIntervalSeconds: Math.max(15, Math.floor(Number(settings.pollIntervalSeconds) || defaultSettings.pollIntervalSeconds)),
    providerTimeoutMs: Math.max(1000, Math.floor(Number(settings.providerTimeoutMs) || defaultSettings.providerTimeoutMs)),
    subscriptionCosts: {
      claude: Math.max(0, Number(sub.claude) || defaultSettings.subscriptionCosts.claude),
      codex: Math.max(0, Number(sub.codex) || defaultSettings.subscriptionCosts.codex),
    },
    pricingOfflineMode: Boolean(settings.pricingOfflineMode),
    costWindow,
    viewMode,
    insightsPanelOpen: Boolean(settings.insightsPanelOpen),
  };
}
```

- [x] **Step 4: Tests laufen lassen — müssen PASS sein**

```
npx vitest run tests/settings.test.ts
```
Erwartet: Alle Tests grün.

- [x] **Step 5: Gesamte Tests**

```
npx vitest run
```
Erwartet: Nur der pre-existing `colors.test.ts`-Fail bleibt.

- [x] **Step 6: Commit**

```
git add src/config/settings.ts tests/settings.test.ts
git commit -m "feat(settings): add viewMode and insightsPanelOpen settings"
```

---

### Task 2: Codex Modell-Preise in `litellm-fetcher.ts`

**Files:**
- Modify: `src/pricing/litellm-fetcher.ts`
- Modify: `tests/litellm-fetcher.test.ts`

- [x] **Step 1: Failing tests schreiben**

In `tests/litellm-fetcher.test.ts` am Ende des `describe`-Blocks einfügen:

```typescript
  it("returns pricing for gpt-5.5", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-5.5");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeCloseTo(5e-6, 10);
    expect(pricing!.output_cost_per_token).toBeCloseTo(30e-6, 10);
    expect(pricing!.cache_read_input_token_cost).toBeCloseTo(0.5e-6, 10);
  });

  it("returns pricing for gpt-5.4", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-5.4");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeCloseTo(2.5e-6, 10);
    expect(pricing!.output_cost_per_token).toBeCloseTo(15e-6, 10);
    expect(pricing!.cache_read_input_token_cost).toBeCloseTo(0.25e-6, 10);
  });

  it("returns pricing for gpt-5.4-mini", async () => {
    const fetcher = new LiteLLMFetcher(true);
    const pricing = await fetcher.getModelPricing("gpt-5.4-mini");
    expect(pricing).not.toBeNull();
    expect(pricing!.input_cost_per_token).toBeCloseTo(0.75e-6, 10);
    expect(pricing!.output_cost_per_token).toBeCloseTo(4.5e-6, 10);
  });
```

- [x] **Step 2: Test laufen — muss FAIL sein**

```
npx vitest run tests/litellm-fetcher.test.ts
```
Erwartet: 3 neue Tests schlagen fehl.

- [x] **Step 3: Implementation**

`FALLBACK_PRICES` in `src/pricing/litellm-fetcher.ts` erweitern — nach dem `"gpt-4o"`-Eintrag einfügen:

```typescript
  "gpt-5.5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 30e-6,
    cache_read_input_token_cost: 0.5e-6,
  },
  "gpt-5.4-mini": {
    input_cost_per_token: 0.75e-6,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 0.075e-6,
  },
  "gpt-5.4": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 0.25e-6,
  },
  "gpt-5.3": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 12e-6,
    cache_read_input_token_cost: 0.2e-6,
  },
  "gpt-5.2": {
    input_cost_per_token: 1.75e-6,
    output_cost_per_token: 14e-6,
    cache_read_input_token_cost: 0.175e-6,
  },
  "gpt-5.1": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.125e-6,
  },
  "gpt-5": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.125e-6,
  },
```

**Wichtig:** `"gpt-5.4-mini"` muss VOR `"gpt-5.4"` stehen, damit der Substring-Match `"gpt-5.4"` nicht fälschlicherweise auf `"gpt-5.4-mini"` matched. Die `lookup`-Methode iteriert die Map in Einfügereihenfolge.

- [x] **Step 4: Tests laufen lassen — müssen PASS sein**

```
npx vitest run tests/litellm-fetcher.test.ts
```
Erwartet: Alle Tests grün.

- [x] **Step 5: Commit**

```
git add src/pricing/litellm-fetcher.ts tests/litellm-fetcher.test.ts
git commit -m "feat(pricing): add gpt-5.x fallback prices for Codex models"
```

---

### Task 3: `analyticsSummary.ts` + IPC-Handler

**Files:**
- Create: `src/main/analyticsSummary.ts`
- Create: `tests/analyticsSummary.test.ts`
- Modify: `src/main/detailsWindow.ts`

- [x] **Step 1: Failing tests schreiben**

Neue Datei `tests/analyticsSummary.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { ReportRow } from "../src/reports/types";
import {
  computeActiveDays,
  buildSparkline7d,
  buildTopModels,
  computeAvgSessionMinutes,
  computeCacheHitRate,
} from "../src/main/analyticsSummary";
import type { ClaudeUsageEntry } from "../src/pricing/jsonl-reader";
import type { UsageSnapshot } from "../src/providers/types";

function makeRow(bucket: string, costUSD: number, provider: "claude" | "codex", models: string[] = []): ReportRow {
  return {
    bucket, provider, costUSD,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: 0, models,
    modelBreakdowns: models.map(model => ({ model, costUSD, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 })),
  };
}

describe("computeActiveDays", () => {
  it("counts union of dates from claude and codex rows", () => {
    const claude = [makeRow("2026-05-01", 1, "claude"), makeRow("2026-05-02", 1, "claude")];
    const codex  = [makeRow("2026-05-02", 1, "codex"),  makeRow("2026-05-03", 1, "codex")];
    expect(computeActiveDays(claude, codex)).toBe(3);
  });

  it("returns 0 for empty input", () => {
    expect(computeActiveDays([], [])).toBe(0);
  });
});

describe("buildSparkline7d", () => {
  it("returns 7 entries", () => {
    expect(buildSparkline7d([], [])).toHaveLength(7);
  });

  it("fills claudeUSD from matching rows", () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [makeRow(today, 5.5, "claude")];
    const sparkline = buildSparkline7d(rows, []);
    const todayEntry = sparkline.find(s => s.date === today);
    expect(todayEntry?.claudeUSD).toBe(5.5);
  });
});

describe("buildTopModels", () => {
  it("aggregates model costs across providers, sorted descending", () => {
    const claude = [makeRow("2026-05-01", 10, "claude", ["claude-sonnet-4-6"])];
    const codex  = [makeRow("2026-05-01", 20, "codex",  ["gpt-5.5"])];
    const top = buildTopModels(claude, codex, 5);
    expect(top[0].model).toBe("gpt-5.5");
    expect(top[0].costUSD).toBe(20);
    expect(top[1].model).toBe("claude-sonnet-4-6");
    expect(top[1].pctOfTotal).toBeCloseTo(10 / 30, 5);
  });
});

describe("computeAvgSessionMinutes", () => {
  it("returns 0 for empty entries", () => {
    expect(computeAvgSessionMinutes([])).toBe(0);
  });

  it("computes duration from first to last timestamp per session", () => {
    const entries: ClaudeUsageEntry[] = [
      { provider: "claude", timestamp: "2026-05-01T10:00:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { provider: "claude", timestamp: "2026-05-01T10:30:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { provider: "claude", timestamp: "2026-05-01T11:00:00.000Z", model: "claude-sonnet-4-6", project: "p1", session: "s1", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ];
    // Session s1: 10:00 → 11:00 = 60 min
    expect(computeAvgSessionMinutes(entries)).toBe(60);
  });
});

describe("computeCacheHitRate", () => {
  it("returns 0 when no tokenUsage in snapshots", () => {
    const snaps: UsageSnapshot[] = [{ provider: "claude", status: "ok", windows: [], updatedAt: "" }];
    const rate = computeCacheHitRate(snaps);
    expect(rate.claude).toBe(0);
  });

  it("computes cache_read / (cache_read + input) for claude", () => {
    const snaps: UsageSnapshot[] = [{
      provider: "claude", status: "ok", windows: [], updatedAt: "",
      costFactor: {
        apiCostUSD: 1, subscriptionCostUSD: 20, factor: 0.05, isEstimate: false, label: "",
        tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 900, totalTokens: 1050, models: [] },
      },
    }];
    expect(computeCacheHitRate(snaps).claude).toBeCloseTo(0.9, 5);
  });
});
```

- [x] **Step 2: Tests laufen — müssen FAIL sein**

```
npx vitest run tests/analyticsSummary.test.ts
```
Erwartet: Fehler `Cannot find module '../src/main/analyticsSummary'`.

- [x] **Step 3: `src/main/analyticsSummary.ts` anlegen**

```typescript
import type { ReportRow } from "../reports/types";
import type { ClaudeUsageEntry } from "../pricing/jsonl-reader";
import type { UsageSnapshot } from "../providers/types";

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

export function computeCacheHitRate(snapshots: UsageSnapshot[]): { claude: number; codex: number } {
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
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10));
  }
  return days;
}
```

- [x] **Step 4: Tests laufen lassen — müssen PASS sein**

```
npx vitest run tests/analyticsSummary.test.ts
```
Erwartet: Alle 7 Tests grün.

- [x] **Step 5: `analytics:summary` IPC-Handler in `detailsWindow.ts` verdrahten**

In `src/main/detailsWindow.ts`:

Imports ergänzen (am Anfang der Datei):
```typescript
import { generateUsageReport } from "../reports/reportService";
import { readClaudeUsageEntriesForPeriod } from "../pricing/jsonl-reader";
import { getClaudeProjectsDirs, getCodexSessionsDirs, getCodexConfigPaths } from "../config/paths";
import {
  computeActiveDays, buildSparkline7d, buildTopModels,
  computeAvgSessionMinutes, computeCacheHitRate,
  type AnalyticsSummary,
} from "./analyticsSummary";
```

Privates Cache-Feld zur Klasse hinzufügen (nach `isPinned`):
```typescript
private analyticsSummaryCache: AnalyticsSummary | null = null;
```

`notifyUpdate`-Methode anpassen (Cache invalidieren):
```typescript
notifyUpdate(snapshots: UsageSnapshot[]): void {
  this.lastSnapshots = snapshots;
  this.lastRefreshedAt = new Date();
  this.analyticsSummaryCache = null;   // Cache invalidieren
  this.pushUpdate();
}
```

In `registerIpcHandlers()` am Ende vor der schließenden `}` einfügen:
```typescript
    ipcMain.handle("analytics:summary", async () => {
      if (this.analyticsSummaryCache) return this.analyticsSummaryCache;

      const settings = await loadSettings();
      const windowDays = settings.costWindow === "7d" ? 7 : 30;
      const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

      const [claudeReport, codexReport] = await Promise.all([
        generateUsageReport({ type: "daily", provider: "claude", since, order: "asc" }, { settings }),
        generateUsageReport({ type: "daily", provider: "codex",  since, order: "asc" }, { settings }),
      ]);

      const claudeEntries = await readClaudeUsageEntriesForPeriod(
        getClaudeProjectsDirs(),
        new Date(Date.now() - windowDays * 24 * 3600 * 1000),
      );

      const activeDays       = computeActiveDays(claudeReport.rows, codexReport.rows);
      const sparkline7d      = buildSparkline7d(claudeReport.rows, codexReport.rows);
      const topModels        = buildTopModels(claudeReport.rows, codexReport.rows, 5);
      const avgSessionMinutes = computeAvgSessionMinutes(claudeEntries);
      const cacheHitRate     = computeCacheHitRate(this.lastSnapshots);

      const claudeCost = claudeReport.totals.costUSD;
      const codexCost  = codexReport.totals.costUSD;
      const claudeSub  = settings.subscriptionCosts.claude;
      const codexSub   = settings.subscriptionCosts.codex;

      const summary: AnalyticsSummary = {
        apiCostUSD:         { claude: claudeCost, codex: codexCost, total: claudeCost + codexCost },
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
      };

      this.analyticsSummaryCache = summary;
      return summary;
    });

    ipcMain.handle("window:set-view", async (_, mode: string) => {
      const settings = await loadSettings();
      if (mode === "dashboard" || mode === "compact") {
        await saveSettings({ ...settings, viewMode: mode });
        log.info(`View mode changed to ${mode}`);
      }
    });
```

- [x] **Step 6: Alle Tests laufen**

```
npx vitest run
```
Erwartet: Nur der pre-existing `colors.test.ts`-Fail bleibt.

- [x] **Step 7: Commit**

```
git add src/main/analyticsSummary.ts tests/analyticsSummary.test.ts src/main/detailsWindow.ts
git commit -m "feat(analytics): add analytics:summary IPC handler with session and cost stats"
```

---

### Task 4: Renderer Shared Utilities extrahieren

**Files:**
- Create: `src/renderer/shared/format.js`
- Create: `src/renderer/shared/colors.js`
- Create: `src/renderer/shared/ipc.js`

Keine automatisierten Tests — diese Dateien sind Browser-JS. Verifikation durch die App in Task 5.

- [x] **Step 1: `src/renderer/shared/format.js` anlegen**

```javascript
/* global require */
'use strict';

window.QB = window.QB || {};

QB.esc = function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

QB.fmtTokens = function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
};

QB.formatCountdown = function formatCountdown(isoStr) {
  const ms = new Date(isoStr).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return 'now';
  const s  = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p  = n => String(n).padStart(2, '0');
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
};

QB.fmtDate = function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleDateString('de-AT', { day: '2-digit', month: 'short' });
};

QB.fmtUSD = function fmtUSD(n) {
  if (typeof n !== 'number') return '—';
  return '$' + n.toFixed(2);
};
```

- [x] **Step 2: `src/renderer/shared/colors.js` anlegen**

```javascript
'use strict';

window.QB = window.QB || {};

QB.usageColor = function usageColor(pct) {
  if (pct < 70) return 'green';
  if (pct < 85) return 'yellow';
  if (pct < 95) return 'orange';
  return 'red';
};

QB.accentVar = function accentVar(pct) {
  if (typeof pct !== 'number') return 'var(--gray)';
  if (pct < 70) return 'var(--green)';
  if (pct < 85) return 'var(--yellow)';
  if (pct < 95) return 'var(--orange)';
  return 'var(--red)';
};

QB.providerColor = function providerColor(name) {
  const map = { claude: '#f59830', codex: '#52d017', gemini: '#8b70f0' };
  return map[name] || '#475460';
};

QB.roiColor = function roiColor(factor) {
  if (factor >= 2) return 'var(--green)';
  if (factor >= 1) return 'var(--yellow)';
  return 'var(--gray)';
};
```

- [x] **Step 3: `src/renderer/shared/ipc.js` anlegen**

```javascript
/* global require */
'use strict';

const { ipcRenderer } = require('electron');

window.QB = window.QB || {};

QB.ipc = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on:     (channel, fn)      => ipcRenderer.on(channel, fn),
  send:   (channel, ...args) => ipcRenderer.send(channel, ...args),
};
```

- [x] **Step 4: Commit**

```
git add src/renderer/shared/
git commit -m "feat(renderer): add shared utility modules (format, colors, ipc)"
```

---

### Task 5: `live.js` extrahieren + `index.html` zur Shell umbauen

**Files:**
- Create: `src/renderer/tabs/live.js`
- Modify: `src/renderer/index.html`

Keine automatisierten Tests. Verifikation: App öffnen, Daten erscheinen wie vorher.

- [x] **Step 1: `src/renderer/tabs/live.js` anlegen**

Alle Render-Funktionen aus `index.html` extrahieren und mit `QB.`-Namespace versehen. Die Funktionen `render`, `renderCard`, `renderStandard`, `renderGemini`, `renderOverview`, `renderTip`, `tokenDetailHtml`, `costBadgeHtml`, `providerIconHtml`, `startCd`, `stopCd`, `paceClass`, `paceLabel` kommen alle hierher.

```javascript
/* global QB */
'use strict';

// ── Countdowns ───────────────────────────────────────────────────────
let _countdowns = [];
let _cdTimer    = null;

function startCd() {
  _cdTimer = setInterval(() => {
    for (const { id, resetsAt } of _countdowns) {
      const el = document.getElementById(id);
      if (el) el.textContent = QB.formatCountdown(resetsAt);
    }
  }, 1000);
}

function stopCd() {
  if (_cdTimer) { clearInterval(_cdTimer); _cdTimer = null; }
}

// ── Helpers ──────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function paceClass(stage) {
  if (stage === 'onTrack') return 'b-ok';
  if (['slightlyAhead', 'ahead', 'farAhead'].includes(stage)) return 'b-warn';
  return 'b-bad';
}

function paceLabel(stage) {
  return ({
    onTrack:'On Track', slightlyAhead:'Slightly Ahead', ahead:'Ahead', farAhead:'Far Ahead',
    slightlyBehind:'Slightly Behind', behind:'Behind', farBehind:'Far Behind',
  })[stage] || stage;
}

function providerIconHtml(provider) {
  const cls = `prov-icon icon-${provider}`;
  const logos = { claude: '../../logos/claude.png', codex: '../../logos/codex.png', gemini: '../../logos/gemini.webp' };
  const src = logos[provider];
  if (!src) return `<div class="${cls}"></div>`;
  return `<div class="${cls}"><img class="prov-logo" src="${src}" alt="" aria-hidden="true" draggable="false"></div>`;
}

function tokenDetailHtml(cf) {
  if (!cf?.tokenUsage) return '';
  const t = cf.tokenUsage;
  const cells = [
    ['Input',   QB.fmtTokens(t.inputTokens),        false],
    ['Output',  QB.fmtTokens(t.outputTokens),       false],
    ['Cache +', QB.fmtTokens(t.cacheCreationTokens),false],
    ['Cache ▷', QB.fmtTokens(t.cacheReadTokens),    false],
    ['Total',   QB.fmtTokens(t.totalTokens),         false],
    ['Cost',    `$${(cf.apiCostUSD || 0).toFixed(2)}`, true],
  ];
  const cellsHtml = cells.map(([lbl, val, isCost]) =>
    `<div class="token-cell">
      <span class="token-cell-lbl">${lbl}</span>
      <span class="token-cell-val${isCost ? ' is-cost' : ''}">${val}</span>
    </div>`
  ).join('');
  const modelsHtml = t.models?.length > 0
    ? `<div class="token-models">${QB.esc(t.models.join(', '))}</div>` : '';
  return `<div class="token-section"><div class="token-grid">${cellsHtml}</div>${modelsHtml}</div>`;
}

function costBadgeHtml(cf) {
  if (!cf) return '';
  const winSuffix = cf.windowLabel && cf.windowLabel !== 'billing' ? ` · ${cf.windowLabel}` : '';
  if (cf.factor === null) return `<span class="badge b-cost">${QB.esc(cf.label || 'Keine Logs')}</span>`;
  const pre = cf.isEstimate ? '~' : '';
  const factorPart = `${pre}${cf.factor.toFixed(2)}× sub`;
  if (cf.apiCostUSD >= 0.005) {
    return `<span class="badge b-cost">$${cf.apiCostUSD.toFixed(2)}${winSuffix} (${factorPart})</span>`;
  }
  return `<span class="badge b-cost">${factorPart}${winSuffix}</span>`;
}

// ── Overview card ─────────────────────────────────────────────────────
function renderOverview(snapshots) {
  const provData = snapshots.map(s => {
    const win = s.windows.find(w => w.name === 'fiveHour');
    const hasData = s.status === 'ok' || s.status === 'stale';
    return { name: s.provider, pct: hasData && typeof win?.usedPercent === 'number' ? win.usedPercent : null };
  });
  if (provData.length === 0) return '';
  const validPcts = provData.filter(p => p.pct !== null).map(p => p.pct);
  const maxPct    = validPcts.length > 0 ? Math.max(...validPcts) : 0;
  const pctStr    = validPcts.length > 0 ? `${Math.round(maxPct)}%` : '—';
  const pctColor  = validPcts.length > 0 ? `color:var(--${QB.usageColor(maxPct)})` : '';
  const rows = provData.map(p => {
    const col      = QB.providerColor(p.name);
    const fill     = p.pct !== null ? clamp(p.pct, 0, 100) : 0;
    const pctText  = p.pct !== null ? `${Math.round(p.pct)}%` : '—';
    const nameStr  = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    const glow     = fill > 0 ? `box-shadow:0 0 6px ${col}66` : '';
    const pctStyle = p.pct !== null ? `color:var(--${QB.usageColor(p.pct)})` : 'color:var(--t400)';
    return `<div class="mini-row">
      <div class="mini-label"><span class="mini-dot" style="background:${col}"></span>${nameStr}</div>
      <div class="mini-track"><div class="mini-fill" style="width:${fill}%;background:${col};${glow}"></div></div>
      <span class="mini-pct" style="${pctStyle}">${pctText}</span>
    </div>`;
  }).join('');
  return `<div class="card" style="animation-delay:0ms">
    <div class="overview-head">
      <span class="overview-label">Overview</span>
      <div class="overview-right"><span class="overview-total-lbl">Peak Usage</span><span class="overview-pct" style="${pctColor}">${pctStr}</span></div>
    </div>
    <div class="mini-bars">${rows}</div>
  </div>`;
}

// ── Tip card ──────────────────────────────────────────────────────────
function renderTip(snapshots) {
  let worstStage = null, worstProvider = null;
  const stageOrder = ['farBehind','behind','slightlyBehind','onTrack','slightlyAhead','ahead','farAhead'];
  for (const snap of snapshots) {
    const weekly = snap.windows.find(w => w.name === 'weekly');
    if (weekly?.pace?.stage) {
      const idx = stageOrder.indexOf(weekly.pace.stage);
      const worstIdx = worstStage ? stageOrder.indexOf(worstStage) : 999;
      if (idx < worstIdx) { worstStage = weekly.pace.stage; worstProvider = snap.provider; }
    }
  }
  if (!worstStage || worstStage === 'onTrack') return '';
  const name = worstProvider ? worstProvider.charAt(0).toUpperCase() + worstProvider.slice(1) : '';
  const tips = {
    farBehind:`You're far behind on ${name}. Your usage is well above the expected pace.`,
    behind:`${name} usage is running behind the expected weekly pace.`,
    slightlyBehind:`${name} is slightly behind pace — you may hit limits before reset.`,
    slightlyAhead:`${name} usage is slightly ahead of pace this week.`,
    ahead:`${name} is well ahead of pace — quota should last until reset.`,
    farAhead:`${name} quota is very underutilized this week.`,
  };
  const text = tips[worstStage] || '';
  if (!text) return '';
  const delay = (snapshots.length + 1) * 65;
  return `<div class="card" style="animation-delay:${delay}ms">
    <div class="tip-body-wrap">
      <div class="tip-icon-box"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="7.5" cy="6" r="3.5" stroke="#52d017" stroke-width="1.4"/><path d="M5.5 10.5h4M6 12h3" stroke="#52d017" stroke-width="1.4" stroke-linecap="round"/></svg></div>
      <div class="tip-content"><div class="tip-label">Tip</div><div class="tip-text">${QB.esc(text)}</div></div>
    </div>
  </div>`;
}

// ── Standard provider card ─────────────────────────────────────────────
function renderStandard(snap, name, delay) {
  const fiveH  = snap.windows.find(w => w.name === 'fiveHour');
  const weekly = snap.windows.find(w => w.name === 'weekly');
  const rawPct = fiveH?.usedPercent;
  const hasPct = typeof rawPct === 'number';
  const pct    = hasPct ? rawPct : 0;
  const color  = hasPct ? QB.usageColor(pct) : 'gray';
  const pctTxt = hasPct ? `${Math.round(pct)}%` : '—';
  const fhId   = `cd-${snap.provider}-5h`;
  const wkId   = `cd-${snap.provider}-wk`;
  if (fiveH?.resetsAt)  _countdowns.push({ id: fhId, resetsAt: fiveH.resetsAt });
  if (weekly?.resetsAt) _countdowns.push({ id: wkId, resetsAt: weekly.resetsAt });
  const fhCd = fiveH?.resetsAt  ? QB.formatCountdown(fiveH.resetsAt)  : '';
  const wkCd = weekly?.resetsAt ? QB.formatCountdown(weekly.resetsAt) : '';
  let bars = `<div class="bar-group"><div class="bar-meta"><span class="bar-tag">5-Hour</span><span class="bar-cd" id="${fhId}">${fhCd}</span></div><div class="bar-track thick"><div class="bar-fill c-${color}" style="width:${clamp(pct,0,100)}%"></div></div></div>`;
  if (weekly && typeof weekly.usedPercent === 'number') {
    const wc = QB.usageColor(weekly.usedPercent);
    bars += `<div class="bar-group"><div class="bar-meta"><span class="bar-tag">Weekly</span><span class="bar-cd" id="${wkId}">${wkCd}</span></div><div class="bar-track"><div class="bar-fill c-${wc}" style="width:${clamp(weekly.usedPercent,0,100)}%"></div></div></div>`;
  }
  const bdgs = [];
  if (snap.status === 'stale') bdgs.push(`<span class="badge b-stale">Stale</span>`);
  if (weekly?.pace) bdgs.push(`<span class="badge ${paceClass(weekly.pace.stage)}">${paceLabel(weekly.pace.stage)}</span>`);
  const costHtml = costBadgeHtml(snap.costFactor);
  if (costHtml) bdgs.push(costHtml);
  const accent = QB.accentVar(hasPct ? pct : null);
  return `<div class="card has-accent" style="--card-accent:${accent};${delay}">
    <div class="card-body">
      ${providerIconHtml(snap.provider)}
      <div class="card-info">
        <div class="card-head"><span class="prov-name">${QB.esc(name)}</span><div class="card-right"><span class="prov-pct" style="color:var(--${color})">${pctTxt}</span><span class="card-chevron">›</span></div></div>
        ${bars}
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${tokenDetailHtml(snap.costFactor)}
      </div>
    </div>
  </div>`;
}

function renderGemini(snap, name, delay) {
  const label = snap.windows[0]?.label ?? (snap.status === 'error' ? 'Unavailable' : 'No local session data');
  const bdgs = [];
  if (snap.status === 'stale') bdgs.push(`<span class="badge b-stale">Stale</span>`);
  if (snap.status === 'error') bdgs.push(`<span class="badge b-error">Error</span>`);
  const costHtml = costBadgeHtml(snap.costFactor);
  if (costHtml) bdgs.push(costHtml);
  return `<div class="card has-accent" style="--card-accent:var(--gray);${delay}">
    <div class="card-body">
      ${providerIconHtml('gemini')}
      <div class="card-info">
        <div class="card-head"><span class="prov-name">${QB.esc(name)}</span><span class="card-chevron">›</span></div>
        <div class="gemini-lbl">${QB.esc(label)}</div>
        ${bdgs.length ? `<div class="badges">${bdgs.join('')}</div>` : ''}
        ${tokenDetailHtml(snap.costFactor)}
      </div>
    </div>
  </div>`;
}

function renderCard(snap, idx) {
  const name  = snap.provider.charAt(0).toUpperCase() + snap.provider.slice(1);
  const delay = `animation-delay:${idx * 65}ms`;
  if (snap.status === 'not_authenticated') {
    return `<div class="card card-status-row" style="--card-accent:var(--gray);${delay}"><span class="prov-name">${QB.esc(name)}</span><span class="badge b-auth">Not Authenticated</span></div>`;
  }
  if (snap.status === 'error' && snap.windows.length === 0) {
    const msg = (snap.errorMessage || 'Error').slice(0, 42);
    return `<div class="card card-status-row has-accent" style="--card-accent:var(--red);${delay}"><span class="prov-name">${QB.esc(name)}</span><span class="badge b-error">${QB.esc(msg)}</span></div>`;
  }
  if (snap.provider === 'gemini') return renderGemini(snap, name, delay);
  return renderStandard(snap, name, delay);
}

// ── Main render ───────────────────────────────────────────────────────
window.QB = window.QB || {};

QB.renderLive = function renderLive(snapshots) {
  const el = document.getElementById('content');
  stopCd();
  _countdowns = [];
  if (!snapshots || snapshots.length === 0) {
    el.innerHTML = '<div class="empty"><span>No provider data</span></div>';
    return;
  }
  const overview = renderOverview(snapshots);
  const cards    = snapshots.map((snap, i) => renderCard(snap, i + 1)).join('');
  const tip      = renderTip(snapshots);
  el.innerHTML   = overview + cards + tip;
  startCd();
};
```

- [x] **Step 2: `index.html` zur Shell umbauen**

Im `<head>` nach dem schließenden `</style>` folgende `<script>`-Tags einfügen (vor dem `</head>`):

```html
  <script src="shared/ipc.js"></script>
  <script src="shared/format.js"></script>
  <script src="shared/colors.js"></script>
  <script src="tabs/live.js"></script>
```

Im bestehenden `<script>`-Block am Ende von `index.html`:
- Die Funktionen `usageColor`, `accentVar`, `providerColor`, `clamp`, `esc`, `fmtTokens`, `formatCountdown` **löschen** (jetzt in shared/)
- Die Funktionen `paceClass`, `paceLabel`, `providerIconHtml`, `tokenDetailHtml`, `costBadgeHtml`, `renderOverview`, `renderTip`, `renderStandard`, `renderGemini`, `renderCard`, `startCd`, `stopCd` **löschen** (jetzt in tabs/live.js)
- `render(snapshots)` Funktion anpassen:

```javascript
function render(snapshots) {
  QB.renderLive(snapshots);
}
```

- Den `ipcRenderer`-Import am Anfang des `<script>`-Blocks entfernen (jetzt in shared/ipc.js). Alle `ipcRenderer.invoke/on/send` durch `QB.ipc.invoke/on/send` ersetzen.

- [x] **Step 3: App manuell testen**

```
npx electron .
```
Prüfen: Dashboard öffnet sich, Provider-Karten erscheinen, Bars aktualisieren sich, keine Konsolen-Errors.

- [x] **Step 4: Commit**

```
git add src/renderer/tabs/live.js src/renderer/index.html
git commit -m "refactor(renderer): extract live.js and shared utilities from index.html"
```

---

### Task 6: Window-Sizing + View-Switcher

**Files:**
- Modify: `src/main/detailsWindow.ts`
- Modify: `src/renderer/index.html`

- [x] **Step 1: `detailsWindow.ts` — Window-Sizing nach viewMode**

Die `open()`-Methode anpassen. Ersetze den `BrowserWindow`-Konstruktoraufruf:

```typescript
open(onRefreshRequest: () => void): void {
  if (this.win && !this.win.isDestroyed()) {
    this.win.show();
    this.positionWindow();
    this.pushUpdate();
    this.win.focus();
    return;
  }

  void loadSettings().then(settings => {
    const isDashboard = settings.viewMode !== "compact";
    this.win = new BrowserWindow({
      width:      isDashboard ? 900 : 340,
      height:     isDashboard ? 660 : 560,
      minWidth:   isDashboard ? 750 : 340,
      minHeight:  isDashboard ? 520 : 560,
      frame:      false,
      resizable:  isDashboard,
      movable:    true,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#090c10",
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    const htmlPath = path.join(__dirname, "../../src/renderer/index.html");
    void this.win.loadFile(htmlPath);

    this.win.once("ready-to-show", () => {
      if (!this.win || this.win.isDestroyed()) return;
      this.positionWindow(isDashboard);
      this.win.show();
    });

    this.win.on("blur", () => {
      if (!this.isPinned && this.win && !this.win.isDestroyed()) this.win.hide();
    });

    this.win.on("closed", () => { this.win = null; });

    this._onRefreshRequest = onRefreshRequest;
  });
}
```

`positionNearTray` umbenennen zu `positionWindow` und Parameter `isDashboard: boolean` hinzufügen:

```typescript
private positionWindow(isDashboard = false): void {
  if (!this.win || this.win.isDestroyed()) return;
  const [winW, winH] = this.win.getSize();

  if (isDashboard) {
    // Zentriert auf Hauptbildschirm
    const { workArea } = screen.getPrimaryDisplay();
    this.win.setPosition(
      Math.round(workArea.x + (workArea.width  - winW) / 2),
      Math.round(workArea.y + (workArea.height - winH) / 2),
      false,
    );
    return;
  }

  // Compact: near tray (bestehende Logik)
  const tray = this.getTray();
  if (tray) {
    try {
      const tb = tray.getBounds();
      const display = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y });
      const wa = display.workArea;
      let x = Math.round(tb.x + tb.width / 2 - winW / 2);
      let y = Math.round(tb.y - winH - 8);
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width  - winW));
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - winH));
      this.win.setPosition(x, y, false);
      return;
    } catch { /* fall through */ }
  }
  const { workArea } = screen.getPrimaryDisplay();
  this.win.setPosition(
    Math.round(workArea.x + (workArea.width  - winW) / 2),
    Math.round(workArea.y + (workArea.height - winH) / 2),
    false,
  );
}
```

Im IPC-Handler `window:set-view` (bereits in Task 3 hinzugefügt) nach dem `saveSettings`-Aufruf das Fenster neu öffnen:

```typescript
    ipcMain.handle("window:set-view", async (_, mode: string) => {
      if (mode !== "dashboard" && mode !== "compact") return;
      const settings = await loadSettings();
      await saveSettings({ ...settings, viewMode: mode as ViewMode });
      log.info(`View mode changed to ${mode}`);
      // Fenster schließen und neu öffnen mit neuen Dimensionen
      if (this.win && !this.win.isDestroyed()) {
        this.win.close();
      }
      // Neu öffnen via Tray-Klick — wird automatisch getriggert durch Tray-Rebuild
    });
```

- [x] **Step 2: View-Switcher-Button zu `index.html` hinzufügen**

In der Titelleiste, nach dem Pin-Button und vor dem Close-Button, einfügen:

```html
      <button class="tbtn" id="btn-view-switch" title="Ansicht wechseln">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1" y="1" width="5" height="5" rx="1"/>
          <rect x="7" y="1" width="5" height="5" rx="1"/>
          <rect x="1" y="7" width="5" height="5" rx="1"/>
          <rect x="7" y="7" width="5" height="5" rx="1"/>
        </svg>
      </button>
```

Im `<script>`-Block Handler einfügen:

```javascript
document.getElementById('btn-view-switch').addEventListener('click', async () => {
  const settings = await QB.ipc.invoke('settings:get');
  const newMode = settings.viewMode === 'dashboard' ? 'compact' : 'dashboard';
  await QB.ipc.invoke('window:set-view', newMode);
  QB.ipc.send('window:close');
});
```

- [x] **Step 3: `viewMode` als CSS-Klasse auf `<body>` setzen**

Im `quota:ready` IPC-Handler im `<script>`-Block:

```javascript
QB.ipc.on('quota:ready-ack', (_, data) => {
  document.body.classList.toggle('view-dashboard', data.viewMode === 'dashboard');
  document.body.classList.toggle('view-compact',   data.viewMode !== 'dashboard');
});
```

Im Main-Prozess `quota:ready` Handler in `detailsWindow.ts` erweitern:

```typescript
    ipcMain.on("quota:ready", async () => {
      log.debug("Dashboard window ready, pushing current data");
      this.pushUpdate();
      this.win?.webContents.send("window:pin-state", this.isPinned);
      const settings = await loadSettings();
      this.win?.webContents.send("quota:ready-ack", { viewMode: settings.viewMode });
    });
```

- [x] **Step 4: App manuell testen**

```
npx electron .
```
Prüfen: View-Switch-Button erscheint, Klick schließt Fenster (öffnet sich nach Tray-Klick neu in anderem Modus).

- [x] **Step 5: Commit**

```
git add src/main/detailsWindow.ts src/renderer/index.html
git commit -m "feat(window): dashboard/compact view switcher with dynamic sizing"
```

---

### Task 7: Dashboard 2-Spalten-Layout + rechtes Panel

**Files:**
- Modify: `src/renderer/index.html`

- [x] **Step 1: CSS für 2-Spalten-Dashboard hinzufügen**

Im `<style>`-Block am Ende (vor `</style>`) einfügen:

```css
    /* ══ DASHBOARD 2-SPALTEN ═══════════════════════════════════════ */
    .view-dashboard #view-dashboard {
      display: grid;
      grid-template-columns: 1fr 360px;
      grid-template-rows: 1fr;
      min-height: 0;
    }
    .view-dashboard .content {
      grid-column: 1;
      border-right: 1px solid var(--border);
    }
    .view-dashboard #right-panel {
      grid-column: 2;
      display: flex;
      flex-direction: column;
      gap: 0;
      overflow-y: auto;
      padding: 8px 10px;
    }
    .view-compact #right-panel { display: none; }

    /* Quick Stats Kacheln */
    .qs-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 5px;
      margin-bottom: 8px;
    }
    .qs-tile {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--r-card);
      padding: 9px 11px;
    }
    .qs-tile-lbl {
      font-size: 8px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--t400); margin-bottom: 4px;
    }
    .qs-tile-val {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 18px; font-weight: 500;
      font-variant-numeric: tabular-nums; line-height: 1;
    }

    /* Top Models Tabelle */
    .top-models-table {
      width: 100%; border-collapse: collapse;
      font-size: 10.5px; margin-bottom: 8px;
    }
    .top-models-table th {
      font-size: 8px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--t400);
      padding: 4px 6px; text-align: left;
      border-bottom: 1px solid var(--border);
    }
    .top-models-table td {
      padding: 5px 6px; color: var(--t200);
      font-family: 'IBM Plex Mono', monospace;
      font-variant-numeric: tabular-nums;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .top-models-table tr:last-child td { border-bottom: none; }
    .top-models-table .model-name {
      font-family: 'DM Sans', system-ui, sans-serif;
      font-size: 10px; max-width: 130px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* Right Panel Section Header */
    .rp-section { margin-bottom: 8px; }
    .rp-section-title {
      font-size: 8px; font-weight: 600; letter-spacing: 0.12em;
      text-transform: uppercase; color: var(--t400);
      padding: 4px 3px 6px; border-bottom: 1px solid var(--border);
      margin-bottom: 7px;
    }

    /* ══ COMPACT INSIGHTS ═══════════════════════════════════════════ */
    .view-compact .insights-panel {
      margin: 4px 6px 0;
      border: 1px solid var(--border);
      border-radius: var(--r-card);
      background: var(--bg-card);
      overflow: hidden;
    }
    .view-dashboard .insights-panel { display: none; }

    .insights-toggle {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 11px; cursor: pointer;
      font-size: 9px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--t400);
    }
    .insights-toggle:hover { color: var(--t200); }
    .insights-toggle-icon { font-size: 12px; transition: transform 120ms; }
    .insights-panel.open .insights-toggle-icon { transform: rotate(180deg); }

    .insights-body {
      display: none;
      padding: 0 11px 10px;
    }
    .insights-panel.open .insights-body { display: block; }

    .insights-row1 {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px; font-variant-numeric: tabular-nums;
      color: var(--t100); margin-bottom: 3px;
    }
    .insights-row2 {
      font-size: 10px; color: var(--t300); margin-bottom: 7px;
    }
    .insights-sparkline {
      display: flex; align-items: flex-end; gap: 3px;
      height: 24px; margin-bottom: 3px;
    }
    .sparkline-bar-wrap { flex: 1; display: flex; flex-direction: column; gap: 1px; align-items: stretch; }
    .sparkline-bar {
      border-radius: 2px 2px 0 0;
      min-height: 2px;
      transition: height 300ms;
    }
    .sparkline-label {
      font-size: 8px; color: var(--t400); text-align: right;
    }
```

- [x] **Step 2: Rechtes Panel und Insights-Panel zum HTML hinzufügen**

Im Dashboard-View `<div class="view" id="view-dashboard">` die Struktur erweitern:

```html
  <div class="view" id="view-dashboard">
    <div class="content" id="content">
      <div class="empty">
        <div class="spinner"></div>
        <span>Loading…</span>
      </div>
    </div>
    <!-- Rechtes Panel (nur Dashboard-Modus) -->
    <div id="right-panel">
      <div class="rp-section">
        <div class="rp-section-title">Quick Stats</div>
        <div class="qs-grid" id="qs-grid">
          <div class="qs-tile"><div class="qs-tile-lbl">API-Äq. (30d)</div><div class="qs-tile-val" id="qs-api-cost">—</div></div>
          <div class="qs-tile"><div class="qs-tile-lbl">Abo ROI</div><div class="qs-tile-val" id="qs-roi">—</div></div>
          <div class="qs-tile"><div class="qs-tile-lbl">Aktive Tage</div><div class="qs-tile-val" id="qs-active-days">—</div></div>
          <div class="qs-tile"><div class="qs-tile-lbl">Ø Session</div><div class="qs-tile-val" id="qs-session">—</div></div>
        </div>
      </div>
      <div class="rp-section">
        <div class="rp-section-title">Top Models (30d)</div>
        <table class="top-models-table" id="top-models-table">
          <thead><tr><th>Modell</th><th>Kosten</th><th>%</th></tr></thead>
          <tbody id="top-models-body"><tr><td colspan="3" style="color:var(--t400);text-align:center">Lädt…</td></tr></tbody>
        </table>
      </div>
      <div class="rp-section">
        <div class="rp-section-title">Cost Window</div>
        <div class="pill-grid-3" id="window-pill-grid">
          <button class="pill" data-win="7d">7 Tage</button>
          <button class="pill" data-win="30d">30 Tage</button>
          <button class="pill active" data-win="billing">Abrechn.</button>
        </div>
      </div>
    </div>
  </div>
```

Außerdem direkt **nach** `</div>` des Dashboard-Views und **vor** dem Settings-View einfügen:

```html
  <!-- Compact Insights (nur Compact-Modus) -->
  <div class="insights-panel" id="insights-panel">
    <div class="insights-toggle" id="insights-toggle">
      INSIGHTS <span class="insights-toggle-icon">∨</span>
    </div>
    <div class="insights-body">
      <div class="insights-row1" id="ins-cost-roi">—</div>
      <div class="insights-row2" id="ins-days-session">—</div>
      <div class="insights-sparkline" id="ins-sparkline"></div>
      <div class="sparkline-label" id="ins-sparkline-label">7-Tage Kosten</div>
    </div>
  </div>
```

Die bestehenden Cost Window Pills aus dem Settings-Panel **entfernen** (die gesamte `<div class="s-section">` mit `id="window-pill-grid"`). Stattdessen sind die Pills jetzt nur im rechten Panel.

Im Settings-Panel den `costWindow`-Handler entfernen. In `loadSettingsUI` die `activeCostWindow`-Zeilen entfernen. Im `btn-save`-Handler `costWindow: activeCostWindow` entfernen — Cost Window wird jetzt separat über das rechte Panel gespeichert.

- [x] **Step 3: JS für rechtes Panel und Insights**

Im `<script>`-Block in `index.html` einfügen:

```javascript
    // ── Analytics Summary laden ──────────────────────────────────────

    async function loadAnalyticsSummary() {
      try {
        const s = await QB.ipc.invoke('analytics:summary');
        updateQuickStats(s);
        updateTopModels(s);
        updateInsights(s);
      } catch (e) {
        console.error('analytics:summary failed', e);
      }
    }

    function updateQuickStats(s) {
      const roi = s.roiFactor?.combined ?? 0;
      document.getElementById('qs-api-cost').textContent   = `$${(s.apiCostUSD?.total ?? 0).toFixed(0)}`;
      document.getElementById('qs-roi').textContent        = `${roi.toFixed(1)}×`;
      document.getElementById('qs-roi').style.color        = QB.roiColor(roi);
      document.getElementById('qs-active-days').textContent = `${s.activeDays ?? 0}/${s.windowDays ?? 30}`;
      document.getElementById('qs-session').textContent    = `${s.avgSessionMinutes ?? 0} min`;
    }

    function updateTopModels(s) {
      const tbody = document.getElementById('top-models-body');
      if (!s.topModels?.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--t400);text-align:center">Keine Daten</td></tr>';
        return;
      }
      tbody.innerHTML = s.topModels.map(m =>
        `<tr>
          <td class="model-name" title="${QB.esc(m.model)}">${QB.esc(m.model.replace(/^claude-|^gpt-/,''))}</td>
          <td>$${(m.costUSD).toFixed(2)}</td>
          <td>${(m.pctOfTotal * 100).toFixed(0)}%</td>
        </tr>`
      ).join('');
    }

    function updateInsights(s) {
      const roi  = s.roiFactor?.combined ?? 0;
      const cost = s.apiCostUSD?.total ?? 0;
      const sub  = s.subscriptionCostUSD?.total ?? 0;
      document.getElementById('ins-cost-roi').textContent =
        `$${cost.toFixed(0)} API-Äq.  vs $${sub.toFixed(0)} Abo  ${roi.toFixed(1)}×`;
      document.getElementById('ins-cost-roi').style.color = QB.roiColor(roi);
      document.getElementById('ins-days-session').textContent =
        `${s.activeDays ?? 0}/${s.windowDays ?? 30} Tage aktiv · Ø ${s.avgSessionMinutes ?? 0} min/Ses`;
      renderSparkline(s.sparkline7d ?? []);
    }

    function renderSparkline(data) {
      const container = document.getElementById('ins-sparkline');
      if (!data.length) { container.innerHTML = ''; return; }
      const maxVal = Math.max(...data.map(d => d.claudeUSD + d.codexUSD), 0.01);
      container.innerHTML = data.map(d => {
        const total  = d.claudeUSD + d.codexUSD;
        const cPct   = Math.round((d.claudeUSD / maxVal) * 100);
        const dPct   = Math.round((d.codexUSD  / maxVal) * 100);
        const totPct = Math.round((total        / maxVal) * 100);
        return `<div class="sparkline-bar-wrap" title="${d.date}: $${total.toFixed(2)}">
          <div class="sparkline-bar" style="height:${cPct}%;background:var(--claude-col)"></div>
          <div class="sparkline-bar" style="height:${dPct}%;background:var(--codex-col)"></div>
        </div>`;
      }).join('');
    }

    // Insights-Panel Toggle
    document.getElementById('insights-toggle').addEventListener('click', async () => {
      const panel = document.getElementById('insights-panel');
      const isOpen = panel.classList.toggle('open');
      const s = await QB.ipc.invoke('settings:get');
      await QB.ipc.invoke('settings:save', { ...s, insightsPanelOpen: isOpen });
    });

    // Cost-Window-Pills im rechten Panel (window-pill-grid ist jetzt im rechten Panel)
    document.querySelectorAll('#window-pill-grid .pill').forEach(btn => {
      btn.addEventListener('click', async () => {
        activeCostWindow = btn.dataset.win;
        document.querySelectorAll('#window-pill-grid .pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        // Sofort speichern (kein Save-Button nötig)
        const s = await QB.ipc.invoke('settings:get');
        await QB.ipc.invoke('settings:save', { ...s, costWindow: activeCostWindow });
      });
    });
```

- [x] **Step 4: `loadSettingsUI` und `quota:update` anpassen**

In `loadSettingsUI` ergänzen (für Insights-Panel-Zustand und Cost-Window-Pills im rechten Panel):

```javascript
    async function loadSettingsUI() {
      try {
        const s = await QB.ipc.invoke('settings:get');
        document.getElementById('cost-claude').value   = s.subscriptionCosts?.claude ?? 20;
        document.getElementById('cost-codex').value    = s.subscriptionCosts?.codex  ?? 10;
        document.getElementById('tog-offline').checked = !!s.pricingOfflineMode;

        activePillVal = s.pollIntervalSeconds ?? 60;
        const stdVals = [30, 60, 120, 300];
        const closest = stdVals.reduce((a, b) =>
          Math.abs(b - activePillVal) < Math.abs(a - activePillVal) ? b : a);
        document.querySelectorAll('#pill-grid .pill').forEach(p => {
          p.classList.toggle('active', parseInt(p.dataset.val, 10) === closest);
        });

        // Cost Window (rechtes Panel)
        activeCostWindow = s.costWindow ?? 'billing';
        document.querySelectorAll('#window-pill-grid .pill').forEach(p => {
          p.classList.toggle('active', p.dataset.win === activeCostWindow);
        });

        // Insights-Panel
        const insightsPanel = document.getElementById('insights-panel');
        if (s.insightsPanelOpen) insightsPanel.classList.add('open');
        else insightsPanel.classList.remove('open');
      } catch (e) {
        console.error('Failed to load settings', e);
      }
    }
```

Im `quota:update`-Handler nach `render(data.snapshots)` einfügen:

```javascript
      loadAnalyticsSummary();
```

Im `btn-save`-Handler `costWindow`-Feld entfernen (wird jetzt per Pill direkt gespeichert):

```javascript
      const payload = {
        pollIntervalSeconds: activePillVal,
        subscriptionCosts: {
          claude: parseFloat(document.getElementById('cost-claude').value) || 20,
          codex:  parseFloat(document.getElementById('cost-codex').value)  || 10,
        },
        pricingOfflineMode: document.getElementById('tog-offline').checked,
      };
```

- [x] **Step 5: App manuell testen im Dashboard-Modus**

```
npx electron .
```
Prüfen:
- Dashboard zeigt 2-spaltig: Provider-Karten links, Quick Stats + Top Models + Cost Window rechts
- Quick Stats zeigen API-Kosten, ROI, Aktive Tage, Session-Dauer
- Cost Window Pills funktionieren und speichern sofort
- Compact-Modus zeigt nur linke Spalte

- [x] **Step 6: Tests laufen**

```
npx vitest run
```
Erwartet: Nur pre-existing colors.test.ts-Fail.

- [x] **Step 7: Commit**

```
git add src/renderer/index.html
git commit -m "feat(ui): 2-column dashboard layout with Quick Stats, Top Models, and Cost Window panel"
```

---

### Task 8: Compact Insights-Leiste finalisieren

**Files:**
- Modify: `src/renderer/index.html`

Das HTML und CSS für die Insights-Leiste wurde bereits in Task 7 eingefügt. Dieser Task stellt sicher dass der Initialisierungsfluss korrekt ist und die Leiste beim App-Start korrekt geladen wird.

- [x] **Step 1: Initialisierung beim App-Start sicherstellen**

Im `quota:ready-ack`-Handler in `index.html` (den wir in Task 6 hinzugefügt haben) `loadAnalyticsSummary()` aufrufen:

```javascript
    QB.ipc.on('quota:ready-ack', async (_, data) => {
      document.body.classList.toggle('view-dashboard', data.viewMode === 'dashboard');
      document.body.classList.toggle('view-compact',   data.viewMode !== 'dashboard');
      const s = await QB.ipc.invoke('settings:get');
      // Cost Window initialisieren
      activeCostWindow = s.costWindow ?? 'billing';
      document.querySelectorAll('#window-pill-grid .pill').forEach(p => {
        p.classList.toggle('active', p.dataset.win === activeCostWindow);
      });
      // Insights-Panel Zustand
      if (s.insightsPanelOpen) document.getElementById('insights-panel').classList.add('open');
      // Analytics sofort laden
      loadAnalyticsSummary();
    });
```

- [x] **Step 2: App manuell testen im Compact-Modus**

```
npx electron .
```
Dann View-Switcher auf Compact klicken. Prüfen:
- Insights-Leiste erscheint unterhalb der Provider-Karten
- `∨` öffnet/schließt sie
- Nach Öffnen: `$298 API-Äq. vs $30 Abo 9.9×` und `20/30 Tage aktiv · Ø 54 min/Ses` sichtbar
- Sparkline zeigt 7 Balken in Claude-Orange und Codex-Grün
- State wird über App-Neustart hinaus gespeichert

- [x] **Step 3: Alle Tests laufen**

```
npx vitest run
```
Erwartet: 129+ Tests grün, nur pre-existing `colors.test.ts`-Fail.

- [x] **Step 4: Final Commit**

```
git add src/renderer/index.html
git commit -m "feat(ui): finalize compact insights strip with sparkline and persistent open state"
```

---

## Self-Review

**1. Spec-Abdeckung:**
- ✅ `viewMode` in Settings (Task 1)
- ✅ `insightsPanelOpen` in Settings (Task 1)
- ✅ Codex Modell-Preise gpt-5.x (Task 2)
- ✅ `analytics:summary` IPC-Handler mit `AnalyticsSummary` (Task 3)
- ✅ Renderer-Module `shared/` (Task 4)
- ✅ `tabs/live.js` extrahiert (Task 5)
- ✅ Window-Sizing 900×660 Dashboard / 340×560 Compact (Task 6)
- ✅ View-Switcher `⊞`-Button (Task 6)
- ✅ 2-Spalten-Grid mit Quick Stats + Top Models + Cost Window rechts (Task 7)
- ✅ Cost Window Pills aus Settings entfernt, ins rechte Panel verschoben (Task 7)
- ✅ Compact Insights-Leiste mit Sparkline (Tasks 7+8)
- ✅ ROI-Farbkodierung: grün ≥ 2×, gelb 1–2×, grau < 1× (Task 7)

**2. Placeholder-Scan:** Keine TBD/TODO im Plan. Alle Schritte enthalten vollständigen Code.

**3. Typ-Konsistenz:**
- `AnalyticsSummary` definiert in Task 3 (`analyticsSummary.ts`), verwendet in Tasks 3, 7 — konsistent.
- `QB.roiColor` definiert in Task 4 (`colors.js`), verwendet in Task 7 (`index.html`) — konsistent.
- `QB.renderLive` definiert in Task 5 (`live.js`), aufgerufen in Task 5 (`index.html`) — konsistent.
- `window:set-view` IPC definiert in Task 3 (`detailsWindow.ts`), aufgerufen in Task 6 (`index.html`) — konsistent.
- `quota:ready-ack` IPC definiert in Task 6 (`detailsWindow.ts`), empfangen in Tasks 6+8 (`index.html`) — konsistent.
