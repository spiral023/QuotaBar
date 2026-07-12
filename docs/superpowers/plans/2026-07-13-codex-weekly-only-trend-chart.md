# Weekly-Only Trend Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the weekly trend chart and forecast for Codex snapshots that expose only a weekly quota (no five-hour window), and during the initial ratio-learning phase, without inventing any five-hour data.

**Architecture:** Introduce a "trend-eligible" state (weekly window present) that is weaker than the existing "full budget" state (`windowBudget` present and not learning). The weekly chart + forecast render for every trend-eligible snapshot; the five-hour tile, converted `currentUsage`, reset markers, and the `Window budget` label are added only in the full-budget state, so five-hour presence is purely additive. Backend selection and marker suppression live in side-effect-free modules so they are unit-testable; the analytics worker module cannot be imported in tests (it calls `parentPort!.on` at import time).

**Tech Stack:** TypeScript (Node/Electron main), vanilla JS renderer, Vitest.

## Global Constraints

- All UI strings remain English (`Window budget`, `Weekly trend`, `still learning…`). Never translate UI copy.
- Do not fabricate five-hour data for weekly-only snapshots. No stale-ratio reconstruction of the tile.
- Do not import `src/main/analyticsWorker.ts` from any test — it executes `parentPort!.on(...)` at module load and throws outside a worker thread. Import worker-owned types with `import type` only (erased at compile time).
- `readWeeklySeries` / `readWeeklySeriesForProviders` must keep reporting real five-hour markers; marker suppression is a presentation concern applied in the worker, not in the series reader.
- Provider window classification and quota semantics for Claude are unchanged. No pricing/cost changes.
- Follow existing patterns: German code comments, Vitest with temp-dir JSONL fixtures, `flatMap`-based snapshot filtering.

Reference spec: `docs/superpowers/specs/2026-07-13-codex-weekly-only-trend-chart-design.md`.

---

### Task 1: Series layer — `withBudgetMarkers` helper + weekly-only coverage

**Files:**
- Modify: `src/main/windowBudgetSeries.ts` (add exported helper after the `WindowBudgetSeries` interface, ~line 23)
- Test: `tests/windowBudgetSeries.test.ts` (add a `withBudgetMarkers` describe block; add one case to the `readWeeklySeries` describe)

**Interfaces:**
- Consumes: `WindowBudgetSeries` (existing: `{ points: WeeklySeriesPoint[]; fiveHourResets: string[]; currentUsage?: CurrentWindowUsage }`), `readWeeklySeriesForProviders` (existing).
- Produces: `withBudgetMarkers(series: WindowBudgetSeries, windowsPerWeek: number | null | undefined): WindowBudgetSeries` — returns the series unchanged when `windowsPerWeek` is a number; otherwise returns a copy with `fiveHourResets: []`. Task 2 consumes this.

- [ ] **Step 1: Write the failing tests for `withBudgetMarkers`**

Add to `tests/windowBudgetSeries.test.ts`. First extend the import on line 5 to include `withBudgetMarkers`:

```ts
import { readWeeklySeries, readWeeklySeriesForProviders, insertBreaks, withBudgetMarkers, GAP_THRESHOLD_MS, WEEKLY_RESET_DROP_PCT } from "../src/main/windowBudgetSeries";
```

Then add a new describe block at the end of the file (after the `insertBreaks` describe):

```ts
describe("withBudgetMarkers", () => {
  const base = () => ({
    points: [{ t: "2026-06-09T08:00:00Z", weeklyPct: 10 }],
    fiveHourResets: ["2026-06-09T10:00:00Z"],
  });

  it("keeps 5h reset markers when a window-budget ratio exists", () => {
    expect(withBudgetMarkers(base(), 8.3).fiveHourResets).toEqual(["2026-06-09T10:00:00Z"]);
  });

  it("drops 5h reset markers when the ratio is absent (weekly-only / learning)", () => {
    expect(withBudgetMarkers(base(), null).fiveHourResets).toEqual([]);
    expect(withBudgetMarkers(base(), undefined).fiveHourResets).toEqual([]);
  });

  it("leaves points untouched while suppressing markers", () => {
    const out = withBudgetMarkers(base(), null);
    expect(out.points).toEqual([{ t: "2026-06-09T08:00:00Z", weeklyPct: 10 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/windowBudgetSeries.test.ts -t "withBudgetMarkers"`
Expected: FAIL — `withBudgetMarkers is not a function` / import has no matching export.

- [ ] **Step 3: Implement `withBudgetMarkers`**

In `src/main/windowBudgetSeries.ts`, add directly after the `WindowBudgetSeries` interface (after line 23):

```ts
/**
 * Blendet die 5h-Reset-Marker aus, solange kein umgerechnetes Fenster-Budget
 * existiert (weekly-only oder Learning-Phase). Der reine Weekly-Trend bleibt
 * dadurch frei von 5h-Overlays; sobald `windowsPerWeek` bekannt ist, erscheinen
 * die echten Marker wieder. Präsentations-Filter — die Serie selbst meldet immer
 * die tatsächlich beobachteten Resets.
 */
export function withBudgetMarkers(
  series: WindowBudgetSeries,
  windowsPerWeek: number | null | undefined,
): WindowBudgetSeries {
  if (typeof windowsPerWeek === "number") return series;
  return { ...series, fiveHourResets: [] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/windowBudgetSeries.test.ts -t "withBudgetMarkers"`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing weekly-only series test**

Add inside the existing `describe("readWeeklySeries", ...)` block (before its closing `});` near line 289) a weekly-only fixture helper and a test. Place the helper just below the existing `snapLine` helper is not possible (it's outside the describe); instead define the helper inline at the top of the test body:

```ts
  it("weekly-only snapshots yield points but no currentUsage and no 5h resets", async () => {
    const weeklyOnly = (weeklyPct: number, ts: string) => JSON.stringify({
      ts, kind: "snapshot", provider: "codex", status: "ok",
      windows: [{ name: "weekly", usedPercent: weeklyPct, windowSeconds: 604800 }],
      fetchedAt: ts,
    });
    await fs.writeFile(path.join(dir, "2026-06-09.jsonl"), [
      weeklyOnly(20, "2026-06-09T08:00:00Z"),
      weeklyOnly(25, "2026-06-09T08:40:00Z"),
    ].join("\n"), "utf8");

    const [s] = await readWeeklySeriesForProviders(dir, [{
      provider: "codex",
      windowStartMs: START,
      windowsPerWeek: null,
      currentWeeklyPct: 25,
    }], NOW);

    expect(s.points.map((p) => p.weeklyPct)).toEqual([20, 25]);
    expect(s.currentUsage).toBeUndefined();
    expect(s.fiveHourResets).toEqual([]);
  });
```

- [ ] **Step 6: Run the weekly-only test to verify it passes**

Run: `npx vitest run tests/windowBudgetSeries.test.ts -t "weekly-only"`
Expected: PASS. (This validates the natural weekly-only path: no `fiveHour` window in the logs means no markers, and `windowsPerWeek: null` skips `currentUsage`. It is green immediately — it documents the data-path contract Task 2 relies on.)

- [ ] **Step 7: Run the full series test file**

Run: `npx vitest run tests/windowBudgetSeries.test.ts`
Expected: PASS (all existing + 4 new tests).

- [ ] **Step 8: Commit**

```bash
git add src/main/windowBudgetSeries.ts tests/windowBudgetSeries.test.ts
git commit -m "feat: add withBudgetMarkers series presentation filter"
```

---

### Task 2: Worker wiring — widen provider input type, suppress markers

**Files:**
- Modify: `src/main/analyticsWorker.ts` (extract/export `WindowBudgetProviderInput`, widen `windowsPerWeek`, call `withBudgetMarkers` in `buildWindowBudgetData`)

**Interfaces:**
- Consumes: `withBudgetMarkers` (Task 1).
- Produces: `export interface WindowBudgetProviderInput { provider: "claude" | "codex"; weeklyUsedPercent: number; weeklyResetsAt: string | null; windowsPerWeek: number | null; burnRatePctPerHour: number | null; pace: UsagePace | null; planType: string | null; }` — Task 3 imports this as `import type`.

- [ ] **Step 1: Export and widen the provider input type**

In `src/main/analyticsWorker.ts`, replace the inline `WindowBudgetTaskInput` definition (lines 48-61):

```ts
interface WindowBudgetTaskInput {
  task: "windowBudget";
  logDir: string;
  nowMs: number;
  providers: Array<{
    provider: "claude" | "codex";
    weeklyUsedPercent: number;
    weeklyResetsAt: string | null;
    windowsPerWeek: number;
    burnRatePctPerHour: number | null;
    pace: UsagePace | null;
    planType: string | null;
  }>;
}
```

with:

```ts
export interface WindowBudgetProviderInput {
  provider: "claude" | "codex";
  weeklyUsedPercent: number;
  weeklyResetsAt: string | null;
  windowsPerWeek: number | null;
  burnRatePctPerHour: number | null;
  pace: UsagePace | null;
  planType: string | null;
}

interface WindowBudgetTaskInput {
  task: "windowBudget";
  logDir: string;
  nowMs: number;
  providers: WindowBudgetProviderInput[];
}
```

- [ ] **Step 2: Import `withBudgetMarkers` and apply it in `buildWindowBudgetData`**

Extend the existing import from `./windowBudgetSeries` (line 21) to include `withBudgetMarkers`:

```ts
import { readWeeklySeriesForProviders, withBudgetMarkers, type WindowBudgetSeries } from "./windowBudgetSeries";
```

Then in `buildWindowBudgetData`, replace the line `const series = seriesList[i];` (line 314) with:

```ts
    const series = withBudgetMarkers(seriesList[i], p.windowsPerWeek);
```

- [ ] **Step 3: Typecheck the build**

Run: `npm run build`
Expected: PASS — `windowsPerWeek: number | null` flows into `WeeklySeriesRequest.windowsPerWeek` (already `number | null`) and into `withBudgetMarkers`. `buildCurrentWindowUsage` is only called for numeric `windowsPerWeek` ([windowBudgetSeries.ts:170](../../../src/main/windowBudgetSeries.ts#L170)), so a `null` value yields `currentUsage: undefined` → `perProvider[...].currentUsage: null`.

- [ ] **Step 4: Run the whole test suite**

Run: `npm test`
Expected: PASS — no test imports the worker module; the widening and marker call are covered indirectly by build + Task 1 unit tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/analyticsWorker.ts
git commit -m "feat: pass weekly-only providers through window-budget worker"
```

---

### Task 3: Provider selection — extract pure selector, wire IPC handler

**Files:**
- Create: `src/main/windowBudgetProviders.ts`
- Modify: `src/main/detailsWindow.ts` (replace inline mapping in the `windowBudget:get` handler, lines 431-449; add import)
- Test: `tests/windowBudgetProviders.test.ts`

**Interfaces:**
- Consumes: `UsageSnapshot` (`src/providers/types.ts`), `WindowBudgetProviderInput` (Task 2, `import type`).
- Produces: `selectWindowBudgetProviders(snapshots: UsageSnapshot[]): WindowBudgetProviderInput[]` — includes any ok/stale claude|codex snapshot with a numeric weekly window; sets `windowsPerWeek` to `budget.windowsPerWeek` for full budgets and `null` otherwise.

- [ ] **Step 1: Write the failing tests**

Create `tests/windowBudgetProviders.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "../src/providers/types";
import { selectWindowBudgetProviders } from "../src/main/windowBudgetProviders";

const weekly = (usedPercent: number): UsageSnapshot["windows"][number] =>
  ({ name: "weekly", usedPercent, windowSeconds: 604800, resetsAt: "2026-07-18T00:00:00Z" });
const five = (usedPercent: number): UsageSnapshot["windows"][number] =>
  ({ name: "fiveHour", usedPercent, windowSeconds: 18000 });

function snap(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  return { provider: "codex", status: "ok", windows: [], updatedAt: "2026-07-13T00:00:00Z", ...overrides };
}

describe("selectWindowBudgetProviders", () => {
  it("maps a full-budget provider to its learned windowsPerWeek", () => {
    const out = selectWindowBudgetProviders([snap({
      windows: [five(60), weekly(40)],
      windowBudget: { learning: false, windowsPerWeek: 8.3, usedWindows: 3, remainingWindows: 5.3, sampleFivePct: 400 },
    })]);
    expect(out).toHaveLength(1);
    expect(out[0].windowsPerWeek).toBe(8.3);
    expect(out[0].weeklyUsedPercent).toBe(40);
    expect(out[0].weeklyResetsAt).toBe("2026-07-18T00:00:00Z");
  });

  it("includes a weekly-only provider with windowsPerWeek null", () => {
    const out = selectWindowBudgetProviders([snap({ windows: [weekly(55)] })]);
    expect(out).toHaveLength(1);
    expect(out[0].windowsPerWeek).toBeNull();
  });

  it("includes a learning provider with windowsPerWeek null", () => {
    const out = selectWindowBudgetProviders([snap({
      windows: [five(10), weekly(55)],
      windowBudget: { learning: true, sampleFivePct: 20 },
    })]);
    expect(out).toHaveLength(1);
    expect(out[0].windowsPerWeek).toBeNull();
  });

  it("excludes snapshots without a numeric weekly window", () => {
    expect(selectWindowBudgetProviders([snap({ windows: [five(10)] })])).toEqual([]);
    expect(selectWindowBudgetProviders([snap({ windows: [{ name: "weekly", windowSeconds: 604800 }] })])).toEqual([]);
  });

  it("excludes error snapshots and non-claude/codex providers", () => {
    expect(selectWindowBudgetProviders([
      snap({ status: "error", windows: [weekly(40)] }),
      snap({ provider: "gemini", windows: [weekly(40)] }),
    ])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/windowBudgetProviders.test.ts`
Expected: FAIL — cannot find module `../src/main/windowBudgetProviders`.

- [ ] **Step 3: Create the selector module**

Create `src/main/windowBudgetProviders.ts`:

```ts
import type { UsageSnapshot } from "../providers/types";
import type { WindowBudgetProviderInput } from "./analyticsWorker";

/**
 * Wählt aus den letzten Snapshots die Provider aus, für die eine Fenster-Budget-
 * bzw. Weekly-Trend-Ansicht möglich ist: jeder ok/stale claude|codex-Snapshot mit
 * numerischem Weekly-Fenster. `windowsPerWeek` wird nur bei gelerntem Budget gesetzt;
 * weekly-only und Learning liefern `null`, sodass der Worker die Fenster-Umrechnung
 * und die 5h-Marker unterdrückt und nur der Weekly-Trend gerendert wird.
 */
export function selectWindowBudgetProviders(snapshots: UsageSnapshot[]): WindowBudgetProviderInput[] {
  return snapshots
    .filter((s) => s.status === "ok" || s.status === "stale")
    .flatMap((s): WindowBudgetProviderInput[] => {
      const weekly = s.windows.find((w) => w.name === "weekly");
      if (!weekly || typeof weekly.usedPercent !== "number") return [];
      if (s.provider !== "claude" && s.provider !== "codex") return [];
      const budget = s.windowBudget;
      const windowsPerWeek = budget && !budget.learning ? budget.windowsPerWeek : null;
      return [{
        provider: s.provider,
        weeklyUsedPercent: weekly.usedPercent,
        weeklyResetsAt: weekly.resetsAt ?? null,
        windowsPerWeek,
        burnRatePctPerHour: weekly.burnRatePctPerHour ?? null,
        pace: weekly.pace ?? null,
        planType: s.planType ?? null,
      }];
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/windowBudgetProviders.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the selector into the IPC handler**

In `src/main/detailsWindow.ts`, add the import next to the other `./` main-module imports near the top of the file:

```ts
import { selectWindowBudgetProviders } from "./windowBudgetProviders";
```

Then replace the handler body (lines 430-459) mapping block. Replace:

```ts
    ipcMain.handle("windowBudget:get", async (): Promise<WindowBudgetData> => {
      const snapshots = this.lastSnapshots ?? [];
      const providers = snapshots
        .filter((s) => s.status === "ok" || s.status === "stale")
        .flatMap((s) => {
          const weekly = s.windows.find((w) => w.name === "weekly");
          if (!weekly || typeof weekly.usedPercent !== "number") return [];
          const budget = s.windowBudget;
          if (!budget || budget.learning) return [];
          if (s.provider !== "claude" && s.provider !== "codex") return [];
          return [{
            provider: s.provider,
            weeklyUsedPercent: weekly.usedPercent,
            weeklyResetsAt: weekly.resetsAt ?? null,
            windowsPerWeek: budget.windowsPerWeek,
            burnRatePctPerHour: weekly.burnRatePctPerHour ?? null,
            pace: weekly.pace ?? null,
            planType: s.planType ?? null,
          }];
        });
      if (providers.length === 0) return { perProvider: {} };
```

with:

```ts
    ipcMain.handle("windowBudget:get", async (): Promise<WindowBudgetData> => {
      const snapshots = this.lastSnapshots ?? [];
      const providers = selectWindowBudgetProviders(snapshots);
      if (providers.length === 0) return { perProvider: {} };
```

(Leave the `this.windowBudgetCache.get(...)` call and the rest of the handler unchanged.)

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run build && npm test`
Expected: PASS. Build confirms the handler compiles against the extracted selector; tests confirm no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/main/windowBudgetProviders.ts src/main/detailsWindow.ts tests/windowBudgetProviders.test.ts
git commit -m "feat: select weekly-only providers for window-budget data"
```

---

### Task 4: Renderer — trend-eligible gating + dynamic label

**Files:**
- Modify: `src/renderer/tabs/live.js` (add `hasWeeklyTrend`; update `windowBudgetCollapseHtml`; update `hydrateWindowBudgets` filter)

**Interfaces:**
- Consumes: `WindowBudgetData` from the `windowBudget:get` IPC (now includes weekly-only + learning providers with `currentUsage: null`, `fiveHourResets: []`).
- Produces: renderer behavior — no exported symbols. Verified manually in Electron.

- [ ] **Step 1: Add the `hasWeeklyTrend` predicate**

In `src/renderer/tabs/live.js`, add this helper directly above `function windowBudgetRowHtml(` (line 188):

```js
function hasWeeklyTrend(snap) {
  const weekly = snap.windows?.find(w => w.name === 'weekly');
  return typeof weekly?.usedPercent === 'number';
}
```

- [ ] **Step 2: Gate the collapse on trend-eligibility with a dynamic label**

Replace the head of `windowBudgetCollapseHtml` (lines 268-274):

```js
function windowBudgetCollapseHtml(snap) {
  const wb = snap.windowBudget;
  if (!wb || wb.learning) return '';
  const id = `wbc-${QB.esc(snap.provider)}`;
  let isOpen = false;
  try { isOpen = localStorage.getItem('windowBudgetOpen') === '1'; } catch {}
  return `<div class="token-collapse wb-collapse${isOpen ? ' open' : ''}" id="${id}">
```

with:

```js
function windowBudgetCollapseHtml(snap) {
  if (!hasWeeklyTrend(snap)) return '';
  const wb = snap.windowBudget;
  const label = wb && !wb.learning ? 'Window budget' : 'Weekly trend';
  const id = `wbc-${QB.esc(snap.provider)}`;
  let isOpen = false;
  try { isOpen = localStorage.getItem('windowBudgetOpen') === '1'; } catch {}
  return `<div class="token-collapse wb-collapse${isOpen ? ' open' : ''}" id="${id}">
```

Then replace the hard-coded button label line (line 281) — change:

```js
      Window budget
    </button>
```

to:

```js
      ${label}
    </button>
```

- [ ] **Step 3: Widen the hydration filter to trend-eligible snapshots**

In `hydrateWindowBudgets`, replace the `wanted` filter (line 312):

```js
  const wanted = snapshots.filter(s => s.windowBudget && !s.windowBudget.learning);
```

with:

```js
  const wanted = snapshots.filter(s => hasWeeklyTrend(s));
```

(The tile-refresh line `if (row && d.currentUsage) ...` stays as-is: weekly-only/learning snapshots have `d.currentUsage === null` and no `wb-row` element, so it is a safe no-op. The chart uses `d.hasSeriesData`; markers arrive already empty from the worker.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS (renderer is copied/bundled; no TS errors introduced elsewhere).

- [ ] **Step 5: Manual verification in Electron per `TESTING.md`**

Follow `TESTING.md` to launch the app with a weekly-only Codex fixture and confirm:

- Weekly-only Codex card: the collapsible section is present, labeled **`Weekly trend`**, shows the weekly line chart + forecast, **no** `X of Y windows` tile, **no** 5h reset markers on the curve, **no** empty `5-Hour` row.
- A normal two-window provider card (Claude, or Codex with both windows): unchanged — labeled **`Window budget`**, tile present, 5h markers present.
- Toggle the collapse open/closed on one card, switch tabs and back: the open/closed state persists across both label variants.

Record the observed result (pass/fail per bullet) in the task notes.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/tabs/live.js
git commit -m "feat: render weekly trend chart for weekly-only Codex"
```

---

## Self-Review

**1. Spec coverage:**

- Two-state model (trend-eligible vs full budget) → Task 3 selector + Task 4 renderer. ✓
- Chart+forecast render for weekly-only and learning → Task 4 (`hasWeeklyTrend` gate + hydration filter), Task 2/3 data path. ✓
- Dynamic label `Window budget` / `Weekly trend` → Task 4 Step 2. ✓
- Tile unchanged / stays hidden for weekly-only → Task 4 leaves `windowBudgetRowHtml` untouched; `currentUsage: null` from Task 2. ✓
- Marker suppression when `windowsPerWeek` not a number (weekly-only + learning) → Task 1 helper, Task 2 wiring. ✓
- Data flow: IPC filter drops the budget gate, `windowsPerWeek` widened to `number | null` → Task 2 (type) + Task 3 (selector/handler). ✓
- Five-hour re-introduction is additive (chart persists, upgrades in place) → follows from gating on `hasWeeklyTrend` (Task 4) plus additive `windowsPerWeek`-driven enrichment; persisted ratio behavior is unchanged. ✓
- Tests 1–4 from spec → Task 1 (weekly-only series, `withBudgetMarkers` covers learning-vs-full marker rule), Task 3 (selector input construction incl. weekly-only/learning/exclusions). ✓
- Build + manual Electron verification of both fixtures → Task 4 Step 5. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**3. Type consistency:** `withBudgetMarkers(series, windowsPerWeek)` signature identical in Task 1 (definition), Task 2 (call). `WindowBudgetProviderInput` fields identical in Task 2 (definition) and Task 3 (selector return + tests). `selectWindowBudgetProviders(snapshots)` identical in Task 3 definition, handler call, and tests. `hasWeeklyTrend(snap)` identical across Task 4 uses. ✓

Note on spec test 2 (a learning snapshot with five-hour log data still yielding empty `fiveHourResets`): this is enforced at the worker layer by `withBudgetMarkers` (unit-tested in Task 1 with a non-empty-markers input + `null` ratio), not by `readWeeklySeriesForProviders`, which by contract keeps reporting real markers. This split is intentional and documented in the Global Constraints.
