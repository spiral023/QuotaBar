# 5H Window Pressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the token-vs-arbitrary-thresholds "5H Window Peak" analytics tile with a real `fivePct`-utilization distribution ("5H Window Pressure"), shown side-by-side for Claude and Codex.

**Architecture:** A new IO-free aggregator `buildFiveHourPressure` in `src/usage/windowHistory.ts` segments live-log snapshot observations into 5h windows (by `fiveResetsAt`), takes each window's peak `fivePct`, and buckets active windows by fill level. The analytics worker reads the snapshot logs (newly passed `logDir`), computes one distribution per provider, and emits `fiveHourPressure` on `AnalyticsData`. The renderer replaces `_buildFiveHourPeak` with a two-column `_buildFiveHourPressure`.

**Tech Stack:** TypeScript (strict), Vitest, Electron (main worker thread + vanilla-JS renderer).

## Global Constraints

- All user-facing UI strings stay **English** (app convention).
- TypeScript strict mode — no `any`, all fields typed.
- Test runner: `npm test` (= `vitest run`). Build check: `npm run build` (= `tsc -p tsconfig.json`).
- Renderer tab scripts share one global scope; do not introduce new top-level symbol collisions (existing file already uses `_`-prefixed module-locals).
- `fivePct` is a 0–100 **percent** (not a 0–1 fraction).
- The tile is **replaced**, not added — no parallel `fiveHourPeak` field/tile remains.

---

### Task 1: `buildFiveHourPressure` aggregator + `PressureDist` type

**Files:**
- Modify: `src/usage/windowHistory.ts` (add type + function near `buildWindowHistory`)
- Test: `tests/windowHistory.test.ts` (add a new `describe` block; reuse existing `obs()` helper)

**Interfaces:**
- Consumes: `HistoryObservation` (existing, in `windowHistory.ts`), `resetsAtChanged` (existing import), `USED_WINDOW_MIN_PCT` (existing export = 5).
- Produces:
  ```ts
  export interface PressureDist {
    buckets: { crit: number; high: number; mid: number; low: number; min: number };
    total: number;     // active windows (peak > 5%)
    hotCount: number;  // windows with peak >= 90% (equals buckets.crit)
    worst: { pct: number; windowStart: string } | null;
  }
  export function buildFiveHourPressure(
    observations: HistoryObservation[],
    sinceMs: number,
    untilMs: number,
    provider: string,
  ): PressureDist
  ```

- [ ] **Step 1: Write the failing tests**

Add to the end of `tests/windowHistory.test.ts` (the `obs()` helper and imports already exist at the top — extend the import to include `buildFiveHourPressure` and `PressureDist`):

```ts
import {
  buildWindowHistory,
  buildFiveHourPressure,
  type HistoryObservation,
  type PressureDist,
} from "../src/usage/windowHistory";

// ... existing tests ...

describe("buildFiveHourPressure", () => {
  const SINCE = Date.parse("2026-06-01T00:00:00Z");
  const UNTIL = Date.parse("2026-06-30T00:00:00Z");
  const FA = "2026-06-02T05:00:00Z";
  const FB = "2026-06-02T10:00:00Z";
  const FC = "2026-06-02T15:00:00Z";

  it("returns an empty distribution for no observations", () => {
    const r = buildFiveHourPressure([], SINCE, UNTIL, "claude");
    expect(r).toEqual<PressureDist>({
      buckets: { crit: 0, high: 0, mid: 0, low: 0, min: 0 },
      total: 0,
      hotCount: 0,
      worst: null,
    });
  });

  it("segments by fiveResetsAt and buckets each window's peak", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 20, FA, 2, R1), // window A peak 95 -> crit
      obs("2026-06-02T04:00:00Z", 95, FA, 5, R1),
      obs("2026-06-02T05:30:00Z", 60, FB, 6, R1), // window B peak 60 -> mid
      obs("2026-06-02T09:00:00Z", 40, FB, 9, R1),
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(2);
    expect(r.buckets.crit).toBe(1);
    expect(r.buckets.mid).toBe(1);
    expect(r.hotCount).toBe(1);
    expect(r.worst).toEqual({ pct: 95, windowStart: "2026-06-02T00:30:00Z" });
  });

  it("ignores windows whose peak is at or below 5%", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 3, FA, 1, R1),
      obs("2026-06-02T04:00:00Z", 5, FA, 1, R1), // peak 5 -> not active
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(0);
    expect(r.worst).toBeNull();
  });

  it("places boundary values in the upper bucket (>= semantics)", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 90, FA, 1, R1), // -> crit (>=90)
      obs("2026-06-02T05:30:00Z", 75, FB, 1, R1), // -> high (>=75)
      obs("2026-06-02T10:30:00Z", 50, FC, 1, R1), // -> mid  (>=50)
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.buckets).toEqual({ crit: 1, high: 1, mid: 1, low: 0, min: 0 });
  });

  it("excludes windows whose start falls outside [sinceMs, untilMs]", () => {
    const data = [
      obs("2026-05-15T00:30:00Z", 95, FA, 1, R1), // before SINCE
      obs("2026-05-15T04:00:00Z", 95, FA, 1, R1),
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(0);
  });

  it("separates providers — only counts the requested provider's windows", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 95, FA, 1, R1, "claude"),
      obs("2026-06-02T00:30:00Z", 80, FA, 1, R1, "codex"),
    ];
    const claude = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    const codex = buildFiveHourPressure(data, SINCE, UNTIL, "codex");
    expect(claude.total).toBe(1);
    expect(claude.buckets.crit).toBe(1);
    expect(codex.total).toBe(1);
    expect(codex.buckets.high).toBe(1);
  });

  it("does not split a window when fiveResetsAt is null", () => {
    const data = [
      obs("2026-06-02T00:30:00Z", 30, null, 1, R1),
      obs("2026-06-02T04:00:00Z", 70, null, 1, R1), // same window, peak 70 -> mid
    ];
    const r = buildFiveHourPressure(data, SINCE, UNTIL, "claude");
    expect(r.total).toBe(1);
    expect(r.buckets.mid).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- windowHistory`
Expected: FAIL — `buildFiveHourPressure is not a function` / `PressureDist` not exported.

- [ ] **Step 3: Implement `buildFiveHourPressure`**

In `src/usage/windowHistory.ts`, after the `buildEntry` function (end of file), add:

```ts
/** Spitzen-fivePct, ab dem ein 5h-Fenster als „heiß" (throttling-nah) gilt. */
export const PRESSURE_HOT_PCT = 90;

export interface PressureDist {
  buckets: { crit: number; high: number; mid: number; low: number; min: number };
  total: number;     // aktive Fenster (Peak > USED_WINDOW_MIN_PCT)
  hotCount: number;  // Fenster mit Peak >= PRESSURE_HOT_PCT (= buckets.crit)
  worst: { pct: number; windowStart: string } | null;
}

/**
 * Verteilung der Spitzen-Auslastung (fivePct) über die aktiven 5h-Fenster eines
 * Anbieters im Zeitraum [sinceMs, untilMs]. Segmentiert nach fiveResetsAt; je
 * Fenster zählt der Spitzenwert. Idle-Fenster (Peak <= 5 %) werden verworfen.
 */
export function buildFiveHourPressure(
  observations: HistoryObservation[],
  sinceMs: number,
  untilMs: number,
  provider: string,
): PressureDist {
  const buckets = { crit: 0, high: 0, mid: 0, low: 0, min: 0 };
  let total = 0;
  let worst: { pct: number; windowStart: string } | null = null;

  const list = observations
    .filter((o) => o.provider === provider)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  let curReset: string | null | undefined;
  let curPeak = 0;
  let curStart: string | null = null;
  let started = false;

  const flush = (): void => {
    if (!started || curStart === null) return;
    const startMs = new Date(curStart).getTime();
    if (!Number.isFinite(startMs) || startMs < sinceMs || startMs > untilMs) return;
    if (curPeak <= USED_WINDOW_MIN_PCT) return;
    total++;
    if (curPeak >= 90) buckets.crit++;
    else if (curPeak >= 75) buckets.high++;
    else if (curPeak >= 50) buckets.mid++;
    else if (curPeak >= 25) buckets.low++;
    else buckets.min++;
    if (!worst || curPeak > worst.pct) worst = { pct: curPeak, windowStart: curStart };
  };

  for (const o of list) {
    if (!started) {
      started = true;
      curReset = o.fiveResetsAt;
      curPeak = o.fivePct;
      curStart = o.ts;
    } else if (resetsAtChanged(curReset, o.fiveResetsAt)) {
      flush();
      curReset = o.fiveResetsAt;
      curPeak = o.fivePct;
      curStart = o.ts;
    } else if (o.fivePct > curPeak) {
      curPeak = o.fivePct;
    }
  }
  flush();

  return { buckets, total, hotCount: buckets.crit, worst };
}
```

Note: `USED_WINDOW_MIN_PCT` and `resetsAtChanged` are already in scope in this file (the latter via the existing top import).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- windowHistory`
Expected: PASS (all `buildFiveHourPressure` cases + existing `buildWindowHistory` cases).

- [ ] **Step 5: Commit**

```bash
git add src/usage/windowHistory.ts tests/windowHistory.test.ts
git commit -m "feat(analytics): add buildFiveHourPressure aggregator"
```

---

### Task 2: Wire `fiveHourPressure` through worker + IPC; remove old `fiveHourPeak`

**Files:**
- Modify: `src/main/analyticsSummary.ts` (remove `buildFiveHourPeak` + `FIVE_HOURS_MS`; swap `fiveHourPeak` → `fiveHourPressure` in `AnalyticsData`)
- Modify: `src/main/analyticsWorker.ts` (add `logDir`/`nowMs` to input; compute the two dists; replace field)
- Modify: `src/main/detailsWindow.ts:363-369` (pass `logDir` + `nowMs` into the `analytics:get` worker call)
- Modify: `tests/analyticsDeepDive.test.ts` (remove the `buildFiveHourPeak` describe block + import)

**Interfaces:**
- Consumes: `buildFiveHourPressure`, `PressureDist`, `readWindowHistoryObservations` (existing), `getDebugLogDir` (existing import in `detailsWindow.ts`).
- Produces: `AnalyticsData.fiveHourPressure: { claude: PressureDist; codex: PressureDist }` (consumed by Task 3).

- [ ] **Step 1: Remove `buildFiveHourPeak` and swap the type in `analyticsSummary.ts`**

In `src/main/analyticsSummary.ts`:
1. Delete the `FIVE_HOURS_MS` constant and the entire `buildFiveHourPeak` function (the block at lines ~264-300).
2. In the `AnalyticsData` interface, replace:
   ```ts
   fiveHourPeak: { maxOutputTokens: number; maxTotalTokens: number; peakWindowStart: string | null };
   ```
   with:
   ```ts
   fiveHourPressure: { claude: PressureDist; codex: PressureDist };
   ```
3. Add an import at the top of the file:
   ```ts
   import type { PressureDist } from "../usage/windowHistory";
   ```

- [ ] **Step 2: Update the worker (`analyticsWorker.ts`)**

In `src/main/analyticsWorker.ts`:
1. Extend the import from `./windowHistory` … actually from `../usage/windowHistory` (already imports `buildWindowHistory`): add `buildFiveHourPressure`.
   ```ts
   import { buildWindowHistory, buildFiveHourPressure, type WindowHistoryEntry } from "../usage/windowHistory";
   ```
2. Remove `buildFiveHourPeak` from the `./analyticsSummary` import list.
3. Add two fields to `AnalyticsTaskInput`:
   ```ts
   interface AnalyticsTaskInput {
     task: "get" | "summary";
     claudeProjectsDirs: string[];
     codexSessionsDirs: string[];
     periodStartMs: number;
     windowDays: number;
     since: string;
     until?: string;
     settings: Settings;
     cacheHitRate: { claude: number; codex: number };
     eurUsdRates?: Record<string, number>;
     fxEstimated?: boolean;
     logDir: string;   // NEW: snapshot debug logs for fivePct
     nowMs: number;    // NEW: upper bound when `until` is absent
   }
   ```
4. In `run()`, inside the `task === "get"` branch (the part that builds the full `AnalyticsData`, after `fiveHourPeak` is currently computed at line ~181), replace the `fiveHourPeak` line. First read observations and compute bounds — add near the other `build*` calls:
   ```ts
   const pressureObs = await readWindowHistoryObservations(input.logDir);
   const sinceMs = input.periodStartMs;
   const untilMs = input.until
     ? Date.parse(input.until) + 24 * 3600 * 1000
     : input.nowMs;
   const fiveHourPressure = {
     claude: buildFiveHourPressure(pressureObs, sinceMs, untilMs, "claude"),
     codex:  buildFiveHourPressure(pressureObs, sinceMs, untilMs, "codex"),
   };
   ```
   Then in the `result: AnalyticsData = { ... }` object literal, replace `fiveHourPeak,` with `fiveHourPressure,`.

   (`readWindowHistoryObservations` is already imported in this file.)

- [ ] **Step 3: Pass `logDir`/`nowMs` from the IPC handler (`detailsWindow.ts`)**

In `src/main/detailsWindow.ts`, the `analytics:get` handler (lines ~363-369), add the two fields to the worker input:
```ts
return this.analyticsDataCache.get(`get:${since}:${until}:${planSig}`, () => runAnalyticsWorker({
  task: "get",
  claudeProjectsDirs: getClaudeProjectsDirs(),
  codexSessionsDirs:  getCodexSessionsDirs(),
  periodStartMs, windowDays, since, until, settings, cacheHitRate,
  eurUsdRates, fxEstimated,
  logDir: getDebugLogDir(),
  nowMs: Date.now(),
}) as Promise<AnalyticsData>);
```
(`getDebugLogDir` is already imported at the top of this file.)

- [ ] **Step 4: Remove the obsolete `buildFiveHourPeak` tests**

In `tests/analyticsDeepDive.test.ts`:
1. Remove `buildFiveHourPeak` from the import block (line ~9).
2. Delete the entire `describe("buildFiveHourPeak", () => { ... })` block (lines ~168-222).

- [ ] **Step 5: Build + test to verify the swap compiles and the suite is green**

Run: `npm run build`
Expected: PASS — no TypeScript errors (confirms every `fiveHourPeak` reference is gone and `fiveHourPressure` is consistently typed).

Run: `npm test`
Expected: PASS — full suite green; no remaining references to `buildFiveHourPeak`.

- [ ] **Step 6: Commit**

```bash
git add src/main/analyticsSummary.ts src/main/analyticsWorker.ts src/main/detailsWindow.ts tests/analyticsDeepDive.test.ts
git commit -m "feat(analytics): emit per-provider fiveHourPressure, drop fiveHourPeak"
```

---

### Task 3: Renderer — two-column "5H Window Pressure" tile

**Files:**
- Modify: `src/renderer/tabs/analytics.js` (section title ~317; call site ~362; replace `_buildFiveHourPeak`; remove `_FIVE_HOUR_THRESHOLDS`)
- Modify: `src/renderer/styles.css` (replace `an-peak*` rules with pressure rules; keep `an-threshold*`)

**Interfaces:**
- Consumes: `data.fiveHourPressure: { claude: PressureDist; codex: PressureDist }` (from Task 2), `QB.esc` (existing renderer helper).
- Produces: rendered DOM in `#an-peak` (container id kept to minimize churn).

- [ ] **Step 1: Update the section title**

In `src/renderer/tabs/analytics.js` line ~317, change:
```js
<div class="an-section-head"><span class="an-section-title">5H WINDOW PEAK (CLAUDE, ${winLabel})</span></div>
```
to:
```js
<div class="an-section-head"><span class="an-section-title">5H WINDOW PRESSURE (${winLabel})</span></div>
```

- [ ] **Step 2: Replace the call site**

In `src/renderer/tabs/analytics.js` line ~362, change `_buildFiveHourPeak(data);` to `_buildFiveHourPressure(data);`.

- [ ] **Step 3: Replace `_buildFiveHourPeak` + `_FIVE_HOUR_THRESHOLDS` with the pressure renderer**

In `src/renderer/tabs/analytics.js`, delete `_FIVE_HOUR_THRESHOLDS` (lines ~895-902) and the `_buildFiveHourPeak` function (lines ~904-932), and insert:

```js
const _PRESSURE_BUCKETS = [
  { key: 'crit', lbl: '>=90%', color: '#e55' },
  { key: 'high', lbl: '75-90', color: '#f59830' },
  { key: 'mid',  lbl: '50-75', color: '#b9d617' },
  { key: 'low',  lbl: '25-50', color: '#52d017' },
  { key: 'min',  lbl: '5-25',  color: '#3a8a2a' },
];

function _pressureColumn(title, dist) {
  if (!dist || dist.total === 0) {
    return `
      <div class="an-pcol">
        <div class="an-pcol-head">${title}</div>
        <div class="an-pcol-empty">Not enough window data yet</div>
      </div>`;
  }
  const maxCount = Math.max(..._PRESSURE_BUCKETS.map(b => dist.buckets[b.key]), 1);
  const rows = _PRESSURE_BUCKETS.map(b => {
    const c = dist.buckets[b.key];
    const w = Math.round((c / maxCount) * 100);
    return `
      <div class="an-threshold-row">
        <div class="an-threshold-lbl">${b.lbl}</div>
        <div class="an-threshold-track"><div class="an-threshold-fill" style="width:${w}%;background:${b.color}"></div></div>
        <div class="an-threshold-pct">${c}</div>
      </div>`;
  }).join('');
  const worst = dist.worst
    ? `${Math.round(dist.worst.pct)}% · ${new Date(dist.worst.windowStart).toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : '—';
  return `
    <div class="an-pcol">
      <div class="an-pcol-head">${title} · <b>${dist.hotCount}/${dist.total}</b> hot (&gt;=90%)</div>
      <div class="an-threshold">${rows}</div>
      <div class="an-pcol-worst">Worst ${QB.esc(worst)}</div>
    </div>`;
}

function _buildFiveHourPressure(data) {
  const el = document.getElementById('an-peak');
  if (!el) return;
  const p = data.fiveHourPressure ?? { claude: null, codex: null };
  el.innerHTML = `
    <div class="an-pressure">
      ${_pressureColumn('CLAUDE', p.claude)}
      ${_pressureColumn('CODEX', p.codex)}
    </div>`;
}
```

Note: `worst` uses **local** time (no `timeZone: 'UTC'`) — this fixes the confusing UTC display of the old tile.

- [ ] **Step 4: Replace the CSS**

In `src/renderer/styles.css`, replace the `.an-peak-hero` and `.an-peak-sub` rules (lines ~992-997) with the pressure layout rules (keep the existing `.an-threshold*` rules — they are reused):
```css
    .an-pressure {
      display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    }
    .view-compact .an-pressure { grid-template-columns: 1fr; }
    .an-pcol { min-width: 0; }
    .an-pcol-head {
      font-size: 10px; color: var(--t300); margin-bottom: 8px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .an-pcol-head b { color: var(--t100); font-weight: 600; }
    .an-pcol-empty { font-size: 10px; color: var(--t400); padding: 12px 0; }
    .an-pcol-worst { font-size: 9px; color: var(--t400); margin-top: 8px; }
```
(If `--t100`/`--t300`/`--t400` are not the exact token names in this file, use the nearest existing text-color variables — grep `--t` in `styles.css` to confirm.)

- [ ] **Step 5: Build to verify the renderer compiles**

Run: `npm run build`
Expected: PASS — TypeScript build clean (renderer JS is copied; no TS errors introduced elsewhere).

- [ ] **Step 6: Manual verification in the app**

Run: `npm run dev`
Open the dashboard → Analytics tab. Confirm:
- The tile titled **5H WINDOW PRESSURE (…)** shows two columns (CLAUDE left, CODEX right).
- Each column shows 5 bars (>=90% … 5-25), a `hot` headline, and a `Worst …%` line in **local** time.
- A provider with no window data shows "Not enough window data yet".
- Switching the window selector (e.g. 30 days vs 7 days) updates both columns.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/tabs/analytics.js src/renderer/styles.css
git commit -m "feat(analytics): render 5H Window Pressure tile (Claude + Codex)"
```

---

## Self-Review

**Spec coverage:**
- Datenquelle/Kennzahl (`buildFiveHourPressure` on `fivePct`, segment by `fiveResetsAt`, active >5%, time filter) → Task 1. ✓
- Buckets 90/75/50/25/5 with `>=` semantics → Task 1 (impl + boundary test). ✓
- Architecture/plumbing (`logDir`+`nowMs` into `analytics:get`, replace `fiveHourPeak`) → Task 2. ✓
- Two-provider side-by-side layout, own-max bar scaling, per-column empty state, local time, English strings → Task 3. ✓
- Cleanup (`buildFiveHourPeak`, `FIVE_HOURS_MS`, `_FIVE_HOUR_THRESHOLDS`, old field, old tests) → Tasks 2 & 3. ✓
- Tests incl. provider separation + null-reset → Task 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `PressureDist` shape (`buckets{crit,high,mid,low,min}`, `total`, `hotCount`, `worst{pct,windowStart}|null`) identical across Task 1 (def), Task 2 (`fiveHourPressure` field), Task 3 (renderer access via `_PRESSURE_BUCKETS` keys + `dist.hotCount`/`dist.total`/`dist.worst`). `buildFiveHourPressure(observations, sinceMs, untilMs, provider)` signature identical in def and both call sites. ✓
